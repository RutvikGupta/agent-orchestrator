import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';

// Observe child I/O without replacing Git, process checks, or the public CLI. The clock offset
// lets CLI commands create genuinely old records without hand-writing task bookkeeping.
function instrumentation(f) {
  const preload = path.join(f.root, 'recover-observe.cjs');
  const trace = path.join(f.root, 'recover-trace.json');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
if (process.env.TEST_OLD_CLOCK) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() - 3 * 86400000])); }
    static now() { return RealDate.now() - 3 * 86400000; }
  };
}
const trace = { events: [], syncStatuses: 0, statuses: 0, peak: 0 };
const open = fs.openSync;
fs.openSync = function(file, ...args) {
  if (String(file).endsWith('/events.jsonl')) trace.events.push(String(file));
  return open.call(this, file, ...args);
};
const sync = cp.spawnSync;
const isStatus = (bin, args) => bin === 'git' && args.includes('status') && args.includes('--porcelain');
cp.spawnSync = function(bin, args, ...rest) {
  if (isStatus(bin, args)) trace.syncStatuses++;
  return sync.call(this, bin, args, ...rest);
};
const spawn = cp.spawn;
let active = 0;
cp.spawn = function(bin, args, ...rest) {
  const child = spawn.call(this, bin, args, ...rest);
  if (isStatus(bin, args)) {
    trace.statuses++; active++; trace.peak = Math.max(trace.peak, active);
    child.on('close', () => active--);
  }
  return child;
};
syncBuiltinESMExports();
process.on('exit', () => {
  if (process.env.TEST_RECOVER_TRACE) fs.writeFileSync(process.env.TEST_RECOVER_TRACE, JSON.stringify(trace));
});
`);
  return {
    old: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_OLD_CLOCK: '1' },
    observe: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, TEST_RECOVER_TRACE: trace },
    trace: () => readJson(trace),
  };
}

test('recover filters old runs before reading their event streams and keeps finished-time precedence', async (t) => {
  const f = await fixture(t);
  const io = instrumentation(f);
  const old = await f.newRun('old', io.old);
  const task = await f.start(old, 'done', { flags: ['--read-only'], env: io.old });
  await f.finished(old, 'done');
  await f.command(['close', old.id, 'done']);
  const recent = await f.newRun('recent');
  // The old result wins over its recently written events, just as in a full description.
  assert.ok(fs.statSync(path.join(task.outDir, 'events.jsonl')).mtimeMs > Date.now() - 86400000);
  const all = await f.json(['recover', '--all'], { env: io.observe });
  assert.deepEqual(all.runs.map((r) => r.id), [recent.id]);
  assert.deepEqual(io.trace().events, [], 'excluded runs must not parse event streams');
  const explicit = await f.json(['recover', old.id], { env: io.observe });
  assert.deepEqual(explicit.runs[0].groups.integrated, ['done']);
  assert.ok(io.trace().events.some((file) => file.startsWith(old.dir)), 'explicit recovery still describes old tasks');

  // An old run whose task finishes now is included even without a recent run or plan timestamp.
  await f.start(old, 'new-result', { flags: ['--read-only'] });
  await f.finished(old, 'new-result');
  await f.command(['close', old.id, 'new-result']);
  const revived = await f.json(['recover', '--all']);
  assert.deepEqual(revived.runs.map((r) => r.id).sort(), [old.id, recent.id].sort());
  assert.deepEqual(revived.runs.find((r) => r.id === old.id).groups.integrated, ['done', 'new-result']);
});

test('recover scans worktrees concurrently with a bounded number of children and preserves warning order', async (t) => {
  const f = await fixture(t);
  const io = instrumentation(f);
  const run = await f.newRun();
  const tasks = ['one', 'two', 'three', 'four', 'five'];
  const warnings = [];
  for (const id of tasks) {
    const wt = await f.json(['worktree', run.id, id]);
    fs.writeFileSync(path.join(wt.path, 'draft.txt'), 'Draft\n');
    warnings.push(`${id}: 1 uncommitted change in its worktree ${wt.path} (git -C ${wt.path} status)`);
  }
  const recovered = await f.json(['recover', '--all'], { env: io.observe });
  assert.deepEqual(recovered.runs[0].groups.prepared, tasks);
  assert.deepEqual(recovered.runs[0].warnings, warnings);
  const observed = io.trace();
  assert.equal(observed.syncStatuses, 0, 'recovery must not serialize worktree scans');
  assert.equal(observed.statuses, tasks.length);
  assert.ok(observed.peak > 1 && observed.peak <= 4, `expected 2–4 concurrent Git checks, got ${observed.peak}`);
  // No persistent cache: another command sees newly clean and newly dirty worktrees.
  const first = readJson(f.taskFile(run, tasks[0])).worktree.path;
  fs.unlinkSync(path.join(first, 'draft.txt'));
  fs.writeFileSync(path.join(first, 'other.txt'), 'Other\n');
  fs.writeFileSync(path.join(first, 'second.txt'), 'Second\n');
  const changed = await f.json(['recover', run.id]);
  assert.match(changed.runs[0].warnings[0], /^one: 2 uncommitted changes /);
});
