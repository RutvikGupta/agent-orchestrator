import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';

async function closedRow(f, run, id) {
  const row = (await f.json(['status', run.id])).tasks.find((row) => row.id === id);
  assert.equal(row.state, 'closed');
  assert.equal(row.phase, 'closed');
  assert.equal(row.closed, true);
  assert.equal(row.now, 'closed before it started');
  assert.equal(row.health, 'ok');
  const status = (await f.command(['status', run.id])).stdout;
  assert.match(status, /closed before it started/);
  assert.doesNotMatch(status, /worktree ready|attempts: none/);
  assert.match(status, /0 running · 0 finished/);
  const waited = await f.command(['wait', run.id, '--timeout', '1s'], { code: 1 });
  assert.match(waited.stderr, /no started tasks in this run/);
  const board = await f.dashboard();
  const dashboardRow = (await board.json('/api/state')).flatMap((section) => section.tasks).find((row) => row.id === id);
  assert.equal(dashboardRow.state, 'closed');
  assert.equal(dashboardRow.closed, true);
  assert.equal(dashboardRow.attention, null);
}

test('prepared task stays ready and startable; closing another never-started task retires its row', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'retired', '--branch', 'retained-branch', '--no-prep']);
  const ready = await f.json(['worktree', run.id, 'ready', '--no-prep']);
  const row = (await f.json(['status', run.id])).tasks.find((row) => row.id === 'ready');
  assert.equal(row.state, 'prepared');
  assert.equal(row.closed, false);
  assert.equal(row.now, 'worktree ready');
  assert.match((await f.command(['status', run.id])).stdout, /prepared.*worktree ready/);
  const kept = await f.command(['close', run.id, 'retired']);
  assert.match(kept.stdout, /skip retired: other tasks in the run are still open/);
  assert.equal(fs.existsSync(wt.path), true);
  await f.start(run, 'ready');
  await f.finished(run, 'ready');
  const closed = await f.command(['close', run.id, 'ready']);
  assert.match(closed.stdout, /removed worktree.*branch kept: retained-branch/);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(fs.existsSync(ready.path), false);
  assert.ok(await f.git(['branch', '--list', wt.branch]));
  // Isolate the never-started row from the genuinely finished task's totals and history.
  const retiredRun = await f.newRun('retired-only');
  await f.json(['worktree', retiredRun.id, 'only', '--no-prep']);
  await f.command(['close', retiredRun.id, 'only']);
  await closedRow(f, retiredRun, 'only');
});

test('close handles a prepared worktree already removed by hand', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'missing', '--no-prep']);
  await f.git(['worktree', 'remove', wt.path]);
  const closed = await f.json(['close', run.id, 'missing']);
  assert.equal(closed.cleanup.removed[0].missing, true);
  assert.ok(await f.git(['branch', '--list', wt.branch]));
  await closedRow(f, run, 'missing');
});

test('close keeps uncommitted and unreachable prepared worktrees and explains why', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const dirty = await f.json(['worktree', run.id, 'dirty', '--no-prep']);
  const detached = await f.json(['worktree', run.id, 'detached', '--no-prep']);
  fs.writeFileSync(path.join(dirty.path, 'precious.txt'), 'keep me');
  await f.git(['-C', detached.path, 'checkout', '--detach']);
  fs.writeFileSync(path.join(detached.path, 'unique.txt'), 'unreachable work');
  await f.git(['-C', detached.path, 'add', 'unique.txt']);
  await f.git(['-C', detached.path, 'commit', '-qm', 'Detached fixture work']);
  const closed = await f.command(['close', run.id, '--all']);
  assert.match(closed.stdout, /skip dirty: uncommitted changes/);
  assert.match(closed.stdout, /skip detached: commits are not reachable from a retained branch/);
  for (const wt of [dirty, detached]) assert.equal(fs.existsSync(wt.path), true);
  const rows = (await f.json(['status', run.id])).tasks;
  assert.ok(rows.every((row) => row.state === 'closed' && row.closed));
});

function plan(f, run, id) {
  const file = path.join(f.root, 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ goal: 'Prepared lifecycle fixture', tasks: [{
    id, goal: 'Build the fixture', type: 'implement', owns: ['src/'], dependsOn: [],
    agent: 'claude', tier: 'complex', why: 'Fixture assessment', readOnly: false, brief: f.brief(id),
  }] }));
  return f.command(['plan', run.id, file]);
}

async function retired(t) {
  const f = await fixture(t), run = await f.newRun();
  await f.json(['worktree', run.id, 'retired', '--no-prep']);
  await f.command(['close', run.id, 'retired']);
  return { f, run };
}

test('restoring a closed preparation reopens its row and makes dispatch start it', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await plan(f, run, 'restored');
  await f.json(['worktree', run.id, 'restored', '--no-prep']);
  await f.command(['close', run.id, 'restored']);
  await f.json(['worktree', run.id, 'restored', '--no-prep']);
  const row = (await f.json(['status', run.id])).tasks.find((row) => row.id === 'restored');
  assert.equal(row.state, 'prepared');
  assert.equal(row.closed, false);
  assert.equal(row.now, 'worktree ready');
  assert.match((await f.command(['recover', run.id])).stdout, /restored/);
  const gc = await f.json(['gc', '--older-than', '0s']);
  assert.equal(gc.runs[0].kept[0].reason, 'restored worktree awaits a new explicit close or acceptance and integration');
  const dispatched = await f.json(['dispatch', run.id]);
  assert.deepEqual(dispatched.started.map((task) => task.id), ['restored']);
  await f.finished(run, 'restored');
});

test('verdict refuses a closed preparation without recording an attempt-zero review', async (t) => {
  const { f, run } = await retired(t);
  for (const verdict of ['clean', 'reject']) {
    const result = await f.command(['verdict', run.id, 'retired', verdict], { code: 1 });
    assert.match(result.stderr, /has not started, so there is nothing to review/);
  }
  assert.equal(fs.existsSync(path.join(run.dir, 'tasks', 'retired', 'reviews.jsonl')), false);
});

test('send tells a closed preparation to use its brief', async (t) => {
  const { f, run } = await retired(t);
  const result = await f.command(['send', run.id, 'retired', 'Fixture message'], { code: 2 });
  assert.match(result.stderr, /has not started; put the message in its brief/);
  assert.doesNotMatch(result.stderr, /undefined|resume it/);
});

test('accept explains that a closed preparation has not started', async (t) => {
  const { f, run } = await retired(t);
  const result = await f.command(['accept', run.id, 'retired'], { code: 1 });
  assert.match(result.stderr, /it has not started/);
  assert.doesNotMatch(result.stderr, /resume it|other agent/);
});

test('wait for another task does not advertise a closed preparation as ready to dispatch', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await plan(f, run, 'retired');
  await f.json(['worktree', run.id, 'retired', '--no-prep']);
  await f.command(['close', run.id, 'retired']);
  await f.start(run, 'observer', { flags: ['--read-only', '--unplanned'] });
  await f.finished(run, 'observer');
  const result = await f.command(['wait', run.id, 'observer', '--timeout', '1s']);
  assert.doesNotMatch(result.stdout, /ready to dispatch: retired/);
});

test('close reports a missing prepared folder as removed while another task stays open', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'missing', '--no-prep']);
  await f.json(['worktree', run.id, 'open', '--no-prep']);
  await f.git(['worktree', 'remove', wt.path]);
  const result = await f.json(['close', run.id, 'missing']);
  assert.equal(result.cleanup.removed[0]?.missing, true);
  assert.deepEqual(result.cleanup.kept, []);
  assert.ok(await f.git(['branch', '--list', wt.branch]));
  assert.equal((await f.json(['status', run.id])).tasks.find((row) => row.id === 'missing').state, 'closed');
});

test('wait excludes closed preparations by default and reports an explicitly named one', async (t) => {
  const { f, run } = await retired(t);
  const result = await f.command(['wait', run.id, '--timeout', '1s'], { code: 1 });
  assert.match(result.stderr, /no started tasks in this run/);
  const named = await f.command(['wait', run.id, 'retired', '--timeout', '1s']);
  assert.match(named.stdout, /closed before it started/);
  assert.doesNotMatch(named.stdout, /attempts: none|counted failures/);
  assert.equal(named.stderr, '');
});

for (const mode of ['deleted branch', 'new branch']) test(`preparing again with a ${mode} reopens a closed task and protects its new folder`, async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await plan(f, run, 'again');
  const original = await f.json(['worktree', run.id, 'again', '--no-prep']);
  await f.command(['close', run.id, 'again']);
  if (mode === 'deleted branch') await f.git(['branch', '-D', original.branch]);
  const flags = mode === 'new branch' ? ['--branch', 'replacement-branch'] : [];
  const replacement = await f.json(['worktree', run.id, 'again', '--no-prep', ...flags]);
  const row = (await f.json(['status', run.id])).tasks.find((row) => row.id === 'again');
  assert.equal(row.state, 'prepared');
  assert.equal(row.closed, false);
  assert.equal(row.now, 'worktree ready');
  assert.match((await f.command(['recover', run.id])).stdout, /again/);
  const cleaned = await f.json(['cleanup', run.id]);
  assert.equal(cleaned.removed.length, 0);
  assert.match(cleaned.kept[0].reason, /awaits a new explicit close/);
  assert.equal((await f.json(['gc', '--older-than', '0s'])).totals.removed, 0);
  assert.equal(fs.existsSync(replacement.path), true);
  const dispatched = await f.json(['dispatch', run.id]);
  assert.deepEqual(dispatched.started.map((task) => task.id), ['again']);
  await f.finished(run, 'again');
  await f.command(['close', run.id, 'again']);
  assert.equal(fs.existsSync(replacement.path), false);
  assert.ok(await f.git(['branch', '--list', replacement.branch]));
});

test('closing another task keeps its folder while a restored preparation is open', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await f.json(['worktree', run.id, 'restored', '--no-prep']);
  await f.command(['close', run.id, 'restored']);
  const restored = await f.json(['worktree', run.id, 'restored', '--no-prep']);
  const other = await f.json(['worktree', run.id, 'other', '--no-prep']);
  const closed = await f.json(['close', run.id, 'other']);
  assert.deepEqual(closed.cleanup.removed, []);
  assert.deepEqual(closed.cleanup.kept.map(({ task, reason }) => ({ task, reason })), [
    { task: 'other', reason: 'other tasks in the run are still open' },
  ]);
  for (const wt of [restored, other]) assert.equal(fs.existsSync(wt.path), true);
  await f.command(['close', run.id, 'restored']);
  for (const wt of [restored, other]) assert.equal(fs.existsSync(wt.path), false);
});
