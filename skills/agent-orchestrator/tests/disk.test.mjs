import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';
import { diskSize, diskState, parseSize } from '../scripts/lib/disk.mjs';

// The free disk space guard: its reading (pure, with an injected reading), worktree creation on a
// full disk (refused, or allowed once automatic collection freed space), and the dashboard's reading.
// The CLI reads the free space that AGENT_ORCH_DISK_FREE_BYTES sets, so no test depends on the
// machine's own disk.

const GB = 1e9;
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const reading = (freeBytes, totalBytes = 500 * GB) => () => ({ freeBytes, totalBytes });

// A run whose launching session has ended (its PID names no process), idle for `hours`, with a
// closed task's clean worktree.
async function endedRun(f, name, hours = 3) {
  const run = await f.newRun(name);
  const wt = await f.json(['worktree', run.id, 'old', '--no-prep']);
  const old = hoursAgo(hours);
  const file = f.taskFile(run, 'old');
  writeJson(file, { ...readJson(file), createdAt: old, closedAt: old, closedExplicitlyAttempt: 0 });
  fs.utimesSync(file, new Date(old), new Date(old));
  const runFile = path.join(run.dir, 'run.json');
  writeJson(runFile, { ...readJson(runFile), createdAt: old, orchestrator: { agent: 'claude', sessionId: 'ended-session', pid: 99999999, lastSeenAt: old } });
  return { run, wt };
}

// Nothing of a refused worktree exists: no folder, no branch, no task record of it.
async function assertNotCreated(f, run, id) {
  assert.equal(fs.existsSync(path.join(run.dir, 'worktrees', id)), false, 'the worktree folder was created');
  assert.equal(await f.git(['branch', '--list', `orch/${run.id}/${id}`]), '', 'the branch was created');
  assert.equal(fs.existsSync(f.taskFile(run, id)) && readJson(f.taskFile(run, id)).worktree, false, 'the task records a worktree');
}

test('the disk reading flags low below twice the minimum and critical below it; 0 turns it off; sizes take units', () => {
  const env = (extra = {}) => ({ ...extra });
  const at = (free, extra) => diskState('/nowhere', { read: reading(free), env: env(extra) });
  assert.deepEqual(at(40 * GB), { dir: '/nowhere', freeBytes: 40 * GB, totalBytes: 500 * GB, minBytes: 15 * GB, low: false, critical: false });
  assert.deepEqual([at(29 * GB).low, at(29 * GB).critical], [true, false]);
  assert.deepEqual([at(14 * GB).low, at(14 * GB).critical], [true, true]);
  assert.deepEqual([at(1, { AGENT_ORCH_MIN_FREE_DISK: '0' }).low, at(1, { AGENT_ORCH_MIN_FREE_DISK: '0' }).critical], [false, false]);
  assert.equal(at(1, { AGENT_ORCH_MIN_FREE_DISK: '500MB' }).minBytes, 500e6);
  assert.equal(parseSize('20GiB', 'X'), 20 * 1024 ** 3);
  assert.equal(parseSize('1234', 'X'), 1234);
  assert.equal(parseSize('2.5 GB', 'X'), 2.5e9);
  assert.throws(() => at(40 * GB, { AGENT_ORCH_MIN_FREE_DISK: 'lots' }), /AGENT_ORCH_MIN_FREE_DISK needs bytes or a size/);
  // A reading that fails is unknown, never low: it blocks nothing.
  const failed = diskState('/nowhere', { read: () => { throw new Error('statfs failed'); }, env: {} });
  assert.deepEqual([failed.freeBytes, failed.low, failed.critical, failed.error], [null, false, false, 'statfs failed']);
  // The environment's reading replaces the real one, one value per reading, the last repeating.
  const forced = { AGENT_ORCH_DISK_FREE_BYTES: '9GB,40GB', AGENT_ORCH_DISK_TOTAL_BYTES: '100GB' };
  const never = () => assert.fail('a forced reading read the real disk');
  assert.deepEqual([1, 2, 3].map(() => diskState('/nowhere', { read: never, env: forced }).freeBytes), [9 * GB, 40 * GB, 40 * GB]);
  assert.deepEqual([diskSize(42.4 * GB), diskSize(9.24 * GB), diskSize(659e6), diskSize(15 * GB)], ['42 GB', '9.2 GB', '659 MB', '15 GB']);
  // The real reading of an existing folder, and of one not created yet (its parent's volume).
  const real = diskState(path.join(process.cwd(), 'not-created-yet'), { env: {} });
  assert.ok(real.totalBytes > 0 && real.freeBytes >= 0 && real.freeBytes <= real.totalBytes, JSON.stringify(real));
});

test('worktree refuses on a disk below the minimum, creates nothing, and names the free space, the minimum and the commands that free space', async (t) => {
  const f = await fixture(t), run = await f.newRun('full');
  const before = await f.git(['worktree', 'list', '--porcelain']);
  const refused = await f.command(['worktree', run.id, 'blocked', '--no-prep'], { code: 1, env: { AGENT_ORCH_DISK_FREE_BYTES: '9GB' } });
  assert.match(refused.stderr, /refusing to create a worktree: only 9 GB of disk is free on the volume that holds .*, below the minimum of 15 GB \(AGENT_ORCH_MIN_FREE_DISK\)/);
  assert.match(refused.stderr, /Automatic collection removed 0 worktrees first and freed 0 bytes, which was not enough/);
  for (const command of ['gc --dry-run', 'gc ', 'close RUN TASK', 'git worktree remove PATH']) assert.ok(refused.stderr.includes(command), `the refusal lacks ${command}:\n${refused.stderr}`);
  assert.match(refused.stderr, /Nothing was created\./);
  await assertNotCreated(f, run, 'blocked');
  assert.equal(await f.git(['worktree', 'list', '--porcelain']), before);
  // Only the setting changes it: a lower minimum, or 0, which turns the check off.
  await f.json(['worktree', run.id, 'lower', '--no-prep'], { env: { AGENT_ORCH_DISK_FREE_BYTES: '9GB', AGENT_ORCH_MIN_FREE_DISK: '8GB' } });
  await f.json(['worktree', run.id, 'off', '--no-prep'], { env: { AGENT_ORCH_DISK_FREE_BYTES: '1', AGENT_ORCH_MIN_FREE_DISK: '0' } });
  const bad = await f.command(['worktree', run.id, 'bad', '--no-prep'], { code: 2, env: { AGENT_ORCH_MIN_FREE_DISK: 'plenty' } });
  assert.match(bad.stderr, /AGENT_ORCH_MIN_FREE_DISK needs bytes or a size/);
  await assertNotCreated(f, run, 'bad');
});

test('on a full disk, worktree creation first collects unused worktrees of ended sessions, then creates or refuses by the new reading; a restore is checked too', async (t) => {
  const f = await fixture(t);
  const ended = await endedRun(f, 'ended');
  // A live session's idle run: automatic collection leaves it to that session, even for the user.
  const live = await endedRun(f, 'live', 48);
  const liveFile = path.join(live.run.dir, 'run.json');
  writeJson(liveFile, { ...readJson(liveFile), orchestrator: { ...readJson(liveFile).orchestrator, agent: 'codex', sessionId: 'live-session', pid: process.pid } });
  const target = await f.newRun('target');

  // Still below the minimum after collecting: refused, but the collection happened and was logged.
  const refused = await f.command(['worktree', target.id, 'first', '--no-prep'], { code: 1, env: { AGENT_ORCH_DISK_FREE_BYTES: '9GB' } });
  assert.match(refused.stderr, /collecting unused worktrees first/);
  assert.ok(refused.stderr.includes(`orch: auto gc removed worktree ${ended.wt.path} (run ${ended.run.id}, task old, `), refused.stderr);
  assert.match(refused.stderr, /orch: auto gc freed .* from 1 worktree\n/);
  assert.match(refused.stderr, /Automatic collection removed 1 worktree first/);
  await assertNotCreated(f, target, 'first');
  assert.equal(fs.existsSync(ended.wt.path), false);
  assert.ok(await f.git(['branch', '--list', ended.wt.branch]), 'the collected worktree lost its branch');
  assert.equal(fs.existsSync(live.wt.path), true, 'a live session\'s worktree was collected');
  const notice = fs.readFileSync(path.join(ended.run.dir, 'owner-notices.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(notice.map((n) => [n.action, n.byLabel, n.user]), [['worktree removed', 'automatic worktree collection', false]]);

  // Space appears once the collection ran (the second reading): the worktree is created.
  const made = await f.command(['worktree', target.id, 'second', '--no-prep'], { env: { AGENT_ORCH_DISK_FREE_BYTES: '9GB,40GB' } });
  assert.match(made.stdout, /^worktree /);
  assert.ok(fs.existsSync(path.join(target.dir, 'worktrees', 'second')));

  // Restoring the collected worktree goes through the same check.
  const restore = await f.command(['worktree', ended.run.id, 'old', '--no-prep'], { code: 1, env: { AGENT_ORCH_DISK_FREE_BYTES: '9GB' } });
  assert.match(restore.stderr, /refusing to create a worktree: only 9 GB/);
  assert.equal(fs.existsSync(ended.wt.path), false);
  assert.equal(readJson(f.taskFile(ended.run, 'old')).worktree, undefined);
  await f.json(['worktree', ended.run.id, 'old', '--no-prep'], { env: { AGENT_ORCH_DISK_FREE_BYTES: '40GB' } });
  assert.equal(fs.existsSync(ended.wt.path), true);
});

test('the dashboard\'s health carries the disk reading, and its header has a place for it', async (t) => {
  const f = await fixture(t);
  Object.assign(f.env, { AGENT_ORCH_DISK_FREE_BYTES: '20GB', AGENT_ORCH_DISK_TOTAL_BYTES: '500GB', AGENT_ORCH_RECLAIM: 'off', AGENT_ORCH_AUTO_GC: 'off' });
  const d = await f.dashboard();
  const { disk } = await d.json('/api/health');
  assert.deepEqual({ ...disk, title: undefined }, {
    dir: f.state, freeBytes: 20 * GB, totalBytes: 500 * GB, minBytes: 15 * GB, low: true, critical: false, summary: 'disk 20 GB free', title: undefined,
  });
  assert.match(disk.title, /20 GB free of 500 GB on the volume that holds .*: low, under twice the minimum of 15 GB \(AGENT_ORCH_MIN_FREE_DISK\)/);
  assert.match(disk.title, /gc --dry-run/);
  assert.match(disk.title, /close RUN TASK/);
  const page = await (await d.get('/')).text();
  assert.match(page, /<span id="disk" class="disk"><\/span>/);
  const script = await (await d.get('/app.js')).text();
  assert.match(script, /fetch\("api\/health"\)/);
});
