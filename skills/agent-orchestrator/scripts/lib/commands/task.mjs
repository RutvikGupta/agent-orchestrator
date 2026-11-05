// `result`, `log`, `stop`, and `close`: read, stop, and close one run's tasks.

import fs from "node:fs";
import path from "node:path";
import { compact, formatElapsed, shortText } from "../format.mjs";
import { verificationsOf } from "../lifecycle.mjs";
import { computeEvidence, evidenceText, evidenceWarning } from "../report.mjs";
import { describe, listTasks, loadRun, loadTask, relayAlive, saveTask, validTask, waitForExit } from "../runs.mjs";
import { die, emit, tail } from "../util.mjs";

const short = (sha) => String(sha || "").slice(0, 12);

function reportText(row) {
  const report = row.report;
  const lines = ["", "Structured report:"];
  if (!report) lines.push("  no orch-result block");
  else if (report.invalid) lines.push(`  invalid orch-result block: ${report.error}`);
  else {
    lines.push(`  outcome: ${report.outcome || "unknown"}`);
    for (const check of report.checks) {
      const evidence = evidenceText(check?.evidence);
      lines.push(`  check [${check?.result || "unknown"}]: ${check?.cmd || "(no command)"}${check?.note ? ` — ${check.note}` : ""}${evidence ? ` · ${evidence}` : ""}`);
    }
    for (const item of report.unresolved) lines.push(`  unresolved: ${typeof item === "string" ? item : JSON.stringify(item)}`);
    if (report.readAt) lines.push(`  checkout when the result was read: ${report.commit ? `${short(report.commit)}, ${report.dirty ? "dirty" : "clean"}` : "not a git checkout"}`);
    for (const check of report.checks) {
      const warning = evidenceWarning(check);
      if (warning) lines.push(`  WARNING: ${warning}`);
    }
  }
  if (row.scopeViolations.length) lines.push(`  scope violations:${row.scopeViolations.map((file) => `\n    ${file}`).join("")}`);
  return lines.join("\n");
}

// The review rounds (`verdict`) and coordinator reruns (`verify`) on file for a task.
function reviewText(run, row) {
  const verifications = verificationsOf(run, row.id);
  const lines = [];
  if (row.reviewRounds?.length) {
    lines.push("", "Review rounds:");
    for (const r of row.reviewRounds) {
      lines.push(`  round ${r.round} (attempt ${r.attempt}): ${r.verdict} by ${r.reviewer}, ${r.at}${r.verifications.length ? ` · verified by ${r.verifications.join(", ")}` : ""}${r.note ? ` — ${r.note}` : ""}`);
    }
  }
  if (verifications.length) {
    lines.push("", "Verifications (coordinator reruns):");
    for (const v of verifications) {
      const tree = v.commit ? `${short(v.commit)}${v.dirty ? " dirty" : ""}` : "no git";
      const end = v.exitCode != null ? `exit ${v.exitCode}` : v.signal ? `killed by ${v.signal}` : "exit unknown";
      const passed = v.passed ?? (v.exitCode === 0 && !v.timedOut);
      lines.push(`  ${v.id} (attempt ${v.attempt ?? "?"}): ${passed ? "pass" : "FAIL"}, ${end}${v.timedOut ? " (timed out)" : ""} · ${formatElapsed(v.durationMs)} · ${tree} · ${shortText(v.cmd, 100)}`);
    }
  }
  if (row.acceptNote) lines.push("", `accepted: ${row.acceptNote}`);
  return lines.length ? lines.join("\n") : null;
}

export function cmdResult(args) {
  computeEvidence();
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const d = describe(run, task);
  // Collecting a finished task's result closes it; resuming the task opens it again. A task that
  // handed back a decision stays open until it is resumed, resolved or closed, but reading it
  // marks the decision seen, so `wait` stops waking for it.
  if (!["running", "prepared", "needs-decision"].includes(d.state) && !task.closedAt) saveTask(run, { ...task, closedAt: new Date().toISOString() });
  if (d.state === "needs-decision" && task.decisionSeenAttempt !== d.attempt) saveTask(run, { ...task, decisionSeenAttempt: d.attempt });
  const r = d.result;
  const session = d.session;
  const lines = [
    `task ${id} → ${d.agent} (${d.mode}), attempt ${d.attempt}: ${d.state}${r?.exitCode != null ? ` (exit ${r.exitCode})` : ""}`,
    d.why ? `why: ${d.why}` : null,
    `cd: ${d.cd}${d.branch ? `  [branch ${d.branch}]` : ""}`,
    `elapsed ${d.elapsed} · ${d.steps} steps · tokens ${d.tokensExact ? "" : "~"}${compact(d.tokensIn)} in (${compact(d.tokensCached)} cached) / ${compact(d.tokensOut)} out${d.model ? ` · model ${d.model}` : ""}`,
    session ? `session: ${session}  (resume with: start ... -- --session ${session})` : null,
    d.limitHit ? `USAGE LIMIT: ${d.agent} reached a usage limit. Ping the user once, and resume the task on the other agent if it is ready (SKILL.md, "Usage limits")` : null,
    d.decisions ? `NEEDS DECISION: decide what the user's request covers and resume this session with the answer; ask the user only about scope, security posture, or cost${d.decisions.map((q) => `\n  - ${q}`).join("")}` : null,
    Array.isArray(r?.touchedFiles) ? `touched (${r.touchedFiles.length}):${r.touchedFiles.map((f) => `\n  ${f}`).join("")}` : null,
    r?.readOnlyViolation ? "WARNING: readOnlyViolation=true; the read-only run changed files" : null,
    `artifacts: ${d.outDir}`,
    "",
    r ? r.finalMessage || "(empty final message: treat as failed)" : `no result.json yet; log tail:\n${tail(path.join(d.outDir || "", "relay.log"), 30)}`,
    reportText(d),
    reviewText(run, d),
    r && d.state !== "completed" && r.stderrTail ? `\nstderr tail:\n${r.stderrTail}` : null,
  ].filter((l) => l !== null);
  emit(args, { ...d }, lines.join("\n"));
}

export function cmdLog(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  if (!task.outDir) die(`task ${id} has not started`);
  const n = Number(args.lines || 40);
  const parts = [`== relay.log`, tail(path.join(task.outDir, "relay.log"), n)];
  const stderr = path.join(task.outDir, "stderr.txt");
  if (fs.existsSync(stderr)) parts.push(`== stderr.txt`, tail(stderr, n));
  process.stdout.write(`${parts.join("\n")}\n`);
}

export function cmdStop(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  if (!relayAlive(task.pid)) die(`task ${id} is not running`);
  try {
    process.kill(-task.pid, "SIGTERM"); // detached → the relay leads its own process group
  } catch {
    process.kill(task.pid, "SIGTERM");
  }
  const gone = waitForExit(task.pid);
  process.stdout.write(`${gone ? "stopped" : "sent SIGTERM to"} ${id} (pid ${task.pid})${gone ? "" : ", which has not exited yet"}; its relay records the outcome\n`);
}

// Stop the named tasks (or, with --all, every task of the run) if they are still running, and mark
// them closed.
export function cmdClose(args) {
  const run = loadRun(args._[0]);
  const ids = args.all ? listTasks(run).map((t) => t.id) : args._.slice(1).map(validTask);
  if (!ids.length) die("name the tasks to close, or pass --all", 2);
  const lines = [];
  for (const id of ids) {
    const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
    lines.push(`${id}: ${closeTask(run, task)}`);
  }
  emit(args, { run: run.id, closed: ids }, lines.join("\n"));
}

// Close one task: stop it if it still runs, and record closedAt, plus `extra` fields (a `reject`
// verdict adds its own). Returns what happened, in words.
export function closeTask(run, task, extra = {}) {
  let note = "closed";
  if (relayAlive(task.pid)) {
    try {
      process.kill(-task.pid, "SIGTERM");
    } catch {
      process.kill(task.pid, "SIGTERM");
    }
    note = waitForExit(task.pid) ? `stopped (pid ${task.pid}) and closed` : `sent SIGTERM to pid ${task.pid}, which has not exited yet; closed`;
  }
  // Closing a task that handed back a decision means the orchestrator dealt with it without
  // resuming the task, so the decision shows as resolved instead of still waiting.
  const row = describe(run, task);
  const now = new Date().toISOString();
  const decision = row.state === "needs-decision"
    ? { decisionResolvedAt: now, decisionResolvedAttempt: row.attempt, decisionNote: "closed by the orchestrator without resuming the task" }
    : {};
  saveTask(run, { ...task, ...decision, ...extra, closedAt: now });
  return `${note}${row.state === "needs-decision" ? "; its decision is marked resolved" : ""}`;
}
