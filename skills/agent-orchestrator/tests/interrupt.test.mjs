import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

// The interrupt: `send --steer`, `steer` and the dashboard deliver a message now to an agent that is
// not in a shell command, by stopping its session and resuming the same session with the message
// (steer.mjs, "Interrupts"). A resumed relay's brief has no fake-relay comment, so it takes its
// controls from FAKE_RELAY_CONFIG in the environment the sender passes on.
const HOLD = { FAKE_RELAY_CONFIG: JSON.stringify({ hold: true }) };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const attemptDir = (run, id, n) => path.join(run.dir, 'tasks', id, `attempt-${n}`);
const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const inboxOf = (run, id) => {
  const file = path.join(run.dir, 'tasks', id, 'inbox.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const ready = (f, run, id, n) => eventually(() => fs.existsSync(path.join(attemptDir(run, id, n), 'ready')), `attempt ${n} of ${id} did not start`);

// The events of a Claude turn that started a background command and then ended: `claude -p` stays
// alive until that command ends, and reads nothing meanwhile.
const idleEvents = (command = 'bash tmp/watch.sh') => [
  { type: 'assistant', message: { id: 'm-bg', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command, run_in_background: true } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: b1' }] }, tool_use_result: { backgroundTaskId: 'b1' } },
  { type: 'assistant', message: { id: 'm-end', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Waiting for the watcher.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Waiting for the watcher.', session_id: 'fixture-claude' },
];
const idle = async (f, run, id) => {
  const task = await f.start(run, id, { config: { hold: true, extraEvents: idleEvents() } });
  await f.ready(task);
  return task;
};
// Registers the orch-inbox hook, so that a plain send would claim the message reaches Claude after
// its next tool call; an idle agent must not be told that.
const hookOn = (f) => writeJson(path.join(f.claude, 'settings.json'), { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node orch-inbox.mjs' }] }] } });

for (const agent of ['claude', 'codex']) {
  test(`send --steer resumes a ${agent} agent that is mid-turn but not in a shell command, in its own session`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const first = await f.start(run, 'worker', { agent, config: { hold: true } });
    await f.ready(first);
    const sent = await f.command(['send', run.id, 'worker', 'Use the v2 API now.', '--steer'], { env: HOLD });
    assert.match(sent.stdout, /^delivery: an interrupt resumes the agent's session with this message as its next prompt$/m);
    assert.match(sent.stdout, /^steered: the agent was not in a shell command \(in a model call, or between steps\), so its session was stopped and resumed in attempt 2 \(pid \d+\) with this message as its next prompt$/m);
    assert.ok(!alive(first.pid), 'the first relay was stopped');
    await ready(f, run, 'worker', 2);
    // The same session, agent, tier, model, mode and folder; a new attempt whose reason is `interrupt`.
    const record = readJson(f.taskFile(run, 'worker'));
    assert.deepEqual([record.attempt, record.agent, record.tier, record.model, record.cd, record.readOnly], [2, agent, first.tier, first.model, first.cd, false]);
    assert.equal(record.attemptReasons['2'], 'interrupt');
    const argv = readJson(path.join(attemptDir(run, 'worker', 2), 'invocation.json')).argv;
    assert.deepEqual(argv.slice(argv.indexOf('--session'), argv.indexOf('--session') + 2), ['--session', `fixture-${agent}`]);
    const brief = fs.readFileSync(path.join(attemptDir(run, 'worker', 2), 'orch-brief.md'), 'utf8');
    assert.match(brief, /^## You were interrupted to deliver a message\n/);
    assert.match(brief, /stopped every command you had started in the background/);
    assert.match(brief, /### Message from your orchestrator \([^)]+\), message [0-9a-f]{8}\n\nUse the v2 API now\.\n/);
    // The brief delivered the message, and the task still runs: the stopped attempt is no failure.
    assert.deepEqual((await f.json(['inbox', run.id, 'worker'])).messages, []);
    const row = await rowOf(f, run, 'worker');
    assert.deepEqual([row.state, row.attempt, row.failureCount], ['running', 2, 0]);
    assert.deepEqual(row.attempts.map((a) => [a.n, a.state, a.reason, a.error]), [[2, 'running', 'interrupt', null], [1, 'interrupted', 'first', null]]);
    f.release({ outDir: attemptDir(run, 'worker', 2) });
    assert.equal((await f.finished(run, 'worker')).state, 'completed');
  });
}

test('a task that ended its turn and waits on its own background command reads as idle, and is flagged once a message waits', async (t) => {
  const f = await fixture(t);
  hookOn(f);
  const run = await f.newRun();
  await idle(f, run, 'idler');
  const row = await rowOf(f, run, 'idler');
  assert.equal(row.state, 'running');
  assert.equal(row.idle.background, 'bash tmp/watch.sh');
  assert.match(row.idle.steer, new RegExp(`orch\\.mjs steer ${run.id} idler$`));
  assert.equal(row.now, 'idle: ended its turn and waits on its own background command `bash tmp/watch.sh`');
  assert.match((await f.command(['status', run.id])).stdout, /idle: ended its turn and waits on its own background command/);

  // A plain send stores the message and says it waits, with the commands that deliver it now; `wait`
  // flags the task at once (exit 5), not only once it has been silent for 15 minutes.
  const waited = await f.waitAfterPoll([run.id, '--timeout', '60s'], async () => {
    const sent = await f.command(['send', run.id, 'idler', 'Also update the changelog.']);
    assert.match(sent.stdout, /^delivery: the agent ended its turn and waits on its own background command `bash tmp\/watch\.sh`, so it does not read this message until that wait ends\. Deliver it now with `node \S+ steer \S+ idler`; next time, send with --steer: `node \S+ send \S+ idler "<message>" --steer`$/m);
    assert.doesNotMatch(sent.stdout, /next tool call/);
  }, { code: 5 });
  assert.match(waited.stdout, /idler: unreachable — ended its turn and waits on its own background command `bash tmp\/watch\.sh`, so a message waits unread until that ends; deliver it now with `node \S+ steer \S+ idler`/);
  assert.match(waited.stdout, /\(a task needs attention\)/);
  // `inbox`, run by anyone but the agent itself, says when the agent reads them.
  const inbox = await f.command(['inbox', run.id, 'idler']);
  assert.match(inbox.stdout, /^1 unread message for idler:\nIt ended its turn and waits on its own background command `bash tmp\/watch\.sh`: it will not read them until that ends\. Interrupt it to deliver them now\.\ninterrupt: node \S+ steer \S+ idler\n/);

  // send --steer resumes it with every unread message, and says it was idle.
  const steered = await f.json(['send', run.id, 'idler', 'And bump the version.', '--steer'], { env: HOLD });
  assert.deepEqual([steered.steer.was, steered.steer.resumed], ['idle', 2]);
  assert.match(steered.steer.doing, /^ended its turn and waited on its own background command `bash tmp\/watch\.sh`$/);
  await ready(f, run, 'idler', 2);
  const brief = fs.readFileSync(path.join(attemptDir(run, 'idler', 2), 'orch-brief.md'), 'utf8');
  assert.match(brief, /You had ended your turn and were waiting on your own background command `bash tmp\/watch\.sh`, so nothing would have reached you until that ended\./);
  assert.match(brief, /stopped every command you had started in the background, including `bash tmp\/watch\.sh`/);
  assert.match(brief, /### 1\. Message from your orchestrator[^\n]*\n\nAlso update the changelog\.\n[\s\S]*### 2\. Message from your orchestrator[^\n]*\n\nAnd bump the version\.\n/);
  const after = await rowOf(f, run, 'idler');
  assert.deepEqual([after.state, after.attempt, after.idle, after.inbox.unread], ['running', 2, undefined, 0]);
  f.release({ outDir: attemptDir(run, 'idler', 2) });
  await f.finished(run, 'idler');
});

test('steer pushes queued messages through an idle task by resuming its session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await idle(f, run, 'idler');
  await f.command(['send', run.id, 'idler', 'Check the DAG run.']);
  const steered = await f.command(['steer', run.id, 'idler'], { env: HOLD });
  assert.match(steered.stdout, /^steered: the agent ended its turn and waited on its own background command `bash tmp\/watch\.sh`, so its session was stopped and resumed in attempt 2 \(pid \d+\) with its 1 queued message as its next prompt$/m);
  await ready(f, run, 'idler', 2);
  assert.match(fs.readFileSync(path.join(attemptDir(run, 'idler', 2), 'orch-brief.md'), 'utf8'), /\n\nCheck the DAG run\.\n/);
  f.release({ outDir: attemptDir(run, 'idler', 2) });
  await f.finished(run, 'idler');
});

test('an interrupted attempt sends its parent no finish notice, and the resumed one reports to the same parent at the same depth', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true } });
  await f.ready(lead);
  const as = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'lead' };
  const nested = await f.newRun('nested', as);
  const kid = await f.start(nested, 'kid', { config: { hold: true }, env: as });
  await f.ready(kid);
  const sent = await f.json(['send', nested.id, 'kid', 'Switch to plan B.', '--steer'], { env: { ...as, ...HOLD } });
  assert.equal(sent.steer.resumed, 2);
  assert.equal(sent.by, `${parent.id}/lead`, 'the message records the task that sent it');
  await ready(f, nested, 'kid', 2);
  const record = readJson(f.taskFile(nested, 'kid'));
  assert.deepEqual([record.attemptStartedBy['2'], record.startDepth], [{ run: parent.id, task: 'lead' }, 1]);
  assert.equal(readJson(path.join(attemptDir(nested, 'kid', 2), 'invocation.json')).depth, '2');
  assert.match(readJson(path.join(attemptDir(nested, 'kid', 1), 'parent-notice.json')).skipped, /^interrupted to deliver a message/);
  f.release({ outDir: attemptDir(nested, 'kid', 2) });
  const notices = await eventually(() => {
    const list = inboxOf(parent, 'lead').filter((m) => m.kind === 'finished');
    return list.length ? list : null;
  }, 'the parent got no finish notice', 20_000);
  assert.deepEqual(notices.map((m) => m.about.attempt), [2]);
  f.release(lead);
  await f.finished(parent, 'lead');
});

test('a second interrupt while one holds the task adds its message and starts no second session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'busy', { config: { hold: true } });
  await f.ready(first);
  // Another interrupt holds the attempt: a live claim, as claimInterrupt writes it.
  const claim = path.join(first.outDir, 'interrupt-1.json');
  writeJson(claim, { claimedAt: new Date().toISOString(), owner: { pid: process.pid }, interrupted: 1, by: 'another sender' });
  const sent = await f.json(['send', run.id, 'busy', 'Second thought.', '--steer'], { env: HOLD });
  assert.deepEqual([sent.steer.resuming, sent.steer.busy], [true, true]);
  assert.match(sent.delivery, /^an interrupt is resuming the agent's session/);
  assert.ok(alive(first.pid), 'nothing was stopped');
  assert.equal(readJson(f.taskFile(run, 'busy')).attempt, 1);
  assert.equal(fs.existsSync(path.join(first.outDir, 'interrupt-2.json')), false);
  // Once that claim is released, the next interrupt resumes the session, with both messages.
  writeJson(claim, { ...readJson(claim), released: true });
  const again = await f.json(['send', run.id, 'busy', 'Third thought.', '--steer'], { env: HOLD });
  assert.equal(again.steer.resumed, 2);
  await ready(f, run, 'busy', 2);
  const brief = fs.readFileSync(path.join(attemptDir(run, 'busy', 2), 'orch-brief.md'), 'utf8');
  assert.match(brief, /Second thought\.[\s\S]*Third thought\./);
  f.release({ outDir: attemptDir(run, 'busy', 2) });
  await f.finished(run, 'busy');
});

test('two interrupts sent at once never run two sessions side by side', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'busy', { config: { hold: true } });
  await f.ready(first);
  const sent = await Promise.all(['one', 'two'].map((text) => f.json(['send', run.id, 'busy', text, '--steer'], { env: HOLD })));
  const resumed = sent.map((s) => s.steer.resumed).filter(Boolean);
  const record = readJson(f.taskFile(run, 'busy'));
  // Each interrupt that won resumed its own attempt in turn; one that lost only added its message.
  assert.equal(record.attempt, 1 + resumed.length);
  assert.deepEqual(resumed.sort(), Array.from({ length: resumed.length }, (_, i) => i + 2));
  assert.ok(sent.every((s) => s.steer.resumed || s.steer.busy), JSON.stringify(sent.map((s) => s.steer)));
  assert.ok(resumed.length >= 1 && !alive(first.pid));
  // Every earlier attempt's relay has exited: one session runs.
  for (let n = 2; n < record.attempt; n++) assert.ok(!alive(readJson(path.join(attemptDir(run, 'busy', n - 1), 'interrupt-1.json')).pid));
  await ready(f, run, 'busy', record.attempt);
  f.release({ outDir: attemptDir(run, 'busy', record.attempt) });
  await f.finished(run, 'busy');
  assert.equal(fs.existsSync(attemptDir(run, 'busy', record.attempt + 1)), false);
});

test('while an interrupt resumes the session, the task reads as running, not finished', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'gap', { config: { hold: true } });
  await f.ready(first);
  // The moment between the two relays: the claim is live and the stopped relay has written its result.
  writeJson(path.join(first.outDir, 'interrupt-1.json'), { claimedAt: new Date().toISOString(), owner: { pid: process.pid }, interrupted: 1, was: 'mid-turn' });
  process.kill(first.pid, 'SIGTERM');
  await eventually(() => !alive(first.pid) && fs.existsSync(path.join(first.outDir, 'result.json')), 'the relay did not stop');
  const row = await rowOf(f, run, 'gap');
  assert.deepEqual([row.state, row.result, row.now, row.interrupting.was], ['running', null, 'interrupted to deliver a message: resuming its session', 'mid-turn']);
  // A message sent now is kept for the resume, and `wait` sees nothing finished.
  const sent = await f.json(['send', run.id, 'gap', 'Hold on.']);
  assert.match(sent.delivery, /^an interrupt is resuming the agent's session/);
  await f.command(['wait', run.id, 'gap', '--timeout', '1s'], { code: 3 });
  // Released, the stopped attempt is what it is.
  writeJson(path.join(first.outDir, 'interrupt-1.json'), { released: true });
  assert.equal((await rowOf(f, run, 'gap')).state, 'stopped');
});

test('an interrupt is refused, with the reason and no change, for a command task and a session not known yet', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.command(['start', run.id, 'cmd', '--agent', 'command', '--why', 'A long command', '--', 'sleep', '30']);
  await eventually(async () => (await rowOf(f, run, 'cmd'))?.state === 'running', 'the command did not start');
  const cmd = await f.command(['send', run.id, 'cmd', 'hello', '--steer']);
  assert.match(cmd.stdout, /^not steered: a command task has no session to resume and no agent to read the message$/m);
  assert.equal((await rowOf(f, run, 'cmd')).attempt, 1);

  const fresh = await f.start(run, 'fresh', { config: { hold: true } });
  await f.ready(fresh);
  fs.writeFileSync(path.join(fresh.outDir, 'events.jsonl'), ''); // no init event yet: no session id
  const refused = await f.json(['send', run.id, 'fresh', 'hello', '--steer']);
  assert.deepEqual([refused.steer.refused, refused.steer.waiting], [true, 'its session id is not known yet, so it is not interrupted; it reads the message after its current step']);
  assert.ok(alive(fresh.pid));
  assert.equal(fs.existsSync(path.join(fresh.outDir, 'interrupt-1.json')), false);
  f.release(fresh);
  await f.finished(run, 'fresh');

  // A sandboxed Codex task with the network on: its relay could not resume the session.
  const boxed = await f.start(run, 'boxed', { agent: 'codex', config: { hold: true }, flags: ['--sandbox'] });
  await f.ready(boxed);
  const sandboxed = await f.json(['send', run.id, 'boxed', 'hello', '--steer']);
  assert.deepEqual([sandboxed.steer.refused, sandboxed.steer.waiting], [true, 'its Codex relay cannot resume a sandboxed session with the network on, so it is not interrupted; it reads the message after its current step']);
  assert.ok(alive(boxed.pid));
  f.release(boxed);
  await f.finished(run, 'boxed');
  await f.command(['stop', run.id, 'cmd']);
});

// A fake gh on PATH that serves an open pull request #42, for `start --babysit`.
function github(f) {
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const pr = { number: 42, url: 'https://github.com/example-org/example-repo/pull/42', state: 'OPEN', isDraft: false };
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === 'pr' && a[1] === 'view') console.log(${JSON.stringify(JSON.stringify(pr))});\nelse process.exit(91);\n`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
}

test('an interrupt is refused for a babysitter, running or parked: its park watcher delivers messages', async (t) => {
  const f = await fixture(t);
  github(f);
  const run = await f.newRun();
  const sitter = await f.json(['start', run.id, 'sitter', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Babysits the fixture PR', '--brief', f.brief('sitter', { hold: true })]);
  await f.ready(sitter);
  const running = await f.json(['send', run.id, 'sitter', 'Rebase first.', '--steer']);
  assert.deepEqual([running.steer.refused, running.steer.waiting], [true, "a babysitter's park watcher delivers its messages, so it is not interrupted; it reads the message after its current step"]);
  assert.ok(alive(sitter.pid));
  assert.equal(fs.existsSync(path.join(sitter.outDir, 'interrupt-1.json')), false);
  f.release(sitter);

  const parks = await f.json(['start', run.id, 'parks', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Babysits the fixture PR', '--brief',
    f.brief('parks', { finalMessage: 'PARKED: PR #42 waits for a human review\n\n```orch-result\n{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}\n```' })]);
  await eventually(async () => (await rowOf(f, run, 'parks'))?.phase === 'parked', 'the babysitter did not park', 20_000);
  const parked = await f.json(['send', run.id, 'parks', 'Rebase first.', '--steer']);
  assert.equal(parked.steer.refused, true);
  assert.match(parked.steer.waiting, /^the task is parked: its watcher resumes it with this message within a few seconds/);
  assert.equal(fs.existsSync(path.join(parks.outDir, 'interrupt-1.json')), false);
  await f.command(['stop', run.id, 'parks']);
});
