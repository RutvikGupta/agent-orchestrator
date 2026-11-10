// All worktree removal goes through these checks. Branches remain recovery points.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reclaimTask } from './reclaim.mjs';
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
    const running = relayAlive(task.pid, task.startedAt) || isParked(run, task);
    const result = task.outDir ? readJson(path.join(task.outDir, 'result.json')) : null;
    const evidence = task.outDir ? readJson(path.join(task.outDir, 'evidence.json')) : null;
    let eventTime = 0;
    try { eventTime = fs.statSync(path.join(task.outDir, 'events.jsonl')).mtimeMs; } catch {}
    return [{ id, attempt: task.attempt || 0, state: running ? 'running' : !task.pid ? 'prepared' : result?.status || 'aborted', result,
      lastActiveMs: Math.max(eventTime, Date.parse(result?.finishedAt || '') || 0),
      readAt: evidence && evidence.attempt === task.attempt ? evidence.readAt : null }];
  });
}

export function worktreeSafety(run, task) {
  const wt = task.worktree?.path;
  if (!wt || !fs.existsSync(wt)) return 'worktree missing';
  if (isParked(run, task) || relayAlive(task.pid, task.startedAt)) return 'task still running';
  if (!task.closedAt && !(acceptedNow(task) && task.integratedAt)) return 'task is not closed or accepted and integrated';
  if (samePath(wt, run.repo)) return 'worktree is the repository checkout';
  const top = value(wt, ['rev-parse', '--show-toplevel']);
  const common = value(wt, ['rev-parse', '--git-common-dir']);
  const repoCommon = value(run.repo, ['rev-parse', '--git-common-dir']);
  const registered = value(run.repo, ['worktree', 'list', '--porcelain', '-z']);
  if (!top || !samePath(top, wt) || !common || !repoCommon ||
      !samePath(path.resolve(wt, common), path.resolve(run.repo, repoCommon)) ||
      !registered?.split('\0').some((line) => line.startsWith('worktree ') && samePath(line.slice(9), wt))) {
    return 'worktree is not registered in the run repository';
  }
  const status = git(wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  if (status.status !== 0) return 'git status failed';
  if (status.stdout) return 'uncommitted changes';
  const head = value(wt, ['rev-parse', '--verify', 'HEAD']);
  const refs = [task.worktree.branch, run.baseBranch].filter(Boolean)
    .map((branch) => value(run.repo, ['rev-parse', '--verify', `refs/heads/${branch}`])).filter(Boolean);
  const retained = (commit) => refs.some((ref) => git(run.repo, ['merge-base', '--is-ancestor', commit, ref]).status === 0);
  if (!head || !retained(head) || (task.acceptedCommit && !retained(task.acceptedCommit))) return 'commits are not reachable from a retained branch';
  return null;
}

// du measures allocated blocks and does not follow preparation symlinks outside the worktree.
function diskBytes(wt) {
  const r = spawnSync('du', ['-sk', wt], { encoding: 'utf8' });
  const kb = Number.parseInt(r.stdout, 10);
  return r.status === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}

export async function collectWorktrees(run, { dryRun = false, tasks = null, actor = null, expired = new Set() } = {}) {
  const report = { run: run.id, removed: [], kept: [], bytesFreed: 0 };
  for (const id of tasks || gcTasks(run).map((r) => r.id)) {
    let task = loadTask(run, id);
    if (!task?.worktree) continue;
    const entry = { task: id, path: task.worktree.path, branch: task.worktree.branch };
    let reason = worktreeSafety(run, dryRun && expired.has(id) ? { ...task, closedAt: 'expired' } : task);
    if (reason) { report.kept.push({ ...entry, reason }); continue; }
    let g;
    if (!dryRun) {
      g = guard(run, `remove worktrees from run ${run.id}`, { refused: [id] });
      reclaimTask(run, task);
      const teardown = await teardownWorktree(run, task);
      if (teardown.some((r) => r.exitCode !== 0)) { report.kept.push({ ...entry, reason: 'teardown failed' }); continue; }
      // Teardown can modify tracked files, and another command may have reopened the task.
      task = loadTask(run, id);
      reason = task?.worktree ? worktreeSafety(run, task) : 'task worktree changed';
      if (reason || task.worktree.path !== entry.path) {
        report.kept.push({ ...entry, reason: reason || 'task worktree changed' }); continue;
      }
    }
    const bytes = diskBytes(entry.path);
    if (!dryRun) {
      // --force permits ignored build output only; status above rejects all other changes.
      const removed = git(run.repo, ['worktree', 'remove', '--force', entry.path]);
      if (removed.status !== 0) { report.kept.push({ ...entry, reason: 'git worktree remove failed', detail: removed.stderr.trim() }); continue; }
      task.removedWorktree = { ...task.worktree, removedAt: new Date().toISOString() };
      delete task.worktree;
      task.worktreeRemovedBy = actor || g.actor;
      saveTask(run, task);
      recordChange(run, g, { task: id, attempt: task.attempt || null, action: 'worktree removed' });
    }
    report.removed.push({ ...entry, bytes, dryRun });
    report.bytesFreed += bytes || 0;
  }
  return report;
}

export function collectionText(report, dryRun = false) {
  return [...report.removed.map((r) => `${dryRun ? 'would remove' : 'removed'} worktree ${r.path} (branch kept: ${r.branch || '(none)'})`),
    ...report.kept.map((r) => `skip ${r.task}: ${r.reason} (${r.path})`),
    `${dryRun ? 'would free' : 'freed'} ${report.bytesFreed} bytes${report.removed.some((r) => r.bytes === null) ? ' (some sizes unavailable)' : ''}`].join('\n');
}
