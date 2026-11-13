// All worktree removal goes through these checks. Branches remain recovery points.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CACHE_PATH, CLI_PATH } from './config.mjs';
import { diskRefusal, diskSize, diskState } from './disk.mjs';
import { reclaimTask, runningDirectories } from './reclaim.mjs';
import { acceptedNow, isClosedPreparation } from './lifecycle.mjs';
import { AUTO_COLLECTOR, guard, ownerText, ownershipOf, recordChange, resetHostView, sessionsEnded, sinceLastUse } from './ownership.mjs';
import { isParked, listRuns, loadTask, relayAlive, saveTask } from './runs.mjs';
import { die, parseDuration, readJson } from './util.mjs';
import { teardownWorktree } from './worktree-prep.mjs';

// A check that hangs (a huge or damaged worktree, a stuck filesystem) must not hold up collection, or
// the worktree creation that waits for it: a git or du call that runs past its limit counts as failed,
// which keeps the worktree. Removing a folder gets longer, since stopping it halfway helps nobody.
const CHECK_TIMEOUT_MS = 30_000, REMOVE_TIMEOUT_MS = 5 * 60_000;
const git = (cwd, args, timeout = CHECK_TIMEOUT_MS) => spawnSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout,
});
const value = (cwd, args) => { const r = git(cwd, args); return r.status === 0 ? r.stdout.trim() : null; };
const samePath = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
};

const taskIds = (run) => {
  const dir = path.join(run.dir, 'tasks');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

// Do not use describe/listTasks here: describing large event logs persists summary caches.
export function gcTasks(run) {
  return taskIds(run).flatMap((id) => {
    const task = loadTask(run, id);
    if (!task) return [];
    const running = relayAlive(task.pid, task.startedAt, task.outDir) || isParked(run, task);
    const result = task.outDir ? readJson(path.join(task.outDir, 'result.json')) : null;
    const evidence = task.outDir ? readJson(path.join(task.outDir, 'evidence.json')) : null;
    const eventTime = latestAttemptActivity(task.outDir);
    return [{ id, attempt: task.attempt || 0, state: running ? 'running' : !task.pid ? (isClosedPreparation(task) ? 'closed' : 'prepared') : result?.status || 'aborted', result,
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

// A path with every link resolved: the path's own real path, or, for a path that does not exist, its
// nearest existing parent's with the rest appended. Null for a link that cannot be resolved.
function canonical(p) {
  let at = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(at), ...rest); } catch {}
    try { fs.lstatSync(at); return null; } catch {}
    const up = path.dirname(at);
    if (up === at) return null;
    rest.unshift(path.basename(at));
    at = up;
  }
}

// Whether a worktree's real path lies inside its run's folder. `gc` collects only those: a folder
// placed elsewhere with `worktree --path`, or reached through a link that leads out of the run
// folder, may be something a person still uses.
export function insideRunFolder(run, wt) {
  const root = canonical(run.dir), real = canonical(wt);
  return Boolean(root && real && real.startsWith(root + path.sep));
}

// Which folder a path leads to now: its real path, and the device and inode of that folder. Null
// when it does not resolve.
function folderIdentity(wt) {
  try {
    const real = fs.realpathSync(wt), st = fs.statSync(real);
    return { real, dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}
const sameFolder = (a, b) => Boolean(a && b && a.real === b.real && a.dev === b.dev && a.ino === b.ino);

// `insideRun`: also keep a worktree whose real path is outside the run's folder (gc).
export function worktreeSafety(run, task, { allowReadClosed = false, insideRun = false } = {}) {
  const wt = task.worktree?.path;
  if (!wt) return 'worktree path missing';
  if (isParked(run, task) || relayAlive(task.pid, task.startedAt, task.outDir)) return 'task still running';
  if (insideRun && !insideRunFolder(run, wt)) return 'worktree is outside the run folder';
  try {
    const root = fs.existsSync(wt) ? fs.realpathSync(wt) : path.resolve(wt);
    if (runningDirectories().some((dir) => dir === root || dir.startsWith(root + path.sep))) return 'worktree is used by a running or parked task';
  } catch { return 'cannot check running task directories'; }
  if (samePath(wt, run.repo) || path.resolve(wt) === path.resolve(run.repo)) return 'worktree is the repository checkout';
  const registered = registration(run, wt);
  if (registered.error) return registered.error;
  const exists = fs.existsSync(wt);
  if (exists) {
    const preparedAt = task.worktree.createdAt || task.worktree.restoredAt;
    if (preparedAt) {
      const preparedMs = Date.parse(preparedAt);
      // Idle-run GC also counts a result that was read after the folder was recreated.
      const closedAfterPreparation = (allowReadClosed || task.closedExplicitlyAttempt === (task.attempt || 0)) && Date.parse(task.closedAt) >= preparedMs;
      const integratedAfterPreparation = acceptedNow(task) && Date.parse(task.acceptedAt) >= preparedMs && Date.parse(task.integratedAt) >= preparedMs;
      if (!closedAfterPreparation && !integratedAfterPreparation) return `${task.worktree.restoredAt ? 'restored' : 'prepared'} worktree awaits a new explicit close or acceptance and integration`;
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
  // A commit is safe when the task's branch or the run's base holds it, or any other local branch or
  // remote-tracking branch does: a babysitter's worktree sits on its pull request's branch. Removing a
  // worktree deletes no branch, so such a commit stays reachable. A commit that only a detached HEAD
  // holds is not safe.
  const onAnyBranch = (commit) => Boolean(value(run.repo, ['for-each-ref', '--count=1', '--contains', commit, '--format=%(refname)', 'refs/heads', 'refs/remotes']));
  const retained = (commit) => refs.some((ref) => git(run.repo, ['merge-base', '--is-ancestor', commit, ref]).status === 0) || onAnyBranch(commit);
  if ((exists && !head) || (head && !retained(head)) || (task.acceptedCommit && !retained(task.acceptedCommit))) return 'commits are not reachable from a retained branch';
  return null;
}

// du measures allocated blocks and does not follow preparation symlinks outside the worktree.
function diskBytes(wt) {
  const r = spawnSync('du', ['-sk', wt], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS });
  const kb = Number.parseInt(r.stdout, 10);
  return r.status === 0 && Number.isFinite(kb) ? kb * 1024 : null;
}

// `reclaimKept`: `cleanup` also stops the build daemons a finished task left in a worktree that is
// kept, as `result` and `accept` do; a worktree whose task still runs, or that another task uses,
// is left alone. `actor` is what each removal records, and the notice to the run's owner names it.
// `ended`: the caller may act on the run because its launching sessions have ended (gc).
// `insideRun`: keep a worktree outside the run's folder (gc). `auto`: the automatic collection made
// the change, so it records that, and the run's owner gets a notice even when the caller owns it.
// `deadline`: a time (ms) after which no further worktree is judged; the rest are kept, unjudged.
export async function collectWorktrees(run, { dryRun = false, tasks = null, actor = null, expired = new Set(), allowReadClosed = false, reclaimKept = false, ended = false, insideRun = false, auto = false, deadline = Infinity } = {}) {
  const report = { run: run.id, removed: [], kept: [], bytesFreed: 0 };
  for (const id of tasks || gcTasks(run).map((r) => r.id)) {
    let task = loadTask(run, id);
    if (!task?.worktree) continue;
    const entry = { task: id, path: task.worktree.path, branch: task.worktree.branch };
    if (Date.now() >= deadline) { report.kept.push({ ...entry, reason: OUT_OF_TIME }); report.timedOut = true; continue; }
    let reason = worktreeSafety(run, dryRun && expired.has(id) ? { ...task, closedAt: new Date().toISOString(), closedExplicitlyAttempt: task.attempt || 0 } : task, { allowReadClosed, insideRun });
    if (reason) {
      report.kept.push({ ...entry, reason });
      if (reclaimKept && !dryRun && fs.existsSync(entry.path) && !isParked(run, task) && !relayAlive(task.pid, task.startedAt, task.outDir)) reclaimTask(run, task);
      continue;
    }
    // The folder the checks above looked at. Every slow step below (teardown, measuring) uses the
    // pathname, which someone could meanwhile point elsewhere: removal acts only on this folder.
    const pinned = dryRun ? null : folderIdentity(entry.path);
    let g;
    if (!dryRun) {
      g = guard(run, `remove worktrees from run ${run.id}`, { refused: [id], ended });
      if (fs.existsSync(entry.path)) {
        reclaimTask(run, task);
        const teardown = await teardownWorktree(run, task);
        entry.teardownFailures = teardown.filter((r) => r.exitCode !== 0);
      }
      // Teardown can modify tracked files, and another command may have reopened the task.
      task = loadTask(run, id);
      reason = task?.worktree ? worktreeSafety(run, task, { allowReadClosed, insideRun }) : 'task worktree changed';
      if (reason || task.worktree.path !== entry.path) {
        report.kept.push({ ...entry, reason: reason || 'task worktree changed' }); continue;
      }
    }
    const missing = !fs.existsSync(entry.path);
    const bytes = missing ? 0 : diskBytes(entry.path);
    if (!dryRun) {
      // The last step before removal: the pathname must still lead to the folder that was checked
      // (the same real path, device and inode), inside the run folder for gc, and removal then names
      // that real path, so a parent swapped for a link during the steps above is not followed. A
      // swap in the instant between this check and git's removal is not caught.
      const now = missing ? null : folderIdentity(entry.path);
      const target = missing ? canonical(entry.path) : now?.real;
      const moved = missing ? Boolean(pinned) && fs.existsSync(pinned.real) : !sameFolder(pinned, now);
      if (moved || !target || (insideRun && !insideRunFolder(run, target))) {
        report.kept.push({ ...entry, reason: 'worktree folder changed while it was being collected' }); continue;
      }
      // Remove this registration only; a repository-wide prune could affect another run.
      // --force permits ignored output and untracked cache files only.
      const removed = missing && !registration(run, entry.path).registered ? { status: 0 } : git(run.repo, ['worktree', 'remove', '--force', target], REMOVE_TIMEOUT_MS);
      if (removed.status !== 0) { report.kept.push({ ...entry, reason: 'git worktree remove failed', detail: (removed.stderr || '').trim() }); continue; }
      task.removedWorktree = { ...task.worktree, removedAt: new Date().toISOString() };
      delete task.worktree;
      task.worktreeRemovedBy = auto ? AUTO_COLLECTOR : actor || g.actor;
      saveTask(run, task);
      recordChange(run, auto ? automatic(g) : actor ? { ...g, actor } : g, { task: id, attempt: task.attempt || null, action: 'worktree removed' });
    }
    report.removed.push({ ...entry, bytes, dryRun, missing, recreateCommand: `node ${CLI_PATH} worktree ${run.id} ${id}` });
    report.bytesFreed += bytes || 0;
  }
  return report;
}

// The reason a worktree is kept when a collection pass reached its deadline before judging it.
export const OUT_OF_TIME = 'not checked: the collection ran out of time';

// What a change by the automatic collection records: the collector as the actor, and a notice for
// the run's owner whoever runs the collection, since nobody asked for the change.
const automatic = (g) => ({ ...g, owned: false, actor: AUTO_COLLECTOR });

// The existing duration parser accepts hours; GC also accepts days for its longer defaults.
export const duration = (s) => /^\d+(?:\.\d+)?d$/.test(String(s)) ? Number.parseFloat(s) * 86400000 : parseDuration(s);
const time = (s) => Date.parse(s || '') || 0;

// A run's latest activity: its creation, its owner's last use, its plan and notices, and each
// task's own times and files.
function activity(run, rows) {
  let latest = Math.max(time(run.createdAt), time(run.orchestrator?.lastSeenAt));
  const stat = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  latest = Math.max(latest, stat(path.join(run.dir, 'plan.json')), stat(path.join(run.dir, 'owner-notices.jsonl')));
  for (const row of rows) {
    const task = loadTask(run, row.id);
    latest = Math.max(latest, row.lastActiveMs || 0, ...['createdAt', 'startedAt', 'closedAt', 'acceptedAt', 'integratedAt', 'resultReadAt'].map((k) => time(task[k])));
    const dir = path.join(run.dir, 'tasks', row.id);
    for (const name of ['task.json', 'inbox.jsonl', 'reviews.jsonl', 'verifications.jsonl']) latest = Math.max(latest, stat(path.join(dir, name)));
  }
  return latest;
}

// A run whose launching sessions have ended is collected automatically only once none of them has
// used it for this long, so a session that has just ended or resumed elsewhere keeps its run.
export const ENDED_QUIET_MS = 3600000;

// gc over every run: expire unread finished tasks, then collect worktrees, in each run the caller
// may collect that has no running task and no activity for `olderThan`. The caller may collect its
// own runs; at a terminal, any run (not in `auto` mode, which leaves a live session's runs to it);
// and any caller, a run whose launching sessions have all certainly ended (sessionsEnded), in `auto`
// mode only once they have not used it for ENDED_QUIET_MS. A caller whose identity cannot be read
// collects nothing. Only worktrees inside the run's folder are collected. `auto` records the
// automatic collector as the actor, and leaves the run's owner a notice of every change.
// `deadline`: a time (ms) after which the pass stops: the runs it has not reached are left alone and
// counted in `unchecked`, and `timedOut` is set. Returns { reports, timedOut, unchecked }.
export async function collectRuns({ dryRun = false, olderThan, expireAfter = duration(process.env.AGENT_ORCH_EXPIRE ?? '7d'), auto = false, now = Date.now(), deadline = Infinity } = {}) {
  const reports = [];
  // One reading of the process table and of the hosts' sessions serves the whole pass.
  resetHostView();
  const runs = listRuns();
  let timedOut = false, unchecked = 0;
  for (const [index, run] of runs.entries()) {
    if (Date.now() >= deadline) { timedOut = true; unchecked = runs.length - index; break; }
    const own = ownershipOf(run);
    const report = { run: run.id, removed: [], kept: [], expired: [], bytesFreed: 0 };
    const known = own.caller.kind !== 'unknown';
    const allowed = (known && own.mine) || (!auto && own.caller.kind === 'user');
    const ended = !allowed && known && sessionsEnded(own).ended && (!auto || sinceLastUse(own) >= ENDED_QUIET_MS);
    // A refused run needs only its task ids, to list its kept worktrees: the automatic collection
    // passes over every run every five minutes, and reading each task's attempts costs time.
    const rows = allowed || ended ? gcTasks(run) : taskIds(run).map((id) => ({ id }));
    // A dry run uses the same ownership decision, without invoking any mutating guard path.
    const reason = !(allowed || ended) ? 'ownership refused' : rows.some((r) => r.state === 'running' || r.phase === 'parked') ? 'run has running tasks' : now - activity(run, rows) < olderThan ? 'run is too recent' : null;
    if (reason) {
      report.reason = reason;
      // Whose run it is, so that a refused caller knows whom to ask.
      if (reason === 'ownership refused') report.owner = ownerText(own);
      for (const row of rows) {
        const wt = loadTask(run, row.id)?.worktree;
        if (wt) report.kept.push({ task: row.id, path: wt.path, branch: wt.branch, reason });
      }
      reports.push(report);
      continue;
    }
    if (ended) report.sessionEnded = sessionsEnded(own).why;
    const g = dryRun ? null : guard(run, `garbage collect run ${run.id}`, { ended });
    const change = g && auto ? automatic(g) : g;
    const expired = new Set();
    for (const row of rows) {
      const task = loadTask(run, row.id);
      const finished = time(row.result?.finishedAt) || (row.state === 'aborted' ? row.lastActiveMs : 0);
      if (!finished || now - finished < expireAfter || task.closedAt || task.acceptedAt || task.resultReadAt || task.readAt || row.readAt || (task.decisionSeenAttempt != null && task.decisionSeenAttempt === row.attempt) || ['running', 'prepared'].includes(row.state)) continue;
      expired.add(row.id);
      report.expired.push(row.id);
      if (!dryRun) {
        saveTask(run, { ...task, closedAt: new Date(now).toISOString(), closedBy: 'expired', closedExplicitlyAttempt: task.attempt || 0 });
        recordChange(run, change, { task: row.id, attempt: task.attempt || null, action: 'expired' });
      }
    }
    const collected = await collectWorktrees(run, { dryRun, expired, allowReadClosed: true, ended, insideRun: true, auto, deadline });
    if (collected.timedOut) timedOut = true;
    reports.push({ ...report, ...collected });
  }
  return { reports, timedOut, unchecked };
}

// Automatic collection collects runs idle this long, or LOW_DISK_AGE while the disk is low.
export const AUTO_AGE = '24h';
export const LOW_DISK_AGE = '1h';

// Automatic collection: collectRuns in `auto` mode, with AUTO_AGE, or LOW_DISK_AGE while `disk` is
// low (twice the minimum free space or less). Returns { olderThan, reports }.
export async function autoCollect({ disk = diskState(), olderThan = null, dryRun = false, deadline = Infinity } = {}) {
  const age = olderThan ?? duration(disk.low ? LOW_DISK_AGE : AUTO_AGE);
  return { olderThan: age, ...(await collectRuns({ dryRun, olderThan: age, auto: true, deadline })) };
}

// How long worktree creation waits for the collection it runs on a full disk:
// AGENT_ORCH_COLLECT_TIMEOUT, default 60s. At that time the pass stops where it is, and the disk is
// read again with what it freed.
const collectTimeout = () => parseDuration(process.env.AGENT_ORCH_COLLECT_TIMEOUT || '60s');

// The log of an automatic collection: one line per worktree removed and per task expired, then
// what it freed. Nothing when it changed nothing.
export function autoCollectionLines(reports, dryRun = false) {
  const removed = reports.flatMap((r) => r.removed.map((w) => ({ ...w, run: r.run })));
  const lines = [
    ...reports.flatMap((r) => r.expired.map((id) => `auto gc ${dryRun ? 'would expire' : 'expired'} task ${id} of run ${r.run} (its result went unread for AGENT_ORCH_EXPIRE)`)),
    ...removed.map((w) => `auto gc ${dryRun ? 'would remove' : 'removed'} worktree ${w.path} (run ${w.run}, task ${w.task}, ${w.bytes == null ? 'size unknown' : sizeText(w.bytes)}; branch kept: ${w.branch || '(none)'})`),
  ];
  if (removed.length) lines.push(`auto gc ${dryRun ? 'would free' : 'freed'} ${sizeText(removed.reduce((n, w) => n + (w.bytes || 0), 0))} from ${removed.length} worktree${removed.length === 1 ? '' : 's'}`);
  return lines;
}

// Every path that creates a worktree goes through this check first. When the volume that holds
// `dir` has less free space than AGENT_ORCH_MIN_FREE_DISK, it collects automatically (as the
// dashboard does while the disk is low), reads the disk again, and refuses when it is still below
// the minimum: nothing is created. No option bypasses it; only the setting changes it.
export async function ensureDisk(dir, what = 'create a worktree') {
  let disk;
  try { disk = diskState(dir); } catch (error) { die(error.message, 2); }
  if (!disk.critical) return disk;
  const limit = collectTimeout();
  process.stderr.write(`orch: only ${diskSize(disk.freeBytes)} of disk is free, below the minimum of ${diskSize(disk.minBytes)} (AGENT_ORCH_MIN_FREE_DISK): collecting unused worktrees first\n`);
  const { reports, timedOut, unchecked } = await autoCollect({ disk, deadline: Date.now() + limit });
  const lines = autoCollectionLines(reports);
  if (timedOut) lines.push(`auto gc stopped at its limit of ${limit / 1000}s (AGENT_ORCH_COLLECT_TIMEOUT)${unchecked ? `, with ${unchecked} run${unchecked === 1 ? '' : 's'} not checked` : ''}; \`gc\` checks them all`);
  if (lines.length) process.stderr.write(lines.map((line) => `orch: ${line}\n`).join(''));
  const after = diskState(dir);
  if (!after.critical) return after;
  const removed = reports.reduce((n, r) => n + r.removed.length, 0);
  die(diskRefusal(after, { what, collected: { removed, bytesFreed: reports.reduce((n, r) => n + r.bytesFreed, 0) } }));
}

// A size a person reads: "1.2 GB", "310 MB", "4 KB".
export function sizeText(bytes) {
  const units = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];
  const [unit, size] = units.find(([, n]) => bytes >= n) || ['bytes', 1];
  return unit === 'bytes' ? `${bytes} bytes` : `${(bytes / size).toFixed(bytes / size >= 100 ? 0 : 1)} ${unit}`;
}

export function collectionText(report, dryRun = false) {
  return [...[...report.removed, ...report.kept].flatMap((r) => (r.teardownFailures || []).map((f) => `teardown ${r.task} failed (${f.exitCode ?? f.signal}): ${f.command}\n${f.output}`)),
    ...report.removed.map((r) => `${dryRun ? 'would remove' : 'removed'} worktree ${r.path} (branch kept: ${r.branch || '(none)'})\n  recreate with: ${r.recreateCommand}`),
    ...report.kept.map((r) => `skip ${r.task}: ${r.reason} (${r.path})`),
    // Only a run that removed something says what it freed.
    ...(report.removed.length ? [`${dryRun ? 'would free' : 'freed'} ${sizeText(report.bytesFreed)}${report.removed.some((r) => r.bytes === null) ? ' (some sizes unavailable)' : ''}`] : [])].join('\n');
}
