import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, jsonl, writeJson } from './helpers.mjs';

// The question-dialog hook (scripts/hooks/orch-ask.mjs) runs as Claude Code runs it: a child process
// that gets the PreToolUse event on stdin. Each test seeds the launching session's id in run.json, as
// the CLI would.

const hook = fileURLToPath(new URL('../scripts/hooks/orch-ask.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const SESSION = '7d1e3f5a-2b4c-4d6e-8f0a-1b2c3d4e5f6a';
const input = (extra = {}) => ({
  session_id: SESSION, transcript_path: '/dev/null', cwd: '/', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which parser?', header: 'Parser', options: [{ label: 'old' }, { label: 'new' }], multiSelect: false }] },
  ...extra,
});
// The session's own shell: its runs' results and closes are the owner's (ownership.mjs).
const OWNER = { CLAUDE_CODE_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION };
const MAIN_START = 'A question dialog stops this session until it is answered: task results, messages and scheduled prompts do not reach you while it is open, and ';
const MAIN_END = '. Do not stop your work to wait for the user. Ask without a dialog: put the question, the options and your recommendation in your reply, and message the user if they may be away; go on with your recommended option, or with work that does not depend on the answer; keep `wait` running.';
const TASK_REASON = 'Nobody answers a question dialog in a delegated task. Decide what your brief covers; hand back anything else with `orch.mjs ask` while you keep working, or end with NEEDS DECISION:.';

// Run the hook once. It must exit 0, write nothing on stderr, and print nothing or one JSON object.
function runHook(f, stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { cwd: f.repo, env: { ...f.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
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

// The reason the hook refused with, or null when it allowed the dialog (no output at all).
async function refused(f, stdin = input(), env = {}) {
  const out = await runHook(f, stdin, env);
  if (out === '') return null;
  assert.ok(out.endsWith('\n') && !out.slice(0, -1).includes('\n'), `one line of output: ${out}`);
  const decision = JSON.parse(out);
  assert.deepEqual(Object.keys(decision), ['hookSpecificOutput']);
  const { hookEventName, permissionDecision, permissionDecisionReason, ...rest } = decision.hookSpecificOutput;
  assert.deepEqual([hookEventName, permissionDecision, rest], ['PreToolUse', 'deny', {}]);
  assert.equal(typeof permissionDecisionReason, 'string');
  return permissionDecisionReason;
}

// The part of a main session's reason that says what is in flight.
function inFlight(reason) {
  assert.ok(reason, 'the dialog was refused');
  assert.ok(reason.startsWith(MAIN_START) && reason.endsWith(MAIN_END), reason);
  return reason.slice(MAIN_START.length, -MAIN_END.length);
}

const commandOf = (pid) => spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();

test('refuses while a task runs, and names its open question to the session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  const task = await f.start(run, 'work', { config: { hold: true } });
  await f.ready(task);
  assert.equal(inFlight(await refused(f)), `1 of your tasks is running (${run.id}/work)`);

  // A question for the session from that task; one for the user is not the session's.
  const at = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
  jsonl(path.join(run.dir, 'tasks', 'work', 'questions.jsonl'), [
    { id: 'q1', time: at(0), attempt: 1, question: 'Which parser should stay?', options: ['old', 'new'], recommend: 'new', to: 'orchestrator', answerFrom: 'orchestrator' },
    { id: 'q2', time: at(1), attempt: 1, question: 'Is the budget fine?', options: [], recommend: null, to: 'user', answerFrom: 'user' },
  ]);
  assert.equal(inFlight(await refused(f)), `1 of your tasks is running (${run.id}/work) and 1 question from your tasks waits for your answer (${run.id}/work)`);
  // A live wait does not make the dialog safe: nothing reaches the session while it is open.
  const waiter = spawn(process.execPath, [cli, 'wait', run.id, '--timeout', '0'], { cwd: f.repo, env: f.env, stdio: 'ignore' });
  const exited = new Promise((resolve) => waiter.on('close', resolve));
  try {
    await eventually(() => commandOf(waiter.pid).includes('orch.mjs wait'), 'the wait did not start');
    assert.ok(await refused(f), 'a live wait still refuses');
  } finally {
    if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGTERM');
    await exited;
  }
  f.release(task);
});

test('refuses for an unread result and a decision read but not resolved, and allows once nothing is in flight', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  await f.start(run, 'work');
  await f.start(run, 'asks', { config: { finalMessage: 'NEEDS DECISION:\n- Which parser should stay?' } });
  await f.finished(run, 'work');
  await f.finished(run, 'asks');
  const both = inFlight(await refused(f));
  assert.match(both, new RegExp(`^2 results are unread \\((${run.id}/work, ${run.id}/asks|${run.id}/asks, ${run.id}/work)\\)$`));

  await f.command(['result', run.id, 'work'], { env: OWNER });
  await f.command(['result', run.id, 'asks'], { env: OWNER }); // marks the decision seen, and leaves it open
  assert.equal(inFlight(await refused(f)), `1 decision you read is unresolved (${run.id}/asks)`);
  await f.command(['resolve', run.id, 'asks', '--note', 'answered it in the chat'], { env: OWNER });
  assert.equal(await refused(f), null, 'nothing in flight: the dialog may open');
});

test('names at most three tasks in each part, then how many more', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  for (const id of ['t1', 't2', 't3', 't4', 't5']) await f.start(run, id, { flags: ['--read-only'] });
  for (const id of ['t1', 't2', 't3', 't4', 't5']) await f.finished(run, id);
  const text = inFlight(await refused(f));
  const m = /^5 results are unread \((\S+), (\S+), (\S+) and 2 more\)$/.exec(text);
  assert.ok(m, text);
  assert.ok(m.slice(1).every((label) => /^\S+\/t[1-5]$/.test(label)), text);
});

// A fake gh on PATH, so that a parked babysitter never reaches a real service: one open pull request,
// #42, with nothing to act on (the protocol of park.test.mjs).
async function fakeGh(f) {
  const bin = path.join(f.root, 'bin');
  const data = path.join(f.root, 'github.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
else process.exit(91);
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] });
}

test('refuses while a babysitter is parked', async (t) => {
  const f = await fixture(t);
  await fakeGh(f);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  const parked = ['PARKED: PR #42 waits for a human review', '```orch-result',
    '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}', '```'].join('\n');
  const task = await f.json(['start', run.id, 'watch', '--agent', 'claude', '--babysit', '--pr', '42',
    '--why', 'Babysits the fixture PR', '--brief', f.brief('watch', { finalMessage: parked })]);
  await eventually(() => fs.existsSync(path.join(task.outDir, 'result.json')) && commandOf(task.pid) === '', 'the babysitter did not park', 20_000);
  assert.equal(inFlight(await refused(f)), `1 of your tasks is parked (${run.id}/watch)`);
  await f.command(['close', run.id, 'watch'], { env: OWNER });
  assert.equal(await refused(f), null);
});

test('allows for another tool, another session, a session with no run, malformed input, and with the switch off', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  f.launchingSession(run, SESSION);
  await f.start(run, 'work');
  await f.finished(run, 'work');
  assert.ok(await refused(f), 'the control: an unread result refuses');
  assert.equal(await refused(f, input({ tool_name: 'Bash', tool_input: { command: 'ls' } })), null);
  assert.equal(await refused(f, input({ session_id: 'another-session' })), null, 'a session that launched no run');
  assert.equal(await refused(f, input({ session_id: '../escape' })), null);
  for (const bad of ['', '{ not json', '[]', 'null', '"AskUserQuestion"', JSON.stringify({ session_id: SESSION })]) {
    assert.equal(await refused(f, bad), null, `malformed input: ${JSON.stringify(bad)}`);
  }
  assert.equal(await refused(f, input(), { AGENT_ORCH_ASK_HOOK: 'off' }), null);
  assert.ok(await refused(f, input(), { AGENT_ORCH_ASK_HOOK: 'on' }), 'any other value leaves the hook on');
  // Only the event's own session_id, a string, names the session: the environment never does, and a
  // missing, empty, non-string or malformed id allows the dialog.
  const inherited = { CLAUDE_CODE_SESSION_ID: SESSION, CODEX_THREAD_ID: SESSION };
  assert.equal(await refused(f, JSON.stringify({ tool_name: 'AskUserQuestion' }), inherited), null);
  for (const id of [undefined, null, '', [SESSION], { id: SESSION }, 42, true, ` ${SESSION}`, `${SESSION}/..`]) {
    assert.equal(await refused(f, input({ session_id: id }), inherited), null, `session_id ${JSON.stringify(id)}`);
  }
  assert.ok(await refused(f, input(), inherited), 'a valid session_id still refuses');
  // A task another task started reports to that task, not to this session.
  const file = f.taskFile(run, 'work');
  writeJson(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), startedBy: { run: 'other', task: 'parent' } });
  assert.equal(await refused(f), null);
});

test('always refuses inside an orch task, with nothing in flight', async (t) => {
  const f = await fixture(t);
  const env = { AGENT_ORCH_TASK: 'work', AGENT_ORCH_RUN: 'some-run', AGENT_ORCH_DEPTH: '1' };
  assert.equal(await refused(f, input(), env), TASK_REASON);
  assert.equal(await refused(f, input({ session_id: 'task-session' }), env), TASK_REASON);
  assert.equal(await refused(f, input({ session_id: undefined }), env), TASK_REASON);
  assert.equal(await refused(f, input({ tool_name: 'Read' }), env), null, 'only the dialog');
  assert.equal(await refused(f, '{ not json', env), null, 'malformed input allows');
  assert.equal(await refused(f, input(), { ...env, AGENT_ORCH_ASK_HOOK: 'off' }), null);
  assert.equal(await refused(f, input()), null, 'the same main session has nothing in flight');
});
