// Historical task outcomes. Read records first; only unfinished/failed tasks need describe().
import fs from "node:fs";
import path from "node:path";
import { decisionsIn } from "./briefs.mjs";
import { summarizeEvents } from "./events.mjs";
import { phaseOf } from "./lifecycle.mjs";
import { modelLabel } from "./policy.mjs";
import { reportFields } from "./report.mjs";
import { attemptAgent, describe } from "./runs.mjs";
import { die, readJson } from "./util.mjs";

export function sinceDuration(value = "30d") {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  const ms = match && Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (!Number.isFinite(ms) || ms < 0) die(`bad duration "${value}" (use e.g. 7d, 12h, 90m)`, 2);
  return ms;
}

function interval(start, finish) {
  const ms = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function outcome(run, task, dir, results) {
  const result = results[task.attempt];
  // Local paths matter for archived/copied runs, whose task.outDir can point at live state.
  const local = { ...task, outDir: path.join(dir, `attempt-${task.attempt}`) };
  if (result?.status !== "completed") return describe(run, local);
  let tokensIn = 0, tokensOut = 0;
  for (let n = 1; n <= task.attempt; n++) {
    const summary = summarizeEvents(attemptAgent(task, n), path.join(dir, `attempt-${n}`, "events.jsonl"), task.cd);
    tokensIn += summary.tokens.input;
    tokensOut += summary.tokens.output;
  }
  const state = decisionsIn(result.finalMessage) ? "needs-decision" : "completed";
  const row = { state, result, tokensIn, tokensOut, limitHit: false, phase: phaseOf(task, state) };
  return { ...row, ...reportFields(run, local, row) };
}

function group(items, identity) {
  const groups = new Map();
  for (const item of items) {
    const labels = identity(item);
    const key = JSON.stringify(labels);
    if (!groups.has(key)) groups.set(key, { ...labels, tasks: 0, attempts: 0, firstAttemptAccepted: 0,
      accepted: 0, integrated: 0, failed: 0, limitHits: 0, transientErrors: 0,
      tokensIn: 0, tokensOut: 0, elapsed: [], reviewWait: [] });
    const g = groups.get(key);
    g.tasks++;
    g.attempts += item.attempts;
    for (const field of ["firstAttemptAccepted", "accepted", "integrated", "failed", "limitHits", "transientErrors", "tokensIn", "tokensOut"]) g[field] += item[field];
    if (item.elapsedMs !== null) g.elapsed.push(item.elapsedMs);
    if (item.reviewWaitMs !== null) g.reviewWait.push(item.reviewWaitMs);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => {
    const { elapsed, reviewWait, ...numbers } = g;
    return { ...numbers, firstAttemptAcceptance: g.accepted ? g.firstAttemptAccepted / g.accepted : null,
      medianFirstAttemptMs: median(elapsed), medianReviewWaitMs: median(reviewWait) };
  });
}

export function taskStats(runs) {
  const items = [];
  for (const run of runs) {
    const tasksDir = path.join(run.dir, "tasks");
    if (!fs.existsSync(tasksDir)) continue;
    for (const entry of fs.readdirSync(tasksDir)) {
      const dir = path.join(tasksDir, entry);
      const task = readJson(path.join(dir, "task.json"));
      // Prepared worktrees, main sessions, and native sub-agents are not dispatched tasks.
      if (!task || !["claude", "codex"].includes(task.agent) || !(task.attempt > 0)) continue;
      const results = {};
      for (let n = 1; n <= task.attempt; n++) results[n] = readJson(path.join(dir, `attempt-${n}`, "result.json"));
      const row = outcome(run, task, dir, results);
      const accepted = Boolean(task.acceptedAt);
      const first = results[1];
      items.push({ agent: task.agent, modelLabel: modelLabel(task),
        type: task.plan?.type || (task.babysit ? "babysit" : task.readOnly ? "read-only" : "write"),
        attempts: task.attempt, accepted: Number(accepted), firstAttemptAccepted: Number(accepted && task.acceptedAttempt === 1),
        integrated: Number(Boolean(task.integratedAt) || row.phase === "integrated"),
        failed: Number(!["completed", "needs-decision", "running", "prepared"].includes(row.state)),
        limitHits: Number(Boolean(row.limitHit)), transientErrors: Number(row.health === "transient-error" || task.retries > 0),
        elapsedMs: interval(first?.startedAt || (task.attempt === 1 ? task.startedAt : null), first?.finishedAt),
        reviewWaitMs: accepted ? interval(results[task.acceptedAttempt]?.finishedAt, task.acceptedAt) : null,
        tokensIn: row.tokensIn, tokensOut: row.tokensOut });
    }
  }
  return { byAgent: group(items, ({ agent, modelLabel }) => ({ agent, modelLabel })),
    byType: group(items, ({ type }) => ({ type })) };
}
