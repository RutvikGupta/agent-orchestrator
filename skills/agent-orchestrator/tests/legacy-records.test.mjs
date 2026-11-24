import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

const SLOW = 20000;
const startedAt = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
  encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
}).stdout.replace(/\s+/g, ' ').trim();

test('retired babysitter CLI options, commands, brief/plan types and pick abilities are refused', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();

  const startBabysit = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--tier', 'standard', '--why', 'Retired', '--brief', f.brief('sit'), '--babysit'], { code: 2 });
  assert.match(startBabysit.stderr, /unknown option --babysit/);

  const startPr = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--tier', 'standard', '--why', 'Retired', '--brief', f.brief('sit'), '--pr', '42'], { code: 2 });
  assert.match(startPr.stderr, /unknown option --pr/);

  const prWatch = await f.command(['pr-watch', '42'], { code: 2 });
  assert.match(prWatch.stderr, /unknown command "pr-watch"/);

  const brief = await f.command(['brief', run.id, 'sit', '--type', 'babysit'], { code: 2 });
  assert.match(brief.stderr, /unknown --type "babysit"/);

  const pick = await f.command(['pick', '--type', 'implement', '--tier', 'standard', '--needs', 'babysit'], { code: 2 });
  assert.match(pick.stderr, /unknown --needs "babysit"/);

  const planFile = path.join(f.root, 'retired-plan.json');
  writeJson(planFile, {
    goal: 'Reject retired plan type',
    tasks: [{
      id: 'sit', goal: 'Watch PR', type: 'babysit', owns: [], dependsOn: [],
      agent: 'claude', tier: 'standard', why: 'Fixture', brief: f.brief('sit'),
    }],
  });
  const plan = await f.command(['plan', run.id, planFile], { code: 1 });
  assert.match(plan.stderr, /type must be one of implement, review, research, debug/);
});

test('older task records with retired babysitter fields load cleanly as ordinary tasks', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'legacy');
  await f.finished(run, 'legacy');
  // A real second attempt so historical attemptReasons ({ 2: "fix" }) reach status and dashboard.
  await f.start(run, 'legacy');
  await f.finished(run, 'legacy');

  // Seed legacy fields that earlier runs could have written to task.json.
  const taskFile = f.taskFile(run, 'legacy');
  writeJson(taskFile, {
    ...readJson(taskFile),
    babysit: true,
    pr: { number: 42, url: 'https://github.com/example-org/example-repo/pull/42' },
    prWatch: { checkedAt: '2026-11-01T00:00:00.000Z', state: 'OPEN' },
    watchTier: 'standard',
    plan: { id: 'legacy', goal: 'Legacy task', type: 'babysit', owns: [], dependsOn: [], agent: 'claude', tier: 'standard', why: 'Legacy', brief: 'briefs/legacy.md' },
    attemptReason: 'fix',
    attemptReasons: { 1: 'first', 2: 'fix' },
    fixes: { 2: { fromAttempt: 1, reason: 'fix', at: '2026-11-01T00:05:00.000Z' } },
    handoffs: { 3: { fromAttempt: 2, contextTokens: 160000, limit: 150000, limitKind: 'warm', at: '2026-11-01T00:10:00.000Z' } },
    handoffChecks: { 2: { ok: true, at: '2026-11-01T00:09:00.000Z' } },
  });

  // status (JSON + text)
  const statusJson = await f.json(['status', run.id]);
  const row = statusJson.tasks.find((x) => x.id === 'legacy');
  assert.equal(row.mode, 'write');
  assert.equal(row.state, 'completed');
  assert.equal(row.phase, 'awaiting-review');
  assert.equal(row.attemptReason, 'resume');
  assert.equal(row.attempts.find((a) => a.n === 2).reason, 'resume');
  assert.equal(row.attempts.some((a) => a.reason === 'fix'), false);
  const statusText = (await f.command(['status', run.id])).stdout;
  assert.match(statusText, /^legacy\b/m);
  assert.doesNotMatch(statusText, /\b(babysit|handoff|fix)\b/i);

  // recover
  const recover = await f.json(['recover', run.id]);
  assert.ok(recover.runs[0].groups['awaiting-review'].some((x) => x.id === 'legacy'));
  assert.deepEqual(recover.runs[0].groups.manual, []);
  await f.command(['recover', run.id]);

  // result
  const result = await f.json(['result', run.id, 'legacy']);
  assert.equal(result.mode, 'write');
  assert.equal(result.state, 'completed');
  await f.command(['result', run.id, 'legacy']);

  // stats: no "babysit" task type appears; legacy task is counted as an ordinary write task.
  const stats = await f.json(['stats']);
  assert.equal(stats.byType.some((g) => g.type === 'babysit'), false);
  assert.ok(stats.byType.some((g) => g.type === 'write' && g.tasks >= 1));
  assert.doesNotMatch((await f.command(['stats'])).stdout, /\bbabysit\b/i);

  // cost
  const cost = await f.json(['cost', run.id, 'legacy']);
  assert.equal(cost.task, 'legacy');
  await f.command(['cost', run.id, 'legacy']);

  // gc
  await f.json(['gc', '--dry-run']);

  // dashboard
  const board = await f.dashboard();
  const sections = await board.json('/api/state');
  const dashRow = sections.flatMap((s) => s.tasks).find((x) => x.id === 'legacy');
  assert.ok(dashRow, 'legacy task appears on the dashboard');
  assert.equal(dashRow.mode, 'write');
  assert.equal(dashRow.state, 'completed');
  assert.equal(dashRow.attempts.find((a) => a.n === 2).reason, 'resume');
  assert.equal(dashRow.attempts.some((a) => a.reason === 'fix'), false);
});

test('saved plans with a retired babysit entry are refused by dispatch and first start, and normalized in status', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const sitBrief = f.brief('sit');
  const workBrief = f.brief('work');

  // Persist a plan directly on disk as an earlier version would have saved it.
  writeJson(path.join(run.dir, 'plan.json'), {
    goal: 'Saved plan with a retired entry',
    tasks: [
      { id: 'sit', goal: 'Watch PR', type: 'babysit', owns: [], dependsOn: [], agent: 'claude', tier: 'standard', why: 'Saved', brief: sitBrief },
      { id: 'work', goal: 'Ordinary work', type: 'implement', owns: ['a.txt'], dependsOn: [], agent: 'claude', tier: 'standard', why: 'Ordinary', brief: workBrief },
    ],
  });

  // status --json normalizes the retired type rather than exposing "babysit".
  const status = await f.json(['status', run.id]);
  assert.equal(status.plannedTasks.find((p) => p.id === 'sit').type, 'retired');
  assert.equal(status.plannedTasks.find((p) => p.id === 'work').type, 'implement');

  // dispatch --dry-run --json refuses the retired entry (exits 1), schedules the ordinary one, and keeps manual: [].
  const dry = await f.json(['dispatch', run.id, '--dry-run'], { code: 1 });
  assert.deepEqual(dry.wouldStart.map((x) => x.id), ['work']);
  assert.equal(dry.failed.length, 1);
  assert.equal(dry.failed[0].id, 'sit');
  assert.match(dry.failed[0].error, /type "babysit" is no longer supported/);
  assert.deepEqual(dry.manual, []);

  // recover --json preserves groups.manual: [].
  const recover = await f.json(['recover', run.id]);
  assert.deepEqual(recover.runs[0].groups.manual, []);

  // First `start` of the retired entry is also refused, even with --force.
  const refused = await f.command([
    'start', run.id, 'sit', '--agent', 'claude', '--tier', 'standard',
    '--why', 'Try starting retired entry', '--brief', sitBrief, '--force',
  ], { code: 1 });
  assert.match(refused.stderr, /type "babysit" is no longer supported/);
  assert.equal(fs.existsSync(f.taskFile(run, 'sit')), false);

  // Real dispatch refuses `sit` (exits 1) and starts only `work`.
  const dispatched = await f.json(['dispatch', run.id], { code: 1 });
  assert.deepEqual(dispatched.started.map((x) => x.id), ['work']);
  assert.equal(dispatched.failed[0].id, 'sit');
  assert.deepEqual(dispatched.manual, []);
  assert.equal(fs.existsSync(f.taskFile(run, 'sit')), false);
  await f.finished(run, 'work');

  // An ordinary implement plan exits 0 on dispatch --dry-run --json with manual: [].
  const okRun = await f.newRun('ordinary');
  const okBrief = f.brief('impl');
  const okPlan = path.join(f.root, 'ordinary-plan.json');
  writeJson(okPlan, {
    goal: 'Ordinary implement plan',
    tasks: [{ id: 'impl', goal: 'Implement', type: 'implement', owns: ['b.txt'], dependsOn: [], agent: 'claude', tier: 'standard', why: 'Ordinary', brief: okBrief }],
  });
  await f.command(['plan', okRun.id, okPlan]);
  const okDry = await f.json(['dispatch', okRun.id, '--dry-run']);
  assert.deepEqual(okDry.wouldStart.map((x) => x.id), ['impl']);
  assert.deepEqual(okDry.manual, []);
  const okRecover = await f.json(['recover', okRun.id]);
  assert.deepEqual(okRecover.runs[0].groups.manual, []);
});

test('a parked parent wakes when a legacy PR child has a suppressed parked notice', async (t) => {
  const f = await fixture(t);
  // Attempt 2 of the parent holds once its park watcher wakes it.
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: 'Woke up and handled the legacy child.' });
  const parentRun = await f.newRun('parent');
  const lead = await f.start(parentRun, 'lead', { config: { hold: true, finalMessage: 'PARKED: waits for legacy child' } });
  await f.ready(lead);

  const childEnv = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parentRun.id, AGENT_ORCH_TASK: 'lead' };
  const childRun = await f.newRun('child', childEnv);
  const child = await f.start(childRun, 'old-pr', { config: { hold: true, finalMessage: 'PARKED: waits for PR #42' }, env: childEnv });
  await f.ready(child);

  // Pre-seed the legacy suppressed parent-notice.json before the child finishes so its finish
  // watcher leaves the legacy record intact (matching an upgrade from before babysitter removal).
  const noticeFile = path.join(child.outDir, 'parent-notice.json');
  writeJson(noticeFile, {
    attempt: 1,
    claimedAt: '2026-11-01T00:00:00.000Z',
    parked: true,
    watcher: 999999,
    skipped: 'the task parked: it still runs as far as its parent can tell, and its watcher resumes it on the next event',
  });
  f.release(child);
  await f.finished(childRun, 'old-pr');

  // Add legacy PR-only babysitter fields to the child task record.
  writeJson(f.taskFile(childRun, 'old-pr'), {
    ...readJson(f.taskFile(childRun, 'old-pr')),
    babysit: true,
    pr: { number: 42, url: 'https://github.com/example-org/example-repo/pull/42' },
  });

  // Verify directly (without spawning a watcher yet) that isParked(parent) stays true on upgrade
  // and lateNotices finds the legacy child's suppressed notice.
  f.release(lead);
  await eventually(() => fs.existsSync(path.join(lead.outDir, 'result.json')), 'lead attempt 1 did not finish', SLOW);

  // The finish watcher starts the parent's park watcher, which converts the legacy suppressed
  // notice into one child-finish notification and wakes the parent into attempt 2.
  const resumed = await eventually(() => {
    const task = readJson(f.taskFile(parentRun, 'lead'));
    return task.attempt === 2 ? task : null;
  }, 'parent did not wake for legacy child', SLOW);
  await f.ready(resumed);

  const notice = readJson(noticeFile);
  assert.ok(notice.message, 'legacy suppressed notice was converted into a delivered finish notice');
  assert.ok(notice.sentAt);
  assert.equal(notice.skipped, undefined);
  assert.match(notice.recovered, /retired park/);

  const brief = fs.readFileSync(path.join(resumed.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /A task you started has finished: its notice is among the messages below/);
  assert.match(brief, new RegExp(`Message from agent:${childRun.id}/old-pr`));

  // Exactly one finished notice was delivered to the parent's inbox.
  const inboxLines = fs.readFileSync(path.join(parentRun.dir, 'tasks', 'lead', 'inbox.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const finishedNotices = inboxLines.filter((m) => m.kind === 'finished' && m.from === `agent:${childRun.id}/old-pr`);
  assert.equal(finishedNotices.length, 1);

  f.release(resumed);
  await f.finished(parentRun, 'lead');
});

test('stop cancels a live park claim on a legacy PR-only park', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'old-pr', { config: { finalMessage: 'PARKED: waits for PR #42' } });
  await f.finished(run, 'old-pr');

  const taskFile = f.taskFile(run, 'old-pr');
  writeJson(taskFile, {
    ...readJson(taskFile),
    babysit: true,
    pr: { number: 42, url: 'https://github.com/example-org/example-repo/pull/42' },
  });

  // Simulate an in-progress legacy resume holding park-claim-1.json that releases once stoppedAt
  // appears on task.json (matching how a watcher's startTask yields to stop).
  const claim1 = path.join(task.outDir, 'park-claim-1.json');
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const taskFile = process.argv[1];
    const claimFile = process.argv[2];
    const check = () => {
      try {
        if (JSON.parse(fs.readFileSync(taskFile, 'utf8')).stoppedAt) {
          const rec = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
          fs.writeFileSync(claimFile, JSON.stringify({ ...rec, released: true, releasedAt: new Date().toISOString() }) + '\\n');
          process.exit(0);
        }
      } catch {}
    };
    setInterval(check, 50);
  `, taskFile, claim1], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });

  writeJson(claim1, {
    by: 'watcher',
    claimedAt: new Date().toISOString(),
    owner: { pid: holder.pid, started: startedAt(holder.pid) },
  });

  const stopped = await f.command(['stop', run.id, 'old-pr']);
  assert.match(stopped.stdout, /^stopped parked old-pr/);
  assert.ok(readJson(taskFile).stoppedAt, 'stop marked stoppedAt on the legacy record');
  const claim2 = readJson(path.join(task.outDir, 'park-claim-2.json'));
  assert.equal(claim2.by, 'stop');
  assert.equal(claim2.ended, true);
});
