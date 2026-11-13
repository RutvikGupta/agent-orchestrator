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
