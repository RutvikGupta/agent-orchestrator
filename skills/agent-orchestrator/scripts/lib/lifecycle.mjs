// Task lifecycle: the phase each task is in (awaiting review, accepted, integrated, ...), and the
// lines `wait` prints about it, such as planned tasks now ready to dispatch. runs.mjs imports this
// module, so it reads plan.json and task records with plain file reads instead of importing runs.mjs.

import fs from "node:fs";
import path from "node:path";
import { decisionsIn } from "./briefs.mjs";
import { agoText, shortText } from "./format.mjs";
import { planProgress, readPlan } from "./plan.mjs";
import { readJson } from "./util.mjs";

// An acceptance covers only the attempt it reviewed: resuming the task needs a new review.
export function acceptedNow(task) {
  return Boolean(task.acceptedAt) && task.acceptedAttempt === (task.attempt || 0);
}

// A `reject` verdict, like an acceptance, covers only the attempt it reviewed.
export function rejectedNow(task) {
  return Boolean(task.rejectedAt) && task.rejectedAttempt === (task.attempt || 0);
}

// Receipts of a task's review, each an append-only JSONL file in its task directory:
// verifications.jsonl (`verify` reruns) and reviews.jsonl (`verdict` rounds).
function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const value = line.trim() ? JSON.parse(line) : null;
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}
export const verificationsPath = (run, id) => path.join(run.dir, "tasks", id, "verifications.jsonl");
export const reviewsPath = (run, id) => path.join(run.dir, "tasks", id, "reviews.jsonl");
export const verificationsOf = (run, id) => readJsonl(verificationsPath(run, id));
export const reviewRoundsOf = (run, id) => readJsonl(reviewsPath(run, id));

// The verification ids that no review round links yet: those recorded since the last round.
export function unlinkedVerifications(verifications, rounds) {
  const linked = new Set(rounds.flatMap((r) => (Array.isArray(r.verifications) ? r.verifications : [])));
  return verifications.map((v) => v.id).filter((id) => id && !linked.has(id));
}

// Why attempt `n` started: `first`, `resume` (a follow-up attempt), `rework` (after a `changes`
// verdict) or `retry` (the automatic retry after a transient error). Records from before
// attemptReasons existed fall back to their retry log.
export function attemptReasonOf(task, n = task.attempt || 0) {
  if (!n) return null;
  return task.attemptReasons?.[n] || (task.retryLog?.some((r) => r.attempt === n) ? "retry" : n === 1 ? "first" : "resume");
}

// Preparing a closed, never-started task again reopens it until the next close.
export function isClosedPreparation(task) {
  const preparedAt = task.worktree?.createdAt || task.worktree?.restoredAt;
  return !task.pid && Boolean(task.closedAt) && (!preparedAt || Date.parse(task.closedAt) >= Date.parse(preparedAt));
}

// The phase of a task in a given state (describe()'s `state`).
export function phaseOf(task, state) {
  // A task that a stop ended did not fail: its orchestrator stopped it and may resume it.
  if (["prepared", "running", "needs-decision", "closed", "stopped"].includes(state)) return state;
  if (state !== "completed" || rejectedNow(task)) return "failed";
  if (task.babysit || task.plan?.type === "babysit") return "integrated";
  if (acceptedNow(task) && task.integratedAt) return "integrated";
  // A read-only task produces no code: collecting its result (or closing it) is its integration.
  if (task.readOnly && task.closedAt) return "integrated";
  return acceptedNow(task) ? "accepted" : "awaiting-review";
}

// Extra fields for one task row from describe(); `row` is the row built so far.
export function lifecycleFields(run, task, row) {
  const resolved = row.state === "needs-decision" && task.decisionResolvedAttempt === row.attempt;
  const state = resolved ? "completed" : row.state;
  const phase = phaseOf(task, state);
  const finished = Date.parse(row.result?.finishedAt || "");
  // Review receipts. The rows leave out each verification's output tail, which `result` and
  // verifications.jsonl keep.
  const rounds = task.id ? reviewRoundsOf(run, task.id) : [];
  const verifications = task.id ? verificationsOf(run, task.id) : [];
  return {
    ...(resolved ? {
      state,
      closed: true,
      decisions: (row.decisions || []).map((question) => `${question} Resolved: ${task.decisionNote}`),
      now: `decision resolved: ${task.decisionNote}`,
    } : {}),
    phase,
    awaitingReviewMs: phase === "awaiting-review" && finished ? Math.max(0, Date.now() - finished) : null,
    attemptReason: attemptReasonOf(task),
    reviewRounds: rounds.map((r) => ({
      round: r.round, attempt: r.attempt, verdict: r.verdict, note: r.note ? shortText(r.note, 200) : null,
      reviewer: r.reviewer, at: r.at, verifications: r.verifications || [],
    })),
    verifications: verifications.slice(-5).map(({ outputTail, ...v }) => v),
    rejected: rejectedNow(task),
    acceptNote: acceptedNow(task) ? task.acceptNote ?? null : null,
    acceptance: acceptanceOf(task),
  };
}

// The task's latest acceptance or rejection, for the dashboard's receipts, with the attempt it
// covered (an earlier attempt's no longer covers the task); null when it has neither.
function acceptanceOf(task) {
  const rejectedLast = task.rejectedAt && !(task.acceptedAt > task.rejectedAt);
  if (rejectedLast) return { verdict: "rejected", attempt: task.rejectedAttempt ?? null, at: task.rejectedAt, note: task.rejectNote ? shortText(task.rejectNote, 300) : null };
  if (!task.acceptedAt) return null;
  return {
    verdict: "accepted", attempt: task.acceptedAttempt ?? null, at: task.acceptedAt, by: task.acceptedBy || null,
    commit: task.acceptedCommit || null, note: task.acceptNote ? shortText(task.acceptNote, 300) : null,
  };
}

// A task's phase from its records alone, for a task that `wait` was not asked about. Without the
// process check a finished-looking task may still be starting, but it is never taken as integrated.
function recordedPhase(run, id) {
  const task = readJson(path.join(run.dir, "tasks", id, "task.json"));
  if (!task) return undefined;
  if (!task.pid) return isClosedPreparation(task) ? "closed" : "prepared";
  const result = task.outDir ? readJson(path.join(task.outDir, "result.json")) : null;
  if (!result) return "running";
  const state = result.status === "completed" && decisionsIn(result.finalMessage) ? "needs-decision" : result.status;
  return lifecycleFields(run, task, { state, attempt: task.attempt || 0, result }).phase;
}

// Phases of every task in `rows`, plus the planned tasks that `rows` leaves out.
export function phaseMap(run, rows, plan) {
  const phases = new Map(rows.map((r) => [r.id, r.phase]));
  for (const t of plan?.tasks || []) {
    if (!phases.has(t.id)) {
      const phase = recordedPhase(run, t.id);
      if (phase) phases.set(t.id, phase);
    }
  }
  return phases;
}

// Extra lines that `wait` prints for these task rows, for example tasks now ready to dispatch.
export function lifecycleHints(run, tasks) {
  const plan = readPlan(run.dir);
  const planned = new Set((plan?.tasks || []).map((t) => t.id));
  const lines = [];
  if (plan) {
    // A planned task that has a record (prepared by `worktree`, say) shows its name (`rename`).
    const nameOf = (id) => readJson(path.join(run.dir, "tasks", id, "task.json"))?.name || id;
    const { ready, unbriefed } = planProgress(plan, phaseMap(run, tasks, plan), run.dir);
    if (ready.length) lines.push(`ready to dispatch: ${ready.map((t) => nameOf(t.id)).join(", ")} (run \`dispatch\`)`);
    if (unbriefed.length) lines.push(`ready, waiting for a brief: ${unbriefed.map((u) => `${nameOf(u.task.id)} (${u.problem})`).join(", ")} (run \`brief\`, fill it in, then \`dispatch\`)`);
  }
  // Outside the plan, a task whose result was already collected has been seen; only the plan's
  // tasks wait on acceptance.
  const reviewing = tasks.filter(
    (t) => t.mode?.split("+")[0] !== "babysit" && t.phase === "awaiting-review" && (planned.has(t.id) || !readJson(path.join(run.dir, "tasks", t.id, "task.json"))?.closedAt),
  );
  if (reviewing.length) {
    lines.push(`awaiting review: ${reviewing.map((t) => `${t.name || t.id} (${agoText(t.awaitingReviewMs || 0)})`).join(", ")}; review, commit, then run \`accept\``);
  }
  const accepted = tasks.filter((t) => t.phase === "accepted");
  if (accepted.length) lines.push(`accepted, not integrated: ${accepted.map((t) => t.name || t.id).join(", ")} (run \`integrate\`)`);
  return lines;
}
