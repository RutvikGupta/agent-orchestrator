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
  const waited = await f.command(['wait', run.id, '--timeout', '1s']);
  assert.match(waited.stdout, /closed before it started/);
  assert.doesNotMatch(waited.stdout, /attempts: none|counted failures/);
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
  await f.start(run, 'ready', { env: { AGENT_ORCH_MAX_PARALLEL: '1' } });
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
