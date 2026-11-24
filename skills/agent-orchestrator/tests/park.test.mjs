import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';
// Pure: decides a board row's attention from the row alone.
import { attentionOf } from '../scripts/lib/dashboard-state.mjs';
// Pure: what a final message says about parking, and the brief that delivers messages.
import { parkedSignal } from '../scripts/lib/runs.mjs';
import { resumeBrief } from '../scripts/lib/park.mjs';

const parkModule = new URL('../scripts/lib/park.mjs', import.meta.url).pathname;
const runsModule = new URL('../scripts/lib/runs.mjs', import.meta.url).pathname;
const finishNotice = new URL('../scripts/lib/finish-notice.mjs', import.meta.url).pathname;

const PARKED = [
  'PARKED: waits for the deploy',
  'All local checks passed.',
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');
const SLOW = 20_000; // a watcher's check is a fresh Node process, slow on a loaded machine
// A start that finds the watcher's claim held waits for it (park.mjs, claimParked); tests that hold
// that claim themselves and expect the refusal at once turn the wait off.
const NO_CLAIM_WAIT = { AGENT_ORCH_PARK_CLAIM_WAIT: '0' };

const condition = (flag) => [process.execPath, '-e', `process.exit(require("node:fs").existsSync(${JSON.stringify(flag)}) ? 0 : 1)`];
const neverCondition = [process.execPath, '-e', 'process.exit(1)'];

function parkUntilRecord(attempt, command = neverCondition, { every = 1000, why = 'the deploy' } = {}) {
  const at = new Date();
  return { attempt, command, cwd: process.cwd(), path: process.env.PATH || null, every, for: 3600_000, why, at: at.toISOString(), until: new Date(at.getTime() + 3600_000).toISOString() };
}

// Start task `id` with a wake condition, whose fake relay ends its first attempt parked.
async function parkTask(f, run, id, { env = {}, command = neverCondition, every = 1000, why = 'the deploy' } = {}) {
  const task = await f.start(run, id, { config: { hold: true, finalMessage: PARKED }, env });
  await f.ready(task);
  await f.command(['park-until', '--every', '30s', '--why', why, '--', ...command], {
    env: { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id },
  });
  const file = path.join(task.outDir, 'park-until.json');
  writeJson(file, { ...readJson(file), every });
  f.release(task);
  return task;
}

const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const attemptDir = (run, id, n) => path.join(run.dir, 'tasks', id, `attempt-${n}`);
// The live watcher shells of a parked attempt, from the process table.
const watchers = (run, id, n) => spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  .filter((line) => line.includes(' park-watch ') && line.includes(` ${attemptDir(run, id, n)} `))
  .map((line) => Number(line.trim().split(/\s+/)[0]));
const parkedRow = (f, run, id, attempt = 1) => eventually(async () => {
  const row = await rowOf(f, run, id);
  return row?.phase === 'parked' && row.attempt === attempt && row.parked.watcher === 'alive' ? row : null;
}, `${id} did not park with a live watcher`, SLOW);
// The claims on a parked attempt, oldest first, as { k, ...record }; the last is the current one.
const claims = (run, id, n) => fs.readdirSync(attemptDir(run, id, n)).map((name) => /^park-claim-(\d+)\.json$/.exec(name)).filter(Boolean)
  .map((m) => ({ k: Number(m[1]), ...readClaim(path.join(attemptDir(run, id, n), m[0])) })).sort((a, b) => a.k - b.k);
// A claim's record, or nothing for an empty or unreadable one.
function readClaim(file) {
  try {
    return readJson(file);
  } catch {
    return {};
  }
}
const claimFile = (run, id, n, k) => path.join(attemptDir(run, id, n), `park-claim-${k}.json`);
// This test process as a claim's owner (alive), and a process that has exited (a dead owner).
const started = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.replace(/\s+/g, ' ').trim();
const liveOwner = () => ({ pid: process.pid, started: started(process.pid) });
const deadOwner = () => ({ pid: spawnSync('true').pid, started: 'Thu Jan 1 00:00:00 2026' });
// A finished attempt, made to look parked without a watcher: as after a reboot.
async function seeded(f, run, id = 'sit') {
  const task = await f.start(run, id);
  await f.finished(run, id);
  const result = path.join(task.outDir, 'result.json');
  writeJson(result, { ...readJson(result), finalMessage: PARKED });
  writeJson(path.join(task.outDir, 'park-until.json'), parkUntilRecord(1));
  return readJson(f.taskFile(run, id));
}

// The watcher's latest check, once it has checked at least `times` more times after now.
async function checkedAgain(run, id, n, times = 2) {
  const file = path.join(attemptDir(run, id, n), 'park-check.json');
  const seen = new Set([fs.existsSync(file) ? readJson(file).at : null]);
  await eventually(() => {
    try {
      seen.add(readJson(file).at);
    } catch {}
    return seen.size > times;
  }, 'the watcher did not check again', SLOW);
  return readJson(file);
}

test('a parked task shows as parked, keeps wait waiting, and is resumed once per event', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const ready = path.join(f.root, 'deploy-ready');
  // Set before parkTask so the finish watcher it starts inherits this for attempt 2 (whose brief
  // has no fake-relay comment and holds until released).
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: PARKED });
  await parkTask(f, run, 'sit', { command: condition(ready) });
  const row = await parkedRow(f, run, 'sit');
  assert.equal(row.state, 'running');
  assert.equal(row.parked.waitsFor, 'waits for the deploy');
  assert.equal(row.report.outcome, 'parked');
  assert.equal(row.closed, false);
  assert.equal(row.health, 'ok');
  assert.equal(attentionOf(row, false), null, 'a parked task never needs attention');
  assert.equal(watchers(run, 'sit', 1).length, 1);

  const status = await f.command(['status', run.id]);
  const line = status.stdout.split('\n').find((l) => l.startsWith('sit '));
  assert.match(line, /\bparked\b.*parked · waits for the deploy/);
  assert.doesNotMatch(status.stdout, /completed|awaiting review|needs decision/);
  // wait treats it as running: it times out instead of reporting a finished result.
  const waited = await f.command(['wait', run.id, 'sit', '--timeout', '1ms'], { code: 3 });
  assert.match(waited.stdout, /still running: wait timed out/);
  // The finish watcher sent no notice for the parked attempt.
  const notice = await eventually(() => {
    const file = path.join(attemptDir(run, 'sit', 1), 'parent-notice.json');
    return fs.existsSync(file) && readJson(file).skipped ? readJson(file) : null;
  }, 'no notice record');
  assert.equal(notice.parked, true);
  // Reading its result does not close it.
  const result = await f.command(['result', run.id, 'sit']);
  assert.match(result.stdout, /attempt 1: parked/);
  assert.equal(readJson(f.taskFile(run, 'sit')).closedAt, null);
  const recover = await f.command(['recover', run.id]);
  assert.match(recover.stdout, /parked tasks .*: sit \(waits for the deploy\)/);

  // When the wake condition exits 0, the watcher resumes the same session once.
  fs.writeFileSync(ready, '');
  const second = await eventually(() => (readJson(f.taskFile(run, 'sit')).attempt === 2 ? readJson(f.taskFile(run, 'sit')) : null), 'the watcher did not resume', SLOW);
  await f.ready(second);
  assert.deepEqual([second.tier, second.attemptReason], ['complex', 'resume']);
  const argv = readJson(path.join(second.outDir, 'invocation.json')).argv;
  assert.equal(argv[argv.indexOf('--session') + 1], 'fixture-claude');
  const brief = fs.readFileSync(path.join(second.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /Your parked watcher woke you/);
  assert.match(brief, /Your wake condition .* exited 0/);
  assert.deepEqual([claims(run, 'sit', 1).at(-1).by, claims(run, 'sit', 1).at(-1).attempt], ['watcher', 2]);
  await eventually(() => watchers(run, 'sit', 1).length === 0, 'the resumed attempt\'s watcher did not exit', SLOW);
  // While it runs, nothing else resumes it.
  const again = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('again'), '--', '--session', 'fixture-claude'], { code: 1 });
  assert.match(again.stderr, /already running/);

  // Attempt 2 records a new wake condition and parks again.
  await f.command(['park-until', '--every', '30s', '--why', 'the deploy', '--', ...neverCondition], {
    env: { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'sit' },
  });
  const cond2 = path.join(second.outDir, 'park-until.json');
  writeJson(cond2, { ...readJson(cond2), every: 1000 });
  f.release(second);
  await parkedRow(f, run, 'sit', 2);
  const check = await checkedAgain(run, 'sit', 2);
  assert.deepEqual(check.events, []);
  assert.equal(readJson(f.taskFile(run, 'sit')).attempt, 2);

  // A message is an event too: it reaches the parked task, and the new attempt gets it in full,
  // however long, in a file its brief points to; only then is it marked read.
  const long = `Please also update the changelog.\n${'Details. '.repeat(1500)}\nCRITICAL_END`;
  const sent = await f.json(['send', run.id, 'sit', long]);
  assert.match(sent.delivery, /parked/);
  const third = await eventually(() => (readJson(f.taskFile(run, 'sit')).attempt === 3 ? readJson(f.taskFile(run, 'sit')) : null), 'a message did not resume it', SLOW);
  await f.ready(third);
  const messages = path.join(third.outDir, 'park-messages.md');
  assert.ok(fs.readFileSync(messages, 'utf8').includes(long), 'the message is delivered whole');
  const thirdBrief = fs.readFileSync(path.join(third.outDir, 'orch-brief.md'), 'utf8');
  assert.ok(thirdBrief.includes(messages), 'the brief points to the messages file');
  assert.match(thirdBrief, /a long message \(\d+ characters\), only in the file/);
  const inbox = await f.command(['inbox', run.id, 'sit']);
  assert.match(inbox.stdout, /no unread messages/);
  await f.command(['park-until', '--every', '30s', '--why', 'the deploy', '--', ...neverCondition], {
    env: { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'sit' },
  });
  const cond3 = path.join(third.outDir, 'park-until.json');
  writeJson(cond3, { ...readJson(cond3), every: 1000 });
  f.release(third);
  await parkedRow(f, run, 'sit', 3);

  // close ends the park and its watcher.
  await f.command(['close', run.id, 'sit']);
  await eventually(() => watchers(run, 'sit', 3).length === 0, 'close left the watcher running');
  const closed = await rowOf(f, run, 'sit');
  assert.equal(closed.closed, true);
  assert.equal(closed.parked, undefined);
});

test('stop ends a park; a dead watcher is reported and restarted once; a hand resume claims the park', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await parkTask(f, run, 'sit');
  await parkedRow(f, run, 'sit');
  // Under load a status call can start the first watcher before the finish watcher gets to it. Wait
  // until the finish watcher has done its part: one that finds the watcher killed below would start
  // the replacement itself, and leave `status` nothing to restart.
  await eventually(() => {
    const notice = readClaim(path.join(attemptDir(run, 'sit', 1), 'parent-notice.json'));
    return notice.parked && notice.skipped;
  }, 'the parked finish notice did not finish', SLOW);
  const row = await parkedRow(f, run, 'sit');
  const [first] = watchers(run, 'sit', 1);
  assert.equal(row.parked.watcherPid, first);

  // A watcher that dies (after a reboot, say) is reported, and two status calls at once start
  // exactly one new watcher.
  process.kill(-first, 'SIGTERM');
  await eventually(() => watchers(run, 'sit', 1).length === 0, 'the watcher did not stop');
  const [a, b] = await Promise.all([f.command(['status', run.id]), f.command(['status', run.id])]);
  assert.match(a.stdout + b.stdout, /sit: parked, and its watcher was not running; started a new one/);
  const revived = await parkedRow(f, run, 'sit');
  assert.equal(revived.parked.generation, 2);
  assert.equal(watchers(run, 'sit', 1).length, 1);
  assert.deepEqual(fs.readdirSync(attemptDir(run, 'sit', 1)).filter((n) => n.startsWith('park-watcher-')).sort(), ['park-watcher-1.json', 'park-watcher-2.json']);

  // While a resume holds the claim, a start by hand is refused.
  const held = { by: 'watcher', claimedAt: new Date().toISOString(), owner: liveOwner() };
  writeJson(claimFile(run, 'sit', 1, 1), held);
  const refused = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('hand'), '--', '--session', 'fixture-claude'], { code: 1, env: NO_CLAIM_WAIT });
  assert.match(refused.stderr, /parked, and its watcher is resuming it/);
  writeJson(claimFile(run, 'sit', 1, 1), { ...held, released: true });

  // A parked task leaves its parallel slot free, but still owns its checkout.
  const reader = await f.json(['start', run.id, 'reader', '--agent', 'claude', '--tier', 'light', '--why', 'Reads alongside', '--read-only', '--max-parallel', '1', '--brief', f.brief('reader', { hold: true })]);
  const writer = await f.command(['start', run.id, 'writer', '--agent', 'claude', '--tier', 'light', '--why', 'Writes in the same checkout', '--brief', f.brief('writer')], { code: 1 });
  assert.match(writer.stderr, /task sit is already writing in/);
  await f.ready(reader);
  f.release(reader);

  // A start by hand claims the park and stops the watcher.
  const hand = await f.json(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('hand-2', { hold: true, finalMessage: PARKED }), '--json', '--', '--session', 'fixture-claude']);
  assert.equal(hand.attempt, 2);
  assert.deepEqual(claims(run, 'sit', 1).map((c) => [c.k, c.by, c.attempt]), [[1, 'watcher', undefined], [2, 'start', 2]]);
  await eventually(() => watchers(run, 'sit', 1).length === 0, 'the old watcher survived a resume');
  await f.ready(hand);
  await f.command(['park-until', '--every', '30s', '--why', 'the deploy', '--', ...neverCondition], {
    env: { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'sit' },
  });
  const cond2 = path.join(hand.outDir, 'park-until.json');
  writeJson(cond2, { ...readJson(cond2), every: 1000 });
  f.release(hand);
  await parkedRow(f, run, 'sit', 2);

  // stop ends the park: the watcher goes, and the task shows as stopped, no longer running.
  const stopped = await f.command(['stop', run.id, 'sit']);
  assert.match(stopped.stdout, /stopped parked sit and its watcher/);
  assert.equal(watchers(run, 'sit', 2).length, 0);
  const after = await rowOf(f, run, 'sit');
  assert.equal(after.state, 'stopped');
  assert.equal(after.parked, undefined);
  assert.match((await f.command(['status', run.id])).stdout, /^sit .*stopped/m);
});

test('a parked task started by an agent parks without telling that agent it finished', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'lead' };
  const child = await f.newRun('child', env);
  await parkTask(f, child, 'sit', { env });
  await parkedRow(f, child, 'sit');
  const notice = await eventually(() => {
    const file = path.join(attemptDir(child, 'sit', 1), 'parent-notice.json');
    return fs.existsSync(file) && readJson(file).skipped ? readJson(file) : null;
  }, 'no notice record');
  assert.equal(notice.parked, true);
  assert.equal(fs.existsSync(path.join(parent.dir, 'tasks', 'lead', 'inbox.jsonl')), false, 'no finish notice reached the parent');
  // The watcher runs as the parked attempt did: under the same parent and depth.
  const task = readJson(f.taskFile(child, 'sit'));
  assert.deepEqual([task.startedBy, task.startDepth], [{ run: parent.id, task: 'lead' }, 1]);
  const [pid] = watchers(child, 'sit', 1);
  const environ = spawnSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  if (environ.includes('AGENT_ORCH_HOME=')) assert.match(environ, new RegExp(`AGENT_ORCH_TASK=lead\\b`));
  f.release(lead);
});

test('a resume that loses the claim changes nothing on disk', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await seeded(f, run);
  const held = { by: 'watcher', claimedAt: new Date().toISOString(), owner: liveOwner() };
  writeJson(claimFile(run, 'sit', 1, 1), held);
  // What the winning resume has written so far for its attempt.
  const next = attemptDir(run, 'sit', 2);
  fs.mkdirSync(next);
  fs.writeFileSync(path.join(next, 'orch-brief.md'), 'WINNING RESUME EVENT');
  const before = fs.readFileSync(f.taskFile(run, 'sit'), 'utf8');
  const lost = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('loser'), '--', '--session', 'fixture-claude'], { code: 1, env: NO_CLAIM_WAIT });
  assert.match(lost.stderr, /parked, and its watcher is resuming it/);
  assert.deepEqual(fs.readdirSync(next), ['orch-brief.md']);
  assert.equal(fs.readFileSync(path.join(next, 'orch-brief.md'), 'utf8'), 'WINNING RESUME EVENT');
  assert.equal(fs.readFileSync(f.taskFile(run, 'sit'), 'utf8'), before);
  assert.deepEqual(claims(run, 'sit', 1).map((c) => c.k), [1]);
  writeJson(claimFile(run, 'sit', 1, 1), { ...held, released: true });
});

test('a claim whose owner died is abandoned: status revives the watcher, start reclaims it, and stop and close end it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await seeded(f, run);
  // A start died after claiming, before saving its attempt.
  writeJson(claimFile(run, 'sit', 1, 1), { by: 'start', claimedAt: new Date().toISOString(), owner: deadOwner() });
  const row = await rowOf(f, run, 'sit'); // this status also revives the watcher
  assert.deepEqual([row.parked.claim, row.parked.resuming], ['abandoned', null]);
  await parkedRow(f, run, 'sit');
  assert.deepEqual(claims(run, 'sit', 1).map((c) => [c.k, Boolean(c.released), c.by]), [[1, false, 'start'], [2, true, 'revive']]);

  // A watcher that died after claiming: a start by hand takes over its claim.
  writeJson(claimFile(run, 'sit', 1, 3), { by: 'watcher', claimedAt: new Date().toISOString(), owner: deadOwner() });
  const hand = await f.json(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('hand', { hold: true, finalMessage: PARKED }), '--json', '--', '--session', 'fixture-claude']);
  assert.equal(hand.attempt, 2);
  const won = claims(run, 'sit', 1).at(-1);
  assert.deepEqual([won.k, won.by, won.takesOver, won.attempt, won.owner.pid > 0], [4, 'start', 3, 2, true]);
  await eventually(() => watchers(run, 'sit', 1).length === 0, 'the old watcher survived the resume');
  await f.ready(hand);
  await f.command(['park-until', '--every', '30s', '--why', 'the deploy', '--', ...neverCondition], {
    env: { AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'sit' },
  });
  const cond2 = path.join(hand.outDir, 'park-until.json');
  writeJson(cond2, { ...readJson(cond2), every: 1000 });
  f.release(hand);

  // close and stop end a park whose claim was abandoned, including one that names no owner.
  await parkedRow(f, run, 'sit', 2);
  writeJson(claimFile(run, 'sit', 2, 1), { by: 'start', claimedAt: '2020-01-01T00:00:00Z' });
  const closed = await f.command(['close', run.id, 'sit']);
  assert.match(closed.stdout, /sit: stopped its park watcher \(pid \d+\) and closed/);
  assert.equal(watchers(run, 'sit', 2).length, 0);
  assert.equal((await rowOf(f, run, 'sit')).parked, undefined);
  await seeded(f, run, 'other');
  writeJson(claimFile(run, 'other', 1, 1), { by: 'close', claimedAt: new Date().toISOString(), owner: deadOwner() });
  const stopped = await f.command(['stop', run.id, 'other']);
  assert.match(stopped.stdout, /stopped parked other/);
  assert.equal((await rowOf(f, run, 'other')).state, 'stopped');
});

test('reviveParked makes at most one ps call, and does nothing while every watcher is alive', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await seeded(f, run);
  await f.command(['status', run.id]); // starts its watcher
  const { parked } = await parkedRow(f, run, 'sit');
  // A ps on PATH that logs who called it, then runs the real one.
  const shim = path.join(f.root, 'shim');
  const log = path.join(f.root, 'ps-calls');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'ps'), `#!/bin/sh\necho "$PPID" >> ${JSON.stringify(log)}\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const script = path.join(f.root, 'revive.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { reviveParked } from ${JSON.stringify(parkModule)};
import { listTasks, loadRun } from ${JSON.stringify(runsModule)};
const calls = () => (fs.existsSync(process.env.PS_LOG) ? fs.readFileSync(process.env.PS_LOG, 'utf8').split('\\n').filter((l) => l.trim() === String(process.pid)).length : 0);
const measure = (fn) => { const before = calls(); const revived = fn(); return { revived: revived.map((r) => r.id), ps: calls() - before }; };
const run = loadRun(process.argv[2]);
const rows = listTasks(run);
console.log(JSON.stringify({ rows: measure(() => reviveParked(run, rows)), records: measure(() => reviveParked(run)), again: measure(() => reviveParked(run)) }));
`);
  const revive = () => {
    const r = spawnSync(process.execPath, [script, run.dir], { cwd: f.repo, encoding: 'utf8', env: { ...f.env, PATH: `${shim}:${f.env.PATH}`, PS_LOG: log } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const files = () => fs.readdirSync(attemptDir(run, 'sit', 1)).filter((n) => /^park-(watcher|claim)-/.test(n)).sort();
  const before = files();
  const alive = revive();
  assert.deepEqual(alive.rows, { revived: [], ps: 0 }, 'rows that show every watcher alive cost nothing');
  assert.deepEqual(alive.records, { revived: [], ps: 1 });
  assert.deepEqual(alive.again, { revived: [], ps: 1 });
  assert.deepEqual(files(), before, 'nothing written while the watcher is alive');

  process.kill(-parked.watcherPid, 'SIGTERM');
  await eventually(() => watchers(run, 'sit', 1).length === 0, 'the watcher did not stop');
  const dead = revive();
  assert.deepEqual(dead.rows.revived, ['sit']);
  assert.ok(dead.rows.ps <= 1, JSON.stringify(dead));
  assert.deepEqual([dead.records, dead.again], [{ revived: [], ps: 1 }, { revived: [], ps: 1 }], 'idempotent: one new watcher');
  await eventually(() => watchers(run, 'sit', 1).length === 1, 'the revived watcher did not start');
});

test('only an unquoted, unindented PARKED: first or last line parks, and an orch-result outcome must agree', () => {
  const report = (outcome) => `\n\`\`\`orch-result\n{"outcome":"${outcome}","changed":[],"checks":[],"decisions":[],"unresolved":[]}\n\`\`\``;
  assert.equal(parkedSignal(`PARKED: waits for the deploy${report('parked')}`), 'waits for the deploy');
  assert.equal(parkedSignal('PARKED: waits for the deploy\nNo report block.'), 'waits for the deploy');
  // An agent told to end with the line puts it last: that parks too, with or without a report block.
  assert.equal(parkedSignal('Build queued; two steps pending.\n\n- detail\n\nPARKED: waits for the deploy\n'), 'waits for the deploy');
  assert.equal(parkedSignal(`Done.\nPARKED: waits for the deploy${report('parked')}`), 'waits for the deploy');
  for (const message of [
    `> PARKED: quoted example\nActually completed.${report('done')}`,
    `> PARKED: quoted example${report('parked')}`,
    `  PARKED: indented${report('parked')}`,
    `**PARKED:** bold${report('parked')}`,
    `Done.\nPARKED: in the middle\nMore text.${report('parked')}`,
    `Done.\n> PARKED: quoted last line${report('parked')}`,
    `Done.\nPARKED: last line${report('done')}`,
    'Done.\nPARKED: last line\nNEEDS DECISION:\n- Proceed or wait?',
    `PARKED: waits for the deploy${report('done')}`,
    'PARKED: waits for the deploy\n```orch-result\nnot json\n```',
    'PARKED: waits for the deploy\nNEEDS DECISION:\n- Proceed or wait?',
  ]) assert.equal(parkedSignal(message), null, message);
});

test('a resume brief quotes only short messages and points to the file that holds every message whole', () => {
  const long = `${'x'.repeat(8000)}CRITICAL_END`;
  const brief = resumeBrief({ id: 'run' }, { id: 'sit' }, { waitsFor: 'waits for the deploy' },
    [{ id: 'a1', time: 't1', text: 'Short note.', from: 'user' }, { id: 'a2', time: 't2', text: long }], '/runs/run/tasks/sit/attempt-2/park-messages.md');
  assert.ok(brief.includes('/runs/run/tasks/sit/attempt-2/park-messages.md'));
  assert.match(brief, /> Short note\./);
  assert.match(brief, /a long message \(8012 characters\), only in the file/);
  assert.ok(!brief.includes('x'.repeat(2000)));
  assert.match(brief, /reply run sit/);
});

test('a late finish notice for a parked attempt stays suppressed after a later attempt starts', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await seeded(f, run);
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  writeJson(f.taskFile(run, 'sit'), { ...task, attemptStartedBy: { 1: { run: parent.id, task: 'lead' } } });
  const next = await f.json(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('next', { hold: true }), '--json', '--', '--session', 'fixture-claude']);
  await f.ready(next);
  const late = spawnSync(process.execPath, [finishNotice, run.dir, 'sit', '1', String(task.pid)], { env: f.env, encoding: 'utf8' });
  assert.equal(late.status, 0, late.stderr);
  const record = readJson(path.join(attemptDir(run, 'sit', 1), 'parent-notice.json'));
  assert.equal(record.parked, true);
  assert.match(record.skipped, /a later attempt has started/);
  assert.equal(fs.existsSync(path.join(parent.dir, 'tasks', 'lead', 'inbox.jsonl')), false, 'no notice reached the parent');
  f.release(next);
  f.release(lead);
});

// A preload for a `start` child that runs `act` (a CommonJS body with `fs` in scope) once the
// patched fs call `call` has targeted `target`, or just before it when `before` is set.
function hook(f, name, call, target, act, { before = false } = {}) {
  const file = path.join(f.root, `${name}.cjs`);
  fs.writeFileSync(file, `const fs = require('node:fs');
const original = fs.${call};
let fired = false;
fs.${call} = function (from, to, ...rest) {
  const hit = !fired && String(to) === ${JSON.stringify(target)};
  if (hit && ${before}) { fired = true; ${act} }
  const result = original.call(this, from, to, ...rest);
  if (hit && !${before}) { fired = true; ${act} }
  return result;
};
`);
  return { NODE_OPTIONS: `--require=${JSON.stringify(file)}` };
}
// The act of a hook that signals `ready`, then holds the process until `release` exists.
const pause = (ready, release) => `fs.writeFileSync(${JSON.stringify(ready)}, ''); while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`;
const relaysOf = (dir) => spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  .filter((line) => line.includes('relay.mjs') && line.includes(`--out-dir ${dir}`)).map((line) => Number(line.trim().split(/\s+/)[0]));

test('a claim is created whole, and an empty or unreadable one is abandoned after a minute', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await seeded(f, run);
  const empty = claimFile(run, 'sit', 1, 1);
  fs.writeFileSync(empty, '');
  // A claim being written a moment ago may still be live.
  const young = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('young'), '--', '--session', 'fixture-claude'], { code: 1 });
  assert.match(young.stderr, /parked, and `another command` already ended its park/);
  // Past a minute it is abandoned: status starts the watcher, and a start takes the park over.
  fs.utimesSync(empty, new Date('2020-01-01'), new Date('2020-01-01'));
  const row = await rowOf(f, run, 'sit');
  assert.deepEqual([row.parked.claim, row.parked.resuming], ['abandoned', null]);
  await parkedRow(f, run, 'sit');
  const resumed = await f.json(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('resume', { finalMessage: PARKED }), '--json', '--', '--session', 'fixture-claude']);
  assert.equal(resumed.attempt, 2);
  assert.deepEqual(claims(run, 'sit', 1).map((c) => [c.k, c.by, Boolean(c.released), c.attempt]), [[1, undefined, false, undefined], [2, 'revive', true, undefined], [3, 'start', false, 2]]);
  assert.deepEqual(fs.readdirSync(attemptDir(run, 'sit', 1)).filter((n) => n.endsWith('.tmp')), [], 'no temporary claim files are left');
});

test('a resume that dies after starting its relay leaves it to be adopted, and only a gone relay is started again', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  // The launcher dies right after starting the relay, before saving the task.
  const crash = async (id) => {
    const env = hook(f, `crash-${id}`, 'renameSync', f.taskFile(run, id), 'process.exit(99);', { before: true });
    await f.command(['start', run.id, id, '--agent', 'claude', '--brief', f.brief(`crash-${id}`, { hold: true }), '--', '--session', 'fixture-claude'], { code: 99, env });
    const claim = claims(run, id, 1).at(-1);
    assert.equal(readJson(f.taskFile(run, id)).attempt, 1);
    assert.deepEqual([claim.task.attempt, claim.relay.pid > 0, Boolean(claim.relay.started)], [2, true, true]);
    await f.ready({ outDir: attemptDir(run, id, 2) });
    return claim.relay.pid;
  };

  await seeded(f, run, 'sit');
  const orphan = await crash('sit');
  const adopted = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('takeover', { hold: true }), '--', '--session', 'fixture-claude'], { code: 1 });
  assert.match(adopted.stderr, new RegExp(`earlier resume died after starting its relay \\(pid ${orphan}\\), which still runs: it is now attempt 2`));
  const task = readJson(f.taskFile(run, 'sit'));
  assert.deepEqual([task.attempt, task.pid], [2, orphan]);
  assert.deepEqual(relaysOf(attemptDir(run, 'sit', 2)), [orphan], 'one relay for the session');
  assert.match(fs.readFileSync(path.join(attemptDir(run, 'sit', 2), 'orch-brief.md'), 'utf8'), /Fixture task crash-sit/);
  assert.equal((await rowOf(f, run, 'sit')).state, 'running');
  f.release({ outDir: attemptDir(run, 'sit', 2) });
  await f.finished(run, 'sit');

  await seeded(f, run, 'gone');
  const dead = await crash('gone');
  process.kill(-dead, 'SIGKILL');
  await eventually(() => relaysOf(attemptDir(run, 'gone', 2)).length === 0, 'the relay did not exit');
  const fresh = await f.json(['start', run.id, 'gone', '--agent', 'claude', '--brief', f.brief('fresh'), '--json', '--', '--session', 'fixture-claude']);
  assert.equal(fresh.attempt, 2);
  assert.notEqual(fresh.pid, dead);
  assert.equal(claims(run, 'gone', 1).at(-1).takesOver, 1);
});

test('close and stop win the race with a resume, whichever comes first', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();

  // close first: the resume has claimed the park but not started its relay; close marks the task
  // closed, waits for the claim, then the resume starts nothing.
  await seeded(f, run, 'first');
  const [ready, release] = [path.join(f.root, 'claimed'), path.join(f.root, 'go-on')];
  const env = hook(f, 'claimed', 'linkSync', claimFile(run, 'first', 1, 1), pause(ready, release));
  const pending = f.command(['start', run.id, 'first', '--agent', 'claude', '--brief', f.brief('late', { hold: true }), '--', '--session', 'fixture-claude'], { code: 1, env });
  try {
    await eventually(() => fs.existsSync(ready), 'the resume did not claim');
    const closed = await f.command(['close', run.id, 'first']);
    assert.match(closed.stdout, /first: closed, though `start` was resuming it/);
  } finally {
    fs.writeFileSync(release, '');
  }
  assert.match((await pending).stderr, /was closed while this resume was starting, so it started nothing/);
  const first = readJson(f.taskFile(run, 'first'));
  assert.deepEqual([first.attempt, Boolean(first.closedAt)], [1, true]);
  assert.equal(fs.existsSync(attemptDir(run, 'first', 2)), false);

  // The resume first: it has started its relay, not saved it yet; stop stops that relay, and the
  // resume's save keeps the stop.
  await seeded(f, run, 'second');
  const [spawned, onward] = [path.join(f.root, 'spawned'), path.join(f.root, 'onward')];
  const target = claimFile(run, 'second', 1, 1);
  const after = hook(f, 'spawned', 'renameSync', target, `if (!JSON.parse(fs.readFileSync(${JSON.stringify(target)}, 'utf8')).relay) { fired = false; } else { ${pause(spawned, onward)} }`);
  const resuming = f.json(['start', run.id, 'second', '--agent', 'claude', '--brief', f.brief('early', { hold: true }), '--json', '--', '--session', 'fixture-claude'], { env: after });
  let relay;
  try {
    await eventually(() => fs.existsSync(spawned), 'the resume did not start its relay');
    relay = claims(run, 'second', 1).at(-1).relay.pid;
    const stopped = await f.command(['stop', run.id, 'second']);
    assert.match(stopped.stdout, new RegExp(`stopped parked second and the relay a resume had started \\(pid ${relay}\\)`));
  } finally {
    fs.writeFileSync(onward, '');
  }
  const started = await resuming;
  assert.equal(started.pid, relay);
  const second = readJson(f.taskFile(run, 'second'));
  assert.deepEqual([second.attempt, Boolean(second.stoppedAt)], [2, true]);
  await eventually(() => relaysOf(attemptDir(run, 'second', 2)).length === 0, 'the resumed relay still runs');
  assert.equal((await f.finished(run, 'second')).state, 'stopped');
});

test('a stop recorded while a resumed relay ends parked holds for the new attempt: it never parks', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  const lead = await f.start(parent, 'lead', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(lead);
  const childEnv = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'lead' };
  const run = await f.newRun('child', childEnv);
  const task1 = await f.start(run, 'sit', { env: childEnv });
  await f.finished(run, 'sit');
  writeJson(path.join(task1.outDir, 'result.json'), { ...readJson(path.join(task1.outDir, 'result.json')), finalMessage: PARKED });
  writeJson(path.join(task1.outDir, 'park-until.json'), parkUntilRecord(1));
  // The launcher pauses after recording its relay; the relay records a wake condition and finishes parked meanwhile.
  const [spawned, onward] = [path.join(f.root, 'spawned'), path.join(f.root, 'onward')];
  const target = claimFile(run, 'sit', 1, 1);
  const env = { ...childEnv, ...hook(f, 'spawned', 'renameSync', target, `if (!JSON.parse(fs.readFileSync(${JSON.stringify(target)}, 'utf8')).relay) { fired = false; } else { ${pause(spawned, onward)} }`) };
  const launching = f.json(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('quick', { hold: true, finalMessage: PARKED }), '--json', '--', '--session', 'fixture-claude'], { env });
  try {
    await eventually(() => fs.existsSync(spawned), 'the launcher did not record its relay');
    const dir2 = attemptDir(run, 'sit', 2);
    await f.ready({ outDir: dir2 });
    writeJson(path.join(dir2, 'park-until.json'), parkUntilRecord(2));
    f.release({ outDir: dir2 });
    await eventually(() => readClaim(path.join(dir2, 'result.json')).status === 'completed', 'the relay did not finish');
    assert.match((await f.command(['stop', run.id, 'sit'], { env: childEnv })).stdout, /stopped parked sit/);
  } finally {
    fs.writeFileSync(onward, '');
  }
  assert.equal((await launching).attempt, 2);
  const task = readJson(f.taskFile(run, 'sit'));
  assert.deepEqual([task.attempt, Boolean(task.stoppedAt)], [2, true]);
  // Its finish watcher has handled the attempt, which ended parked, and started no park watcher.
  const notice = await eventually(() => readClaim(path.join(attemptDir(run, 'sit', 2), 'parent-notice.json')).skipped && readClaim(path.join(attemptDir(run, 'sit', 2), 'parent-notice.json')), 'no notice record');
  assert.deepEqual([notice.parked, notice.watcher], [true, null]);
  const row = await rowOf(f, run, 'sit');
  assert.deepEqual([row.state, row.phase, row.parked], ['stopped', 'stopped', undefined]);
  assert.equal(watchers(run, 'sit', 2).length, 0);
  assert.equal(fs.readdirSync(attemptDir(run, 'sit', 2)).some((n) => n.startsWith('park-watcher-')), false);
  f.release(lead);
});

test('an adoption during start counts toward the parallel limit', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await seeded(f, run);
  // A resume of sit dies after starting its relay, before saving the task.
  const env = hook(f, 'crash', 'renameSync', f.taskFile(run, 'sit'), 'process.exit(99);', { before: true });
  await f.command(['start', run.id, 'sit', '--agent', 'claude', '--brief', f.brief('orphan', { hold: true }), '--', '--session', 'fixture-claude'], { code: 99, env });
  const orphan = claims(run, 'sit', 1).at(-1).relay.pid;
  await f.ready({ outDir: attemptDir(run, 'sit', 2) });
  // Starting another task adopts that relay first, so with --max-parallel 1 there is no slot left.
  const refused = await f.command(['start', run.id, 'reader', '--agent', 'claude', '--tier', 'light', '--why', 'Reads alongside',
    '--read-only', '--max-parallel', '1', '--brief', f.brief('reader', { hold: true })], { code: 1 });
  assert.match(refused.stderr, /1 tasks already running \(limit 1\)/);
  assert.equal(fs.existsSync(path.join(run.dir, 'tasks', 'reader')), false);
  assert.deepEqual([readJson(f.taskFile(run, 'sit')).attempt, readJson(f.taskFile(run, 'sit')).pid], [2, orphan]);
  assert.deepEqual(relaysOf(attemptDir(run, 'sit', 2)), [orphan]);
  f.release({ outDir: attemptDir(run, 'sit', 2) });
  await f.finished(run, 'sit');
});

test('wait restarts a parked task\'s dead watcher while it waits', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await parkTask(f, run, 'sit');
  await parkedRow(f, run, 'sit');
  const [first] = watchers(run, 'sit', 1);
  process.kill(-first, 'SIGTERM');
  await eventually(() => watchers(run, 'sit', 1).length === 0, 'the watcher did not stop');
  // The parked task still counts as running, so wait times out; its poll starts a new watcher.
  await f.command(['wait', run.id, 'sit', '--timeout', '1s'], { code: 3 });
  assert.equal(watchers(run, 'sit', 1).length, 1);
  assert.equal((await parkedRow(f, run, 'sit')).parked.generation, 2);
});
