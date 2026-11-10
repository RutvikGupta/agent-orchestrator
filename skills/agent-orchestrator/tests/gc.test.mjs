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
  patch(f, run, id, fields);
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
  patch(f, run, id, { pid: 99999999, attempt: 1, agent: 'claude', outDir, startedAt: daysAgo(days + 1), ...fields });
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
  const detachedTip = await commit(f, detached);
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
