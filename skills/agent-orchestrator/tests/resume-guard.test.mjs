import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, readJson, writeJson } from './helpers.mjs';

// The resume guard (scripts/hooks/orch-resume-guard.mjs) runs as Claude Code runs a hook: a child
// process that gets the PreToolUse event on stdin. `claude` is a fake that prints the rows of a
// control file; a "live" session is a row whose pid is a process that exists (this test's own, or a
// child it started), and a finished one has a pid that is gone. Session ids are made up.

const hook = fileURLToPath(new URL('../scripts/hooks/orch-resume-guard.mjs', import.meta.url));
const ID = '3f6c1a90-5b2d-4e7a-9c18-a4d2e6b07f31';
const OTHER = '3f6c1a90-0000-4000-8000-000000000001'; // shares the first eight digits with ID
const CALLER = '9a8b7c6d-1111-4222-8333-444455556666';

const reasonFor = (id, name, pid) => `Session ${id} is still running as "${name}" (pid ${pid}). Starting a second process on it makes two processes write one session. Message it instead: SendMessage to "${name}" (names change when a session restarts: find it by its session id in ListAgents or claude agents --json). If it is an orch task, use orch.mjs send.`;

const row = (sessionId, over = {}) => ({ sessionId, name: 'review-52', pid: process.pid, status: 'idle', kind: 'interactive', cwd: '/work', state: 'idle', ...over });

// A fake `claude`: it logs its arguments, then fails, prints text that is not JSON, or prints rows.
function fakeClaude(f, rows = [], mode = 'ok') {
  const bin = path.join(f.root, 'fake-claude');
  const control = path.join(f.root, 'claude-control.json');
  const calls = path.join(f.root, 'claude-calls.jsonl');
  writeJson(control, { mode, rows });
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (control.mode === 'failure') process.exit(1);
if (control.mode === 'invalid') { console.log('not JSON'); process.exit(0); }
console.log(JSON.stringify(control.rows));
`);
  fs.chmodSync(bin, 0o755);
  f.env.AGENT_ORCH_CLAUDE_BIN = bin;
  return {
    set: (next, nextMode = 'ok') => writeJson(control, { mode: nextMode, rows: next }),
    // The session listings the guard made: `claude agents --json`, not the dashboard's `--all`.
    listings: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
      .filter((argv) => !argv.includes('--all')),
  };
}

// Run the hook once. It must exit 0, write nothing on stderr, and print nothing or one JSON object.
function runHook(f, stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { cwd: f.repo, env: { ...f.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      assert.equal(code, 0, `the hook must always exit 0 (signal ${signal}): ${stderr}`);
      assert.equal(stderr, '');
      resolve(stdout);
    });
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

const bash = (command, extra = {}) => ({
  session_id: CALLER, transcript_path: '/dev/null', cwd: '/', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra,
});

// The reason the hook refused with, or null when it allowed the command (no output at all).
async function refused(f, command, env = {}, extra = {}) {
  const out = await runHook(f, bash(command, extra), env);
  if (out === '') return null;
  assert.ok(out.endsWith('\n') && !out.slice(0, -1).includes('\n'), `one line of output: ${out}`);
  const decision = JSON.parse(out);
  assert.deepEqual(Object.keys(decision), ['hookSpecificOutput']);
  const { hookEventName, permissionDecision, permissionDecisionReason, ...rest } = decision.hookSpecificOutput;
  assert.deepEqual([hookEventName, permissionDecision, rest], ['PreToolUse', 'deny', {}]);
  assert.equal(typeof permissionDecisionReason, 'string');
  return permissionDecisionReason;
}

// A process that has ended, for the pid of a session that is no longer running.
async function endedPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid;
}

// A live process named `codex` (a script that `node` runs, as the npm package's is) whose arguments
// carry a session id, as `codex resume <id>` does. Ended with the test, by its pid.
async function fakeCodex(f, t, args) {
  const file = path.join(f.root, 'bin', 'codex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\nconsole.log('ready'); setInterval(() => {}, 1000);\n`);
  fs.chmodSync(file, 0o755);
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  return child;
}

test('refuses a resume of a running session, naming its name and pid', async (t) => {
  const f = await fixture(t);
  const claude = fakeClaude(f, [row(ID)]);
  assert.equal(await refused(f, `claude --resume ${ID}`), reasonFor(ID, 'review-52', process.pid));
  assert.deepEqual(claude.listings(), [['agents', '--json']]);
});

test('refuses every way of writing a Claude resume, with a full id or a prefix', async (t) => {
  const f = await fixture(t);
  fakeClaude(f, [row(ID)]);
  const reason = reasonFor(ID, 'review-52', process.pid);
  for (const command of [
    `claude -r ${ID}`,
    `claude --resume=${ID}`,
    `claude --resume ${ID.slice(0, 8)}`,
    `claude --resume ${ID.slice(0, 13)}`,
    `claude --resume ${ID.toUpperCase()}`,
    `claude --model opus -p "carry on" --resume ${ID}`,
    `/usr/local/bin/claude --dangerously-skip-permissions --resume ${ID}`,
    `cd /repo && claude --resume ${ID}`,
    `env FOO=1 nohup claude -r ${ID} > /tmp/out.log 2>&1 &`,
    `npx @anthropic-ai/claude-code --resume ${ID}`,
  ]) assert.equal(await refused(f, command), reason, command);
});

test('refuses the tmux-quoted form, and the other wrappers that quote a command', async (t) => {
  const f = await fixture(t);
  fakeClaude(f, [row(ID)]);
  const reason = reasonFor(ID, 'review-52', process.pid);
  for (const command of [
    `tmux new-session -d -s code-review -c /repo 'claude --resume ${ID}'`,
    `tmux new-session -d -s code-review "cd /repo && claude --resume ${ID}"`,
    `bash -c 'claude --resume ${ID}'`,
    `bash -lc "claude -r ${ID}; echo done"`,
    `screen -dmS review claude --resume ${ID}`,
    `nohup sh -c "claude --resume ${ID}" &`,
    `ssh host "claude --resume \\"${ID}\\""`,
  ]) assert.equal(await refused(f, command), reason, command);
});

test('names the first live process when two run the session', async (t) => {
  const f = await fixture(t);
  fakeClaude(f, [row(ID, { name: 'review-52' }), row(ID, { name: 'review-copy', pid: process.ppid })]);
  assert.equal(await refused(f, `claude --resume ${ID}`), reasonFor(ID, 'review-52', process.pid));
});

test('allows a resume of a finished session', async (t) => {
  const f = await fixture(t);
  const gone = await endedPid();
  const claude = fakeClaude(f, [row(ID, { pid: gone })]);
  assert.equal(await refused(f, `claude --resume ${ID}`), null, 'its process has ended');
  claude.set([row(ID, { state: 'done', status: 'idle' })]);
  assert.equal(await refused(f, `claude --resume ${ID}`), null, 'a finished background job');
  claude.set([row(OTHER)]);
  assert.equal(await refused(f, `claude --resume ${ID}`), null, 'another session runs');
  claude.set([]);
  assert.equal(await refused(f, `tmux new-session -d 'claude --resume ${ID}'`), null, 'no session runs');
  claude.set([{ sessionId: ID, name: 'review-52' }]);
  assert.equal(await refused(f, `claude --resume ${ID}`), null, 'a row with no pid');
});

test('allows a malformed id, a name, no id, and an id that several sessions share', async (t) => {
  const f = await fixture(t);
  const claude = fakeClaude(f, [row(ID), row(OTHER, { name: 'other' })]);
  for (const command of [
    'claude --resume abc',
    'claude --resume 3f6c1a9', // seven digits
    `claude --resume ${ID}0`, // too long to be an id
    'claude --resume 3f6c1a90-5b2d-ZZZZ-9c18-a4d2e6b07f31',
    'claude --resume "my review session"',
    'claude --resume',
    'claude -c',
    'claude --resume deadbeef-title', // a name that starts like a prefix
  ]) assert.equal(await refused(f, command), null, command);
  assert.deepEqual(claude.listings(), [], 'it never listed sessions for those');
  assert.equal(await refused(f, `claude --resume ${ID.slice(0, 8)}`), null, 'two live sessions start with these digits');
  assert.equal(await refused(f, `claude --resume ${ID}`), reasonFor(ID, 'review-52', process.pid), 'a full id is never ambiguous');
});

test('allows every resume when claude fails, prints junk, or is missing', async (t) => {
  const f = await fixture(t);
  const claude = fakeClaude(f, [row(ID)], 'failure');
  assert.equal(await refused(f, `claude --resume ${ID}`), null, 'a failing claude');
  claude.set([row(ID)], 'invalid');
  assert.equal(await refused(f, `claude --resume ${ID}`), null, 'output that is not JSON');
  claude.set({ sessions: [row(ID)] });
  assert.equal(await refused(f, `claude --resume ${ID}`), null, 'JSON that is not a list');
  assert.equal(await refused(f, `claude --resume ${ID}`, { AGENT_ORCH_CLAUDE_BIN: path.join(f.root, 'no-such-claude') }), null, 'a missing claude');
});

test('allows a session to resume itself, and a resume that forks', async (t) => {
  const f = await fixture(t);
  fakeClaude(f, [row(CALLER)]);
  assert.equal(await refused(f, `claude --resume ${CALLER}`), null, 'the caller named by the event');
  fakeClaude(f, [row(ID)]);
  assert.equal(await refused(f, `claude --resume ${ID} --fork-session`), null, 'a fork is a new session');
  assert.equal(await refused(f, `claude --resume ${ID}`, {}, { session_id: ID }), null, 'the event names the session');
  assert.equal(await refused(f, `claude --resume ${ID}`, {}, { session_id: 7 }), reasonFor(ID, 'review-52', process.pid), 'a bad session_id is ignored');
});

test('is turned off by AGENT_ORCH_RESUME_GUARD=off', async (t) => {
  const f = await fixture(t);
  const claude = fakeClaude(f, [row(ID)]);
  assert.equal(await refused(f, `claude --resume ${ID}`, { AGENT_ORCH_RESUME_GUARD: 'off' }), null);
  assert.deepEqual(claude.listings(), []);
  assert.ok(await refused(f, `claude --resume ${ID}`, { AGENT_ORCH_RESUME_GUARD: 'on' }));
});

test('does nothing for other tools, other commands, or input it cannot read', async (t) => {
  const f = await fixture(t);
  const claude = fakeClaude(f, [row(ID)]);
  assert.equal(await runHook(f, { ...bash(`claude --resume ${ID}`), tool_name: 'Read' }), '');
  assert.equal(await runHook(f, { tool_name: 'Bash', tool_input: {} }), '');
  assert.equal(await runHook(f, { tool_name: 'Bash', tool_input: { command: 7 } }), '');
  assert.equal(await runHook(f, 'not json'), '');
  assert.equal(await runHook(f, ''), '');
  assert.equal(await runHook(f, '[]'), '');
  for (const command of [
    'ls -la', `git log --grep ${ID}`, `cat ~/.claude/projects/x/${ID}.jsonl`, `claude-delegate --resume ${ID}`,
    `echo claude && rm -r ${ID.slice(0, 8)}`, `claude agents --json | grep ${ID}`,
  ]) assert.equal(await refused(f, command), null, command);
  assert.deepEqual(claude.listings(), [], 'it asked claude for none of them');
});

test('refuses a codex resume of a session a live process runs', async (t) => {
  const f = await fixture(t);
  const codex = await fakeCodex(f, t, ['resume', ID]);
  const reason = `Session ${ID} is still running (pid ${codex.pid}). Starting a second process on it makes two processes write one session. Message it instead: if it is an orch task, use orch.mjs send; otherwise ask the user, or message it from the terminal it runs in.`;
  for (const command of [
    `codex resume ${ID}`,
    `codex exec resume ${ID} "carry on"`,
    `codex exec --json resume ${ID.slice(0, 8)}`,
    `tmux new-session -d -s review 'codex resume ${ID}'`,
    `bash -c "cd /repo && codex exec resume ${ID}"`,
  ]) assert.equal(await refused(f, command), reason, command);
});

test('allows a codex resume of a session no live process runs', async (t) => {
  const f = await fixture(t);
  await fakeCodex(f, t, ['resume', OTHER]);
  assert.equal(await refused(f, `codex resume ${ID}`), null, 'another session runs');
  assert.equal(await refused(f, `codex resume ${OTHER.slice(0, 7)}`), null, 'a prefix of seven digits is not an id');
  assert.equal(await refused(f, 'codex resume --last'), null, 'no id');

  // A process that only mentions the id, in a path that holds "codex", is not a Codex session.
  const rollout = path.join(f.codex, 'sessions', `rollout-${ID}.jsonl`);
  fs.writeFileSync(rollout, '');
  const tail = spawn('tail', ['-f', rollout], { stdio: 'ignore' });
  t.after(() => tail.kill('SIGKILL'));
  assert.equal(await refused(f, `codex resume ${ID}`), null, 'a tail of its rollout file');
});

test('start --session refuses a Claude session a process runs', async (t) => {
  const f = await fixture(t);
  const claude = fakeClaude(f, [row(ID)]);
  const run = await f.newRun();
  const start = (id, code, session = ID) => f.command(['start', run.id, id, '--agent', 'claude', '--tier', 'complex',
    '--why', 'Exercises the session guard with a local fake relay', '--brief', f.brief(id), '--', '--session', session], { code });

  const refusal = await start('copy', 1);
  assert.equal(refusal.stderr, `orch: cannot start copy: ${reasonFor(ID, 'review-52', process.pid)}\n`);
  assert.ok(!fs.existsSync(f.taskFile(run, 'copy')), 'no task was started');
  assert.deepEqual(claude.listings(), [['agents', '--json']]);

  // The same refusal when the id is a prefix, and written as --session=<id>.
  await start('prefix', 1, ID.slice(0, 8));
  await f.command(['start', run.id, 'equals', '--agent', 'claude', '--tier', 'complex', '--why', 'Exercises the session guard',
    '--brief', f.brief('equals'), '--', `--session=${ID}`], { code: 1 });
});

test('start --session goes on when the session is not running, or the check cannot tell', async (t) => {
  const f = await fixture(t);
  const claude = fakeClaude(f, [row(ID, { state: 'done' })]);
  const run = await f.newRun();
  let n = 0;
  const start = async (session, flags = []) => {
    const id = `work-${++n}`;
    const out = await f.command(['start', run.id, id, '--agent', 'claude', '--tier', 'complex', '--force', '--why', 'Exercises the session guard with a local fake relay',
      '--brief', f.brief(id), ...flags, '--', '--session', session]);
    assert.match(out.stdout, new RegExp(`^started ${id} `));
    await f.finished(run, id);
    const invocation = readJson(path.join(readJson(f.taskFile(run, id)).outDir, 'invocation.json'));
    assert.deepEqual(invocation.argv.slice(-2), ['--session', session]);
  };
  await start(ID); // a finished background job
  claude.set([row(ID, { pid: await endedPid() })]);
  await start(ID); // its process has ended
  claude.set([row(ID)], 'failure');
  await start(ID); // the listing fails
  claude.set([row(ID)], 'invalid');
  await start(ID); // the listing is not JSON
  claude.set([row(ID)]);
  const before = claude.listings().length;
  await start('fixture-claude'); // not a session id: nothing to look up
  assert.equal(claude.listings().length, before);
});
