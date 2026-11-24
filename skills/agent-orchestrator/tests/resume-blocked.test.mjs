import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';
// Pure: a board row's attention, and the texts that tell an agent or the user about an item.
import { attentionOf } from '../scripts/lib/dashboard-state.mjs';
import { agentNoticeText, goneText, taskAttention } from '../scripts/lib/escalate.mjs';
import { claimWaitMs } from '../scripts/lib/park.mjs';
import { resumeBlockedMs } from '../scripts/lib/runs.mjs';

// A parked task whose watcher cannot resume it, and what `start`, `send`, `wait`, `status`, the
// dashboard and escalation say about it (park.mjs, claimParked and checkPark).

const PARKED = [
  'PARKED: waits for the deploy',
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');
const SLOW = 20_000; // a watcher's check is a fresh Node process, slow on a loaded machine
const REASON = 'task writer is already writing in /work/checkout; give this task its own worktree, or pass --force';

const condition = (flag) => [process.execPath, '-e', `process.exit(require("node:fs").existsSync(${JSON.stringify(flag)}) ? 0 : 1)`];

const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const attemptDir = (run, id, n = 1) => path.join(run.dir, 'tasks', id, `attempt-${n}`);
const claimFile = (run, id, k) => path.join(attemptDir(run, id), `park-claim-${k}.json`);
const checkFile = (run, id) => path.join(attemptDir(run, id), 'park-check.json');
const started = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.replace(/\s+/g, ' ').trim();
const liveOwner = () => ({ pid: process.pid, started: started(process.pid) });
const heldByWatcher = () => ({ by: 'watcher', claimedAt: new Date().toISOString(), owner: liveOwner() });

// A finished attempt made to look parked, with no watcher: as after a reboot.
async function seeded(f, run, id = 'sit') {
  const task = await f.start(run, id);
  await f.finished(run, id);
  const result = path.join(task.outDir, 'result.json');
  writeJson(result, { ...readJson(result), finalMessage: PARKED });
  writeJson(path.join(task.outDir, 'park-until.json'), { attempt: 1, command: [process.execPath, '-e', 'process.exit(1)'], every: 60000, for: 3600000, why: 'the deploy', at: new Date().toISOString(), until: new Date(Date.now() + 3600000).toISOString() });
}

test('start waits out the watcher\'s claim and resumes once the watcher gives it back', async (t) => {
  const f = await fixture(t);
  const r = await f.newRun();
  await seeded(f, r);
  writeJson(claimFile(r, 'sit', 1), heldByWatcher());
  const hand = f.command(['start', r.id, 'sit', '--agent', 'claude', '--brief', f.brief('hand', { finalMessage: PARKED }), '--json', '--', '--session', 'fixture-claude']);
  // The watcher's claim is live (this process owns it), so the start cannot have ended: it waits.
  const early = await Promise.race([hand.then(() => 'ended'), delay(1500).then(() => 'waiting')]);
  assert.equal(early, 'waiting', 'the start gave up before the watcher\'s claim ended');
  // The watcher's try was refused and it gave the claim back: the start takes the park.
  writeJson(claimFile(r, 'sit', 1), { ...heldByWatcher(), released: true });
  const resumed = JSON.parse((await hand).stdout);
  assert.equal(resumed.attempt, 2);
  const claims = fs.readdirSync(attemptDir(r, 'sit')).filter((n) => n.startsWith('park-claim-')).sort();
  assert.deepEqual(claims, ['park-claim-1.json', 'park-claim-2.json']);
  assert.deepEqual([readJson(claimFile(r, 'sit', 2)).by, readJson(claimFile(r, 'sit', 2)).attempt], ['start', 2]);
});

test('start refuses with "resumed it" when the watcher it waited for saved a new attempt', async (t) => {
  const f = await fixture(t);
  const r = await f.newRun();
  await seeded(f, r);
  const held = heldByWatcher();
  writeJson(claimFile(r, 'sit', 1), held);
  const hand = f.command(['start', r.id, 'sit', '--agent', 'claude', '--brief', f.brief('hand'), '--', '--session', 'fixture-claude'], { code: 1 });
  const early = await Promise.race([hand.then(() => 'ended'), delay(1500).then(() => 'waiting')]);
  assert.equal(early, 'waiting');
  writeJson(claimFile(r, 'sit', 1), { ...held, attempt: 2, pid: process.pid, resumedAt: new Date().toISOString() });
  const lost = await hand;
  assert.match(lost.stderr, /task sit is parked, and its watcher resumed it; run `status` to see its new attempt/);
  assert.doesNotMatch(lost.stderr, /right now/);
  assert.equal(readJson(f.taskFile(r, 'sit')).attempt, 1, 'the losing start wrote nothing');
});

test('a start that is still refused after the wait says what the watcher is doing', async (t) => {
  const f = await fixture(t);
  const r = await f.newRun();
  await seeded(f, r);
  const held = heldByWatcher();
  writeJson(claimFile(r, 'sit', 1), held);
  const brief = f.brief('hand');
  const env = { AGENT_ORCH_PARK_CLAIM_WAIT: '300ms' };
  const began = Date.now();

  // The last check recorded a refused resume: the watcher is blocked, not resuming "right now".
  writeJson(checkFile(r, 'sit'), { at: new Date().toISOString(), generation: 1, waiting: REASON, waitingSince: '2026-11-17T02:05:00.000Z' });
  const blocked = await f.command(['start', r.id, 'sit', '--agent', 'claude', '--brief', brief, '--', '--session', 'fixture-claude'], { code: 1, env });
  assert.ok(Date.now() - began >= 300, 'the start waited before it refused');
  assert.match(blocked.stderr, new RegExp(`task sit is parked, and its watcher's resume is blocked: ${REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; run start again`));
  assert.doesNotMatch(blocked.stderr, /right now|is resuming it/);

  // No refused resume on record: the watcher is resuming it.
  fs.rmSync(checkFile(r, 'sit'));
  const resuming = await f.command(['start', r.id, 'sit', '--agent', 'claude', '--brief', brief, '--', '--session', 'fixture-claude'], { code: 1, env });
  assert.match(resuming.stderr, /task sit is parked, and its watcher is resuming it right now; run `status`/);
  assert.doesNotMatch(resuming.stderr, /blocked/);
  writeJson(claimFile(r, 'sit', 1), { ...held, released: true });
});

test('the claim wait and the blocked-resume threshold read their settings, with defaults', () => {
  assert.equal(claimWaitMs('0'), 0);
  assert.equal(claimWaitMs('300ms'), 300);
  assert.equal(claimWaitMs('2s'), 2000);
  assert.equal(claimWaitMs(undefined), 20000, 'the default is 20 seconds');
  assert.equal(claimWaitMs('soon'), 20000, 'a bad value falls back to the default');
  assert.equal(resumeBlockedMs(undefined), 600000, 'the default is 10 minutes');
  assert.equal(resumeBlockedMs('90s'), 90000);
  assert.equal(resumeBlockedMs('soon'), 600000);
});

test('send says a parked task\'s resume is blocked, and does not promise one in seconds', async (t) => {
  const f = await fixture(t);
  const r = await f.newRun();
  await seeded(f, r);
  // The park's latest check: no refusal, so the watcher resumes it within seconds.
  writeJson(checkFile(r, 'sit'), { at: new Date().toISOString(), generation: 1 });
  const fine = await f.json(['send', r.id, 'sit', 'First message']);
  assert.match(fine.delivery, /its watcher resumes it within a few seconds/);

  writeJson(checkFile(r, 'sit'), { at: new Date().toISOString(), generation: 1, waiting: REASON, waitingSince: new Date().toISOString() });
  const blocked = await f.json(['send', r.id, 'sit', 'Second message']);
  assert.match(blocked.delivery, /^the message is stored, but the task's resume is blocked: task writer is already writing in /);
  assert.match(blocked.delivery, /delivers the message with the resume once that clears/);
  assert.doesNotMatch(blocked.delivery, /few seconds/);
  const text = (await f.command(['send', r.id, 'sit', 'Third message'])).stdout;
  assert.match(text, /delivery: the message is stored, but the task's resume is blocked: /);
  assert.doesNotMatch(text, /few seconds/);
  // Steering a parked task interrupts nothing; its note says why, without the same promise.
  const steered = await f.json(['send', r.id, 'sit', 'Fourth message', '--steer']);
  assert.match(steered.steer.waiting, /^the task is parked and its resume is blocked: task writer is already writing in .*, so it is not interrupted$/);
  assert.equal(steered.steer.refused, true);
  assert.equal(readJson(f.taskFile(r, 'sit')).attempt, 1, 'a message starts no attempt');
});

test('attentionOf raises "resume blocked" once the first refusal is old enough, and escalation names it', () => {
  const now = Date.parse('2026-11-17T15:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const row = (fields = {}, parked = {}) => ({ id: 'sit', state: 'running', phase: 'parked', lastActiveMs: now - 60_000,
    parked: { waitsFor: 'its pull request', resumeWaits: REASON, resumeWaitsSince: ago(14 * 3600_000), ...parked }, ...fields });

  const item = attentionOf(row(), false, now);
  assert.deepEqual([item.kind, item.rank, item.label, item.sinceMs], ['resume-blocked', 2.8, 'resume blocked', now - 14 * 3600_000]);
  assert.match(item.reason, /its watcher cannot resume it, and has tried for 14h00m: task writer is already writing in \/work\/checkout/);
  assert.match(item.reason, /To clear it: give the task its own worktree, pass --force to `start`, or wait for the other writer\. The watcher keeps trying/);

  // Under ten minutes, a parked task is still just waiting; at ten it needs attention.
  assert.equal(attentionOf(row({}, { resumeWaitsSince: ago(9 * 60_000 + 59_000) }), false, now), null);
  assert.equal(attentionOf(row({}, { resumeWaitsSince: ago(10 * 60_000) }), false, now).kind, 'resume-blocked');
  // No refusal on record (or no time for it), a closed task, and a task that is not parked: nothing.
  assert.equal(attentionOf(row({}, { resumeWaits: null, resumeWaitsSince: null }), false, now), null);
  assert.equal(attentionOf(row({}, { resumeWaitsSince: null }), false, now), null);
  assert.equal(attentionOf(row(), true, now), null);
  assert.equal(attentionOf(row({ phase: 'running', parked: undefined }), false, now), null);

  // AGENT_ORCH_RESUME_BLOCKED_AFTER moves the threshold.
  const saved = process.env.AGENT_ORCH_RESUME_BLOCKED_AFTER;
  try {
    process.env.AGENT_ORCH_RESUME_BLOCKED_AFTER = '30m';
    assert.equal(attentionOf(row({}, { resumeWaitsSince: ago(20 * 60_000) }), false, now), null);
    assert.equal(attentionOf(row({}, { resumeWaitsSince: ago(30 * 60_000) }), false, now).kind, 'resume-blocked');
    process.env.AGENT_ORCH_RESUME_BLOCKED_AFTER = '1m';
    assert.equal(attentionOf(row({}, { resumeWaitsSince: ago(61_000) }), false, now).kind, 'resume-blocked');
  } finally {
    if (saved === undefined) delete process.env.AGENT_ORCH_RESUME_BLOCKED_AFTER;
    else process.env.AGENT_ORCH_RESUME_BLOCKED_AFTER = saved;
  }

  // wait and escalation read the same item, and an agent that started the task is told what to do.
  const shown = taskAttention(row(), false);
  assert.deepEqual([shown.kind, shown.label], ['resume-blocked', 'resume blocked']);
  const notice = agentNoticeText('run-1', { id: 'sit', attempt: 1 }, item, 14 * 3600_000);
  assert.match(notice, /resume blocked — its watcher cannot resume it/);
  assert.match(notice, /give the task its own worktree/);
  assert.match(notice, /start run-1 sit \.\.\. --force/);
  assert.match(notice, /or wait for the other writer to finish/);
  assert.match(goneText('sit', { ...item, agent: 'orchestrator session 425c2bc2', gone: 'its process has ended' }, 25 * 60_000), /sit has waited 25m while its resume is blocked$/);
});

test('a refused resume is recorded with its first time, shows everywhere, and clears when the resume succeeds', async (t) => {
  const f = await fixture(t);
  f.env.AGENT_ORCH_RESUME_BLOCKED_AFTER = '1ms'; // any refusal counts as old, so the test needs no long wait
  const r = await f.newRun();
  const ready = path.join(f.root, 'deploy-ready');
  // Another writer holds the checkout, so the same-checkout rule refuses each of the watcher's tries.
  const sit = await f.start(r, 'sit', { config: { hold: true, finalMessage: PARKED } });
  await f.ready(sit);
  await f.command(['park-until', '--every', '30s', '--why', 'the deploy', '--', ...condition(ready)], {
    env: { AGENT_ORCH_RUN: r.id, AGENT_ORCH_TASK: 'sit' },
  });
  const condFile = path.join(sit.outDir, 'park-until.json');
  writeJson(condFile, { ...readJson(condFile), every: 1000 });
  f.release(sit);
  const parked = () => eventually(async () => {
    const row = await rowOf(f, r, 'sit');
    return row?.phase === 'parked' && row.parked.watcher === 'alive' ? row : null;
  }, 'sit did not park with a live watcher', SLOW);
  await parked();
  const writer = await f.start(r, 'writer', { config: { hold: true }, flags: ['--force'] });
  await f.ready(writer);
  const board = await f.dashboard();

  // wait starts before the first refusal, so the item is new to it and ends it with exit 5.
  const waiting = f.command(['wait', r.id, 'sit', '--timeout', '14s'], { code: 5 });
  fs.writeFileSync(ready, '');
  const waited = await waiting;
  assert.match(waited.stdout, /sit: resume blocked — its watcher cannot resume it, and has tried for \S+: task writer is already writing in /);
  assert.match(waited.stdout, /To clear it: give the task its own worktree, pass --force to `start`, or wait for the other writer\. The watcher keeps trying/);
  assert.match(waited.stdout, /a task needs attention/);

  // The check recorded the refusal and when its streak began; later refusals keep that time.
  const first = readJson(checkFile(r, 'sit'));
  assert.match(first.waiting, /^task writer is already writing in /);
  assert.ok(Date.parse(first.waitingSince) <= Date.parse(first.at));
  const again = await eventually(() => {
    const check = readJson(checkFile(r, 'sit'));
    return check.at !== first.at && check.waiting ? check : null;
  }, 'the watcher did not try again', SLOW);
  assert.equal(again.waitingSince, first.waitingSince, 'the streak keeps its first time');

  // status says it, in the row's activity and in the JSON; the dashboard lists the item.
  const row = await rowOf(f, r, 'sit');
  assert.equal(row.parked.resumeWaitsSince, first.waitingSince);
  assert.match(row.now, /^parked · resume blocked for \S+: task writer is already writing in /);
  assert.match((await f.command(['status', r.id])).stdout, /parked · resume blocked for/);
  const section = await eventually(async () => {
    const s = (await board.json('/api/state')).find((x) => x.tasks.some((t2) => t2.id === 'sit'));
    return s?.attention.some((a) => a.id === 'sit') ? s : null;
  }, 'the dashboard did not list the blocked resume', SLOW);
  const item = section.attention.find((a) => a.id === 'sit');
  assert.deepEqual([item.kind, item.label, item.rank], ['resume-blocked', 'resume blocked', 2.8]);
  assert.match(item.reason, /task writer is already writing in .*pass --force to `start`/);

  // The other writer ends: the watcher's next try succeeds, and the record of the refusal is gone.
  f.release(writer);
  await f.finished(r, 'writer');
  await eventually(() => readJson(f.taskFile(r, 'sit')).attempt === 2, 'the watcher did not resume the task', SLOW);
  const resumed = readJson(checkFile(r, 'sit'));
  assert.equal(resumed.resumed, 2);
  assert.equal(resumed.waiting, undefined);
  assert.equal(resumed.waitingSince, undefined);
  await eventually(async () => !(await board.json('/api/state')).some((s) => s.attention.some((a) => a.id === 'sit' && a.kind === 'resume-blocked')), 'the item stayed on the dashboard', SLOW);
});
