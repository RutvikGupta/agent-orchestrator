import { collectWorktrees, collectionText } from "../worktree-gc.mjs";
// `result`, `log`, `stop`, and `close`: read, stop, and close one run's tasks.

import { reclaimTask } from "../reclaim.mjs";
import fs from "node:fs";
import path from "node:path";
import { compact, formatElapsed, shortText } from "../format.mjs";
import { isClosedPreparation, verificationsOf } from "../lifecycle.mjs";
import { computeEvidence, evidenceText, evidenceWarning } from "../report.mjs";
import { endPark } from "../park.mjs";
import { stopResume } from "../steer.mjs";
import { guard, ownershipOf, recordChange } from "../ownership.mjs";
import { endRecordedGroup } from "../command-group.mjs";
import { COMMAND_AGENT } from "../policy.mjs";
import { attemptAgent, describe, earlierNames, interruptHeld, isParked, listRuns, listTaskRecords, listTasks, loadRun, loadTask, relayAlive, saveTask, shownName, taskDir, validTask, waitForExit } from "../runs.mjs";
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

// Send SIGTERM to a relay's process group (`start` runs it detached, so it leads its own), or to the
// relay alone when it has no group. A relay that exited between the check that it runs and the signal
// is no failure: it is gone, as the stop wanted. Returns null, or the error when the signal could not
// be sent for another reason.
function terminate(pid) {
  try {
    process.kill(-pid, "SIGTERM");
    return null;
  } catch {}
  try {
    process.kill(pid, "SIGTERM");
    return null;
  } catch (error) {
    return error.code === "ESRCH" ? null : error;
  }
}

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
    for (const item of report.choices || []) lines.push(`  choice the agent made (needs no answer): ${item}`);
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
  // A named task (`rename`) shows its name, then its id and the names it had before.
  const earlier = earlierNames(task);
  const lines = [
    `task ${shownName(d)} → ${d.agent} (${d.mode}), attempt ${d.attempt}: ${d.phase === "parked" ? "parked" : d.state}${r?.exitCode != null ? ` (exit ${r.exitCode})` : ""}`,
    d.name || earlier.length ? `id: ${id}${d.name ? ` · name: ${d.name}` : ""}${earlier.length ? ` · earlier names: ${earlier.join(", ")}` : ""}` : null,
    `${d.failureCount || 0} counted failures; attempts: ${(d.attempts || []).slice().reverse().map((a) => `${a.n} ${a.agent} ${a.tier || "no tier"}`).join(", ") || "none"}`,
    d.why ? `why: ${d.why}` : null,
    `cd: ${d.cd}${d.branch ? `  [branch ${d.branch}]` : ""}`,
    `elapsed ${d.elapsed} · ${d.steps} steps · tokens ${d.tokensExact ? "" : "~"}${compact(d.tokensIn)} in (${compact(d.tokensCached)} cached) / ${compact(d.tokensOut)} out${d.model ? ` · model ${d.model}` : ""}`,
    session ? `session: ${session}  (resume with: start ... -- --session ${session})` : null,
    d.handoff ? `fresh session: attempt ${d.attempt} started from the handoff note, since attempt ${d.handoff.fromAttempt}'s context had grown to ${d.handoff.contextTokens} tokens (limit ${d.handoff.limit})` : null,
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

// Stop one task of `run`, as `stop` does: mark it stopped (stoppedAt, stoppedBy), end its park, stop
// a resume that holds it between two relays, and signal its relay's process group. `g` is guard()'s
// answer for its run, and a change by anyone but the run's owner leaves the owner a notice. Returns
// null when nothing of the task runs; otherwise { finish }, where finish() waits for the relay to
// exit, ends what its command left running, and returns { text, exited }: the line `stop` prints, and
// whether everything has gone. Signalling and waiting are apart, so that a caller stopping several
// tasks signals them all before it waits for any.
function stopTask(run, task, g) {
  const id = task.id;
  const mark = () => saveTask(run, { ...(loadTask(run, id) || task), stoppedAt: new Date().toISOString(), stoppedBy: g.actor });
  const stopped = () => recordChange(run, g, { task: id, attempt: task.attempt || null, action: "stopped" });
  const ended = (text) => ({ finish: () => ({ text, exited: true }) });
  // A parked babysitter has no relay. Mark it stopped first, so that a resume that has not started
  // its relay yet starts nothing and one that has keeps the stop; then end its park, stopping its
  // watcher and any relay a resume started.
  if (isParked(run, task)) {
    mark();
    const parked = endPark(run, task, "stop");
    parked?.ended?.();
    const latest = loadTask(run, id) || task;
    if (latest.attempt === task.attempt || !relayAlive(latest.pid, null, latest.outDir)) {
      const what = [parked?.stopped?.length ? `its watcher (pid ${parked.stopped.join(", ")})` : null, parked?.relayStopped ? `the relay a resume had started (pid ${parked.relayStopped})` : null].filter(Boolean);
      stopped();
      return ended(`stopped parked ${shownName(task)}${what.length ? ` and ${what.join(" and ")}` : ""}${parked?.error ? `; ending its park failed: ${parked.error}` : ""}`);
    }
    task = latest; // a resume saved its attempt first: stop that attempt too
  }
  // A resume between the task's two relays, such as an interrupt's (steer.mjs): mark the task
  // stopped first, so that it starts nothing, and stop what it runs.
  const resume = stopResume(run, task, mark);
  if (resume?.text) {
    stopped();
    return ended(resume.text);
  }
  if (resume?.task) task = resume.task;
  // The stop is recorded on the task's current record, whatever its attempt. A resume that saved a
  // newer attempt after the checks above (stopResume found no claim of its yet) gets the mark, so
  // its relay is stopped too: the recorded stop and the stopped processes agree.
  const newer = () => {
    const current = loadTask(run, id);
    return current && current.attempt !== task.attempt && current.pid && current.pid !== task.pid && relayAlive(current.pid, current.startedAt, current.outDir) ? current : null;
  };
  if (!relayAlive(task.pid, null, task.outDir)) {
    const left = endCommandGroups(run, task);
    if (!left) {
      // Nothing of this attempt runs; a resume may have saved a newer one meanwhile.
      const latest = loadTask(run, id);
      return latest && latest.attempt > (task.attempt || 0) ? stopTask(run, latest, g) : null;
    }
    if (!task.stoppedAt) mark();
    stopped();
    const later = newer();
    const failed = later ? terminate(later.pid) : null;
    if (failed) throw failed;
    if (!later) return ended(`stopped the ${leftText(left)}; its relay had already exited`);
    return {
      finish: () => {
        const gone = waitForExit(later.pid, 15000, later.outDir);
        return { exited: gone, text: `stopped the ${leftText(left)}; its relay had already exited; ${gone ? "stopped" : "sent SIGTERM to"} attempt ${later.attempt}, which a resume had started (pid ${later.pid})${gone ? "" : ", which has not exited yet"}` };
      },
    };
  }
  // Recorded on the task, whatever its attempt: a babysitter stopped as it ends parked never parks.
  if (!task.stoppedAt) mark();
  stopped();
  const failed = terminate(task.pid);
  const later = newer();
  const failedLater = later ? terminate(later.pid) : null;
  if (failed || failedLater) throw failed || failedLater;
  return {
    finish: () => {
      const gone = waitForExit(task.pid, 15000, task.outDir) && (!later || waitForExit(later.pid, 15000, later.outDir));
      const left = gone ? endCommandGroups(run, later || task) : null;
      const also = later ? ` and attempt ${later.attempt}, which a resume had started (pid ${later.pid})` : "";
      return { exited: gone, text: `${gone ? "stopped" : "sent SIGTERM to"} ${shownName(task)} (pid ${task.pid})${also}${gone ? "" : ", which has not exited yet"}; its relay records the outcome${left ? `\nalso stopped the ${leftText(left)}` : ""}` };
    },
  };
}

// One pass over the tasks below task `id` of `run`: each running task of every run that the task
// created (the run's orchestrator names it as parentRun and parentTask, as `status` lists nested
// runs), then of every run that any task of those runs created, and so on down until no run is left.
// Each run is visited once, so a cycle in the records ends the pass. Each level is signalled, then
// waited for, before the next is read, so a task has stopped before the tasks it started are, and
// cannot start more or react to theirs ending. Each is marked stopped as `stop` marks its own task.
// An error on one task never ends the pass: it is collected and the pass goes on. Adds to `stopped`
// ({ run, task, name, exited }) and `errors` ({ run, task, name, error }); `handled` holds the
// attempts already dealt with, which later passes skip. Returns how many it dealt with.
function stopPass(run, id, g, { stopped, errors, handled }) {
  let found = 0;
  const seen = new Set([run.id]);
  let parents = new Set([`${run.id}/${id}`]);
  while (parents.size) {
    const runs = listRuns().filter((r) => !seen.has(r.id) && parents.has(`${r.orchestrator?.parentRun}/${r.orchestrator?.parentTask}`));
    const level = [];
    for (const nested of runs) {
      seen.add(nested.id);
      let ng = null;
      for (const task of listTaskRecords(nested)) {
        const key = `${nested.id}/${task.id}#${task.attempt || 0}`;
        if (handled.has(key)) continue;
        const entry = { run: nested.id, task: task.id, name: shownName(task) };
        try {
          if (!ng) {
            const own = ownershipOf(nested);
            ng = { actor: g.actor, owned: own.mine, own };
          }
          const handle = stopTask(nested, task, ng);
          if (!handle) continue;
          level.push({ ...entry, handle });
        } catch (error) {
          errors.push({ ...entry, error });
        }
        handled.add(key);
        found += 1;
      }
    }
    for (const { handle, ...entry } of level) {
      try {
        stopped.push({ ...entry, exited: handle.finish().exited });
      } catch (error) {
        errors.push({ ...entry, error });
      }
    }
    parents = new Set(runs.flatMap((r) => listTaskRecords(r).map((t) => `${r.id}/${t.id}`)));
  }
  return found;
}

// Passes after the first: a task below whose `start` saved its record only after a pass read its
// run is found by the next one, as is a run created meanwhile.
const MORE_PASSES = 5;

// Stop every task below task `id` of `run` (stopPass), then read them all again, up to MORE_PASSES
// more times, until a pass finds nothing running. Owning the named task's run is enough: the runs
// below it exist only through it. `g` is guard()'s answer for `run`. Returns { stopped, errors,
// busy }, where `busy` says that the last pass still found tasks running.
function stopBelow(run, id, g) {
  const acc = { stopped: [], errors: [], handled: new Set() };
  let found = stopPass(run, id, g, acc);
  for (let pass = 0; found && pass < MORE_PASSES; pass++) found = stopPass(run, id, g, acc);
  return { stopped: acc.stopped, errors: acc.errors, busy: found > 0 };
}

// The lines that list what was stopped below the named task, by run and task, and whether the last
// pass still found tasks running; and the errors, each on a line of its own, for stderr.
function belowLines(below) {
  const lines = [];
  const list = below.stopped;
  if (list.length) lines.push(`also stopped ${list.length} task${list.length === 1 ? "" : "s"} below it: ${list.map((b) => `${b.run}/${b.name}${b.exited ? "" : " (sent SIGTERM; it has not exited yet)"}`).join(", ")}`);
  if (below.busy) lines.push(`tasks below it were still starting after ${MORE_PASSES + 1} passes; run stop again`);
  return lines;
}
const errorLines = (errors) => errors.map((e) => `orch: could not stop ${e.run}/${e.name}: ${e.error?.message || e.error}\n`).join("");

export function cmdStop(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const g = guard(run, `stop task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  // The named task first, waiting for it to exit, then the tasks below it. An error on one task never
  // keeps the others from being stopped: each is reported once all have been dealt with.
  const errors = [];
  let own = null;
  try {
    own = stopTask(run, task, g)?.finish() ?? null;
  } catch (error) {
    errors.push({ run: run.id, task: id, name: shownName(task), error });
  }
  const below = stopBelow(run, id, g);
  errors.push(...below.errors);
  if (!own && !below.stopped.length && !errors.length && !below.busy) die(`task ${shownName(task)} is not running`);
  const head = own ? own.text : errors.some((e) => e.run === run.id && e.task === id) ? null : `task ${shownName(task)} is not running`;
  const lines = [head, ...belowLines(below)].filter(Boolean);
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  if (errors.length) {
    process.stderr.write(errorLines(errors));
    process.exitCode = 1;
  }
}

// Stop the named tasks (or, with --all, every task of the run) if they are still running, and mark
// them closed. A run has one owner, so a refused close closes none of them and lists them all.
export async function cmdClose(args) {
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
  const stoppedBelow = [];
  const errors = []; // tasks below that could not be stopped, reported after the rest
  for (const task of tasks) {
    // Reading a result or restoring its folder needs a fresh explicit close.
    const explicitlyClosed = task.closedAt && task.closedExplicitlyAttempt === (task.attempt || 0) &&
      (task.pid ? (!task.worktree?.restoredAt || Date.parse(task.closedAt) >= Date.parse(task.worktree.restoredAt)) : isClosedPreparation(task));
    // Closing a task that still runs (its relay, a park, or an interrupt's resume) stops it, and so
    // stops the tasks below it too, after it; it closes only the tasks it was asked to close.
    const ran = Boolean(task.pid) && (relayAlive(task.pid, task.startedAt, task.outDir) || isParked(run, task) || Boolean(interruptHeld(task)));
    lines.push(`${shownName(task)}: ${closeTask(run, task, explicitlyClosed ? {} : { closedBy: g.actor })}`);
    // The owner hears of a task that was open; one it had closed already changed nothing.
    if (!explicitlyClosed) recordChange(run, g, { task: task.id, attempt: task.attempt || null, action: "closed" });
    if (!ran) continue;
    const below = stopBelow(run, task.id, g);
    lines.push(...belowLines(below).map((line) => `${shownName(task)}: ${line}`));
    stoppedBelow.push(...below.stopped.map((b) => ({ below: task.id, run: b.run, task: b.task })));
    errors.push(...below.errors);
  }
  const allClosed = listTasks(run).every((r) => {
    const task = loadTask(run, r.id);
    return task?.pid ? Boolean(task.closedAt) : Boolean(task && isClosedPreparation(task));
  });
  const preparations = tasks.filter((task) => !task.pid && task.worktree);
  let cleanup = allClosed ? await collectWorktrees(run, { actor: g.actor }) : null;
  if (!allClosed && preparations.length) {
    // Missing folders can be recorded now; existing folders wait until the run closes.
    const missing = preparations.filter((task) => !fs.existsSync(task.worktree.path));
    cleanup = await collectWorktrees(run, { tasks: missing.map((task) => task.id), actor: g.actor });
    cleanup.kept.push(...preparations.filter((task) => fs.existsSync(task.worktree.path)).map((task) => ({
      task: task.id, path: task.worktree.path, branch: task.worktree.branch,
      reason: "other tasks in the run are still open",
    })));
  }
  if (cleanup) lines.push(collectionText(cleanup));
  emit(args, { run: run.id, closed: ids, cleanup, ...(stoppedBelow.length ? { stoppedBelow } : {}) }, lines.join("\n"));
  if (errors.length) {
    process.stderr.write(errorLines(errors));
    process.exitCode = 1;
  }
}

// Close one task: stop it if it still runs, and record closedAt, plus `extra` fields (closedBy, the
// actor; a `reject` verdict adds its own). Returns what happened, in words.
export function closeTask(run, task, extra = {}) {
  extra = { ...extra, closedExplicitlyAttempt: task.attempt || 0 };
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
  // A resume between the task's two relays (steer.mjs): mark it closed first, as for a park.
  const resume = stopResume(run, task, () => saveTask(run, { ...(loadTask(run, task.id) || task), ...extra, closedAt: now }));
  if (resume?.task) task = resume.task;
  else if (resume?.text) note = `${resume.text}; closed`;
  if (relayAlive(task.pid, null, task.outDir)) {
    const latest = loadTask(run, task.id) || task;
    const stop = latest.attempt === task.attempt
      ? { stoppedAt: latest.stoppedAt || now, stoppedBy: latest.stoppedBy || extra.closedBy }
      : { attemptStops: { ...(latest.attemptStops || {}), [task.attempt]: now } };
    saveTask(run, { ...latest, ...stop });
    const failed = terminate(task.pid);
    if (failed) throw failed;
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
