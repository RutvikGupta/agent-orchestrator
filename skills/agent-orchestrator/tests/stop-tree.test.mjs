import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

// `stop` and `close` reach the tasks a stopped task started (the tasks of every run it created, and so
// on down); a task that a stop ended reads `stopped` and is not reported as failed or unread; and an
// item whose agent is not running goes up the chain to the agent above it, not straight to the user.

const hook = fileURLToPath(new URL('../scripts/hooks/orch-stop.mjs', import.meta.url));
const SESSION = '5d1e7c2a-3b4f-4a6e-8c9d-0e1f2a3b4c5d';
// The environment of an agent that `start` launched as task `id` of `run`.
const as = (run, id, depth = 1) => ({ AGENT_ORCH_DEPTH: String(depth), AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });
// A resumed relay's brief has no fake-relay comment, so it takes its controls from the environment.
const HOLD = { FAKE_RELAY_CONFIG: JSON.stringify({ hold: true }) };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const attemptDir = (run, id, n) => path.join(run.dir, 'tasks', id, `attempt-${n}`);
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

// The real relays record `aborted` when SIGTERM stops them, while the shared fake records `stopped`.
// These tests make their fixture's fakes record `aborted` too, so they see what a stop leaves behind
// with the real relays.
function abortOnSigterm(f) {
  for (const agent of ['claude', 'codex']) {
    const file = path.join(f.skills, `${agent}-delegate`, 'scripts', 'relay.mjs');
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("finish('stopped', 'SIGTERM')"), 'the fake relay\'s SIGTERM handler was found');
    fs.writeFileSync(file, source.replace("finish('stopped', 'SIGTERM')", "finish('aborted', 'SIGTERM')"));
  }
}

// Task `id` of `run`, started from `env` (an agent's shell, or the test's own), running until released.
// Read-only, so that several share the fixture's checkout.
async function held(f, run, id, env = {}) {
  const task = await f.start(run, id, { config: { hold: true }, env, flags: ['--read-only'] });
  await f.ready(task);
  return task;
}

// A parent `lead` running in a top-level run; a run it created, with two running tasks; and a run that
// one of those created, with one more.
async function tree(f) {
  const top = await f.newRun('top');
  const lead = await held(f, top, 'lead');
  const mid = await f.newRun('mid', as(top, 'lead'));
  const a = await held(f, mid, 'a', as(top, 'lead'));
  const b = await held(f, mid, 'b', as(top, 'lead'));
  const deep = await f.newRun('deep', as(mid, 'a', 2));
  const d = await held(f, deep, 'd', as(mid, 'a', 2));
  return { top, mid, deep, lead, a, b, d };
}

test('stop reaches every task below the stopped one, a level at a time, and each reads stopped', async (t) => {
  const f = await fixture(t);
  abortOnSigterm(f);
  const { top, mid, deep, lead, a, b, d } = await tree(f);
  // A sibling of lead, and a run that sibling created: neither is below lead.
  const other = await held(f, top, 'other');
  const side = await f.newRun('side', as(top, 'other'));
  const s = await held(f, side, 's', as(top, 'other'));

  const out = await f.command(['stop', top.id, 'lead']);
  const lines = out.stdout.trim().split('\n');
  assert.match(lines[0], new RegExp(`^stopped lead \\(pid ${lead.pid}\\); its relay records the outcome$`));
  assert.equal(lines[1], `also stopped 3 tasks below it: ${mid.id}/a, ${mid.id}/b, ${deep.id}/d`);
  assert.equal(lines.length, 2);
  for (const task of [lead, a, b, d]) assert.ok(!alive(task.pid), `${task.id}'s relay has exited`);
  assert.ok(alive(other.pid) && alive(s.pid), 'a sibling and the tasks it started are not below lead');

  const by = readJson(f.taskFile(top, 'lead')).stoppedBy;
  for (const [run, id] of [[top, 'lead'], [mid, 'a'], [mid, 'b'], [deep, 'd']]) {
    const row = await rowOf(f, run, id);
    assert.deepEqual([row.state, row.result.status, row.failureCount, row.health, row.limitHit], ['stopped', 'aborted', 0, 'ok', false], id);
    assert.match(row.now, /^stopped by /, id);
    const record = readJson(f.taskFile(run, id));
    assert.ok(record.stoppedAt, `${id} records its stop`);
    assert.deepEqual(record.stoppedBy, by, `${id}'s stop names the same actor`);
  }
  // A level at a time: lead first, then the tasks it started, then the one they started.
  const at = (run, id) => Date.parse(readJson(f.taskFile(run, id)).stoppedAt);
  assert.ok(at(top, 'lead') <= Math.min(at(mid, 'a'), at(mid, 'b')), 'lead was stopped before its sub-agents');
  assert.ok(Math.max(at(mid, 'a'), at(mid, 'b')) <= at(deep, 'd'), 'the sub-agents were stopped before theirs');
  assert.match((await f.command(['status', mid.id])).stdout, /^a +claude .* stopped /m);
  // A second stop has nothing left to stop.
  assert.match((await f.command(['stop', top.id, 'lead'], { code: 1 })).stderr, /task lead is not running/);

  f.release(other);
  f.release(s);
  await f.finished(top, 'other');
  await f.finished(side, 's');
});

// The pull request a parked babysitter's watcher checks: a fake gh on PATH, as park.test.mjs serves.
async function github(f) {
  const bin = path.join(f.root, 'bin');
  const data = path.join(f.root, 'github.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
else process.exit(91);
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  writeJson(data, { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] });
}

const PARKED = [
  'PARKED: PR #42 waits for a human review',
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');
const watchers = (run, id, n) => spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  .filter((line) => line.includes(' park-watch ') && line.includes(` ${attemptDir(run, id, n)} `));

test('stop ends the park of a babysitter below the stopped task', async (t) => {
  const f = await fixture(t);
  await github(f);
  const top = await f.newRun('top');
  const lead = await held(f, top, 'lead');
  const kids = await f.newRun('kids', as(top, 'lead'));
  await f.json(['start', kids.id, 'sit', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Babysits the fixture PR',
    '--brief', f.brief('sit', { finalMessage: PARKED })], { env: as(top, 'lead') });
  await eventually(async () => {
    const row = await rowOf(f, kids, 'sit');
    return row?.phase === 'parked' && row.parked.watcher === 'alive';
  }, 'sit did not park with a live watcher', 20_000);

  const out = await f.command(['stop', top.id, 'lead']);
  assert.match(out.stdout, new RegExp(`^stopped lead \\(pid ${lead.pid}\\)`));
  assert.match(out.stdout, new RegExp(`\\nalso stopped 1 task below it: ${kids.id}/sit\\n$`));
  assert.deepEqual(watchers(kids, 'sit', 1), [], 'the park watcher was stopped');
  const row = await rowOf(f, kids, 'sit');
  assert.deepEqual([row.state, row.phase === 'parked', row.parked], ['stopped', false, undefined]);
  assert.ok(readJson(f.taskFile(kids, 'sit')).stoppedAt);
});

test('close of a task that still runs stops the tasks below it and closes only that task', async (t) => {
  const f = await fixture(t);
  abortOnSigterm(f);
  const top = await f.newRun('top');
  const lead = await held(f, top, 'lead');
  const kids = await f.newRun('kids', as(top, 'lead'));
  const k1 = await held(f, kids, 'k1', as(top, 'lead'));
  const k2 = await held(f, kids, 'k2', as(top, 'lead'));

  const out = await f.command(['close', top.id, 'lead']);
  assert.match(out.stdout, new RegExp(`^lead: stopped \\(pid ${lead.pid}\\) and closed\\nlead: also stopped 2 tasks below it: ${kids.id}/k1, ${kids.id}/k2$`, 'm'));
  for (const task of [lead, k1, k2]) assert.ok(!alive(task.pid), `${task.id}'s relay has exited`);
  assert.ok(readJson(f.taskFile(top, 'lead')).closedAt, 'lead is closed');
  for (const id of ['k1', 'k2']) {
    const record = readJson(f.taskFile(kids, id));
    assert.deepEqual([Boolean(record.stoppedAt), record.closedAt ?? null], [true, null], `${id} is stopped, not closed`);
    assert.equal((await rowOf(f, kids, id)).state, 'stopped');
  }

  // Closing a task that has finished reaches nothing below it: what it left running stays.
  await f.start(top, 'done', { flags: ['--read-only'] });
  await f.finished(top, 'done');
  const later = await f.newRun('later', as(top, 'done'));
  const left = await held(f, later, 'left', as(top, 'done'));
  const closed = await f.json(['close', top.id, 'done']);
  assert.equal(closed.stoppedBelow, undefined);
  assert.ok(alive(left.pid), 'a finished task\'s close stopped a task below it');
  f.release(left);
  await f.finished(later, 'left');
});

test('an interrupt of a task does not reach the tasks below it', async (t) => {
  const f = await fixture(t);
  const top = await f.newRun('top');
  const lead = await held(f, top, 'lead');
  const kids = await f.newRun('kids', as(top, 'lead'));
  const kid = await held(f, kids, 'kid', as(top, 'lead'));

  const sent = await f.command(['send', top.id, 'lead', 'Change of plan.', '--steer'], { env: HOLD });
  assert.match(sent.stdout, /^steered: .* resumed in attempt 2 /m);
  assert.ok(!alive(lead.pid), 'the interrupt stopped lead\'s first relay');
  await eventually(() => fs.existsSync(path.join(attemptDir(top, 'lead', 2), 'ready')), 'lead\'s second attempt did not start');
  assert.ok(alive(kid.pid), 'the interrupt reached the task below');
  assert.equal(readJson(f.taskFile(kids, 'kid')).stoppedAt ?? null, null);
  assert.equal((await rowOf(f, kids, 'kid')).state, 'running');

  f.release(kid);
  f.release({ outDir: attemptDir(top, 'lead', 2) });
  await f.finished(kids, 'kid');
  await f.finished(top, 'lead');
});

// Run the Stop hook once, as Claude Code runs it, for SESSION; the reason it blocked with, or null.
function stopHook(f) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { cwd: f.repo, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      assert.equal(code, 0);
      resolve(stdout ? JSON.parse(stdout).reason : null);
    });
    child.stdin.end(JSON.stringify({ session_id: SESSION, stop_hook_active: false, transcript_path: '/dev/null', cwd: '/' }));
  });
}

test('a stopped task raises no attention item and no unread-result line, while one that died without a stop does', async (t) => {
  const f = await fixture(t);
  abortOnSigterm(f);
  const run = await f.newRun('mine');
  const owner = f.launchingSession(run, SESSION);
  await held(f, run, 'halted');
  const died = await held(f, run, 'died');
  await f.command(['stop', run.id, 'halted'], { env: owner });
  // The test ends died's relay itself, as an outside kill would: no stop is recorded on the task.
  process.kill(died.pid, 'SIGTERM');
  assert.equal((await f.finished(run, 'died')).state, 'aborted');
  const halted = await rowOf(f, run, 'halted');
  assert.deepEqual([halted.state, halted.failureCount, halted.closed], ['stopped', 0, false]);

  // wait returns, since nothing runs, and lists only died as unread and as needing attention.
  const waited = await f.json(['wait', run.id, '--timeout', '30s'], { env: owner });
  assert.equal(waited.finished, true);
  assert.deepEqual(waited.attention.map((item) => [item.task, item.kind]), [['died', 'failed']]);
  const text = (await f.command(['wait', run.id, '--timeout', '30s'], { env: owner })).stdout;
  assert.match(text, /\n\(died finished and nobody has read its result: /);
  assert.doesNotMatch(text, /halted[^\n]*(?:finished and nobody|— )/);
  assert.doesNotMatch(text, /awaiting review: .*halted/);

  // The board's lane has died's item only.
  const board = await f.dashboard();
  const lane = (await board.json('/api/state')).flatMap((section) => section.attention);
  assert.deepEqual(lane.map((item) => item.id), ['died']);
  const row = (await board.json('/api/state')).flatMap((section) => section.tasks).find((task) => task.id === 'halted');
  assert.deepEqual([row.state, row.attention], ['stopped', null]);

  // The Stop hook names died's unread result, and not halted's.
  const reason = await stopHook(f);
  assert.match(reason, new RegExp(`${run.id}/died finished \\(aborted\\) and nobody has read its result`));
  assert.doesNotMatch(reason, /halted/);

  // A start by hand clears the stop: the resumed task reads as its new attempt does.
  await f.command(['start', run.id, 'halted', '--agent', 'claude', '--read-only', '--brief', f.brief('again', { status: 'failed', error: 'Build failed' })], { env: owner });
  const resumed = await f.finished(run, 'halted');
  assert.deepEqual([resumed.state, resumed.attempts.map((a) => a.state)], ['failed', ['failed', 'stopped']]);
});

test('an item of a stopped task\'s sub-agent goes to the session above it while that session is live, and to the user once it is gone', async (t) => {
  const f = await fixture(t);
  const top = await f.newRun('top');
  const owner = f.launchingSession(top, 'abovesn1-0001');
  await held(f, top, 'lead');
  const kids = await f.newRun('kids', as(top, 'lead'));
  await f.start(kids, 'kid', { config: { status: 'failed', error: 'Build failed' }, env: as(top, 'lead'), flags: ['--read-only'] });
  await f.finished(kids, 'kid');
  await f.command(['stop', top.id, 'lead'], { env: owner });

  const board = await f.dashboard();
  const item = async () => (await board.json('/api/state')).flatMap((section) => section.attention).find((a) => a.id === 'kid');
  const passed = [`task ${top.id}/lead is not running`];
  const live = await item();
  assert.deepEqual([live.to, live.agent, live.agentTask, live.gone, live.passed], ['agent', 'orchestrator session abovesn1', null, null, passed]);
  assert.equal(live.reason, `Build failed (passed on: task ${top.id}/lead is not running)`);

  // The session's wait on its run shows the item: it is the session's now.
  const waited = await f.command(['wait', top.id, '--timeout', '30s'], { env: owner });
  assert.ok(waited.stdout.includes(`\n${kids.id}/kid: failed — Build failed (passed on: task ${top.id}/lead is not running)`), waited.stdout);

  // Once the session has had no wait on its run for 20 minutes, it is gone, and the item is the user's.
  writeJson(path.join(top.dir, 'main-wait.json'), { pid: 1, at: minutesAgo(20) });
  const gone = await eventually(async () => {
    const now = await item();
    return now?.to === 'user' ? now : null;
  }, 'the item did not go to the user once the session was gone');
  assert.deepEqual([gone.agent, gone.gone, gone.passed], ['orchestrator session abovesn1', 'no wait on its run for 20m', passed]);
});

// Races the walk below a stopped task must survive. Each test holds a process at an exact point with
// a preload in that process alone, never with a sleep.

// The environment that makes this test's `stop` find relay `pid` gone as it signals it: the relay
// exits just before the SIGTERM reaches it, so both signals fail with ESRCH, as when a task ends
// between the check that it runs and the stop. The preload kills only that PID, which the test started.
function vanishes(f, pid) {
  const file = path.join(f.root, 'vanish.cjs');
  fs.writeFileSync(file, `const target = Number(process.env.TEST_VANISH_PID);
if (target && /orch\\.mjs$/.test(process.argv[1] || '') && process.argv[2] === 'stop') {
  const { spawnSync } = require('node:child_process');
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (Math.abs(pid) === target && signal) {
      try { kill(target, 'SIGKILL'); } catch {}
      for (let i = 0; i < 200; i++) { try { kill(target, 0); } catch { break; } spawnSync('sleep', ['0.05']); }
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' });
    }
    return kill(pid, signal);
  };
}
`);
  return { NODE_OPTIONS: `--require=${JSON.stringify(file)}`, TEST_VANISH_PID: String(pid) };
}

// The environment that holds one `orch.mjs <sub>` process at its first write of `file` (a path) whose
// content holds `text` (fixtures/pause-at-write.cjs), and its marker: the process writes its PID there
// and waits for `<marker>.release`.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function pauseAt(f, name, { sub, file, text = '', after = false }) {
  const marker = path.join(f.root, name);
  const preload = fileURLToPath(new URL('./fixtures/pause-at-write.cjs', import.meta.url));
  return { marker, env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_PAUSE_SCRIPT: 'orch\\.mjs$', TEST_PAUSE_SUB: sub, TEST_PAUSE_FILE: `^${escape(file)}$`, TEST_PAUSE_TEXT: text, TEST_PAUSE_AFTER: after ? '1' : '', TEST_PAUSE_MARKER: marker } };
}
// The environment that holds this test's `stop` as it is about to record the stop on task file
// `file`: after it found the task's attempt running, before it reads the record it marks (the `mark`
// step of stopTask in commands/task.mjs). It writes its PID to the marker and waits for
// `<marker>.release`.
function holdBeforeMark(f, name, file) {
  const marker = path.join(f.root, name);
  const preload = path.join(f.root, `${name}.cjs`);
  fs.writeFileSync(preload, `const fs = require('node:fs');
const file = process.env.TEST_MARK_FILE, marker = process.env.TEST_MARK_MARKER;
if (file && /orch\\.mjs$/.test(process.argv[1] || '') && process.argv[2] === 'stop') {
  const read = fs.readFileSync, sleep = new Int32Array(new SharedArrayBuffer(4));
  let done = false;
  fs.readFileSync = function readFileSync(target, ...rest) {
    if (!done && String(target) === file && /at mark \\(.*commands\\/task\\.mjs/.test(new Error().stack)) {
      done = true;
      fs.writeFileSync(marker, String(process.pid));
      while (!fs.existsSync(marker + '.release')) Atomics.wait(sleep, 0, 0, 10);
    }
    return read.call(fs, target, ...rest);
  };
}
`);
  return { marker, env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_MARK_FILE: file, TEST_MARK_MARKER: marker } };
}
const reached = (marker) => eventually(() => fs.existsSync(marker), 'the process did not reach the write', 20_000);
const go = (marker) => fs.writeFileSync(`${marker}.release`, '');

test('a task below that exits as it is signalled does not end the walk: the rest are still stopped', async (t) => {
  const f = await fixture(t);
  const { top, mid, deep, lead, a, b, d } = await tree(f);
  const out = await f.command(['stop', top.id, 'lead'], { env: vanishes(f, a.pid) });
  assert.equal(out.stderr, '');
  assert.match(out.stdout, new RegExp(`^stopped lead \\(pid ${lead.pid}\\)`));
  assert.match(out.stdout, new RegExp(`\\nalso stopped 3 tasks below it: ${mid.id}/a, ${mid.id}/b, ${deep.id}/d\\n$`));
  for (const task of [lead, a, b, d]) assert.ok(!alive(task.pid), `${task.id}'s relay has exited`);
  for (const [run, id] of [[mid, 'a'], [mid, 'b'], [deep, 'd']]) {
    assert.ok(readJson(f.taskFile(run, id)).stoppedAt, `${id} records its stop`);
    assert.equal((await rowOf(f, run, id)).state, 'stopped', id);
  }
});

test('a task below whose start saves its record after the walk read its run is stopped by a later pass', async (t) => {
  const f = await fixture(t);
  const top = await f.newRun('top');
  const lead = await held(f, top, 'lead');
  const mid = await f.newRun('mid', as(top, 'lead'));
  const a = await held(f, mid, 'a', as(top, 'lead'));
  // b's start is held at its record's first write, so the walk below cannot see b yet.
  const starting = pauseAt(f, 'start-b', { sub: 'start', file: f.taskFile(mid, 'b') });
  const start = f.json(['start', mid.id, 'b', '--agent', 'claude', '--tier', 'complex', '--read-only', '--why', 'Starts while its parent is stopped',
    '--brief', f.brief('b', { hold: true })], { env: { ...as(top, 'lead'), ...starting.env } });
  await reached(starting.marker);
  // The stop is held once it has read mid's tasks and marked a stopped; then b's start finishes.
  const stopping = pauseAt(f, 'stop-a', { sub: 'stop', file: f.taskFile(mid, 'a'), text: 'stoppedBy', after: true });
  const stop = f.command(['stop', top.id, 'lead'], { env: stopping.env });
  await reached(stopping.marker);
  go(starting.marker);
  const b = await start;
  await f.ready(b);
  go(stopping.marker);
  const out = await stop;
  assert.match(out.stdout, new RegExp(`\\nalso stopped 2 tasks below it: ${mid.id}/a, ${mid.id}/b\\n$`));
  for (const task of [lead, a, b]) assert.ok(!alive(task.pid), `${task.id}'s relay has exited`);
  assert.ok(readJson(f.taskFile(mid, 'b')).stoppedAt, 'b records its stop');
  assert.equal((await rowOf(f, mid, 'b')).state, 'stopped');
});

test('a stop that a resume overtakes stops the attempt it recorded the stop on', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('race');
  const first = await held(f, run, 'w');
  // The stop is held after it found attempt 1 running and before it reads the record it marks.
  const stopping = holdBeforeMark(f, 'stop-w', f.taskFile(run, 'w'));
  const stop = f.command(['stop', run.id, 'w'], { env: stopping.env });
  await reached(stopping.marker);
  // Meanwhile an interrupt stops attempt 1 and resumes the session in attempt 2.
  await f.command(['send', run.id, 'w', 'Change of plan.', '--steer'], { env: HOLD });
  await eventually(() => fs.existsSync(path.join(attemptDir(run, 'w', 2), 'ready')), 'attempt 2 did not start');
  const second = readJson(f.taskFile(run, 'w'));
  assert.deepEqual([second.attempt, alive(second.pid), alive(first.pid)], [2, true, false]);
  go(stopping.marker);
  const out = await stop;
  assert.match(out.stdout, new RegExp(`and attempt 2, which a resume had started \\(pid ${second.pid}\\)`));
  const record = readJson(f.taskFile(run, 'w'));
  assert.deepEqual([record.attempt, Boolean(record.stoppedAt)], [2, true], 'the stop is recorded on attempt 2');
  assert.ok(!alive(second.pid), 'attempt 2, which the stop is recorded on, was stopped');
  assert.equal((await rowOf(f, run, 'w')).state, 'stopped');
});

test('the walk below a stopped task and the chain above an item go past twenty levels', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_MAX_DEPTH = '40';
  const top = await f.newRun('top');
  f.launchingSession(top, 'deepsesn-0001');
  // t0 in the top run started t1 in a run of its own, and so on, 22 levels down; each has finished.
  const runs = [top];
  await f.start(top, 't0', { flags: ['--read-only'] });
  for (let i = 1; i <= 21; i++) {
    const env = as(runs[i - 1], `t${i - 1}`, i);
    runs.push(await f.newRun(`l${i}`, env));
    await f.start(runs[i], `t${i}`, { env, flags: ['--read-only'] });
  }
  const env = as(runs[21], 't21', 22);
  const last = await f.newRun('l22', env);
  await f.start(last, 'kid', { config: { status: 'failed', error: 'Build failed' }, env, flags: ['--read-only'] });
  await f.finished(last, 'kid');
  const deepest = await held(f, last, 'held', env);

  // kid's item passes 22 tasks that are not running, up to the session that launched the top run.
  const board = await f.dashboard();
  const item = await eventually(async () => {
    const found = (await board.json('/api/state')).flatMap((section) => section.attention).find((a) => a.id === 'kid');
    return found?.passed?.length === 22 ? found : null;
  }, 'kid\'s item did not pass all 22 levels');
  assert.deepEqual([item.to, item.agent, item.passed.at(-1)], ['agent', 'orchestrator session deepsesn', `task ${top.id}/t0 is not running`]);

  // A stop of t0, which has ended, still reaches the running task 22 levels below it.
  const out = await f.command(['stop', top.id, 't0']);
  assert.equal(out.stdout, `task t0 is not running\nalso stopped 1 task below it: ${last.id}/held\n`);
  assert.ok(!alive(deepest.pid), 'the deepest task was stopped');
  assert.equal((await rowOf(f, last, 'held')).state, 'stopped');
});
