import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, writeJson } from './helpers.mjs';

const cli = fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../scripts/hooks/orch-inbox.mjs', import.meta.url));
const hookInput = JSON.stringify({ session_id: 'agent-session', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' } });

// Runs a Node script the way an agent or Claude Code would: its own working directory and
// environment, with the hook input on stdin (which the hook may leave unread).
function node(args, { cwd, env, input = hookInput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

// What `start` puts in an agent's environment.
const agentEnv = (f, run, id) => ({ ...f.env, AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
const runHook = (f, env) => node([hook], { cwd: f.repo, env });
const inboxFile = (run, id) => path.join(run.dir, 'tasks', id, 'inbox.jsonl');
const readFile = (run, id) => path.join(run.dir, 'tasks', id, 'inbox-read.jsonl');
const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

async function running(f, run, id, agent = 'claude') {
  const task = await f.start(run, id, { agent, config: { hold: true } });
  await f.ready(task);
  return task;
}

test('send refuses a task that is not running', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'done');
  assert.equal((await f.finished(run, 'done')).session, 'fixture-claude');
  const refused = await f.command(['send', run.id, 'done', 'Use the v2 API'], { code: 2 });
  assert.match(refused.stderr, /task done is not running \(completed\); resume it with a delta brief instead: node .*orch\.mjs start .* done --agent claude --brief <delta> -- --session fixture-claude/);
  assert.equal(fs.existsSync(inboxFile(run, 'done')), false);
  assert.equal((await f.json(['status', run.id])).tasks[0].inbox, undefined);
  const missing = await f.command(['send', run.id, 'nope', 'hello'], { code: 1 });
  assert.match(missing.stderr, /no task nope/);
  const both = await f.command(['send', run.id, 'nope', 'hello', '--file', 'brief.md'], { code: 1 });
  assert.match(both.stderr, /no task nope/);
});

test('send and inbox round trip, including --file, from the agent\'s own directory', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await running(f, run, 'steer');
  const sent = await f.command(['send', run.id, 'steer', 'Use', 'the v2 API']);
  const [, first] = /^sent message ([0-9a-f]{8}) to steer \(attempt 1\)$/m.exec(sent.stdout);
  assert.match(sent.stdout, /^delivery: the orch-inbox hook is not registered in .*settings\.json, so Claude reads it the next time it runs `inbox`, at its next gate run$/m);
  const file = path.join(f.root, 'message.md');
  fs.writeFileSync(file, 'The schema changed:\n  column `b` is now `c`.\n\n');
  // Once the hook is registered in the user's settings, delivery says so.
  writeJson(path.join(f.claude, 'settings.json'), { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: `node ${hook}` }] }] } });
  const second = await f.json(['send', run.id, 'steer', '--file', file]);
  assert.equal(second.delivery, "the orch-inbox hook adds it to Claude's context after its next tool call");
  assert.equal(second.text, 'The schema changed:\n  column `b` is now `c`.');
  assert.equal(second.attempt, 1);

  const stored = lines(inboxFile(run, 'steer'));
  assert.deepEqual(stored.map((m) => Object.keys(m).sort()), [['attempt', 'id', 'logOffset', 'text', 'time'], ['attempt', 'id', 'logOffset', 'text', 'time']]);
  assert.deepEqual(stored.map((m) => m.id), [first, second.id]);
  assert.equal(stored[0].text, 'Use the v2 API');
  assert.ok(Number.isFinite(Date.parse(stored[0].time)));

  // The agent runs `inbox` with the absolute CLI path and the run's id, from its own directory.
  const elsewhere = path.join(f.root, 'agent-cwd');
  fs.mkdirSync(elsewhere);
  const read = await node([cli, 'inbox', run.id, 'steer'], { cwd: elsewhere, env: agentEnv(f, run, 'steer'), input: '' });
  assert.equal(read.code, 0, read.stderr);
  assert.equal(read.stdout, `2 unread messages for steer:\n\n[${first}] Message from your orchestrator, ${stored[0].time}\nUse the v2 API\n\n[${second.id}] Message from your orchestrator, ${stored[1].time}\nThe schema changed:\n  column \`b\` is now \`c\`.\n`);

  for (const [args, error] of [
    [['send', run.id, 'steer', 'text', '--file', file], /as text or with --file, not both/],
    [['send', run.id, 'steer', '   '], /the message is empty/],
    [['send', run.id, 'steer'], /the message is empty/],
    [['send', run.id, 'steer', '--file', path.join(f.root, 'missing.md')], /cannot read --file/],
  ]) assert.match((await f.command(args, { code: 2 })).stderr, error);
  assert.equal(lines(inboxFile(run, 'steer')).length, 2);
});

test('send says how a Codex agent and an agent without the inbox note get the message', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await running(f, run, 'codex-task', 'codex');
  const sent = await f.command(['send', run.id, 'codex-task', 'Stop editing docs']);
  assert.match(sent.stdout, /^delivery: Codex reads it the next time it runs `inbox`: after each gate run, and at least every 10 commands$/m);
  // An attempt started before messages existed has no note in its brief.
  const brief = path.join(task.outDir, 'orch-brief.md');
  fs.writeFileSync(brief, fs.readFileSync(brief, 'utf8').replace('## Messages from your orchestrator', ''));
  const old = await f.command(['send', run.id, 'codex-task', 'Stop editing docs']);
  assert.match(old.stdout, /^delivery: this attempt's brief has no inbox note, so Codex will not read it; stop it and resume it with a delta brief instead$/m);
});

test('inbox --ack marks the printed messages read, and --all shows read ones too', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await running(f, run, 'steer');
  const a = await f.json(['send', run.id, 'steer', 'first']);
  const b = await f.json(['send', run.id, 'steer', 'second']);

  const acked = await f.command(['inbox', run.id, 'steer', '--ack']);
  assert.match(acked.stdout, /^2 unread messages for steer:/);
  assert.match(acked.stdout, /\nmarked 2 messages as read\n$/);
  assert.deepEqual(lines(readFile(run, 'steer')).map((r) => r.id), [a.id, b.id]);
  assert.equal((await f.command(['inbox', run.id, 'steer'])).stdout, 'no unread messages for steer\n');
  assert.equal((await f.command(['inbox', run.id, 'steer', '--ack'])).stdout, 'no unread messages for steer\n');

  const c = await f.json(['send', run.id, 'steer', 'third']);
  const all = await f.command(['inbox', run.id, 'steer', '--all']);
  assert.equal(all.stdout, `3 messages for steer (1 unread):\n\n[${a.id}] Message from your orchestrator, ${a.time} (read)\nfirst\n\n[${b.id}] Message from your orchestrator, ${b.time} (read)\nsecond\n\n[${c.id}] Message from your orchestrator, ${c.time}\nthird\n`);
  // --all --ack marks only the unread one; the read ones are not recorded twice.
  const json = await f.json(['inbox', run.id, 'steer', '--all', '--ack']);
  assert.deepEqual(json.messages.map((m) => [m.id, m.read]), [[a.id, true], [b.id, true], [c.id, false]]);
  assert.deepEqual(json.acked, [c.id]);
  assert.deepEqual(lines(readFile(run, 'steer')).map((r) => r.id), [a.id, b.id, c.id]);
  assert.deepEqual((await f.json(['inbox', run.id, 'steer'])).messages, []);

  // An agent that cannot write the state folder still gets its messages, and a warning.
  const d = await f.json(['send', run.id, 'steer', 'fourth']);
  fs.rmSync(readFile(run, 'steer'));
  fs.mkdirSync(readFile(run, 'steer'));
  const blocked = await f.command(['inbox', run.id, 'steer', '--ack']);
  assert.match(blocked.stdout, new RegExp(`^4 unread messages for steer:[\\s\\S]*\\[${d.id}\\]`));
  assert.doesNotMatch(blocked.stdout, /marked/);
  assert.match(blocked.stderr, /could not mark the messages as read .*; they will show again/);
});

test('the hook delivers unread messages once, then prints nothing', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await running(f, run, 'steer');
  const env = agentEnv(f, run, 'steer');
  const empty = await runHook(f, env);
  assert.deepEqual([empty.code, empty.stdout, empty.stderr], [0, '', '']);

  const a = await f.json(['send', run.id, 'steer', 'Use the v2 API']);
  const b = await f.json(['send', run.id, 'steer', 'Skip the docs\nthey are owned elsewhere']);
  const delivered = await runHook(f, env);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.deepEqual(JSON.parse(delivered.stdout), { hookSpecificOutput: { hookEventName: 'PostToolUse',
    additionalContext: `Message from your orchestrator (${a.time}): Use the v2 API\nMessage from your orchestrator (${b.time}): Skip the docs\nthey are owned elsewhere` } });
  assert.deepEqual(lines(readFile(run, 'steer')).map((r) => r.id), [a.id, b.id]);

  const again = await runHook(f, env);
  assert.deepEqual([again.code, again.stdout, again.stderr], [0, '', '']);
  assert.equal((await f.command(['inbox', run.id, 'steer'])).stdout, 'no unread messages for steer\n');

  // A later message is delivered on its own.
  const c = await f.json(['send', run.id, 'steer', 'One more thing']);
  const later = await runHook(f, env);
  assert.equal(JSON.parse(later.stdout).hookSpecificOutput.additionalContext, `Message from your orchestrator (${c.time}): One more thing`);
});

test('the hook does nothing without the orchestrator\'s environment variables', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await running(f, run, 'steer');
  await f.json(['send', run.id, 'steer', 'Use the v2 API']);
  const { AGENT_ORCH_RUN, AGENT_ORCH_TASK, ...base } = agentEnv(f, run, 'steer');
  for (const env of [
    base,
    { ...base, AGENT_ORCH_RUN },
    { ...base, AGENT_ORCH_TASK },
    { ...base, AGENT_ORCH_RUN: '', AGENT_ORCH_TASK },
    { ...base, AGENT_ORCH_RUN: `../runs/${AGENT_ORCH_RUN}`, AGENT_ORCH_TASK },
    { ...base, AGENT_ORCH_RUN: 'no-such-run', AGENT_ORCH_TASK },
    { ...base, AGENT_ORCH_RUN, AGENT_ORCH_TASK: 'no-such-task' },
  ]) {
    const result = await runHook(f, env);
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], JSON.stringify(env));
  }
  assert.equal(fs.existsSync(readFile(run, 'steer')), false);
  assert.match((await f.command(['inbox', run.id, 'steer'])).stdout, /^1 unread message for steer:/);
});

test('the hook never fails on a corrupt inbox', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const env = agentEnv(f, run, 'agent');
  const dir = path.join(run.dir, 'tasks', 'agent');
  fs.mkdirSync(dir, { recursive: true });
  const good = { id: 'aaaa1111', time: '2026-10-29T19:00:00.000Z', attempt: 1, text: 'still delivered' };
  fs.writeFileSync(path.join(dir, 'inbox.jsonl'), [
    '{"id":"torn","time":"2026-10-29T18:00:00.000Z","te', 'not json at all', 'null', '42', '{"id":"no-text"}',
    JSON.stringify(good), '{"id":"tail-without-newline","text":"half',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'inbox-read.jsonl'), '{"id":\n[]\n');
  const result = await runHook(f, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, 'Message from your orchestrator (2026-10-29T19:00:00.000Z): still delivered');
  assert.equal((await runHook(f, env)).stdout, '');

  // Files that cannot be read or written end the hook quietly too.
  fs.rmSync(path.join(dir, 'inbox-read.jsonl'));
  fs.mkdirSync(path.join(dir, 'inbox-read.jsonl'));
  const unwritable = await runHook(f, env);
  assert.equal(unwritable.code, 0);
  assert.match(unwritable.stdout, /still delivered/);
  fs.rmSync(path.join(dir, 'inbox.jsonl'));
  fs.mkdirSync(path.join(dir, 'inbox.jsonl'));
  const unreadable = await runHook(f, env);
  assert.deepEqual([unreadable.code, unreadable.stdout, unreadable.stderr], [0, '', '']);
});

test('every brief tells its agent how to read its messages', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const { inboxNote } = await import('../scripts/lib/inbox.mjs');
  for (const agent of ['claude', 'codex']) {
    const started = await f.start(run, agent, { agent, flags: ['--read-only'] });
    const brief = fs.readFileSync(path.join(started.outDir, 'orch-brief.md'), 'utf8');
    const note = inboxNote(run, agent, agent);
    assert.ok(brief.endsWith(note), `${agent} brief ends with:\n${brief.slice(-400)}`);
    assert.ok(brief.indexOf('## Decisions') < brief.indexOf('## Messages from your orchestrator'));
    assert.match(note, new RegExp(`${cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} inbox ${run.id} ${agent} --ack`));
    assert.match(note, /reply .* "<your answer>"/);
    assert.match(note, /in the background/);
    assert.match(note, agent === 'claude' ? /run_in_background: true/ : /start it with `&`/);
    assert.match(note, /nap <duration>/);
    assert.match(note, /exit code 143/);
    await f.finished(run, agent);
  }
});

test('status rows count a task\'s messages', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await running(f, run, 'steer');
  const row = async () => (await f.json(['status', run.id])).tasks.find((task) => task.id === 'steer');
  assert.equal((await row()).inbox, undefined);
  const a = await f.json(['send', run.id, 'steer', 'first']);
  const b = await f.json(['send', run.id, 'steer', 'x'.repeat(800)]);
  const listed = (read) => [
    { id: a.id, time: a.time, attempt: 1, read, from: 'orchestrator', text: 'first' },
    { id: b.id, time: b.time, attempt: 1, read, from: 'orchestrator', text: 'x'.repeat(800) },
  ];
  // Every unread message, whole up to 2000 characters, with who sent it; and when the agent reads them.
  assert.deepEqual((await row()).inbox, {
    unread: 2, read: 0, lastSentAt: b.time,
    unreadMessages: [
      { id: a.id, time: a.time, text: 'first', from: 'orchestrator', sender: 'the launching session' },
      { id: b.id, time: b.time, text: 'x'.repeat(800), from: 'orchestrator', sender: 'the launching session' },
    ],
    delivery: { how: 'inbox', text: 'The orch-inbox hook is not registered, so it reads them the next time it runs `inbox`, at its next gate run.' },
    messages: listed(false),
  });
  await f.command(['inbox', run.id, 'steer', '--ack']);
  assert.deepEqual((await row()).inbox, { unread: 0, read: 2, lastSentAt: b.time, unreadMessages: [], messages: listed(true) });
  // A corrupt line counts as nothing; the row still builds.
  fs.appendFileSync(inboxFile(run, 'steer'), 'garbage\n');
  assert.deepEqual((await row()).inbox, { unread: 0, read: 2, lastSentAt: b.time, unreadMessages: [], messages: listed(true) });
});
