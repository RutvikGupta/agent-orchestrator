// Collect inactive runs the caller may collect, retaining every branch and unsafe worktree.
import { diskState, diskSummary } from '../disk.mjs';
import { die, emit } from '../util.mjs';
import { autoCollect, autoCollectionLines, collectRuns, collectionText, duration, sizeText } from '../worktree-gc.mjs';

export async function cmdGc(args) {
  if (args._.length) die('gc takes no run argument; it checks runs the caller may own', 2);
  const dryRun = Boolean(args['dry-run']);
  const expireAfter = duration(process.env.AGENT_ORCH_EXPIRE ?? '7d');
  // `--auto` is the collection the dashboard runs on its own: it leaves a live session's runs to
  // that session, and its age shortens while the disk is low.
  let disk = null;
  if (args.auto) {
    try { disk = diskState(); } catch (error) { die(error.message, 2); }
  }
  const given = args['older-than'] === undefined ? null : duration(args['older-than']);
  const { olderThan, reports } = args.auto
    ? await autoCollect({ disk, dryRun, olderThan: given })
    : { olderThan: given ?? duration('24h'), reports: (await collectRuns({ dryRun, olderThan: given ?? duration('24h'), expireAfter })).reports };
  const totals = { removed: 0, kept: 0, keptByReason: {}, expired: 0, bytesFreed: 0 };
  for (const r of reports) {
    totals.removed += r.removed.length; totals.kept += r.kept.length;
    totals.expired += r.expired.length; totals.bytesFreed += r.bytesFreed;
    for (const k of r.kept) totals.keptByReason[k.reason] = (totals.keptByReason[k.reason] || 0) + 1;
  }
  const value = { dryRun, olderThan, expireAfter, ...(args.auto ? { auto: true, disk } : {}), runs: reports, totals };
  // The automatic collection logs only what it changed: one line per worktree removed and task
  // expired, then what it freed and the free space left. It prints nothing when it changed nothing.
  if (args.auto && !args.json) {
    const lines = autoCollectionLines(reports, dryRun);
    if (lines.length) {
      lines[lines.length - 1] += totals.removed && !dryRun ? `; ${diskSummary(diskState())}` : '';
      process.stdout.write(lines.map((line) => `orch: ${line}\n`).join(''));
    }
    return;
  }
  // The text lists only the runs with something to say (a worktree removed or kept, or a task
  // expired), then one line of totals: a line per empty run buried the result.
  const shown = reports.filter((r) => r.removed.length || r.kept.length || r.expired.length);
  const kept = Object.entries(totals.keptByReason).map(([why, n]) => `${n} ${why}`).join(', ');
  const total = `${dryRun ? 'would remove' : 'removed'} ${totals.removed} worktree${totals.removed === 1 ? '' : 's'} and ${dryRun ? 'free' : 'freed'} ${sizeText(totals.bytesFreed)}`
    + `; kept ${totals.kept}${kept ? ` (${kept})` : ''}; ${dryRun ? 'would expire' : 'expired'} ${totals.expired} task${totals.expired === 1 ? '' : 's'}; ${reports.length} runs checked`;
  const heading = (r) => `${r.run}${r.reason ? `: ${r.reason}${r.owner ? ` (belongs to ${r.owner})` : ''}` : r.sessionEnded ? `: its session has ended (${r.sessionEnded})` : ''}`;
  emit(args, value,
    [...shown.map((r) => `${heading(r)}\n${r.expired.length ? `  ${dryRun ? 'would expire' : 'expired'}: ${r.expired.join(', ')}\n` : ''}${collectionText(r, dryRun)}`), total].join('\n\n'));
}
