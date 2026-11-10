// All worktree removal goes through these checks. Branches remain recovery points.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CACHE_PATH, CLI_PATH } from './config.mjs';
import { reclaimTask, runningDirectories } from './reclaim.mjs';
import { acceptedNow } from './lifecycle.mjs';
import { guard, recordChange } from './ownership.mjs';
import { isParked, loadTask, relayAlive, saveTask } from './runs.mjs';
import { readJson } from './util.mjs';
import { teardownWorktree } from './worktree-prep.mjs';

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
});
const value = (cwd, args) => { const r = git(cwd, args); return r.status === 0 ? r.stdout.trim() : null; };
const samePath = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
};

// Do not use describe/listTasks here: describing large event logs persists summary caches.
export function gcTasks(run) {
  const dir = path.join(run.dir, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((id) => {
    const task = loadTask(run, id);
    if (!task) return [];
    const running = relayAlive(task.pid, task.startedAt, task.outDir) || isParked(run, task);
    const result = task.outDir ? readJson(path.join(task.outDir, 'result.json')) : null;
    const evidence = task.outDir ? readJson(path.join(task.outDir, 'evidence.json')) : null;
    const eventTime = latestAttemptActivity(task.outDir);
    return [{ id, attempt: task.attempt || 0, state: running ? 'running' : !task.pid ? 'prepared' : result?.status || 'aborted', result,
      lastActiveMs: Math.max(eventTime, Date.parse(result?.finishedAt || '') || 0),
      readAt: evidence && evidence.attempt === task.attempt ? evidence.readAt : null }];
  });
}

// Read file times without following links into other attempts or checkouts.
function latestAttemptActivity(dir) {
  if (!dir) return 0;
  let newest = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) newest = Math.max(newest, latestAttemptActivity(file));
      else newest = Math.max(newest, fs.lstatSync(file).mtimeMs);
    }
  } catch {}
  return newest;
}

function registration(run, wt) {
  const listing = value(run.repo, ['worktree', 'list', '--porcelain', '-z']);
  if (listing === null) return { error: 'cannot list registered worktrees' };
  const matches = (dir) => samePath(dir, wt) || path.resolve(dir) === path.resolve(wt);
  const record = listing.split('\0\0').find((part) => part.split('\0').some((line) => line.startsWith('worktree ') && matches(line.slice(9))));
  return { registered: Boolean(record), head: record?.split('\0').find((line) => line.startsWith('HEAD '))?.slice(5) };
}

export function worktreeSafety(run, task, { allowReadClosed = false } = {}) {
  const wt = task.worktree?.path;
  if (!wt) return 'worktree path missing';
  if (isParked(run, task) || relayAlive(task.pid, task.startedAt, task.outDir)) return 'task still running';
  try {
    const root = fs.existsSync(wt) ? fs.realpathSync(wt) : path.resolve(wt);
    if (runningDirectories().some((dir) => dir === root || dir.startsWith(root + path.sep))) return 'worktree is used by a running or parked task';
  } catch { return 'cannot check running task directories'; }
  if (samePath(wt, run.repo) || path.resolve(wt) === path.resolve(run.repo)) return 'worktree is the repository checkout';
  const registered = registration(run, wt);
  if (registered.error) return registered.error;
  const exists = fs.existsSync(wt);
  if (exists) {
    if (task.worktree.restoredAt) {
      const restoredAt = Date.parse(task.worktree.restoredAt);
      // Idle-run GC also counts a result that was only read after the restore.
      const closedAfterRestore = (allowReadClosed || task.closedExplicitlyAttempt === (task.attempt || 0)) && Date.parse(task.closedAt) >= restoredAt;
      const integratedAfterRestore = acceptedNow(task) && Date.parse(task.acceptedAt) >= restoredAt && Date.parse(task.integratedAt) >= restoredAt;
      if (!closedAfterRestore && !integratedAfterRestore) return 'restored worktree awaits a new explicit close or acceptance and integration';
    }
    // Idle-run GC can collect read results; other callers keep them available for review.
    const closed = task.closedAt && (allowReadClosed || task.readOnly || task.closedExplicitlyAttempt === (task.attempt || 0));
    if (!closed && !(acceptedNow(task) && task.integratedAt)) return `task is not ${allowReadClosed ? '' : 'explicitly '}closed or accepted and integrated`;
    const top = value(wt, ['rev-parse', '--show-toplevel']);
    const common = value(wt, ['rev-parse', '--git-common-dir']);
    const repoCommon = value(run.repo, ['rev-parse', '--git-common-dir']);
    if (!top || !samePath(top, wt) || !common || !repoCommon ||
        !samePath(path.resolve(wt, common), path.resolve(run.repo, repoCommon)) || !registered.registered) {
      return 'worktree is not registered in the run repository';
    }
    const status = git(wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
    if (status.status !== 0) return 'git status failed';
    const records = status.stdout.split('\0').filter(Boolean);
    for (const entry of records) {
      // Cache names never exempt tracked modifications, staged additions, deletions or renames.
      if (!entry.startsWith('?? ') || !CACHE_PATH.test(entry.slice(3))) return 'uncommitted changes';
    }
  }
  // A missing folder may still have a detached HEAD in git's worktree registration.
  // Prune that registration only after verifying that its commits have a durable ref.
  const head = exists ? value(wt, ['rev-parse', '--verify', 'HEAD']) : registered.head;
  const refs = [task.worktree.branch, run.baseBranch].filter(Boolean)
    .map((branch) => value(run.repo, ['rev-parse', '--verify', `refs/heads/${branch}`])).filter(Boolean);
  const retained = (commit) => refs.some((ref) => git(run.repo, ['merge-base', '--is-ancestor', commit, ref]).status === 0);
  if ((exists && !head) || (head && !retained(head)) || (task.acceptedCommit && !retained(task.acceptedCommit))) return 'commits are not reachable from a retained branch';
  return null;
}

// du measures allocated blocks and does not follow preparation symlinks outside the worktree.
function diskBytes(wt) {
  const r = spawnSync('du', ['-sk', wt], { encoding: 'utf8' });
  const kb = Number.parseInt(r.stdout, 10);
  return r.status === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}

export async function collectWorktrees(run, { dryRun = false, tasks = null, actor = null, expired = new Set(), allowReadClosed = false } = {}) {
  const report = { run: run.id, removed: [], kept: [], bytesFreed: 0 };
  for (const id of tasks || gcTasks(run).map((r) => r.id)) {
    let task = loadTask(run, id);
    if (!task?.worktree) continue;
    const entry = { task: id, path: task.worktree.path, branch: task.worktree.branch };
    let reason = worktreeSafety(run, dryRun && expired.has(id) ? { ...task, closedAt: new Date().toISOString(), closedExplicitlyAttempt: task.attempt || 0 } : task, { allowReadClosed });
    if (reason) { report.kept.push({ ...entry, reason }); continue; }
    let g;
    if (!dryRun) {
      g = guard(run, `remove worktrees from run ${run.id}`, { refused: [id] });
      if (fs.existsSync(entry.path)) {
        reclaimTask(run, task);
        const teardown = await teardownWorktree(run, task);
        entry.teardownFailures = teardown.filter((r) => r.exitCode !== 0);
      }
      // Teardown can modify tracked files, and another command may have reopened the task.
      task = loadTask(run, id);
      reason = task?.worktree ? worktreeSafety(run, task, { allowReadClosed }) : 'task worktree changed';
      if (reason || task.worktree.path !== entry.path) {
        report.kept.push({ ...entry, reason: reason || 'task worktree changed' }); continue;
      }
    }
    const missing = !fs.existsSync(entry.path);
    const bytes = missing ? 0 : diskBytes(entry.path);
    if (!dryRun) {
      // Remove this registration only; a repository-wide prune could affect another run.
      // --force permits ignored output and untracked cache files only.
      const removed = missing && !registration(run, entry.path).registered ? { status: 0 } : git(run.repo, ['worktree', 'remove', '--force', entry.path]);
      if (removed.status !== 0) { report.kept.push({ ...entry, reason: 'git worktree remove failed', detail: removed.stderr.trim() }); continue; }
      task.removedWorktree = { ...task.worktree, removedAt: new Date().toISOString() };
      delete task.worktree;
      task.worktreeRemovedBy = actor || g.actor;
      saveTask(run, task);
      recordChange(run, g, { task: id, attempt: task.attempt || null, action: 'worktree removed' });
    }
    report.removed.push({ ...entry, bytes, dryRun, missing, recreateCommand: `node ${CLI_PATH} worktree ${run.id} ${id}` });
    report.bytesFreed += bytes || 0;
  }
  return report;
}

export function collectionText(report, dryRun = false) {
  return [...[...report.removed, ...report.kept].flatMap((r) => (r.teardownFailures || []).map((f) => `teardown ${r.task} failed (${f.exitCode ?? f.signal}): ${f.command}\n${f.output}`)),
    ...report.removed.map((r) => `${dryRun ? 'would remove' : 'removed'} worktree ${r.path} (branch kept: ${r.branch || '(none)'})\n  recreate with: ${r.recreateCommand}`),
    ...report.kept.map((r) => `skip ${r.task}: ${r.reason} (${r.path})`),
    `${dryRun ? 'would free' : 'freed'} ${report.bytesFreed} bytes${report.removed.some((r) => r.bytes === null) ? ' (some sizes unavailable)' : ''}`].join('\n');
}
