// Collect inactive runs owned by the caller, retaining every branch and unsafe worktree.
import fs from 'node:fs';
import path from 'node:path';
import { guard, ownerText, ownershipOf, recordChange } from '../ownership.mjs';
import { listRuns, loadTask, saveTask } from '../runs.mjs';
import { die, emit, parseDuration } from '../util.mjs';
import { collectWorktrees, collectionText, gcTasks, sizeText } from '../worktree-gc.mjs';

// The existing duration parser accepts hours; GC also accepts days for its longer defaults.
const duration = (s) => /^\d+(?:\.\d+)?d$/.test(String(s)) ? Number.parseFloat(s) * 86400000 : parseDuration(s);
const time = (s) => Date.parse(s || '') || 0;
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

export async function cmdGc(args) {
  if (args._.length) die('gc takes no run argument; it checks runs the caller may own', 2);
  const dryRun = Boolean(args['dry-run']);
  const olderThan = duration(args['older-than'] ?? '24h');
  const expireAfter = duration(process.env.AGENT_ORCH_EXPIRE ?? '7d');
  const now = Date.now();
  const reports = [];
  for (const run of listRuns()) {
    const own = ownershipOf(run);
    const rows = gcTasks(run);
    const report = { run: run.id, removed: [], kept: [], expired: [], bytesFreed: 0 };
    // A dry run uses the same ownership decision, without invoking any mutating guard path.
    const reason = !(own.caller.kind === 'user' || (own.caller.kind !== 'unknown' && own.mine)) ? 'ownership refused' : rows.some((r) => r.state === 'running' || r.phase === 'parked') ? 'run has running tasks' : now - activity(run, rows) < olderThan ? 'run is too recent' : null;
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
    const g = dryRun ? null : guard(run, `garbage collect run ${run.id}`);
    const expired = new Set();
    for (const row of rows) {
      const task = loadTask(run, row.id);
      const finished = time(row.result?.finishedAt) || (row.state === 'aborted' ? row.lastActiveMs : 0);
      if (!finished || now - finished < expireAfter || task.closedAt || task.acceptedAt || task.resultReadAt || task.readAt || row.readAt || (task.decisionSeenAttempt != null && task.decisionSeenAttempt === row.attempt) || ['running', 'prepared'].includes(row.state)) continue;
      expired.add(row.id);
      report.expired.push(row.id);
      if (!dryRun) {
        saveTask(run, { ...task, closedAt: new Date(now).toISOString(), closedBy: 'expired', closedExplicitlyAttempt: task.attempt || 0 });
        recordChange(run, g, { task: row.id, attempt: task.attempt || null, action: 'expired' });
      }
    }
    const collected = await collectWorktrees(run, { dryRun, expired, allowReadClosed: true });
    reports.push({ ...report, ...collected });
  }
  const totals = { removed: 0, kept: 0, keptByReason: {}, expired: 0, bytesFreed: 0 };
  for (const r of reports) {
    totals.removed += r.removed.length; totals.kept += r.kept.length;
    totals.expired += r.expired.length; totals.bytesFreed += r.bytesFreed;
    for (const k of r.kept) totals.keptByReason[k.reason] = (totals.keptByReason[k.reason] || 0) + 1;
  }
  // The text lists only the runs with something to say (a worktree removed or kept, or a task
  // expired), then one line of totals: a line per empty run buried the result.
  const shown = reports.filter((r) => r.removed.length || r.kept.length || r.expired.length);
  const kept = Object.entries(totals.keptByReason).map(([why, n]) => `${n} ${why}`).join(', ');
  const total = `${dryRun ? 'would remove' : 'removed'} ${totals.removed} worktree${totals.removed === 1 ? '' : 's'} and ${dryRun ? 'free' : 'freed'} ${sizeText(totals.bytesFreed)}`
    + `; kept ${totals.kept}${kept ? ` (${kept})` : ''}; ${dryRun ? 'would expire' : 'expired'} ${totals.expired} task${totals.expired === 1 ? '' : 's'}; ${reports.length} runs checked`;
  emit(args, { dryRun, olderThan, expireAfter, runs: reports, totals },
    [...shown.map((r) => `${r.run}${r.reason ? `: ${r.reason}${r.owner ? ` (belongs to ${r.owner})` : ''}` : ''}\n${r.expired.length ? `  ${dryRun ? 'would expire' : 'expired'}: ${r.expired.join(', ')}\n` : ''}${collectionText(r, dryRun)}`), total].join('\n\n'));
}
