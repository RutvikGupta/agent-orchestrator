import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

function entry(f, id, extra = {}, config = {}) {
  return { id, goal: `Build ${id}`, type: 'implement', owns: [`src/${id}`], dependsOn: [],
    agent: 'claude', tier: 'complex', why: 'Fixture plan', brief: f.brief(id, config), ...extra };
}
async function plan(f, run, tasks) {
  const file = path.join(f.root, 'plan-input.json');
  writeJson(file, { goal: 'Run the planned waves', tasks });
  await f.command(['plan', run.id, file]);
}
async function commit(f, cd, file = 'change.txt') {
  fs.writeFileSync(path.join(cd, file), 'Integrated work\n');
  await f.git(['-C', cd, 'add', file]);
  await f.git(['-C', cd, 'commit', '-qm', 'Fixture change']);
  return f.git(['-C', cd, 'rev-parse', 'HEAD']);
}
async function accept(f, run, id) {
  await f.command(['verify', run.id, id, '--', process.execPath, '-e', 'process.exit(0)']);
  await f.command(['verdict', run.id, id, 'clean', '--note', 'Reviewed fixture change']);
  await f.command(['accept', run.id, id, '--note', 'Reviewed and verified fixture']);
}
async function ready(f, run, id) {
  await eventually(() => fs.existsSync(f.taskFile(run, id)) && readJson(f.taskFile(run, id)).outDir, `${id} not dispatched`);
  const task = readJson(f.taskFile(run, id));
  await f.ready(task);
  return task;
}

test('dispatch --follow runs two resumable waves from the integration branch and stops for review', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'first', {}, { hold: true }), entry(f, 'second', { dependsOn: ['first'] }, { hold: true })]);
  let exited = false;
  const firstFollow = f.json(['dispatch', run.id, '--follow']).then((r) => { exited = true; return r; });
  const first = await ready(f, run, 'first');
  assert.equal(exited, false, 'follow must wait while its task runs');
  assert.equal(fs.existsSync(f.taskFile(run, 'second')), false);
  await commit(f, first.cd);
  f.release(first);
  const firstResult = await firstFollow;
  assert.equal(firstResult.reason, 'attention');
  assert.deepEqual(firstResult.attention.map((a) => [a.id, a.phase]), [['first', 'awaiting-review']]);
  await accept(f, run, 'first');
  const accepted = await f.json(['dispatch', run.id, '--follow']);
  assert.equal(accepted.attention[0].phase, 'accepted');
  assert.deepEqual(accepted.started, []);
  await f.git(['checkout', '-qb', 'integration']);
  await f.command(['integrate', run.id, 'first', '--into', 'integration']);
  const integrated = await f.git(['rev-parse', 'HEAD']);
  assert.equal(readJson(f.taskFile(run, 'first')).integratedInto, 'integration');
  await f.git(['checkout', '-q', 'main']);
  const secondFollow = f.json(['dispatch', run.id, '--follow']);
  const second = await ready(f, run, 'second');
  assert.equal(second.worktree.from, integrated);
  assert.equal(await f.git(['-C', second.cd, 'rev-parse', 'HEAD']), integrated);
  assert.equal(fs.readFileSync(path.join(second.cd, 'change.txt'), 'utf8'), 'Integrated work\n');
  await commit(f, second.cd, 'second.txt');
  f.release(second);
  assert.equal((await secondFollow).attention[0].id, 'second');
  await accept(f, run, 'second');
  await f.git(['checkout', '-q', 'integration']);
  await f.command(['integrate', run.id, 'second', '--into', 'integration']);
  const done = await f.json(['dispatch', run.id, '--follow']);
  assert.equal(done.complete, true);
  assert.deepEqual(done.started, []);
  assert.equal(readJson(f.taskFile(run, 'second')).attempt, 1);
});

test('start enforces dependency, running ownership and unplanned checks with explicit overrides', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const tasks = [entry(f, 'first', { owns: ['src/'] }), entry(f, 'later', { owns: ['src/later'], dependsOn: ['first'] })];
  await plan(f, run, tasks);
  const args = (id) => ['start', run.id, id, '--agent', 'claude', '--tier', 'complex', '--why', 'Fixture', '--brief', f.brief(id, { hold: true })];
  assert.match((await f.command(args('later'), { code: 1 })).stderr, /waits on first .*not integrated/);
  assert.equal(fs.existsSync(f.taskFile(run, 'later')), false);
  const first = await f.json(args('first'));
  await f.ready(first);
  // A dependency edge does not hide an overlapping running writer from the runtime check.
  const refused = await f.command(args('later'), { code: 1 });
  assert.match(refused.stderr, /conflicts with running task first: src\/later \/ src\//);
  assert.match((await f.command([...args('extra'), '--force'], { code: 1 })).stderr, /not in the plan.*--unplanned/);
  const later = await f.json([...args('later'), '--force']);
  await f.ready(later);
  assert.deepEqual(later.plan, tasks[1]);
  const extra = await f.json([...args('extra'), '--unplanned', '--force']);
  assert.equal(extra.unplanned, true);
  assert.ok(extra.unplannedAt);
  await f.ready(extra);
  for (const task of [first, later, extra]) f.release(task);
  for (const task of [first, later, extra]) await f.finished(run, task.id);
  await accept(f, run, 'later');
  assert.match((await f.command(['integrate', run.id, 'later'], { code: 1 })).stderr, /waits on first/);
});

test('dispatch skips runtime ownership conflicts and fills available slots with independent tasks', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const tasks = [entry(f, 'first', {}, { hold: true }), entry(f, 'second'), entry(f, 'third')];
  await plan(f, run, tasks);
  await f.command(['dispatch', run.id, '--max', '1']);
  const first = await ready(f, run, 'first');
  // A reservation retained from a prior plan must remain effective even if the current plan shrinks it.
  writeJson(f.taskFile(run, 'first'), { ...first, plan: { ...first.plan, owns: ['src/first', 'src/second'] } });
  const dry = await f.json(['dispatch', run.id, '--dry-run']);
  assert.deepEqual(dry.wouldStart.map((x) => x.id), ['third']);
  assert.deepEqual(dry.waitingForConflict.map((x) => x.id), ['second']);
  const wave = await f.json(['dispatch', run.id]);
  assert.deepEqual(wave.started.map((x) => x.id), ['third']);
  assert.deepEqual(wave.waitingForConflict.map((x) => x.id), ['second']);
  assert.equal(fs.existsSync(f.taskFile(run, 'second')), false);
  f.release(first);
  await f.finished(run, 'first');
  await f.finished(run, 'third');
});

test('status and recover flag hand merges; --already-merged checks reachability and records integration', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'writer')]);
  await f.command(['dispatch', run.id]);
  await f.finished(run, 'writer');
  const task = readJson(f.taskFile(run, 'writer'));
  assert.deepEqual((await f.json(['recover', run.id])).runs[0].manualMerges, [], 'unchanged branch is not a hand merge');
  const tip = await commit(f, task.cd);
  await accept(f, run, 'writer');
  const rejected = await f.command(['integrate', run.id, 'writer', '--already-merged'], { code: 1 });
  assert.match(rejected.stderr, /does not contain.*--already-merged/);
  assert.equal(readJson(f.taskFile(run, 'writer')).integratedAt, undefined);
  await f.git(['merge', '--no-ff', '-qm', 'Manual fixture merge', task.worktree.branch]);
  const head = await f.git(['rev-parse', 'HEAD']);
  const recovered = (await f.json(['recover', run.id])).runs[0];
  assert.deepEqual(recovered.manualMerges, [{ id: 'writer', branch: task.worktree.branch, into: 'main', commit: tip }]);
  assert.match(recovered.warnings.join('\n'), /without integrate.*--already-merged/);
  assert.match((await f.command(['status', run.id])).stdout, /--already-merged/);
  // Recording evidence does not need the target checkout and must not alter unrelated local work.
  await f.git(['checkout', '-qb', 'elsewhere']);
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'Local edits\n');
  await f.command(['integrate', run.id, 'writer', '--already-merged', '--dry-run']);
  assert.equal(readJson(f.taskFile(run, 'writer')).integratedAt, undefined);
  await f.command(['integrate', run.id, 'writer', '--already-merged']);
  assert.equal(readJson(f.taskFile(run, 'writer')).integratedCommit, head);
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), 'Local edits\n');
  assert.equal((await f.json(['status', run.id])).tasks.find((r) => r.id === 'writer').phase, 'integrated');
  assert.deepEqual((await f.json(['recover', run.id])).runs[0].manualMerges, []);
});

test('third task without a plan prints one suggestion and preserves unplanned run behavior', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (let n = 1; n <= 4; n++) {
    const result = await f.command(['start', run.id, `task-${n}`, '--agent', 'claude', '--tier', 'complex', '--why', 'Fixture', '--brief', f.brief(`task-${n}`)]);
    assert.equal(/third task without a plan.* plan /.test(result.stderr), n === 3);
    await f.finished(run, `task-${n}`);
  }
});

for (const [name, config, phase, code] of [
  ['decision', { finalMessage: 'NEEDS DECISION: Choose a direction.' }, 'needs-decision', 0],
  ['failure', { status: 'failed' }, 'failed', 1],
]) test(`dispatch --follow stops for a ${name}`, async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, name, {}, config)]);
  const result = await f.json(['dispatch', run.id, '--follow'], { code });
  assert.equal(result.attention[0].phase, phase);
});

test('a following dispatch observes integration during its wait and launches the next wave without restarting', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'superseded', { config: { status: 'failed' } });
  await f.finished(run, 'superseded');
  await f.command(['result', run.id, 'superseded']); // closed work outside the plan needs no attention

  await plan(f, run, [entry(f, 'producer', {}, { hold: true }), entry(f, 'consumer', { dependsOn: ['producer'] }, { hold: true })]);
  // Hold the first polling callback while the coordinator reviews and integrates the producer.
  // This synchronizes on the poll itself, so the test never guesses when dispatch will read state.
  const marker = path.join(f.root, 'dispatch-poll');
  const preload = path.join(f.root, 'dispatch-poll.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const original = global.setTimeout;
let observed = false;
global.setTimeout = (callback, ms, ...args) => {
  if (ms !== 1000 || observed || !process.argv.includes('dispatch')) return original(callback, ms, ...args);
  observed = true;
  fs.writeFileSync(${JSON.stringify(marker)}, '');
  return original(function released() {
    if (!fs.existsSync(${JSON.stringify(marker + '.release')})) return original(released, 10);
    callback(...args);
  }, ms);
};`);
  const following = f.json(['dispatch', run.id, '--follow'], { env: { NODE_OPTIONS: `--require=${preload}`, AGENT_ORCH_MAX_PARALLEL: '1' } });
  try {
    await eventually(() => fs.existsSync(marker), 'dispatch never waited');
    const producer = await ready(f, run, 'producer');
    assert.equal(fs.existsSync(f.taskFile(run, 'consumer')), false);
    await commit(f, producer.cd);
    f.release(producer);
    await f.finished(run, 'producer');
    await accept(f, run, 'producer');
    await f.command(['integrate', run.id, 'producer']);
    const integrated = readJson(f.taskFile(run, 'producer')).integratedCommit;
    fs.writeFileSync(`${marker}.release`, '');
    const consumer = await ready(f, run, 'consumer');
    assert.equal(consumer.worktree.from, integrated);
    f.release(consumer);
    const out = await following;
    assert.deepEqual(out.started.map((task) => task.id), ['producer', 'consumer']);
    assert.deepEqual(out.attention.map((task) => task.id), ['consumer']);
  } finally {
    fs.writeFileSync(`${marker}.release`, '');
    await following;
  }
});

test('a prior integration receipt does not hide later commits merged by hand', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await plan(f, run, [entry(f, 'writer')]);
  await f.command(['dispatch', run.id]);
  await f.finished(run, 'writer');
  const task = readJson(f.taskFile(run, 'writer'));
  await commit(f, task.cd);
  await accept(f, run, 'writer');
  await f.command(['integrate', run.id, 'writer']);
  const oldReceipt = readJson(f.taskFile(run, 'writer')).integratedCommit;
  // Integrating collected the worktree and kept its branch: a resume says how to restore it.
  const gone = await f.command(['start', run.id, 'writer', '--agent', 'claude', '--tier', 'complex', '--why', 'resume', '--brief', f.brief('writer')], { code: 1 });
  assert.match(gone.stderr, /worktree was collected .* Restore the folder with `node \S+ worktree \S+ writer`/);
  await f.command(['worktree', run.id, 'writer', '--no-prep']);
  await f.start(run, 'writer');
  await f.finished(run, 'writer');
  const tip = await commit(f, task.cd, 'later.txt');
  await f.git(['merge', '--no-ff', '-qm', 'Later hand merge', task.worktree.branch]);
  assert.equal(readJson(f.taskFile(run, 'writer')).integratedCommit, oldReceipt);
  assert.equal((await f.json(['recover', run.id])).runs[0].manualMerges[0].commit, tip);
  assert.equal((await f.json(['status', run.id])).manualMerges[0].commit, tip);
});
