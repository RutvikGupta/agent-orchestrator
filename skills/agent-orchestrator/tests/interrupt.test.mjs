import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

// The interrupt: `send --steer`, `steer` and the dashboard deliver a message now to an agent that is
// not in a shell command, by stopping its session and resuming the same session with the message
// (steer.mjs, "Interrupts"). A resumed relay's brief has no fake-relay comment, so it takes its
// controls from FAKE_RELAY_CONFIG in the environment the sender passes on.
const HOLD = { FAKE_RELAY_CONFIG: JSON.stringify({ hold: true }) };
const CLI = new URL('../scripts/orch.mjs', import.meta.url).pathname;
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
  assert.match(brief, /You had ended your turn and were waiting on your own background command `bash tmp\/watch\.sh`, so nothing would have reached you until that ended\. It was stopped with the session\./);
  assert.match(brief, /stopped every command you had started in the background/);
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
  // Another interrupt holds the attempt: a live claim, as claimResume writes it.
  const claim = path.join(first.outDir, 'resume-1.json');
  writeJson(claim, { kind: 'interrupt', claimedAt: new Date().toISOString(), owner: { pid: process.pid }, replaces: 1, by: 'another sender' });
  const sent = await f.json(['send', run.id, 'busy', 'Second thought.', '--steer'], { env: HOLD });
  assert.deepEqual([sent.steer.resuming, sent.steer.busy], [true, true]);
  assert.match(sent.delivery, /^an interrupt is resuming the agent's session/);
  assert.ok(alive(first.pid), 'nothing was stopped');
  assert.equal(readJson(f.taskFile(run, 'busy')).attempt, 1);
  assert.equal(fs.existsSync(path.join(first.outDir, 'resume-2.json')), false);
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
  for (let n = 2; n < record.attempt; n++) assert.ok(!alive(readJson(path.join(attemptDir(run, 'busy', n - 1), 'resume-1.json')).pid));
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
  writeJson(path.join(first.outDir, 'resume-1.json'), { kind: 'interrupt', claimedAt: new Date().toISOString(), owner: { pid: process.pid }, replaces: 1, was: 'mid-turn' });
  process.kill(first.pid, 'SIGTERM');
  await eventually(() => !alive(first.pid) && fs.existsSync(path.join(first.outDir, 'result.json')), 'the relay did not stop');
  const row = await rowOf(f, run, 'gap');
  assert.deepEqual([row.state, row.result, row.now, row.interrupting.was], ['running', null, 'interrupted to deliver a message: resuming its session', 'mid-turn']);
  // A message sent now is kept for the resume, and `wait` sees nothing finished.
  const sent = await f.json(['send', run.id, 'gap', 'Hold on.']);
  assert.match(sent.delivery, /^an interrupt is resuming the agent's session/);
  await f.command(['wait', run.id, 'gap', '--timeout', '1s'], { code: 3 });
  // Released, the stopped attempt is what it is.
  writeJson(path.join(first.outDir, 'resume-1.json'), { kind: 'interrupt', released: true });
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
  assert.equal(fs.existsSync(path.join(fresh.outDir, 'resume-1.json')), false);
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

// A fake gh on PATH that serves an open pull request #42: enough for `start --babysit` and for a
// parked babysitter's watcher, which reads the pull request and its review threads.
async function github(f) {
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const pr = { number: 42, url: 'https://github.com/example-org/example-repo/pull/42', title: 'Fixture PR', state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] };
  const threads = { data: { repository: { pullRequest: { reviewThreads: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] } } } } };
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === 'pr' && a[1] === 'view') console.log(${JSON.stringify(JSON.stringify(pr))});\nelse if (a[0] === 'api' && a[1] === 'graphql') console.log(${JSON.stringify(JSON.stringify(threads))});\nelse process.exit(91);\n`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
}
const PARKED = 'PARKED: PR #42 waits for a human review\n\n```orch-result\n{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}\n```';
// Start babysitter `id` of PR #42, whose fake relay ends its first attempt parked, and wait for the park.
async function parkedSitter(f, run, id) {
  const task = await f.json(['start', run.id, id, '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Babysits the fixture PR', '--brief', f.brief(id, { finalMessage: PARKED })]);
  await eventually(async () => (await rowOf(f, run, id))?.phase === 'parked', 'the babysitter did not park', 20_000);
  return task;
}
// The environment that holds one process at one write (fixtures/pause-at-write.cjs), and its marker.
function pauseAt(f, name, { script, sub = '', file, text = '', after = false }) {
  const marker = path.join(f.root, name);
  const preload = new URL('./fixtures/pause-at-write.cjs', import.meta.url).pathname;
  return { marker, env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_PAUSE_SCRIPT: script, TEST_PAUSE_SUB: sub, TEST_PAUSE_FILE: file, TEST_PAUSE_TEXT: text, TEST_PAUSE_AFTER: after ? '1' : '', TEST_PAUSE_MARKER: marker } };
}
// The same for several processes in one test: `rules` maps a name to a pauseAt() rule.
function pauseEach(f, rules) {
  const preload = new URL('./fixtures/pause-at-write.cjs', import.meta.url).pathname;
  const list = Object.entries(rules).map(([name, r]) => ({ sub: '', text: '', after: false, ...r, marker: path.join(f.root, name) }));
  return { markers: Object.fromEntries(list.map((r, i) => [Object.keys(rules)[i], r.marker])), env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_PAUSE_RULES: JSON.stringify(list) } };
}
const paused = (marker) => eventually(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8'), 'the process did not reach the write', 20_000);
const go = (marker) => fs.writeFileSync(`${marker}.release`, '');

test('an interrupt is refused for a babysitter, running or parked: its park watcher delivers messages', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  const sitter = await f.json(['start', run.id, 'sitter', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Babysits the fixture PR', '--brief', f.brief('sitter', { hold: true })]);
  await f.ready(sitter);
  const running = await f.json(['send', run.id, 'sitter', 'Rebase first.', '--steer']);
  assert.deepEqual([running.steer.refused, running.steer.waiting], [true, "a babysitter's park watcher delivers its messages, so it is not interrupted; it reads the message after its current step"]);
  assert.ok(alive(sitter.pid));
  assert.equal(fs.existsSync(path.join(sitter.outDir, 'resume-1.json')), false);
  f.release(sitter);

  const parks = await parkedSitter(f, run, 'parks');
  const parked = await f.json(['send', run.id, 'parks', 'Rebase first.', '--steer']);
  assert.equal(parked.steer.refused, true);
  assert.match(parked.steer.waiting, /^the task is parked: its watcher resumes it with this message within a few seconds/);
  assert.equal(fs.existsSync(path.join(parks.outDir, 'resume-1.json')), false);
  await f.command(['stop', run.id, 'parks']);
});

// Review findings: each test below fails without its fix.

test('a resume keeps every relay option of the attempt it replaces: permission rules and effort too', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = JSON.parse((await f.command(['start', run.id, 'keeper', '--agent', 'claude', '--tier', 'frontier', '--effort', 'medium', '--why', 'Exercises the CLI with a local fake relay',
    '--brief', f.brief('keeper', { hold: true }), '--json', '--', '--deny', 'Bash(curl *)', '--max-turns', '40'])).stdout);
  await f.ready(first);
  const sent = await f.json(['send', run.id, 'keeper', 'Carry on.', '--steer'], { env: HOLD });
  assert.equal(sent.steer.resumed, 2);
  await ready(f, run, 'keeper', 2);
  // The same arguments, but for this attempt's brief and folder, and the session it resumes.
  const argvOf = (n) => readJson(path.join(attemptDir(run, 'keeper', n), 'invocation.json')).argv.map((word) => word.replace(`attempt-${n}`, 'attempt-N'));
  assert.deepEqual(argvOf(2), [...argvOf(1), '--session', 'fixture-claude']);
  assert.ok(argvOf(2).includes('Bash(curl *)'));
  assert.deepEqual(argvOf(2).slice(argvOf(2).indexOf('--effort'), argvOf(2).indexOf('--effort') + 2), ['--effort', 'medium']);
  const record = readJson(f.taskFile(run, 'keeper'));
  assert.deepEqual([record.tier, record.effort, record.model], ['frontier', 'medium', first.model]);
  f.release({ outDir: attemptDir(run, 'keeper', 2) });
  await f.finished(run, 'keeper');
});

// A turn whose first call runs `command` and whose later call reads a file, both still open.
const twoCalls = (command) => ({ type: 'assistant', message: { content: [
  { type: 'tool_use', id: 'toolu_shell', name: 'Bash', input: { command } },
  { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/tmp/notes.md' } },
] } });

test('an interrupt never ends a session while a publishing command of its turn runs, though a later call is open', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'pusher', { config: { hold: true, extraEvents: [twoCalls('git push origin main')] } });
  await f.ready(task);
  const sent = await f.json(['send', run.id, 'pusher', 'Stop and rebase.', '--steer']);
  assert.equal(sent.steer.waiting, 'the agent is running `git push origin main`, which is not stopped part-way');
  assert.ok(alive(task.pid), 'the session was not stopped');
  assert.equal(fs.existsSync(path.join(task.outDir, 'resume-1.json')), false);
  f.release(task);
  await f.finished(run, 'pusher');
});

test('an interrupt stops a shell command of the turn that still runs, though a later call is open, instead of ending the session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const command = 'sleep 61; echo done';
  const task = await f.start(run, 'sleeper', { config: { hold: true, shell: ['/bin/bash', '-c', command], extraEvents: [twoCalls(command)] } });
  await f.ready(task);
  const pid = Number(await eventually(() => fs.existsSync(path.join(task.outDir, 'shell.pid')) && fs.readFileSync(path.join(task.outDir, 'shell.pid'), 'utf8'), 'the shell did not start'));
  const sent = await f.json(['send', run.id, 'sleeper', 'Stop polling.', '--steer']);
  assert.match(sent.steer.stopped, /sleep 61; echo done/);
  await eventually(() => !alive(pid), 'the shell command is still running');
  assert.ok(alive(task.pid), 'the session was not stopped');
  assert.equal(readJson(f.taskFile(run, 'sleeper')).attempt, 1);
  f.release(task);
  await f.finished(run, 'sleeper');
});

test('every resume claims the attempt it replaces: a start never runs beside an interrupt or another start', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'held', { config: { hold: true } });
  await f.ready(first);
  // An interrupt between its two relays: its claim is live, and the relay it stopped has exited.
  const claim = path.join(first.outDir, 'resume-1.json');
  writeJson(claim, { kind: 'interrupt', claimedAt: new Date().toISOString(), owner: { pid: process.pid }, replaces: 1, was: 'mid-turn' });
  process.kill(first.pid, 'SIGTERM');
  await eventually(() => !alive(first.pid) && fs.existsSync(path.join(first.outDir, 'result.json')), 'the relay did not stop');
  const resume = ['start', run.id, 'held', '--agent', 'claude', '--brief', f.brief('again', {}), '--', '--session', 'fixture-claude'];
  const refused = await f.command(resume, { code: 1 });
  assert.match(refused.stderr, /task held is being resumed right now \(an interrupt is delivering a message\)/);
  assert.equal(fs.existsSync(attemptDir(run, 'held', 2)), false);
  // Released, a start resumes it, and claims the attempt while it does.
  writeJson(claim, { ...readJson(claim), released: true });
  await f.command(resume);
  const done = readJson(path.join(first.outDir, 'resume-2.json'));
  assert.deepEqual([done.kind, done.replaces, done.attempt], ['start', 1, 2]);
  await f.finished(run, 'held');
  // A start that holds the next attempt keeps any other start out.
  const held = path.join(attemptDir(run, 'held', 2), 'resume-1.json');
  writeJson(held, { kind: 'start', claimedAt: new Date().toISOString(), owner: { pid: process.pid }, replaces: 2 });
  const busy = await f.command(resume, { code: 1 });
  assert.match(busy.stderr, /task held is being resumed right now \(by `start`\)/);
  assert.equal(fs.existsSync(attemptDir(run, 'held', 3)), false);
  writeJson(held, { ...readJson(held), released: true }); // the claim this test holds, given back
});

test('idle reads only the session\'s own turn: a sub-agent\'s events neither end nor reopen it, and a model request reopens it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const child = (e) => ({ ...e, parent_tool_use_id: 'toolu_task' });
  const subagent = { type: 'assistant', message: { id: 'm-task', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { prompt: 'look around' } }] } };
  const configs = {
    // Mid-turn, with a background command running: a sub-agent's final result does not end the turn.
    working: [...idleEvents().slice(0, 2), subagent,
      child({ type: 'assistant', message: { id: 'm-c1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'found it' }] } }),
      child({ type: 'result', subtype: 'success', is_error: false, result: 'found it', session_id: 'sub' })],
    // Idle: a background sub-agent's events after the turn ended do not reopen it.
    waiting: [...idleEvents(), child({ type: 'assistant', message: { id: 'm-c2', content: [{ type: 'text', text: 'still looking' }] } })],
    // Idle, then the session sends a new model request: its turn is open again.
    reopened: [...idleEvents(), { type: 'api-request' }],
  };
  const tasks = {};
  for (const [id, extraEvents] of Object.entries(configs)) {
    tasks[id] = await f.start(run, id, { config: { hold: true, extraEvents }, flags: ['--read-only'] });
    await f.ready(tasks[id]);
  }
  const rows = (await f.json(['status', run.id])).tasks;
  const idleOf = (id) => rows.find((r) => r.id === id).idle?.background ?? null;
  assert.deepEqual([idleOf('working'), idleOf('waiting'), idleOf('reopened')], [null, 'bash tmp/watch.sh', null]);
  for (const [id, task] of Object.entries(tasks)) {
    f.release(task);
    await f.finished(run, id);
  }
});

test('stop cancels an interrupt between its two relays: the task ends stopped and is not resumed', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'gap', { config: { hold: true } });
  await f.ready(first);
  const marker = path.join(f.root, 'gap-marker');
  const preload = new URL('./fixtures/interrupt-gap.cjs', import.meta.url).pathname;
  const sending = f.command(['send', run.id, 'gap', 'Hello.', '--steer'], { env: { ...HOLD, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_GAP_MARKER: marker } });
  try {
    await eventually(() => fs.existsSync(marker), 'the interrupt did not reach the gap between the relays', 20_000);
    assert.ok(!alive(first.pid), 'the first relay has exited');
    const stopping = f.command(['stop', run.id, 'gap']);
    await eventually(() => readJson(f.taskFile(run, 'gap')).stoppedAt, 'stop did not mark the task');
    fs.writeFileSync(`${marker}.release`, '');
    assert.match((await stopping).stdout, /^stopped gap while an interrupt was resuming its session; it starts no new attempt\n$/);
  } finally {
    fs.writeFileSync(`${marker}.release`, '');
  }
  assert.match((await sending).stdout, /^not steered: the agent .*, and resuming its session failed: task gap was stopped/m);
  const record = readJson(f.taskFile(run, 'gap'));
  assert.equal(record.attempt, 1);
  assert.ok(record.stoppedAt);
  assert.equal(fs.existsSync(attemptDir(run, 'gap', 2)), false);
  assert.equal((await rowOf(f, run, 'gap')).state, 'stopped');
});

// A nested task `kid`, interrupted and held between its two relays (fixtures/interrupt-gap.cjs) until
// its finish watcher, which reports through fixtures/notice-wait.cjs, has run once its relay was gone:
// it found the notice taken and the helper alive, and waits (`waits`), or it exited. The sender is
// started here, so that a test can end it by its PID. `extra` goes into the watcher's environment.
async function heldInterrupt(f, t, extra = {}) {
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true } });
  await f.ready(lead);
  const as = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'lead' };
  const nested = await f.newRun('nested', as);
  const watch = path.join(f.root, 'notice-marker');
  const waiter = new URL('./fixtures/notice-wait.cjs', import.meta.url).pathname;
  const watcherEnv = { NODE_OPTIONS: `--require=${JSON.stringify(waiter)}`, TEST_NOTICE_MARKER: watch, ...extra };
  const kid = await f.start(nested, 'kid', { config: { hold: true }, env: { ...as, ...watcherEnv } });
  await f.ready(kid);
  const gap = path.join(f.root, 'gap-marker');
  const preload = new URL('./fixtures/interrupt-gap.cjs', import.meta.url).pathname;
  const sender = spawn(process.execPath, [CLI, 'send', nested.id, 'kid', 'Switch to plan B.', '--steer'], {
    cwd: f.repo, env: { ...f.env, ...as, ...HOLD, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_GAP_MARKER: gap }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  sender.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
  const sent = new Promise((resolve) => sender.on('close', (code, signal) => resolve({ code, signal, stdout })));
  const release = () => fs.writeFileSync(`${gap}.release`, '');
  // On a failure the helper is released and the sender ended here: the fixture's cleanup, which runs
  // first, waits for the finish watcher, and that waits for the helper.
  const abort = async () => {
    release();
    if (sender.exitCode === null && sender.signalCode === null) sender.kill('SIGKILL');
    await sent;
  };
  t.after(() => sent); // the sender is ended by then: it waits at most 45 seconds
  try {
    await eventually(() => fs.existsSync(gap), 'the interrupt did not reach the gap between the relays', 20_000);
    assert.ok(!alive(kid.pid), 'the first relay has exited');
    await eventually(() => fs.existsSync(watch) || fs.existsSync(`${watch}.exit`), 'the finish watcher did not run', 20_000);
  } catch (error) {
    await abort();
    throw error;
  }
  const notices = () => inboxOf(parent, 'lead').filter((m) => m.kind === 'finished');
  return { parent, lead, nested, kid, watcherEnv, sender, sent, release, abort, notices, waits: fs.existsSync(watch), exited: () => fs.existsSync(`${watch}.exit`) };
}

// Kill the held interrupt's helper, as a crash would, after it stopped the first relay and before
// it started the next one.
async function killHelper(held) {
  const resume = readJson(path.join(attemptDir(held.nested, 'kid', 1), 'resume-1.json'));
  try {
    assert.equal(resume.stopped, true);
    // The sender stops waiting first, as one that timed out does: a dead helper whose sender still
    // runs stays a zombie, which counts as running, until the sender ends.
    held.sender.kill('SIGKILL');
    await held.sent;
    assert.match(spawnSync('ps', ['-o', 'command=', '-p', String(resume.helper)], { encoding: 'utf8' }).stdout, /steer\.mjs resume /);
    process.kill(resume.helper, 'SIGKILL');
  } catch (error) {
    await held.abort();
    throw error;
  }
}

test('an interrupt whose helper dies between the two relays leaves its parent one finish notice for the stopped attempt', async (t) => {
  const f = await fixture(t);
  const held = await heldInterrupt(f, t);
  const { parent, lead, nested } = held;
  await killHelper(held);
  const notices = await eventually(() => (held.notices().length ? held.notices() : null), 'the parent got no finish notice', 20_000);
  // The watcher had seen the helper alive at its first check, and waited on it instead of giving up.
  assert.ok(held.waits, 'the finish watcher found the notice taken and gave up');
  await eventually(held.exited, 'the finish watcher did not exit', 20_000);
  assert.deepEqual(held.notices().map((m) => m.about), [{ run: nested.id, task: 'kid', attempt: 1 }], 'exactly one notice, for the stopped attempt');
  assert.equal(notices[0].from, `agent:${nested.id}/kid`);
  const claim = readJson(path.join(attemptDir(nested, 'kid', 1), 'parent-notice.json'));
  assert.deepEqual([claim.to, claim.message, claim.skipped], [`${parent.id}/lead`, notices[0].id, undefined]);
  assert.match(claim.recovered, /interrupt/);
  assert.equal(readJson(f.taskFile(nested, 'kid')).attempt, 1);
  assert.equal(fs.existsSync(attemptDir(nested, 'kid', 2)), false);
  f.release(lead);
  await f.finished(parent, 'lead');
});

test('watchers that take over the notice a dead interrupt left, at the same moment, send it once', async (t) => {
  const f = await fixture(t);
  const barrier = path.join(f.root, 'barrier');
  fs.mkdirSync(barrier);
  const held = await heldInterrupt(f, t, { TEST_NOTICE_BARRIER: barrier });
  const { parent, lead, nested } = held;
  const go = () => fs.writeFileSync(path.join(barrier, 'go'), '');
  t.after(() => fs.existsSync(barrier) && go());
  await killHelper(held);
  // Two more runs of the attempt's watcher (finish-notice.mjs, run directly) besides its own: each
  // finds the helper gone and the notice still taken, and stops at the barrier before taking it over.
  const script = new URL('../scripts/lib/finish-notice.mjs', import.meta.url).pathname;
  const others = [1, 2].map(() => {
    const child = spawn(process.execPath, [script, nested.dir, 'kid', '1', String(held.kid.pid), 'Thu Jan  1 00:00:00 1970'], { cwd: nested.dir, env: { ...f.env, ...held.watcherEnv }, stdio: 'ignore' });
    return new Promise((resolve) => child.on('close', (code) => resolve(code)));
  });
  try {
    await eventually(() => fs.readdirSync(barrier).length === 3, 'three watchers did not reach the takeover', 20_000);
  } finally {
    go();
  }
  assert.deepEqual(await Promise.all(others), [0, 0]);
  const waiting = fs.readdirSync(barrier).filter((name) => /^\d+$/.test(name)).map(Number);
  await eventually(() => waiting.every((pid) => !alive(pid)), 'a watcher did not exit', 20_000);
  assert.deepEqual(held.notices().map((m) => m.about), [{ run: nested.id, task: 'kid', attempt: 1 }], 'exactly one notice');
  const claim = readJson(path.join(attemptDir(nested, 'kid', 1), 'parent-notice.json'));
  assert.deepEqual([claim.to, claim.message], [`${parent.id}/lead`, held.notices()[0].id]);
  assert.equal(readJson(path.join(attemptDir(nested, 'kid', 1), 'parent-notice-recovery.json')).generation, 1);
  f.release(lead);
  await f.finished(parent, 'lead');
});

test('a finish watcher that waits on an interrupt\'s helper sends nothing once the helper resumes the session', async (t) => {
  const f = await fixture(t);
  const held = await heldInterrupt(f, t);
  const { parent, lead, nested } = held;
  held.release();
  const sent = await held.sent;
  assert.equal(sent.code, 0);
  assert.match(sent.stdout, /^steered: .* resumed in attempt 2 /m);
  await eventually(held.exited, 'the finish watcher did not exit', 20_000);
  assert.deepEqual(held.notices(), [], 'the interrupted attempt sends no notice');
  assert.match(readJson(path.join(attemptDir(nested, 'kid', 1), 'parent-notice.json')).skipped, /^interrupted to deliver a message/);
  await ready(f, nested, 'kid', 2);
  f.release({ outDir: attemptDir(nested, 'kid', 2) });
  await eventually(() => (held.notices().length ? held.notices() : null), 'the parent got no finish notice', 20_000);
  assert.deepEqual(held.notices().map((m) => m.about.attempt), [2]);
  f.release(lead);
  await f.finished(parent, 'lead');
});

test('message text is data: a message that reads like a template marker resumes the session and reaches it as written', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'templated', { config: { hold: true } });
  await f.ready(first);
  const text = 'Replace <fill in: description> in the template.';
  const sent = await f.json(['send', run.id, 'templated', text, '--steer'], { env: HOLD });
  assert.equal(sent.steer.resumed, 2);
  await ready(f, run, 'templated', 2);
  assert.ok(fs.readFileSync(path.join(attemptDir(run, 'templated', 2), 'orch-brief.md'), 'utf8').includes(`\n\n${text}\n`));
  f.release({ outDir: attemptDir(run, 'templated', 2) });
  await f.finished(run, 'templated');
});

test('an interrupt checks the resume before it stops anything: one that cannot start leaves the session running', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const cd = path.join(f.root, 'gone');
  fs.mkdirSync(cd);
  const task = await f.start(run, 'homeless', { config: { hold: true }, flags: ['--cd', cd] });
  await f.ready(task);
  fs.rmSync(cd, { recursive: true });
  const sent = await f.command(['send', run.id, 'homeless', 'hello', '--steer']);
  assert.match(sent.stdout, /^not steered: its session cannot be resumed \(--cd does not exist: \S+gone\), so it was not stopped; the message stays unread$/m);
  assert.ok(alive(task.pid), 'the session runs on');
  assert.equal(readJson(f.taskFile(run, 'homeless')).attempt, 1);
  f.release(task);
  await f.finished(run, 'homeless');
});

// Second review: each test below fails without its fix.

test('an interrupt looks again just before it stops the session: a publishing command that started meanwhile is not ended', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'late', { config: { hold: true } });
  await f.ready(task);
  // Hold the helper after the sender planned the resume and before its last look.
  const hold = pauseAt(f, 'late-marker', { script: 'steer\\.mjs$', sub: 'resume', file: 'interrupt-resume\\.md$' });
  const sending = f.command(['send', run.id, 'late', 'Stop and rebase.', '--steer'], { env: { ...HOLD, ...hold.env } });
  try {
    await paused(hold.marker);
    fs.appendFileSync(path.join(task.outDir, 'events.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_push', name: 'Bash', input: { command: 'git push origin main' } }] } })}\n`);
  } finally {
    go(hold.marker);
  }
  assert.match((await sending).stdout, /^not steered: its session cannot be resumed \(the agent is running `git push origin main`, which is not stopped part-way\), so it was not stopped; the message stays unread$/m);
  assert.ok(alive(task.pid), 'the session was not stopped');
  assert.equal(readJson(f.taskFile(run, 'late')).attempt, 1);
  assert.equal(fs.existsSync(path.join(task.outDir, 'parent-notice.json')), false, 'the attempt still sends its finish notice');
  f.release(task);
  await f.finished(run, 'late');
});

test('the session an interrupt resumes is the task\'s own, never a sub-agent\'s', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const events = [
    { type: 'assistant', message: { id: 'm-task', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { prompt: 'look around' } }] } },
    { type: 'system', subtype: 'init', session_id: 'child-session', parent_tool_use_id: 'toolu_task' },
    { type: 'result', subtype: 'success', is_error: false, result: 'found it', session_id: 'child-session', parent_tool_use_id: 'toolu_task' },
  ];
  const task = await f.start(run, 'parent', { config: { hold: true, extraEvents: events } });
  await f.ready(task);
  assert.equal((await rowOf(f, run, 'parent')).session, 'fixture-claude');
  const sent = await f.json(['send', run.id, 'parent', 'Carry on.', '--steer'], { env: HOLD });
  assert.equal(sent.steer.resumed, 2);
  await ready(f, run, 'parent', 2);
  const argv = readJson(path.join(attemptDir(run, 'parent', 2), 'invocation.json')).argv;
  assert.equal(argv[argv.indexOf('--session') + 1], 'fixture-claude');
  f.release({ outDir: attemptDir(run, 'parent', 2) });
  await f.finished(run, 'parent');
});

test('the helper owns the interrupt\'s claim once it takes over, and a dead owner\'s claim is taken over', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'owned', { config: { hold: true } });
  await f.ready(first);
  const sent = await f.json(['send', run.id, 'owned', 'One.', '--steer'], { env: HOLD });
  assert.equal(sent.steer.resumed, 2);
  // The claim names the helper as its owner, not the sender that started it and has exited.
  const claim = readJson(path.join(first.outDir, 'resume-1.json'));
  assert.ok(Number.isInteger(claim.helper) && claim.helper > 0);
  assert.equal(claim.owner.pid, claim.helper);
  await ready(f, run, 'owned', 2);
  // A claim whose owner has ended without saving anything is abandoned: the next interrupt takes it over.
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  writeJson(path.join(attemptDir(run, 'owned', 2), 'resume-1.json'), { kind: 'interrupt', claimedAt: new Date().toISOString(), owner: { pid: gone }, helper: gone, replaces: 2 });
  const again = await f.json(['send', run.id, 'owned', 'Two.', '--steer'], { env: HOLD });
  assert.equal(again.steer.resumed, 3);
  assert.equal(readJson(path.join(attemptDir(run, 'owned', 2), 'resume-2.json')).attempt, 3);
  await ready(f, run, 'owned', 3);
  f.release({ outDir: attemptDir(run, 'owned', 3) });
  await f.finished(run, 'owned');
});

test('a stop that comes after a parked task\'s watcher claimed its resume wins: the watcher starts nothing', async (t) => {
  const f = await fixture(t);
  await github(f);
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  // Hold the watcher's check after it claimed the park and before it starts the next attempt. Every
  // command of this test carries the hold, whichever of them starts the watcher.
  const hold = pauseAt(f, 'park-marker', { script: 'park\\.mjs$', sub: 'check', file: 'park-resume\\.md$' });
  Object.assign(f.env, hold.env);
  const run = await f.newRun();
  const task = await parkedSitter(f, run, 'sitter');
  await f.command(['send', run.id, 'sitter', 'Rebase first.']);
  let stopping;
  try {
    await paused(hold.marker);
    assert.equal(readJson(path.join(task.outDir, 'park-claim-1.json')).by, 'watcher');
    stopping = f.command(['stop', run.id, 'sitter']);
    await eventually(() => readJson(f.taskFile(run, 'sitter')).stoppedAt, 'stop did not mark the task');
  } finally {
    go(hold.marker);
  }
  assert.match((await stopping).stdout, /^stopped parked sitter/);
  const record = readJson(f.taskFile(run, 'sitter'));
  assert.equal(record.attempt, 1);
  assert.ok(record.stoppedAt);
  assert.equal(fs.existsSync(attemptDir(run, 'sitter', 2)), false, 'the watcher started nothing');
  assert.deepEqual(readJson(path.join(task.outDir, 'park-claim-1.json')).since, { closedAt: null, stoppedAt: null });
});

// A `start` that resumes `id` and is killed after it started its relay and before it saved the
// task. Returns that relay's PID.
async function orphaned(f, run, id, name) {
  const hold = pauseAt(f, name, { script: 'orch\\.mjs$', sub: 'start', file: 'resume-\\d+\\.json$', text: '"relay"', after: true });
  const starting = f.command(['start', run.id, id, '--agent', 'claude', '--brief', f.brief(`${id}-again`, { hold: true }), '--', '--session', 'fixture-claude'], { code: null, env: hold.env });
  const starter = Number(await paused(hold.marker));
  process.kill(starter, 'SIGKILL');
  await starting;
  const relay = readJson(path.join(attemptDir(run, id, 1), 'resume-1.json')).relay.pid;
  assert.ok(alive(relay), 'the relay runs on');
  assert.equal(readJson(f.taskFile(run, id)).attempt, 1, 'the task was never saved');
  return relay;
}

test('a relay left by a start that died before saving the task is adopted by the next start, and stopped by stop', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const id of ['one', 'two']) {
    await f.start(run, id, { flags: ['--read-only'] });
    await f.finished(run, id);
  }
  // The next start adopts the relay as the task's attempt, and starts nothing new.
  const relay = await orphaned(f, run, 'one', 'orphan-one');
  const again = await f.command(['start', run.id, 'one', '--agent', 'claude', '--brief', f.brief('one-third', {}), '--', '--session', 'fixture-claude'], { code: 1 });
  assert.match(again.stderr, new RegExp(`task one's earlier resume ended after starting its relay \\(pid ${relay}\\), which still runs: it is now attempt 2, so nothing new was started`));
  assert.deepEqual([readJson(f.taskFile(run, 'one')).attempt, readJson(f.taskFile(run, 'one')).pid], [2, relay]);
  assert.equal((await rowOf(f, run, 'one')).state, 'running');
  assert.equal(fs.existsSync(attemptDir(run, 'one', 3)), false);
  await f.command(['stop', run.id, 'one']);
  await eventually(() => !alive(relay), 'the adopted relay was not stopped');
  // `stop` adopts it too, and stops it.
  const other = await orphaned(f, run, 'two', 'orphan-two');
  const stopped = await f.command(['stop', run.id, 'two']);
  assert.match(stopped.stdout, new RegExp(`^stopped two \\(pid ${other}\\)`));
  await eventually(() => !alive(other), 'the orphaned relay was not stopped');
  assert.deepEqual([readJson(f.taskFile(run, 'two')).attempt, Boolean(readJson(f.taskFile(run, 'two')).stoppedAt)], [2, true]);
});

test('a command start of a parked task takes the park\'s claim, as every start does', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  const task = await parkedSitter(f, run, 'sitter');
  // The watcher holds the park: it is resuming the task.
  const claim = path.join(task.outDir, 'park-claim-1.json');
  writeJson(claim, { by: 'watcher', claimedAt: new Date().toISOString(), owner: { pid: process.pid } });
  const refused = await f.command(['start', run.id, 'sitter', '--agent', 'command', '--why', 'Runs a command in its place', '--', 'sleep', '30'], { code: 1 });
  assert.match(refused.stderr, /task sitter is parked, and its watcher is resuming it right now/);
  assert.equal(readJson(f.taskFile(run, 'sitter')).attempt, 1);
  assert.equal(fs.existsSync(attemptDir(run, 'sitter', 2)), false);
  writeJson(claim, { ...readJson(claim), released: true }); // the claim this test holds, given back
  await f.command(['stop', run.id, 'sitter']);
});

test('a parked task\'s watcher delivers a message that reads like a template marker, as written', async (t) => {
  const f = await fixture(t);
  await github(f);
  Object.assign(f.env, { AGENT_ORCH_PARK_INTERVAL: '1s', ...HOLD });
  const run = await f.newRun();
  await parkedSitter(f, run, 'sitter');
  const text = 'Replace <fill in: description> in the template.';
  await f.command(['send', run.id, 'sitter', text]);
  await eventually(() => readJson(f.taskFile(run, 'sitter')).attempt === 2, 'the watcher did not resume the task', 20_000);
  await ready(f, run, 'sitter', 2);
  const brief = fs.readFileSync(path.join(attemptDir(run, 'sitter', 2), 'orch-brief.md'), 'utf8');
  assert.ok(brief.includes(`## The messages, quoted\n\n- Message from your orchestrator`) && brief.includes(`\n    > ${text}\n`));
  assert.ok(fs.readFileSync(path.join(attemptDir(run, 'sitter', 2), 'park-messages.md'), 'utf8').includes(text));
  await f.command(['stop', run.id, 'sitter']);
});

// Third review: each test below fails without its fix.

test('a publishing command that a sub-agent still runs holds an interrupt back, also once the session ended its turn', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  // A background sub-agent started a shell command; then the session ended its turn and waits.
  const childCall = (command) => [
    { type: 'assistant', message: { id: 'm-task', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { prompt: 'publish it', run_in_background: true } }] } },
    { type: 'assistant', parent_tool_use_id: 'toolu_task', message: { id: 'm-child', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command } }] } },
    ...idleEvents(),
  ];
  const pushing = await f.start(run, 'pushing', { config: { hold: true, extraEvents: childCall('git push origin main') }, flags: ['--read-only'] });
  await f.ready(pushing);
  assert.equal((await rowOf(f, run, 'pushing')).idle.background, 'bash tmp/watch.sh');
  const sent = await f.json(['send', run.id, 'pushing', 'Stop and rebase.', '--steer']);
  assert.equal(sent.steer.waiting, 'the agent is running `git push origin main`, which is not stopped part-way');
  assert.ok(alive(pushing.pid), 'the session was not stopped');
  assert.equal(fs.existsSync(path.join(pushing.outDir, 'resume-1.json')), false);
  f.release(pushing);
  await f.finished(run, 'pushing');
  // Any other command of a background sub-agent is background work: the idle session is resumed.
  const polling = await f.start(run, 'polling', { config: { hold: true, extraEvents: childCall('sleep 61') }, flags: ['--read-only'] });
  await f.ready(polling);
  const resumed = await f.json(['send', run.id, 'polling', 'Wake up.', '--steer'], { env: HOLD });
  assert.deepEqual([resumed.steer.was, resumed.steer.resumed], ['idle', 2]);
  await ready(f, run, 'polling', 2);
  f.release({ outDir: attemptDir(run, 'polling', 2) });
  await f.finished(run, 'polling');
});

test('the sender hands its claim to the helper without touching the helper\'s record, whichever of them writes first', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'handed', { config: { hold: true } });
  await f.ready(first);
  // Hold the sender just before any write of the claim after it started the helper, and the helper
  // just after it recorded itself in the claim: the order in which a sender could undo that record.
  const hold = pauseEach(f, {
    sender: { script: 'orch\\.mjs$', sub: 'send', file: 'resume-\\d+\\.json$' },
    helper: { script: 'steer\\.mjs$', sub: 'resume', file: 'resume-\\d+\\.json$', text: '"helper"', after: true },
  });
  const claim = path.join(first.outDir, 'resume-1.json'), handoff = path.join(first.outDir, 'resume-1.handoff.json');
  const sending = f.command(['send', run.id, 'handed', 'Carry on.', '--steer'], { env: { ...HOLD, ...hold.env } });
  try {
    const helper = Number(await paused(hold.markers.helper));
    assert.equal(readJson(claim).helper, helper);
    go(hold.markers.sender);
    // The sender's handoff is done once its own file names the helper; a sender that rewrote the
    // claim instead has dropped what the helper recorded.
    await eventually(() => fs.existsSync(handoff) || !readJson(claim)?.helper, 'the sender did not hand the claim over');
    assert.deepEqual([fs.existsSync(handoff) ? readJson(handoff).pid : null, readJson(claim).helper], [helper, helper], 'the helper\'s record stands, and the handoff names it');
  } finally {
    go(hold.markers.sender);
    go(hold.markers.helper);
  }
  assert.match((await sending).stdout, /so its session was stopped and resumed in attempt 2 /);
  await ready(f, run, 'handed', 2);
  f.release({ outDir: attemptDir(run, 'handed', 2) });
  await f.finished(run, 'handed');
});

test('an adopter that ends before it saves the task leaves a claim the next one can still adopt and stop', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'twice', { flags: ['--read-only'] });
  await f.finished(run, 'twice');
  const relay = await orphaned(f, run, 'twice', 'orphan-twice');
  // A stop adopts the relay, and is killed before it saves the task.
  const hold = pauseAt(f, 'adopter', { script: 'orch\\.mjs$', sub: 'stop', file: 'tasks/twice/task\\.json$' });
  const stopping = f.command(['stop', run.id, 'twice'], { code: null, env: hold.env });
  const adopter = Number(await paused(hold.marker));
  const adoption = readJson(path.join(attemptDir(run, 'twice', 1), 'resume-2.json'));
  assert.deepEqual([adoption.kind, adoption.relay.pid, adoption.task.attempt, adoption.since], ['adopt', relay, 2, { closedAt: null, stoppedAt: null }]);
  process.kill(adopter, 'SIGKILL');
  await stopping;
  assert.equal(readJson(f.taskFile(run, 'twice')).attempt, 1, 'the task was never saved');
  assert.ok(alive(relay), 'the relay runs on');
  // The next stop adopts it from that claim, and stops it.
  const stopped = await f.command(['stop', run.id, 'twice']);
  assert.match(stopped.stdout, new RegExp(`^stopped twice \\(pid ${relay}\\)`));
  await eventually(() => !alive(relay), 'the relay was not stopped');
  assert.deepEqual([readJson(f.taskFile(run, 'twice')).attempt, readJson(path.join(attemptDir(run, 'twice', 1), 'resume-3.json')).adopted], [2, true]);
});

for (const publishing of [false, true]) {
  test(`a child shell started after the parent turn ends ${publishing ? 'still protects publishing' : 'resumes the idle parent with its message'}`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const command = publishing ? 'sleep 61; git push origin topic' : 'sleep 61; echo done';
    const child = { type: 'assistant', parent_tool_use_id: 'toolu_task', message: { id: 'm-child-late', content: [{ type: 'tool_use', id: 'toolu_child_late', name: 'Bash', input: { command } }] } };
    const first = await f.start(run, 'late-child', { config: { hold: true, shell: ['/bin/bash', '-c', command], extraEvents: [...idleEvents(), child] } });
    await f.ready(first);
    const shell = Number(fs.readFileSync(path.join(first.outDir, 'shell.pid'), 'utf8'));
    assert.ok(alive(shell));
    assert.ok((await rowOf(f, run, 'late-child')).idle);
    const sent = await f.json(['send', run.id, 'late-child', 'Handle this now.', '--steer'], { env: HOLD });
    assert.equal(sent.steer.stopped, undefined, 'stopping a child shell does not deliver to its idle parent');
    if (publishing) {
      assert.match(sent.steer.waiting, /not stopped part-way/);
      assert.ok(alive(first.pid) && alive(shell));
      assert.equal(readJson(f.taskFile(run, 'late-child')).attempt, 1);
      assert.equal((await f.json(['inbox', run.id, 'late-child'])).messages.length, 1);
      await f.command(['stop', run.id, 'late-child']);
    } else {
      assert.deepEqual([sent.steer.was, sent.steer.resumed], ['idle', 2]);
      await ready(f, run, 'late-child', 2);
      assert.ok(!alive(first.pid));
      assert.match(fs.readFileSync(path.join(attemptDir(run, 'late-child', 2), 'orch-brief.md'), 'utf8'), /Handle this now\./);
      assert.deepEqual((await f.json(['inbox', run.id, 'late-child'])).messages, []);
      f.release({ outDir: attemptDir(run, 'late-child', 2) });
      await f.finished(run, 'late-child');
    }
  });
}

for (const publishing of [false, true]) {
  test(`the delivery line ${publishing ? 'offers no interrupt while a publishing command would hold it back' : 'offers the interrupt for an idle task'}`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const command = publishing ? 'sleep 61; git push origin topic' : 'sleep 61; echo done';
    const child = { type: 'assistant', parent_tool_use_id: 'toolu_task', message: { id: 'm-child-held', content: [{ type: 'tool_use', id: 'toolu_child_held', name: 'Bash', input: { command } }] } };
    const task = await f.start(run, 'held', { config: { hold: true, shell: ['/bin/bash', '-c', command], extraEvents: [...idleEvents(), child] } });
    await f.ready(task);
    const sent = await f.command(['send', run.id, 'held', 'Read this when you can.']);
    const { delivery } = (await rowOf(f, run, 'held')).inbox;
    const listed = await f.command(['inbox', run.id, 'held']);
    if (publishing) {
      assert.match(delivery.held, /git push origin topic/);
      assert.equal(delivery.steer, undefined);
      for (const text of [delivery.text, sent.stdout, listed.stdout]) {
        assert.match(text, /An interrupt waits too: `sleep 61; git push origin topic` is not stopped part-way/);
        assert.doesNotMatch(text, /Interrupt it to deliver|Deliver it now|steer /);
      }
    } else {
      assert.equal(delivery.held, undefined);
      assert.match(delivery.steer, / steer /);
      assert.match(delivery.text, /Interrupt it to deliver them now\./);
      assert.match(sent.stdout, /Deliver it now with/);
    }
    await f.command(['stop', run.id, 'held']);
  });
}

// A parent that waits only for its background Task: no background Bash command makes it idle.
const childOnlyEvents = () => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { prompt: 'look around', run_in_background: true } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'Agent running in background.' }] } },
  { type: 'result', subtype: 'success', result: 'Waiting for the agent.', session_id: 'fixture-claude' },
];
const childShell = (command, id = 'toolu_late') => ({ type: 'assistant', parent_tool_use_id: 'toolu_task', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const appendFresh = (task, events) => {
  const file = path.join(task.outDir, 'events.jsonl');
  fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  // Exclude the quiet-file grace period even on a loaded host: only the parent's turn and the
  // child's open call may decide the state. No sleep is needed to arrange this interleaving.
  const fresh = new Date(Date.now() + 60_000);
  fs.utimesSync(file, fresh, fresh);
};

test('a parent idle on a background sub-agent stays idle between two of the sub-agent\'s calls', async (t) => {
  const f = await fixture(t);
  hookOn(f);
  const run = await f.newRun();
  const task = await f.start(run, 'between-calls', { config: { hold: true, extraEvents: childOnlyEvents() } });
  await f.ready(task);
  // The sub-agent ran a Read and got its result: no call is open, and the log was just written.
  appendFresh(task, [
    { type: 'assistant', parent_tool_use_id: 'toolu_task', message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.txt' } }] } },
    { type: 'user', parent_tool_use_id: 'toolu_task', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }] } },
  ]);
  assert.ok((await rowOf(f, run, 'between-calls')).idle, 'idle though no child call is open');
  const sent = await f.command(['send', run.id, 'between-calls', 'Read this.']);
  assert.doesNotMatch(sent.stdout, /after its next tool call/);
  assert.match(sent.stdout, /--steer/);
  await f.command(['stop', run.id, 'between-calls']);
});

for (const lastLook of [false, true]) {
  for (const publishing of [false, true]) {
    test(`a background Task alone keeps its late child shell in the background at ${lastLook ? 'the helper last look' : 'the first plan'}${publishing ? ', protecting publishing' : ''}`, async (t) => {
      const f = await fixture(t);
      hookOn(f);
      const run = await f.newRun();
      const command = publishing ? 'sleep 61; git push origin topic' : 'sleep 61; echo done';
      const task = await f.start(run, 'child-only', { config: { hold: true, shell: ['/bin/bash', '-c', command], extraEvents: childOnlyEvents() } });
      await f.ready(task);
      const shell = Number(fs.readFileSync(path.join(task.outDir, 'shell.pid'), 'utf8'));
      await f.command(['send', run.id, 'child-only', 'Queued before the child call.']);
      const hold = lastLook ? pauseAt(f, 'child-last-look', { script: 'steer\\.mjs$', sub: 'resume', file: 'interrupt-resume\\.md$' }) : null;
      let sending, before, inbox;
      if (lastLook) sending = f.json(['send', run.id, 'child-only', 'Handle this now.', '--steer'], { env: { ...HOLD, ...hold.env } });
      try {
        if (hold) await paused(hold.marker);
        appendFresh(task, [childShell(command)]);
        before = await rowOf(f, run, 'child-only');
        inbox = await f.command(['inbox', run.id, 'child-only']);
      } finally {
        if (hold) go(hold.marker);
      }
      if (!sending) sending = f.json(['send', run.id, 'child-only', 'Handle this now.', '--steer'], { env: HOLD });
      const sent = await sending;
      assert.equal(before.shell, undefined, 'a child call cannot be the ended parent turn\'s foreground shell');
      assert.ok(before.idle, 'an open child call is background work without a parent Bash command');
      assert.equal(before.inbox.delivery.how, 'idle');
      assert.doesNotMatch(inbox.stdout, /when its current shell command ends/);
      assert.match(inbox.stdout, /ended its turn and waits on its own background work/);
      assert.equal(sent.steer.stopped, undefined, 'stopping the child cannot deliver a message to its parent');
      if (publishing) {
        assert.match(sent.steer.waiting || sent.steer.failed, /not stopped part-way/);
        assert.ok(alive(task.pid) && alive(shell));
        assert.equal(readJson(f.taskFile(run, 'child-only')).attempt, 1);
        await f.command(['stop', run.id, 'child-only']);
      } else {
        assert.equal(sent.steer.resumed, 2);
        await ready(f, run, 'child-only', 2);
        assert.ok(!alive(task.pid));
        const brief = fs.readFileSync(path.join(attemptDir(run, 'child-only', 2), 'orch-brief.md'), 'utf8');
        assert.match(brief, /Queued before the child call\.[\s\S]*Handle this now\./);
        assert.deepEqual((await f.json(['inbox', run.id, 'child-only'])).messages, []);
        f.release({ outDir: attemptDir(run, 'child-only', 2) });
        await f.finished(run, 'child-only');
      }
    });
  }
}

for (const wake of [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Continuing.' }] } },
  { type: 'user', message: { content: [{ type: 'text', text: 'Continue.' }] } },
  { type: 'system', subtype: 'task_notification' },
  { type: 'api-request' },
]) {
  test(`a background Task's new child call is foreground again after the parent's ${wake.subtype || wake.type}`, async (t) => {
    const f = await fixture(t);
    hookOn(f);
    const run = await f.newRun();
    const command = 'sleep 61; echo done';
    const task = await f.start(run, 'new-turn', { config: { hold: true, shell: ['/bin/bash', '-c', command], extraEvents: childOnlyEvents() } });
    await f.ready(task);
    appendFresh(task, [childShell('sleep 62; echo old')]);
    assert.equal((await rowOf(f, run, 'new-turn')).shell, undefined, 'the first child call belongs to the ended turn');
    appendFresh(task, [wake, childShell(command, 'toolu_next')]);
    await f.command(['send', run.id, 'new-turn', 'Handle this in the new turn.']);
    const row = await rowOf(f, run, 'new-turn');
    assert.equal(row.idle, undefined);
    assert.equal(row.shell, command);
    assert.equal(row.inbox.delivery.how, 'shell');
    const sent = await f.json(['steer', run.id, 'new-turn']);
    assert.equal(sent.steer.stopped, command, 'a new foreground call returns to an active parent turn');
    assert.equal(readJson(f.taskFile(run, 'new-turn')).attempt, 1);
    f.release(task);
    await f.finished(run, 'new-turn');
  });
}

test('the interrupt notice documentation distinguishes starting a replacement relay from saving its attempt', () => {
  const doc = fs.readFileSync(new URL('../references/messages.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(doc, /helper dies without starting a replacement relay, the stopped attempt sends its finish notice after all/);
  assert.match(doc, /If it already started a relay, the notice stays suppressed until that relay is adopted and the adopted attempt ends/);
});
