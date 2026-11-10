// `stats`: historical evidence about delegated tasks, grouped independently by agent and type.
import { compact, formatElapsed, table } from "../format.mjs";
import { listRuns, loadRun } from "../runs.mjs";
import { sinceDuration, taskStats } from "../stats.mjs";
import { die, emit } from "../util.mjs";

export function cmdStats(args) {
  if (args._.length > 1) die("usage: stats [RUN] [--since DUR] [--json]", 2);
  const since = sinceDuration(args.since);
  const cutoff = Date.now() - since;
  const runs = args._[0] ? [loadRun(args._[0])] : listRuns().filter((run) => Date.parse(run.createdAt) >= cutoff);
  const groups = taskStats(runs);
  const rows = (entries, label) => entries.map((g) => ({
    group: label(g), tasks: g.tasks, attempts: g.attempts,
    "first accepted": `${g.firstAttemptAccepted}/${g.accepted}`, accepted: g.accepted, integrated: g.integrated,
    failed: g.failed, "limit hits": g.limitHits, transient: g.transientErrors,
    "first elapsed": formatElapsed(g.medianFirstAttemptMs), "review wait": formatElapsed(g.medianReviewWaitMs),
    "tokens in": compact(g.tokensIn), "tokens out": compact(g.tokensOut),
    "tokens in per accepted": compact(g.tokensInPerAccepted),
  }));
  const columns = ["group", "tasks", "attempts", "first accepted", "accepted", "integrated", "failed", "limit hits", "transient", "first elapsed", "review wait", "tokens in", "tokens out", "tokens in per accepted"];
  const text = groups.byAgent.length ? [
    "By agent and model", table(rows(groups.byAgent, (g) => `${g.agent} ${g.modelLabel}`), columns),
    "By task type", table(rows(groups.byType, (g) => g.type), columns),
  ].join("\n") : "no tasks in range";
  emit(args, groups, text);
}
