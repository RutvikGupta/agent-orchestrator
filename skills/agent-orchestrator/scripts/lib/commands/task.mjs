// `result`, `log`, `stop`, and `close`: read, stop, and close one run's tasks.

import { reclaimTask } from "../reclaim.mjs";
import fs from "node:fs";
import path from "node:path";
import { compact, formatElapsed, shortText } from "../format.mjs";
import { verificationsOf } from "../lifecycle.mjs";
import { computeEvidence, evidenceText, evidenceWarning } from "../report.mjs";
import { endPark } from "../park.mjs";
import { guard, ownershipOf, recordChange } from "../ownership.mjs";
import { endRecordedGroup } from "../command-group.mjs";
import { COMMAND_AGENT } from "../policy.mjs";
import { attemptAgent, describe, isParked, listTasks, loadRun, loadTask, relayAlive, saveTask, taskDir, validTask, waitForExit } from "../runs.mjs";
import { die, emit, tail } from "../util.mjs";

const short = (sha) => String(sha || "").slice(0, 12);

// A command task's relay ends what its command left running in its process group. When the relay
// has gone without doing that (it was killed), `stop` and `close` end each recorded group that is
// left, even after the command that led it has exited (lib/command-group.mjs). Returns
// { found, killed, groups } over the task's command attempts, or null when nothing was left.
function endCommandGroups(run, task) {
  let found = 0, killed = 0;
  const groups = [];
  for (let n = 1; n <= (task.attempt || 0); n++) {
    if (attemptAgent(task, n) !== COMMAND_AGENT) continue;
    const ended = endRecordedGroup(path.join(taskDir(run, task.id), `attempt-${n}`));
    if (!ended?.found) continue;
    found += ended.found;
    killed += ended.killed;
    groups.push(ended.pgid);
  }
  return found ? { found, killed, groups } : null;
}

const leftText = (left) => `${left.found} process${left.found === 1 ? "" : "es"} its command left running (process group ${left.groups.join(", ")}${left.killed ? `; ${left.killed} needed SIGKILL` : ""})`;

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
  // marks the decision seen, so `wait` stops waking for it. That is the owner's to do: for anyone
  // else `result` only reads, and the owner's `wait` still wakes for the task.
  const mine = ownershipOf(run).mine;
  if (mine && !["running", "prepared", "needs-decision"].includes(d.state) && !task.closedAt) {
    saveTask(run, { ...task, closedAt: new Date().toISOString() });
    reclaimTask(run, task);
  }
  if (mine && d.state === "needs-decision" && task.decisionSeenAttempt !== d.attempt) saveTask(run, { ...task, decisionSeenAttempt: d.attempt });
  const r = d.result;
  const session = d.session;
  const lines = [
    `task ${id} → ${d.agent} (${d.mode}), attempt ${d.attempt}: ${d.phase === "parked" ? "parked" : d.state}${r?.exitCode != null ? ` (exit ${r.exitCode})` : ""}`,
    `${d.failureCount || 0} counted failures; attempts: ${(d.attempts || []).slice().reverse().map((a) => `${a.n} ${a.agent} ${a.tier || "no tier"}`).join(", ") || "none"}`,
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
  let task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const g = guard(run, `stop task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  const stopped = () => recordChange(run, g, { task: id, attempt: task.attempt || null, action: "stopped" });
  // A parked babysitter has no relay. Mark it stopped first, so that a resume that has not started
  // its relay yet starts nothing and one that has keeps the stop; then end its park, stopping its
  // watcher and any relay a resume started.
  if (isParked(run, task)) {
    saveTask(run, { ...(loadTask(run, id) || task), stoppedAt: new Date().toISOString(), stoppedBy: g.actor });
    const parked = endPark(run, task, "stop");
    parked?.ended?.();
    const latest = loadTask(run, id) || task;
    if (latest.attempt === task.attempt || !relayAlive(latest.pid, null, latest.outDir)) {
      const what = [parked?.stopped?.length ? `its watcher (pid ${parked.stopped.join(", ")})` : null, parked?.relayStopped ? `the relay a resume had started (pid ${parked.relayStopped})` : null].filter(Boolean);
      stopped();
      process.stdout.write(`stopped parked ${id}${what.length ? ` and ${what.join(" and ")}` : ""}${parked?.error ? `; ending its park failed: ${parked.error}` : ""}\n`);
      return;
    }
    task = latest; // a resume saved its attempt first: stop that attempt too
  }
  if (!relayAlive(task.pid, null, task.outDir)) {
    const left = endCommandGroups(run, task);
    if (!left) die(`task ${id} is not running`);
    if (!task.stoppedAt) saveTask(run, { ...(loadTask(run, id) || task), stoppedAt: new Date().toISOString(), stoppedBy: g.actor });
    stopped();
    process.stdout.write(`stopped the ${leftText(left)}; its relay had already exited\n`);
    return;
  }
  // Recorded on the task, whatever its attempt: a babysitter stopped as it ends parked never parks.
  if (!task.stoppedAt) saveTask(run, { ...(loadTask(run, id) || task), stoppedAt: new Date().toISOString(), stoppedBy: g.actor });
  stopped();
  try {
    process.kill(-task.pid, "SIGTERM"); // detached → the relay leads its own process group
  } catch {
    process.kill(task.pid, "SIGTERM");
  }
  const gone = waitForExit(task.pid, 15000, task.outDir);
  const left = gone ? endCommandGroups(run, task) : null;
  process.stdout.write(`${gone ? "stopped" : "sent SIGTERM to"} ${id} (pid ${task.pid})${gone ? "" : ", which has not exited yet"}; its relay records the outcome${left ? `\nalso stopped the ${leftText(left)}` : ""}\n`);
}

// Stop the named tasks (or, with --all, every task of the run) if they are still running, and mark
// them closed. A run has one owner, so a refused close closes none of them and lists them all.
export function cmdClose(args) {
  const run = loadRun(args._[0]);
  const rows = args.all ? listTasks(run) : null;
  const ids = rows ? rows.map((t) => t.id) : args._.slice(1).map(validTask);
  if (!ids.length) die("name the tasks to close, or pass --all", 2);
  const tasks = ids.map((id) => loadTask(run, id) || die(`no task ${id} in run ${run.id}`));
  const g = guard(run, `close ${args.all ? "every task" : ids.length === 1 ? `task ${ids[0]}` : "tasks"} of run ${run.id}`, {
    adopt: args.adopt,
    refused: () => (rows || tasks.map((task) => describe(run, task))).map((r) => `${r.id} (${r.phase === "parked" ? "parked" : r.state})`),
  });
  const lines = [];
  for (const task of tasks) {
    // A task that was closed already keeps who closed it: closing it again changes nothing.
    lines.push(`${task.id}: ${closeTask(run, task, task.closedAt ? {} : { closedBy: g.actor })}`);
    // The owner hears of a task that was open; one it had closed already changed nothing.
    if (!task.closedAt) recordChange(run, g, { task: task.id, attempt: task.attempt || null, action: "closed" });
  }
  emit(args, { run: run.id, closed: ids }, lines.join("\n"));
}

// Close one task: stop it if it still runs, and record closedAt, plus `extra` fields (closedBy, the
// actor; a `reject` verdict adds its own). Returns what happened, in words.
export function closeTask(run, task, extra = {}) {
  let note = "closed";
  const now = new Date().toISOString();
  // A parked babysitter has no relay. Mark it closed first, so that a resume that has not started
  // its relay yet starts nothing and one that has keeps the close; then end its park, stopping its
  // watcher and any relay a resume started.
  if (isParked(run, task)) {
    saveTask(run, { ...(loadTask(run, task.id) || task), ...extra, closedAt: now });
    const parked = endPark(run, task, "close");
    parked?.ended?.();
    if (parked?.ended) note = `stopped its park watcher${parked.stopped.length ? ` (pid ${parked.stopped.join(", ")})` : ""} and closed`;
    else if (parked?.busy) note = `closed, though \`${parked.busy}\` was resuming it${parked.relayStopped ? `; stopped the relay it had started (pid ${parked.relayStopped})` : ""}`;
    else if (parked?.error) note = `closed, though ending its park failed: ${parked.error}`;
    task = loadTask(run, task.id) || task; // a resume may have saved its attempt first: stopped below
  }
  if (relayAlive(task.pid, null, task.outDir)) {
    const latest = loadTask(run, task.id) || task;
    const stop = latest.attempt === task.attempt
      ? { stoppedAt: latest.stoppedAt || now, stoppedBy: latest.stoppedBy || extra.closedBy }
      : { attemptStops: { ...(latest.attemptStops || {}), [task.attempt]: now } };
    saveTask(run, { ...latest, ...stop });
    try {
      process.kill(-task.pid, "SIGTERM");
    } catch {
      process.kill(task.pid, "SIGTERM");
    }
    note = waitForExit(task.pid, 15000, task.outDir) ? `stopped (pid ${task.pid}) and closed` : `sent SIGTERM to pid ${task.pid}, which has not exited yet; closed`;
  }
  // Only once the relay has gone: a live relay ends its own command's group.
  const left = relayAlive(task.pid, null, task.outDir) ? null : endCommandGroups(run, task);
  if (left) note = `stopped the ${leftText(left)}; ${note}`;
  // Closing a task that handed back a decision means the orchestrator dealt with it without
  // resuming the task, so the decision shows as resolved instead of still waiting.
  const row = describe(run, task);
  const decision = row.state === "needs-decision"
    ? { decisionResolvedAt: now, decisionResolvedAttempt: row.attempt, decisionNote: "closed by the orchestrator without resuming the task" }
    : {};
  saveTask(run, { ...(loadTask(run, task.id) || task), ...decision, ...extra, closedAt: now });
  reclaimTask(run, task);
  return `${note}${row.state === "needs-decision" ? "; its decision is marked resolved" : ""}`;
}
