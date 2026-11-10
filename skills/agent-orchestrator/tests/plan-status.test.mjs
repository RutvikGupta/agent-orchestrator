import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

// `status` shows the whole plan, never-started tasks included, the receipt `integrate` recorded,
// and a warning for each task whose branch was merged by hand. Everything runs in temporary runs.

function entry(f, id, extra = {}, config = {}) {
  return {
    id, goal: `Build ${id}`, type: 'implement', owns: [`src/${id}`], dependsOn: [],
    agent: 'claude', tier: 'complex', why: 'Fixture plan', brief: f.brief(id, config), ...extra,
  };
}

async function accept(f, run, id) {
  await f.command(['verify', run.id, id, '--', process.execPath, '-e', 'process.exit(0)']);
  await f.command(['verdict', run.id, id, 'clean', '--note', 'Reviewed fixture change']);
  await f.command(['accept', run.id, id, '--note', 'Reviewed and verified fixture']);
}

async function commit(f, cd, file) {
  fs.writeFileSync(path.join(cd, file), `${file}\n`);
  await f.git(['-C', cd, 'add', file]);
  await f.git(['-C', cd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', `Add ${file}`]);
  return f.git(['-C', cd, 'rev-parse', 'HEAD']);
}

test('status shows the plan from waiting to integrated, with the receipt and hand-merge warnings', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const plan = [
    entry(f, 'base'),
    entry(f, 'api', { dependsOn: ['base'] }),
    entry(f, 'ui', { dependsOn: ['base'] }),
    entry(f, 'live', { dependsOn: ['base'] }, { hold: true }),
    entry(f, 'docs', { dependsOn: ['api', 'ui'] }),
    entry(f, 'qa', { dependsOn: ['live', 'docs'] }),
    entry(f, 'notes'),
    entry(f, 'release', { dependsOn: ['base'], brief: 'briefs/release.md' }), // its brief is not written yet
    entry(f, 'watch-pr', { type: 'babysit', owns: [], tier: null }),
  ];
  const file = path.join(f.root, 'plan-input.json');
  writeJson(file, { goal: 'Ship the planned waves', tasks: plan });
  await f.command(['plan', run.id, file]);
  const task = (id) => readJson(f.taskFile(run, id));

  // Wave 1: only `base` takes the one slot; `notes` is ready but never starts. Integrate it for real.
  await f.command(['dispatch', run.id, '--max', '1']);
  await f.finished(run, 'base');
  await commit(f, task('base').cd, 'base.txt');
  await accept(f, run, 'base');
  await f.command(['integrate', run.id, 'base']);
  const head = await f.git(['rev-parse', 'HEAD']);

  // Wave 2: api and ui finish, live keeps running. Their branches are merged by hand, and ui is accepted.
  // dispatch exits 1 because release's brief is not written; the three tasks with slots still start.
  const wave = await f.command(['dispatch', run.id, '--max', '3'], { code: 1 });
  assert.match(wave.stdout, /could not start release: brief is missing or empty/);
  await f.finished(run, 'api');
  await f.finished(run, 'ui');
  await f.ready(task('live'));
  const tips = {};
  for (const id of ['api', 'ui', 'live']) tips[id] = await commit(f, task(id).cd, `${id}.txt`);
  for (const id of ['api', 'ui', 'live']) await f.git(['merge', '--no-ff', '-qm', `Merge ${id} by hand`, task(id).worktree.branch]);
  await accept(f, run, 'ui');
  await f.command(['start', run.id, 'extra', '--agent', 'claude', '--tier', 'complex', '--why', 'Fixture',
    '--brief', f.brief('extra'), '--unplanned', '--read-only']);

  const status = await f.json(['status', run.id]);
  const rows = Object.fromEntries(status.plannedTasks.map((p) => [p.id, p]));
  assert.deepEqual(status.plannedTasks.map((p) => [p.id, p.status]), [
    ['base', 'integrated'], ['api', 'awaiting-review'], ['ui', 'accepted'], ['live', 'running'], ['docs', 'waiting'],
    ['qa', 'waiting'], ['notes', 'ready'], ['release', 'ready'], ['watch-pr', 'ready'],
  ], 'every planned task, in plan order, whether or not it started');
  assert.deepEqual([rows.base.integratedCommit, rows.base.integratedInto], [head, 'main']);
  assert.deepEqual(rows.docs.waitsOn, [{ id: 'api', phase: 'awaiting-review' }, { id: 'ui', phase: 'accepted' }]);
  assert.deepEqual(rows.qa.waitsOn, [{ id: 'live', phase: 'running' }, { id: 'docs', phase: 'not started' }]);
  assert.match(rows.release.briefProblem, /not written yet/);
  assert.equal(rows['watch-pr'].manual, true);
  assert.deepEqual([rows.docs.dependsOn, rows.docs.agent, rows.docs.tier, rows['watch-pr'].tier], [['api', 'ui'], 'claude', 'complex', null]);
  assert.deepEqual(status.unplannedTasks, ['extra']);
  // `tasks` is as before: only recorded tasks. The planned rows are extra.
  assert.deepEqual(status.tasks.map((x) => x.id).sort(), ['api', 'base', 'extra', 'live', 'ui']);
  const branch = (id) => task(id).worktree.branch;
  assert.deepEqual(
    [...status.manualMerges].sort((a, b) => a.id.localeCompare(b.id)),
    [['api', 'awaiting-review'], ['live', 'running'], ['ui', 'accepted']].map(([id, phase]) => ({ id, phase, branch: branch(id), into: 'main', commit: tips[id] })),
    'every unintegrated writer branch that main already contains, whatever its phase; not integrated base',
  );

  const text = (await f.command(['status', run.id])).stdout.replace(/node \S+orch\.mjs/g, 'orch');
  assert.match(text, /^plan: Ship the planned waves \(9 tasks: 2 waiting, 3 ready, 1 running, 1 awaiting-review, 1 accepted, 1 integrated\)$/m);
  assert.match(text, new RegExp(`^base\\s+integrated\\s+at ${head.slice(0, 12)} in main$`, 'm'));
  assert.match(text, /^api\s+awaiting-review$/m);
  assert.match(text, /^ui\s+accepted$/m);
  assert.match(text, /^live\s+running$/m);
  assert.match(text, /^docs\s+waiting\s+waits on api \(awaiting-review\), ui \(accepted\)$/m);
  assert.match(text, /^qa\s+waiting\s+waits on live \(running\), docs \(not started\)$/m);
  assert.match(text, /^notes\s+ready$/m);
  assert.match(text, /^release\s+ready\s+brief not written yet$/m);
  assert.match(text, /^watch-pr\s+ready\s+start by hand: it babysits a pull request$/m);
  assert.match(text, /^recorded outside the plan: extra$/m);
  const warning = (id, phase, fix) => `warning: ${id}'s branch ${branch(id)} (${tips[id].slice(0, 12)}) is already in main, but ${id} is not recorded as integrated (${phase}).\n  ${fix}`;
  const recordIt = (id) => `record it: orch integrate ${run.id} ${id} --already-merged`;
  assert.ok(text.includes(warning('ui', 'accepted', recordIt('ui'))), text);
  assert.ok(text.includes(warning('api', 'awaiting-review', `review it and accept it (orch accept ${run.id} api), then ${recordIt('api')}`)), text);
  assert.ok(text.includes(warning('live', 'running', `once it is finished, reviewed and accepted, ${recordIt('live')}`)), text);
  assert.doesNotMatch(text, /warning: base/);

  // Recording the merge clears the warning.
  await f.command(['integrate', run.id, 'ui', '--already-merged']);
  assert.deepEqual((await f.json(['status', run.id])).manualMerges.map((m) => m.id).sort(), ['api', 'live']);

  f.release(task('live'));
  await f.finished(run, 'live');
});

test('help explains the plan options, and each option is accepted only by its own command', async (t) => {
  const f = await fixture(t);
  const help = (await f.command(['--help'])).stdout;
  for (const text of [
    'dispatch RUN [--max N] [--dry-run] [--follow]',
    '--follow stays after that first wave',
    'a decision handed back, or a failure',
    'from the head of the branch they were integrated into',
    'integrate RUN TASK [--into BRANCH] [--dry-run] [--already-merged]',
    '--already-merged records an',
    'accepted task whose branch was merged earlier',
    '[--max-parallel N] [--force] [--unplanned] [--babysit --pr N]',
    '[--max-parallel N] [--force] [--unplanned] -- COMMAND [ARG...]',
    '--force bypasses those checks. A task the plan',
    'does not name needs --unplanned, which --force does not imply',
    'for each task whose branch was already merged by hand',
    'plannedTasks, unplannedTasks and manualMerges',
  ]) assert.ok(help.includes(text), `help lacks: ${text}`);

  // A run with no plan: each new option parses, and the command then fails for its own reason.
  const run = await f.newRun();
  assert.match((await f.command(['dispatch', run.id, '--follow'], { code: 1 })).stderr, /has no plan/);
  assert.match((await f.command(['integrate', run.id, 'nope', '--already-merged'], { code: 1 })).stderr, /no task nope/);
  assert.match((await f.command(['start', run.id, 'nope', '--unplanned'], { code: 2 })).stderr, /--agent is required/);
  // The options belong to their commands: another command still refuses them.
  assert.match((await f.command(['status', run.id, '--follow'], { code: 2 })).stderr, /unknown option --follow/);
  assert.match((await f.command(['dispatch', run.id, '--already-merged'], { code: 2 })).stderr, /unknown option --already-merged/);
  assert.match((await f.command(['integrate', run.id, 'nope', '--unplanned'], { code: 2 })).stderr, /unknown option --unplanned/);

  // A run with no plan or tasks: status keeps its output and adds only empty lists.
  const status = await f.json(['status', run.id]);
  assert.deepEqual([status.tasks, status.plannedTasks, status.unplannedTasks, status.manualMerges], [[], [], [], []]);
  assert.doesNotMatch((await f.command(['status', run.id])).stdout, /plan:|warning:|outside the plan/);
});
