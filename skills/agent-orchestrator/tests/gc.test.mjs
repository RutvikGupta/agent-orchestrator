import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
function patch(f, run, id, fields) {
  writeJson(f.taskFile(run, id), { ...readJson(f.taskFile(run, id)), ...fields });
}
async function worktree(f, run, id, fields = {}) {
  const wt = await f.json(['worktree', run.id, id, '--no-prep']);
  patch(f, run, id, { ...(fields.closedAt ? { closedExplicitlyAttempt: 0 } : {}), ...fields });
  return wt;
}
async function commit(f, wt, name = 'change.txt') {
  fs.writeFileSync(path.join(wt.path, name), 'Unique committed work.\n');
  await f.git(['-C', wt.path, 'add', name]);
  await f.git(['-C', wt.path, 'commit', '-qm', 'Fixture change']);
  return f.git(['-C', wt.path, 'rev-parse', 'HEAD']);
}
function finished(f, run, id, days, fields = {}) {
  const outDir = path.join(run.dir, 'tasks', id, 'attempt-1');
  writeJson(path.join(outDir, 'result.json'), { status: 'completed', finishedAt: daysAgo(days), finalMessage: 'Finished fixture.' });
  patch(f, run, id, { pid: 99999999, attempt: 1, agent: 'claude', outDir, startedAt: daysAgo(days + 1), ...(fields.closedAt ? { closedExplicitlyAttempt: 1 } : {}), ...fields });
}
function snapshot(root) {
  const out = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), st = fs.lstatSync(file);
      out[path.relative(root, file)] = [st.mtimeMs, st.isFile() ? fs.readFileSync(file).toString('base64') : st.isSymbolicLink() ? fs.readlinkSync(file) : null];
      if (st.isDirectory()) walk(file);
    }
  }
  walk(root);
  return out;
}

test('gc removes clean closed folders, preserves branches and unmerged commits, and explains kept work', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const merged = await worktree(f, run, 'merged', { closedAt: daysAgo(3) });
  const unmerged = await worktree(f, run, 'unmerged', { closedAt: daysAgo(3) });
  const tip = await commit(f, unmerged);
  const dirty = await worktree(f, run, 'dirty', { closedAt: daysAgo(3) });
  fs.writeFileSync(path.join(dirty.path, 'precious'), 'Uncommitted work');
  const open = await worktree(f, run, 'open');
  const detached = await worktree(f, run, 'detached', { closedAt: daysAgo(3) });
  await f.git(['-C', detached.path, 'checkout', '--detach']);
  // Its own file, so that no branch happens to hold the same commit.
  const detachedTip = await commit(f, detached, 'detached.txt');
  const report = await f.json(['gc', '--older-than', '0s']);
  assert.equal(report.totals.removed, 2);
  assert.ok(report.totals.bytesFreed > 0);
  assert.deepEqual(report.totals.keptByReason, { 'uncommitted changes': 1, 'task is not closed or accepted and integrated': 1, 'commits are not reachable from a retained branch': 1 });
  for (const wt of [merged, unmerged]) assert.equal(fs.existsSync(wt.path), false);
  for (const wt of [dirty, open, detached]) assert.equal(fs.existsSync(wt.path), true);
  assert.equal(await f.git(['rev-parse', unmerged.branch]), tip);
  assert.equal(await f.git(['cat-file', '-t', tip]), 'commit');
  assert.equal(await f.git(['cat-file', '-t', detachedTip]), 'commit');
  assert.ok(await f.git(['branch', '--list', merged.branch]));
});

test('dry-run is byte-for-byte read-only, including expiry and ignored files', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'old');
  finished(f, run, 'old', 8);
  const events = path.join(run.dir, 'tasks', 'old', 'attempt-1', 'events.jsonl');
  fs.writeFileSync(events, JSON.stringify({ type: 'irrelevant', padding: 'x'.repeat(1100000) }) + '\n');
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\nignored-cache/\n');
  fs.mkdirSync(path.join(wt.path, 'ignored-cache'));
  fs.writeFileSync(path.join(wt.path, 'ignored-cache', 'output'), 'cache');
  const before = snapshot(f.state), gitBefore = snapshot(path.join(f.repo, '.git'));
  const report = await f.json(['gc', '--dry-run', '--older-than', '0s']);
  assert.equal(report.totals.removed, 1);
  assert.equal(report.totals.expired, 1);
  assert.ok(report.totals.bytesFreed > 0);
  assert.deepEqual(snapshot(f.state), before);
  assert.deepEqual(snapshot(path.join(f.repo, '.git')), gitBefore);
});

test('expiry closes only unread finished tasks older than the configured limit', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  for (const id of ['old', 'recent', 'accepted', 'read', 'prepared']) await worktree(f, run, id);
  finished(f, run, 'old', 8); finished(f, run, 'recent', 6);
  finished(f, run, 'accepted', 8, { acceptedAt: daysAgo(7), acceptedAttempt: 1 });
  finished(f, run, 'read', 8, { decisionSeenAttempt: 1 });
  const report = await f.json(['gc', '--older-than', '0s']);
  assert.deepEqual(report.runs[0].expired, ['old']);
  assert.equal(readJson(f.taskFile(run, 'old')).closedBy, 'expired');
  for (const id of ['recent', 'accepted', 'read', 'prepared']) assert.equal(readJson(f.taskFile(run, id)).closedAt, undefined);
  const next = await f.json(['gc', '--older-than', '0s'], { env: { AGENT_ORCH_EXPIRE: '5d' } });
  assert.deepEqual(next.runs[0].expired, ['recent']);
});

test('gc refuses another session in both modes and keeps all state untouched', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'closed', { closedAt: daysAgo(3) });
  f.launchingSession(run, 'session-owner');
  const before = snapshot(f.state);
  for (const flags of [[], ['--dry-run']]) {
    const report = await f.json(['gc', '--older-than', '0s', ...flags], { env: { CODEX_THREAD_ID: 'another-session', CLAUDE_CODE_SESSION_ID: 'another-session' } });
    assert.equal(report.runs[0].reason, 'ownership refused');
    assert.equal(report.totals.removed, 0);
  }
  assert.equal(fs.existsSync(wt.path), true);
  assert.deepEqual(snapshot(f.state), before);
});

test('default age filter keeps recent runs and collects inactive runs after 24 hours', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await worktree(f, run, 'closed', { closedAt: daysAgo(3), createdAt: daysAgo(3) });
  assert.equal((await f.json(['gc'])).runs[0].reason, 'run is too recent');
  const file = path.join(run.dir, 'run.json');
  const old = daysAgo(3);
  writeJson(file, { ...readJson(file), createdAt: old, orchestrator: { agent: 'terminal', lastSeenAt: old } });
  fs.utimesSync(f.taskFile(run, 'closed'), new Date(old), new Date(old));
  assert.equal((await f.json(['gc'])).totals.removed, 1);
});

test('close waits until the last open task, then removes clean worktrees and keeps dirty ones', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const first = await worktree(f, run, 'first'), second = await worktree(f, run, 'second');
  fs.writeFileSync(path.join(second.path, 'dirty'), 'keep');
  await f.command(['close', run.id, 'first']);
  assert.equal(fs.existsSync(first.path), true);
  const closed = await f.json(['close', run.id, 'second']);
  assert.equal(closed.cleanup.removed.length, 1);
  assert.equal(closed.cleanup.kept[0].reason, 'uncommitted changes');
  assert.equal(fs.existsSync(first.path), false);
  assert.equal(fs.existsSync(second.path), true);
});

test('integrate automatically removes its accepted worktree and retains the branch', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'feature');
  const tip = await commit(f, wt);
  finished(f, run, 'feature', 1, { acceptedAt: daysAgo(1), acceptedAttempt: 1, acceptedCommit: tip });
  const report = await f.json(['integrate', run.id, 'feature']);
  assert.equal(report.cleanup.removed.length, 1);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(await f.git(['rev-parse', wt.branch]), tip);
  await f.git(['merge-base', '--is-ancestor', tip, 'main']);
});

test('cleanup cannot discard dirty changes or delete branches; teardown changes are checked again', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'safe', { closedAt: daysAgo(1) });
  const task = readJson(f.taskFile(run, 'safe'));
  patch(f, run, 'safe', { worktree: { ...task.worktree, prep: { recipe: { teardown: ['echo keep > README.md'] } } } });
  // The recipe shape is the same as preparation persists it.
  const data = readJson(f.taskFile(run, 'safe'));
  data.worktree.prep.teardown = ['echo keep > README.md'];
  writeJson(f.taskFile(run, 'safe'), data);
  const report = await f.json(['cleanup', run.id, '--force', '--delete-branches']);
  assert.equal(report.removed.length, 0);
  assert.equal(report.kept[0].reason, 'uncommitted changes');
  assert.equal(fs.existsSync(wt.path), true);
  assert.ok(await f.git(['branch', '--list', wt.branch]));
});

test('gc keeps runs with a running task even when the age threshold is zero', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'busy');
  const task = await f.start(run, 'busy', { config: { hold: true } });
  await f.ready(task);
  const report = await f.json(['gc', '--older-than', '0s'], { env: { AGENT_ORCH_EXPIRE: '0s' } });
  assert.equal(report.runs[0].reason, 'run has running tasks');
  assert.equal(report.totals.expired, 0);
  assert.equal(fs.existsSync(wt.path), true);
  f.release(task);
  await f.finished(run, 'busy');
});

test('cleanup retains custom branch metadata so accepted work can still be integrated', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'custom', '--branch', 'kept-custom', '--no-prep']);
  const tip = await commit(f, wt);
  finished(f, run, 'custom', 1, { acceptedAt: daysAgo(1), acceptedAttempt: 1, acceptedCommit: tip, closedAt: daysAgo(1) });
  await f.command(['cleanup', run.id]);
  assert.equal(fs.existsSync(wt.path), false);
  const report = await f.json(['integrate', run.id, 'custom']);
  assert.ok(report.integratedCommit);
  assert.equal(await f.git(['rev-parse', wt.branch]), tip);
  await f.git(['merge-base', '--is-ancestor', tip, 'main']);
});

test('regression: result collection preserves a write worktree until explicit close or integration', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'unreviewed');
  finished(f, run, 'unreviewed', 1);
  await worktree(f, run, 'other');
  await f.command(['result', run.id, 'unreviewed']);
  await f.command(['close', run.id, 'other']);
  assert.equal(fs.existsSync(wt.path), true);
  assert.match((await f.command(['cleanup', run.id])).stdout, /not explicitly closed/);
  const closed = await f.json(['close', run.id, 'unreviewed']);
  assert.equal(closed.cleanup.removed.length, 1);
  assert.equal(readJson(f.taskFile(run, 'unreviewed')).closedExplicitlyAttempt, 1);
  assert.equal(fs.existsSync(wt.path), false);
});

test('regression: explicit closure applies only to its attempt and reject also permits cleanup', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'resumed');
  finished(f, run, 'resumed', 1, { attempt: 2, closedAt: daysAgo(1), closedBy: 'user (terminal)', closedExplicitlyAttempt: 1 });
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 0);
  await f.command(['verdict', run.id, 'resumed', 'reject', '--note', 'This result is no longer needed']);
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 1);
  assert.equal(fs.existsSync(wt.path), false);
});

test('regression: integrate preserves a worktree used by a running reviewer in a subdirectory', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'impl');
  const tip = await commit(f, wt);
  finished(f, run, 'impl', 1, { acceptedAt: daysAgo(1), acceptedAttempt: 1, acceptedCommit: tip });
  const subdir = path.join(wt.path, 'nested');
  fs.mkdirSync(subdir);
  const reviewer = await f.start(run, 'reviewer', { config: { hold: true }, flags: ['--read-only', '--cd', subdir] });
  await f.ready(reviewer);
  const report = await f.json(['integrate', run.id, 'impl']);
  assert.equal(report.cleanup.removed.length, 0);
  assert.equal(report.cleanup.kept[0].reason, 'worktree is used by a running or parked task');
  assert.equal(fs.existsSync(wt.path), true);
  f.release(reviewer);
  await f.finished(run, 'reviewer');
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 1);
});

for (const parked of [false, true]) test(`regression: gc preserves a worktree used by another run's ${parked ? 'parked' : 'running'} task`, async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'impl', { closedAt: daysAgo(3) });
  const other = await f.newRun('review');
  let reader;
  if (parked) {
    const outDir = path.join(other.dir, 'tasks', 'reader', 'attempt-1');
    writeJson(f.taskFile(other, 'reader'), { id: 'reader', cd: wt.path, outDir, pid: 99999999, attempt: 1, babysit: true, startedAt: daysAgo(2) });
    writeJson(path.join(outDir, 'result.json'), { status: 'completed', finishedAt: daysAgo(1), finalMessage: 'PARKED: waiting for feedback' });
  } else {
    reader = await f.start(other, 'reader', { config: { hold: true }, flags: ['--read-only', '--cd', wt.path] });
    await f.ready(reader);
  }
  const report = await f.json(['gc', '--older-than', '0s']);
  const kept = report.runs.find((r) => r.run === run.id);
  assert.equal(kept.removed.length, 0);
  assert.equal(kept.kept[0].reason, 'worktree is used by a running or parked task');
  assert.equal(fs.existsSync(wt.path), true);
  if (reader) { f.release(reader); await f.finished(other, 'reader'); }
  else patch(f, other, 'reader', { closedAt: new Date().toISOString() });
});

test('regression: an unidentified caller cannot collect or expire another session runs', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await worktree(f, run, 'old');
  finished(f, run, 'old', 9);
  f.launchingSession(run, 'owner-session');
  const before = snapshot(f.state);
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: 'missing-parent', AGENT_ORCH_TASK: 'missing-task' };
  for (const flags of [[], ['--dry-run']]) {
    const report = await f.json(['gc', '--older-than', '0s', ...flags], { env });
    assert.equal(report.runs[0].reason, 'ownership refused');
    assert.equal(report.totals.expired, 0);
    assert.equal(report.totals.removed, 0);
  }
  assert.deepEqual(snapshot(f.state), before);
  const file = path.join(run.dir, 'run.json');
  writeJson(file, { ...readJson(file), orchestrator: { agent: 'delegated-agent', parentRun: 'missing-parent', parentTask: 'missing-task' } });
  const matchedBefore = snapshot(f.state);
  const matched = await f.json(['gc', '--older-than', '0s'], { env });
  assert.equal(matched.runs[0].reason, 'ownership refused', 'an invalid identity cannot own a run by matching stale records');
  assert.deepEqual(snapshot(f.state), matchedBefore);
});

test('regression: missing folders are pruned individually and recorded without deleting their branch', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'missing', { closedAt: daysAgo(3) });
  const tip = await commit(f, wt);
  const other = await f.newRun('unowned');
  const otherWt = await worktree(f, other, 'also-missing');
  fs.rmSync(wt.path, { recursive: true });
  fs.rmSync(otherWt.path, { recursive: true });
  const before = snapshot(f.state), gitBefore = snapshot(path.join(f.repo, '.git'));
  const dry = await f.json(['gc', '--older-than', '0s', '--dry-run']);
  assert.ok(dry.runs.find((r) => r.run === run.id).removed[0].missing);
  assert.deepEqual(snapshot(f.state), before);
  assert.deepEqual(snapshot(path.join(f.repo, '.git')), gitBefore);
  const cleaned = await f.json(['cleanup', run.id]);
  assert.equal(cleaned.removed[0].missing, true);
  assert.equal(cleaned.bytesFreed, 0);
  assert.equal(readJson(f.taskFile(run, 'missing')).worktree, undefined);
  assert.equal(await f.git(['rev-parse', wt.branch]), tip);
  const registered = await f.git(['worktree', 'list', '--porcelain']);
  assert.ok(!registered.includes(wt.path));
  assert.ok(registered.includes(otherWt.path), 'another run registration must remain');
});

test('regression: cache-only worktrees are removable but ordinary untracked work stays', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'caches', { closedAt: daysAgo(3) });
  for (const name of ['.DS_Store', '__pycache__/a.pyc', 'node_modules/pkg/index.js']) {
    fs.mkdirSync(path.dirname(path.join(wt.path, name)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, name), 'cache');
  }
  fs.writeFileSync(path.join(wt.path, 'keep.txt'), 'work');
  assert.equal((await f.json(['cleanup', run.id])).kept[0].reason, 'uncommitted changes');
  fs.unlinkSync(path.join(wt.path, 'keep.txt'));
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 1);
});

test('regression: teardown failures are reported without retaining a safe worktree', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'teardown', { closedAt: daysAgo(3) });
  const task = readJson(f.taskFile(run, 'teardown'));
  patch(f, run, 'teardown', { worktree: { ...task.worktree, prep: { teardown: ['echo failed; exit 7'] } } });
  const report = await f.json(['cleanup', run.id]);
  assert.equal(report.removed.length, 1);
  assert.equal(report.removed[0].teardownFailures[0].exitCode, 7);
  assert.equal(fs.existsSync(wt.path), false);
  assert.ok(await f.git(['branch', '--list', wt.branch]));
});

test('regression: dead relays expire by the newest file in their latest attempt only', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  for (const [id, age] of [['expired', 8], ['recent', 6]]) {
    await worktree(f, run, id);
    const outDir = path.join(run.dir, 'tasks', id, 'attempt-2');
    const files = [['events.jsonl', 9], ['relay.log', age], ['nested/progress', age]];
    for (const [name, days] of files) {
      const file = path.join(outDir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      fs.utimesSync(file, new Date(daysAgo(days)), new Date(daysAgo(days)));
    }
    const earlier = path.join(run.dir, 'tasks', id, 'attempt-1', 'relay.log');
    fs.mkdirSync(path.dirname(earlier), { recursive: true });
    fs.writeFileSync(earlier, 'A recent read of an old attempt must not reset expiry.');
    patch(f, run, id, { pid: 99999999, attempt: 2, outDir, startedAt: daysAgo(10) });
  }
  const before = snapshot(f.state);
  const preview = await f.json(['gc', '--older-than', '0s', '--dry-run']);
  assert.deepEqual(preview.runs[0].expired, ['expired']);
  assert.deepEqual(snapshot(f.state), before);
  const report = await f.json(['gc', '--older-than', '0s']);
  assert.deepEqual(report.runs[0].expired, ['expired']);
  assert.equal(readJson(f.taskFile(run, 'expired')).closedBy, 'expired');
  assert.equal(readJson(f.taskFile(run, 'recent')).closedAt, undefined);
});

function idleRun(f, run, days = 3) {
  const old = daysAgo(days);
  const file = path.join(run.dir, 'run.json');
  const record = readJson(file);
  writeJson(file, { ...record, createdAt: old, orchestrator: { ...record.orchestrator, lastSeenAt: old } });
  for (const id of fs.readdirSync(path.join(run.dir, 'tasks'))) {
    const task = readJson(f.taskFile(run, id));
    patch(f, run, id, { createdAt: old, ...(task.closedAt ? { closedAt: old } : {}) });
  }
  function backdate(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) backdate(name);
      fs.utimesSync(name, new Date(old), new Date(old));
    }
  }
  backdate(path.join(run.dir, 'tasks'));
}

for (const closure of ['result', 'legacy']) test(`round two: idle gc collects ${closure} closure and worktree restores retained commits`, async (t) => {
  const f = await fixture(t), run = await f.newRun();
  // A folder of its own name, inside the run's folder: gc collects only worktrees there.
  const wt = await f.json(['worktree', run.id, 'restore', '--branch', 'retained-feature', '--path', path.join(run.dir, 'custom-folder'), '--no-prep']);
  const tip = await commit(f, wt);
  finished(f, run, 'restore', 3);
  if (closure === 'result') await f.command(['result', run.id, 'restore']);
  else patch(f, run, 'restore', { closedAt: daysAgo(3), closedBy: 'user (terminal)' });
  assert.equal(readJson(f.taskFile(run, 'restore')).closedExplicitlyAttempt, undefined);
  const manual = await f.json(['cleanup', run.id]);
  assert.match(manual.kept[0].reason, /not explicitly closed/);
  idleRun(f, run);
  const preview = await f.json(['gc', '--dry-run']);
  assert.equal(preview.totals.removed, 1);
  assert.equal(fs.existsSync(wt.path), true);
  const collected = await f.command(['gc']);
  assert.match(collected.stdout, new RegExp(`recreate with: .*orch.mjs worktree ${run.id} restore`));
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(await f.git(['rev-parse', wt.branch]), tip);
  const recreated = await f.json(['worktree', run.id, 'restore', '--no-prep']);
  assert.equal(recreated.path, wt.path);
  assert.equal(recreated.branch, wt.branch);
  assert.equal(recreated.from, wt.from);
  assert.equal(recreated.restoredCommit, tip);
  assert.equal(recreated.restored, true);
  assert.equal(await f.git(['-C', recreated.path, 'rev-parse', 'HEAD']), tip);
  assert.equal(fs.readFileSync(path.join(recreated.path, 'change.txt'), 'utf8'), 'Unique committed work.\n');
  await f.command(['accept', run.id, 'restore']);
});

test('round two: collected branch restoration rejects --from and allows a separately named branch', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'restore', { closedAt: daysAgo(1) });
  const tip = await commit(f, wt);
  await f.command(['cleanup', run.id]);
  const refused = await f.command(['worktree', run.id, 'restore', '--from', run.baseCommit, '--no-prep'], { code: 1 });
  assert.match(refused.stderr, /cannot use --from while restoring retained branch/);
  assert.equal(await f.git(['rev-parse', wt.branch]), tip);
  const different = await f.json(['worktree', run.id, 'restore', '--branch', 'separate-feature', '--from', run.baseCommit, '--no-prep']);
  assert.equal(different.branch, 'separate-feature');
  assert.equal(await f.git(['-C', different.path, 'rev-parse', 'HEAD']), run.baseCommit);
  assert.equal(await f.git(['rev-parse', wt.branch]), tip);
});

for (const change of ['modified', 'staged', 'added', 'renamed', 'deleted']) test(`round two: ${change} tracked cache files survive all cleanup entry points`, async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'tracked');
  const dir = path.join(wt.path, 'node_modules', 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  const tip = await commit(f, wt, 'node_modules/pkg/index.js');
  finished(f, run, 'tracked', 1, { acceptedAt: daysAgo(1), acceptedAttempt: 1, acceptedCommit: tip });
  const file = path.join(dir, 'index.js');
  if (change === 'modified' || change === 'staged') {
    fs.writeFileSync(file, 'Precious dependency patch.\n');
    if (change === 'staged') await f.git(['-C', wt.path, 'add', 'node_modules/pkg/index.js']);
  } else if (change === 'added') {
    fs.writeFileSync(path.join(dir, 'new.js'), 'Precious staged addition.\n');
    await f.git(['-C', wt.path, 'add', 'node_modules/pkg/new.js']);
  } else if (change === 'renamed') await f.git(['-C', wt.path, 'mv', 'node_modules/pkg/index.js', 'node_modules/pkg/renamed.js']);
  else await f.git(['-C', wt.path, 'rm', 'node_modules/pkg/index.js']);
  const before = await f.git(['-C', wt.path, 'status', '--porcelain']);
  const closed = await f.json(['close', run.id, 'tracked']);
  assert.equal(closed.cleanup.kept[0].reason, 'uncommitted changes');
  assert.equal((await f.json(['cleanup', run.id])).kept[0].reason, 'uncommitted changes');
  const gc = await f.json(['gc', '--older-than', '0s']);
  assert.equal(gc.runs[0].kept[0].reason, 'uncommitted changes');
  const integrated = await f.json(['integrate', run.id, 'tracked']);
  assert.equal(integrated.cleanup.kept[0].reason, 'uncommitted changes');
  assert.equal(fs.existsSync(wt.path), true);
  assert.equal(await f.git(['-C', wt.path, 'status', '--porcelain']), before);
  if (change === 'modified' || change === 'staged') assert.equal(fs.readFileSync(file, 'utf8'), 'Precious dependency patch.\n');
});

test('round two: worktree recreates a folder collected by explicit cleanup from the existing branch', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'recreate', { closedAt: daysAgo(1) });
  const tip = await commit(f, wt);
  const removed = await f.json(['cleanup', run.id]);
  const restored = await f.json(['worktree', run.id, 'recreate', '--no-prep']);
  assert.match(removed.removed[0].recreateCommand, new RegExp(`worktree ${run.id} recreate$`));
  assert.equal(restored.branch, wt.branch);
  assert.equal(await f.git(['-C', restored.path, 'rev-parse', 'HEAD']), tip);
  assert.equal(fs.readFileSync(path.join(restored.path, 'change.txt'), 'utf8'), 'Unique committed work.\n');
});

test('round three: restored task keeps its original start point through accept and integrate', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'feature');
  const tip = await commit(f, wt);
  finished(f, run, 'feature', 1, { closedAt: daysAgo(1) });
  await f.command(['cleanup', run.id]);
  const restored = await f.json(['worktree', run.id, 'feature', '--no-prep']);
  assert.equal(restored.from, wt.from);
  assert.equal(restored.restoredCommit, tip);
  assert.ok(restored.restoredAt);
  const accepted = await f.command(['accept', run.id, 'feature']);
  assert.doesNotMatch(accepted.stdout, /has no commits beyond where it started/);
  assert.equal(await f.git(['rev-list', '--count', `${restored.from}..${tip}`]), '1');
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 0, 'acceptance alone does not release a restored folder');
  const integrated = await f.json(['integrate', run.id, 'feature']);
  assert.equal(integrated.cleanup.removed.length, 1);
  await f.git(['merge-base', '--is-ancestor', tip, 'main']);
});

test('round three: restore survives cleanup, idle gc, result reads and closing another task until explicitly closed again', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'feature');
  finished(f, run, 'feature', 1, { closedAt: daysAgo(1), closedBy: 'previous coordinator' });
  await f.command(['cleanup', run.id]);
  await f.command(['worktree', run.id, 'feature', '--no-prep']);
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 0);
  assert.equal(fs.existsSync(wt.path), true);
  await worktree(f, run, 'other');
  const closedOther = await f.json(['close', run.id, 'other']);
  assert.ok(closedOther.cleanup.kept.some((r) => r.task === 'feature' && /restored worktree/.test(r.reason)));
  await f.command(['result', run.id, 'feature']);
  idleRun(f, run);
  const collected = await f.json(['gc']);
  assert.equal(collected.totals.removed, 0);
  assert.match(collected.runs[0].kept[0].reason, /restored worktree/);
  const closed = await f.json(['close', run.id, 'feature']);
  assert.equal(closed.cleanup.removed.length, 1);
  assert.equal(readJson(f.taskFile(run, 'feature')).closedBy, 'user (terminal)');
  assert.equal(fs.existsSync(wt.path), false);
});

test('round three: restored previously integrated work needs fresh acceptance and integration', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'feature');
  const tip = await commit(f, wt);
  finished(f, run, 'feature', 1);
  await f.command(['accept', run.id, 'feature']);
  await f.command(['integrate', run.id, 'feature']);
  assert.equal(fs.existsSync(wt.path), false);
  const restored = await f.json(['worktree', run.id, 'feature', '--no-prep']);
  const oldIntegration = readJson(f.taskFile(run, 'feature')).integratedAt;
  assert.ok(Date.parse(restored.restoredAt) > Date.parse(oldIntegration));
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 0);
  const stale = await f.json(['integrate', run.id, 'feature']);
  assert.equal(stale.cleanup.removed.length, 0);
  await f.command(['accept', run.id, 'feature']);
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 0);
  const confirmed = await f.json(['integrate', run.id, 'feature']);
  assert.equal(confirmed.cleanup.removed.length, 1);
  assert.ok(Date.parse(readJson(f.taskFile(run, 'feature')).integratedAt) >= Date.parse(restored.restoredAt));
  assert.equal(await f.git(['rev-parse', wt.branch]), tip);
});

test('idle gc collects a restored worktree whose task was resumed and only read afterwards, and a dry run agrees', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const wt = await worktree(f, run, 'feature');
  finished(f, run, 'feature', 1, { closedAt: daysAgo(1), closedBy: 'previous coordinator' });
  await f.command(['cleanup', run.id]);
  await f.command(['worktree', run.id, 'feature', '--no-prep']);
  idleRun(f, run);
  // Restored five days ago, then resumed as attempt 2, whose result was read three days ago: closed, not explicitly.
  const task = readJson(f.taskFile(run, 'feature'));
  patch(f, run, 'feature', { attempt: 2, closedAt: daysAgo(3), closedExplicitlyAttempt: 1, worktree: { ...task.worktree, restoredAt: daysAgo(5) } });
  assert.equal((await f.json(['cleanup', run.id])).removed.length, 0, 'cleanup still needs an explicit close');
  idleRun(f, run); // the cleanup above counted as activity
  const dry = await f.json(['gc', '--dry-run']);
  assert.equal(dry.totals.removed, 1, `the dry run counts it: ${JSON.stringify(dry.runs)}`);
  assert.equal(fs.existsSync(wt.path), true);
  assert.equal((await f.json(['gc'])).totals.removed, 1);
  assert.equal(fs.existsSync(wt.path), false);
});

test('a worktree on another local branch, as a babysitter\'s is, is collected; one on a detached commit no branch holds is kept', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  // On the pull request's own branch: the commit is on neither the task's branch nor the base.
  const pr = await worktree(f, run, 'babysit', { closedAt: daysAgo(3) });
  await f.git(['-C', pr.path, 'switch', '-q', '-c', 'feature/pull-request']);
  const onBranch = await commit(f, pr);
  // On a detached HEAD with a commit that no branch holds.
  const loose = await worktree(f, run, 'detached', { closedAt: daysAgo(3) });
  await f.git(['-C', loose.path, 'switch', '-q', '--detach']);
  await commit(f, loose, 'loose.txt');
  idleRun(f, run);
  const out = await f.json(['gc']);
  assert.deepEqual(out.runs[0].removed.map((r) => r.task), ['babysit']);
  assert.match(out.runs[0].kept.find((k) => k.task === 'detached').reason, /not reachable from a retained branch/);
  assert.equal(fs.existsSync(pr.path), false);
  assert.equal(fs.existsSync(loose.path), true);
  assert.equal((await f.git(['rev-parse', 'feature/pull-request'])).trim(), String(onBranch).trim(), 'the branch and its commit remain');
});

test('gc text lists only runs with something to report, names sizes in units, and ends with a total', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const empty = await f.newRun('empty'); // no worktrees, nothing to expire
  const wt = await worktree(f, run, 'done', { closedAt: daysAgo(3) });
  fs.writeFileSync(path.join(wt.path, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  await f.git(['-C', wt.path, 'add', 'big.bin']);
  await f.git(['-C', wt.path, 'commit', '-qm', 'Large fixture file']);
  idleRun(f, run);
  idleRun(f, empty);
  const text = (await f.command(['gc'])).stdout;
  assert.ok(!text.includes(empty.id), 'a run with nothing to report is left out');
  assert.match(text, new RegExp(`${run.id}\\nremoved worktree `));
  assert.doesNotMatch(text, /freed 0 bytes/);
  assert.match(text, /\nfreed \d+(\.\d)? MB\n/);
  assert.match(text.trim().split('\n').at(-1), /^removed 1 worktree and freed \d+(\.\d)? MB; kept 0; expired 0 tasks; 2 runs checked$/);
});

test('a refused run names its owner, and a main session collects the runs its own delegated task started', async (t) => {
  const f = await fixture(t);
  const session = (id) => ({ CLAUDE_CODE_SESSION_ID: id, CODEX_THREAD_ID: id });
  const A = session('session-a'), B = session('session-b');
  const parent = await f.newRun('parent', A);
  f.launchingSession(parent, 'session-a');
  await f.start(parent, 'lead', { flags: ['--read-only'], env: A });
  await f.finished(parent, 'lead');
  // The run that task `lead` started for its own agents, with a closed task's worktree.
  const child = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'lead' };
  const nested = await f.newRun('nested', child);
  const wt = await f.json(['worktree', nested.id, 'kid', '--no-prep'], { env: child });
  patch(f, nested, 'kid', { closedAt: daysAgo(3), closedExplicitlyAttempt: 0 });
  idleRun(f, parent);
  idleRun(f, nested);

  const other = await f.command(['gc', '--dry-run'], { env: B });
  assert.match(other.stdout, new RegExp(`${nested.id}: ownership refused \\(belongs to task lead of run ${parent.id} \\(an orch task\\), under (claude|codex) session session-a[^)]*\\)\\)`));
  assert.equal(fs.existsSync(wt.path), true);

  const mine = await f.json(['gc'], { env: A });
  assert.deepEqual(mine.runs.find((r) => r.run === nested.id).removed.map((r) => r.task), ['kid']);
  assert.equal(fs.existsSync(wt.path), false);
});

// Who launched a run, as gc finds it: a session whose PID names no process (it has ended), or this
// test's own process, which shows as a live `codex` host (helpers.mjs sets its title).
function launchedBy(run, { live = false } = {}) {
  const file = path.join(run.dir, 'run.json');
  const record = readJson(file);
  writeJson(file, { ...record, orchestrator: { ...record.orchestrator, agent: live ? 'codex' : 'claude', sessionId: live ? 'live-session' : 'ended-session', pid: live ? process.pid : 99999999 } });
}
const notices = (run) => fs.readFileSync(path.join(run.dir, 'owner-notices.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('gc collects a run whose launching session has ended, for another session and under every safety rule; a live session keeps its run', async (t) => {
  const f = await fixture(t);
  const ended = await f.newRun('ended');
  const clean = await worktree(f, ended, 'clean', { closedAt: daysAgo(3) });
  const dirty = await worktree(f, ended, 'dirty', { closedAt: daysAgo(3) });
  fs.writeFileSync(path.join(dirty.path, 'precious'), 'Uncommitted work');
  const open = await worktree(f, ended, 'open');
  launchedBy(ended);
  idleRun(f, ended);
  const live = await f.newRun('live');
  const kept = await worktree(f, live, 'closed', { closedAt: daysAgo(3) });
  launchedBy(live, { live: true });
  idleRun(f, live);
  const B = { CLAUDE_CODE_SESSION_ID: 'session-b', CODEX_THREAD_ID: 'session-b' };

  const preview = await f.command(['gc', '--dry-run'], { env: B });
  assert.match(preview.stdout, new RegExp(`${ended.id}: its session has ended \\(its process \\(pid 99999999\\) is gone\\)\\n  would expire|${ended.id}: its session has ended \\(its process \\(pid 99999999\\) is gone\\)\\nwould remove`));
  assert.match(preview.stdout, new RegExp(`${live.id}: ownership refused \\(belongs to codex session live-session`));
  assert.equal(fs.existsSync(clean.path), true);

  const report = await f.json(['gc'], { env: B });
  const collected = report.runs.find((r) => r.run === ended.id);
  assert.deepEqual(collected.removed.map((r) => r.task), ['clean']);
  assert.deepEqual(Object.fromEntries(collected.kept.map((r) => [r.task, r.reason])), { dirty: 'uncommitted changes', open: 'task is not closed or accepted and integrated' });
  assert.equal(collected.sessionEnded, 'its process (pid 99999999) is gone');
  assert.equal(report.runs.find((r) => r.run === live.id).reason, 'ownership refused');
  assert.equal(fs.existsSync(clean.path), false);
  assert.ok(await f.git(['branch', '--list', clean.branch]), 'the collected worktree lost its branch');
  for (const wt of [dirty, open, kept]) assert.equal(fs.existsSync(wt.path), true);
  // The run's owner, should its session come back, learns who removed the worktree.
  assert.deepEqual(notices(ended).map((n) => n.action), ['worktree removed']);
  assert.match(notices(ended)[0].byLabel, /session session-b/);
  // Only gc widens: other commands still refuse such a run until --adopt takes it over.
  const refused = await f.command(['cleanup', ended.id], { code: 4, env: B });
  assert.match(refused.stderr, /refusing to clean up run/);
  assert.equal(fs.existsSync(dirty.path), true);
});

test('gc --auto collects the caller\'s own and ended sessions\' idle runs, never a live session\'s, after 24 hours or 1 hour on a low disk, and logs only what it changed', async (t) => {
  const f = await fixture(t);
  const own = await f.newRun('own');
  const ownWt = await worktree(f, own, 'old', { closedAt: daysAgo(3) });
  idleRun(f, own, 3 / 24);
  const ended = await f.newRun('ended');
  const endedWt = await worktree(f, ended, 'old', { closedAt: daysAgo(3) });
  launchedBy(ended);
  idleRun(f, ended, 3 / 24);
  const live = await f.newRun('live');
  const liveWt = await worktree(f, live, 'old', { closedAt: daysAgo(3) });
  launchedBy(live, { live: true });
  idleRun(f, live, 3);
  const plenty = { AGENT_ORCH_DISK_FREE_BYTES: '100GB' }, low = { AGENT_ORCH_DISK_FREE_BYTES: '20GB' };

  // With space to spare, three hours of rest is too recent, and the live session's run is its own.
  assert.equal((await f.command(['gc', '--auto'], { env: plenty })).stdout, '', 'a collection that changed nothing printed something');
  const quiet = await f.json(['gc', '--auto', '--dry-run'], { env: plenty });
  assert.equal(quiet.olderThan, 24 * 3600000);
  assert.deepEqual(quiet.disk.low, false);
  assert.deepEqual(Object.fromEntries(quiet.runs.map((r) => [r.run, r.reason])), { [own.id]: 'run is too recent', [ended.id]: 'run is too recent', [live.id]: 'ownership refused' });

  // On a low disk the age is one hour.
  assert.equal((await f.json(['gc', '--auto', '--dry-run'], { env: low })).olderThan, 3600000);
  const run = await f.command(['gc', '--auto'], { env: low });
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 3, run.stdout);
  for (const [r, wt] of [[own, ownWt], [ended, endedWt]]) {
    assert.ok(lines.some((line) => line.startsWith(`orch: auto gc removed worktree ${wt.path} (run ${r.id}, task old, `) && line.endsWith(`; branch kept: ${wt.branch})`)), run.stdout);
    assert.equal(fs.existsSync(wt.path), false);
  }
  assert.match(lines[2], /^orch: auto gc freed \S+ \S+ from 2 worktrees; disk 20 GB free$/);
  assert.equal(fs.existsSync(liveWt.path), true, 'automatic collection took a live session\'s worktree');
  // Nobody asked for an automatic change, so every run's owner is told, the caller's own included.
  for (const r of [ended, own]) assert.deepEqual(notices(r).map((n) => [n.action, n.byLabel]), [['worktree removed', 'automatic worktree collection']]);
  // An explicit gc from a terminal still collects any run, the live session's too.
  assert.deepEqual((await f.json(['gc'])).runs.find((r) => r.run === live.id).removed.map((r) => r.task), ['old']);
});

test('gc keeps a worktree whose real path is outside its run folder: one made with --path elsewhere, and one reached through a link that leads out', async (t) => {
  const f = await fixture(t), run = await f.newRun('outside');
  const inside = await worktree(f, run, 'inside', { closedAt: daysAgo(3) });
  const elsewhere = await f.json(['worktree', run.id, 'elsewhere', '--no-prep', '--path', path.join(f.root, 'review-elsewhere')]);
  patch(f, run, 'elsewhere', { closedAt: daysAgo(3), closedExplicitlyAttempt: 0 });
  // A link inside the run folder whose target is outside it.
  const target = await f.json(['worktree', run.id, 'linked', '--no-prep', '--path', path.join(f.root, 'linked-target')]);
  const link = path.join(run.dir, 'worktrees', 'linked');
  fs.symlinkSync(target.path, link);
  patch(f, run, 'linked', { closedAt: daysAgo(3), closedExplicitlyAttempt: 0, worktree: { ...readJson(f.taskFile(run, 'linked')).worktree, path: link } });
  idleRun(f, run);
  const outside = 'worktree is outside the run folder';

  const preview = await f.json(['gc', '--dry-run']);
  const planned = preview.runs.find((r) => r.run === run.id);
  assert.deepEqual(planned.removed.map((r) => r.task), ['inside']);
  assert.deepEqual(Object.fromEntries(planned.kept.map((r) => [r.task, r.reason])), { elsewhere: outside, linked: outside });
  const report = await f.json(['gc']);
  assert.deepEqual(Object.fromEntries(report.runs.find((r) => r.run === run.id).kept.map((r) => [r.task, r.reason])), { elsewhere: outside, linked: outside });
  assert.equal(fs.existsSync(inside.path), false);
  for (const wt of [elsewhere, target]) assert.equal(fs.existsSync(path.join(wt.path, '.git')), true, `${wt.path} was removed`);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  // The automatic collection keeps them too, on a low disk.
  const auto = await f.json(['gc', '--auto', '--older-than', '0s'], { env: { AGENT_ORCH_DISK_FREE_BYTES: '20GB' } });
  assert.deepEqual(auto.runs.find((r) => r.run === run.id).kept.map((r) => r.reason), [outside, outside]);
  for (const wt of [elsewhere, target]) assert.equal(fs.existsSync(path.join(wt.path, '.git')), true);
});

test('gc --auto leaves a run whose session ended under an hour ago; an explicit gc collects it', async (t) => {
  const f = await fixture(t), run = await f.newRun('recent');
  const wt = await worktree(f, run, 'old', { closedAt: daysAgo(3) });
  launchedBy(run);
  idleRun(f, run);
  const file = path.join(run.dir, 'run.json');
  writeJson(file, { ...readJson(file), orchestrator: { ...readJson(file).orchestrator, lastSeenAt: new Date(Date.now() - 10 * 60000).toISOString() } });
  const auto = await f.json(['gc', '--auto', '--older-than', '0s'], { env: { AGENT_ORCH_DISK_FREE_BYTES: '20GB' } });
  assert.equal(auto.runs.find((r) => r.run === run.id).reason, 'ownership refused');
  assert.equal(fs.existsSync(wt.path), true);
  const B = { CLAUDE_CODE_SESSION_ID: 'session-b', CODEX_THREAD_ID: 'session-b' };
  const explicit = await f.json(['gc', '--older-than', '0s'], { env: B });
  assert.deepEqual(explicit.runs.find((r) => r.run === run.id).removed.map((r) => r.task), ['old']);
});
