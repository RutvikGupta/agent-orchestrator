import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

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

  // Seed legacy fields that earlier runs could have written to task.json.
  const taskFile = f.taskFile(run, 'legacy');
  writeJson(taskFile, {
    ...readJson(taskFile),
    babysit: true,
    pr: { number: 42, url: 'https://github.com/example-org/example-repo/pull/42' },
    prWatch: { checkedAt: '2026-11-01T00:00:00.000Z', state: 'OPEN' },
    watchTier: 'standard',
    plan: { id: 'legacy', goal: 'Legacy task', type: 'babysit', owns: [], dependsOn: [], agent: 'claude', tier: 'standard', why: 'Legacy', brief: 'briefs/legacy.md' },
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
  const statusText = (await f.command(['status', run.id])).stdout;
  assert.match(statusText, /^legacy\b/m);
  assert.doesNotMatch(statusText, /\b(babysit|handoff|fix)\b/i);

  // recover
  const recover = await f.json(['recover', run.id]);
  assert.ok(recover.runs[0].groups['awaiting-review'].some((x) => x.id === 'legacy'));
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
});
