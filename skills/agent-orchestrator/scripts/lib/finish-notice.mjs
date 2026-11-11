// The finish notice: when a delegated task's attempt ends, the orch task whose environment started
// it (the task record's `startedBy`) gets one inbox message saying how it ended, so a parent that
// is busy with its own work learns it at its next tool call instead of at its next `wait`.
//
// `start` runs a small detached watcher beside the relay: it records the relay's identity (its PID
// and start time), checks every second whether that process still exists, then runs this file to
// send the notice. It is a sibling, not a wrapper, so the task's PID stays the relay's
// (relayAlive, stop, close and steering rely on that), and a stop that signals the relay's process
// group never reaches the watcher. Everything is kept per attempt: the parent that started it
// (`attemptStartedBy` in the task record), its relay, its result, and a claim file in its folder
// (parent-notice.json) that makes its notice go out exactly once and records what happened to it.
// A later attempt that starts first never cancels an earlier attempt's notice. A top-level run's
// parent is the user's own session, which has no inbox and whose `wait` already wakes, so `start`
// starts no watcher there, except beside a pull-request babysitter: an attempt that ends parked sends
// no notice (it still runs, as far as its parent can tell), and its watcher starts the park watcher
// that resumes it (park.mjs).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decisionsIn } from "./briefs.mjs";
import { CLI_PATH, RUNS_DIR } from "./config.mjs";
import { firstLine } from "./format.mjs";
import { spawnParkWatcher } from "./park.mjs";
import { attemptAgent, describe, loadTask, parkedSignal, taskDir } from "./runs.mjs";
import { readJson, writeJson } from "./util.mjs";
import { SendError, deliverMessage } from "./commands/inbox.mjs";

export const NOTICE_FILE = "parent-notice.json";
const NOTICE_LOG = "parent-notice.log";
const SCRIPT = fileURLToPath(import.meta.url);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a run or task id, never a path
const POLL_MS = 1000;

// The orch task whose environment runs this process, { run, task }, or null in a session that
// `start` did not launch (the user's own).
export function callerTask(env = process.env) {
  const run = env.AGENT_ORCH_RUN, task = env.AGENT_ORCH_TASK;
  return run && task && NAME.test(run) && NAME.test(task) ? { run, task } : null;
}

// A run by its id, or null; unlike loadRun() it never exits the process.
export function runById(id) {
  if (!id || !NAME.test(id)) return null;
  const dir = path.join(RUNS_DIR, id);
  const run = readJson(path.join(dir, "run.json"));
  return run ? { ...run, dir } : null;
}

// Who a task reports to: the orch task that started its current attempt, recorded by `start`. A
// task started before `startedBy` existed falls back to the task that created its run. Null means
// the user's own session.
export function parentOf(run, task) {
  if (task && "startedBy" in task) return task.startedBy || null;
  const o = run.orchestrator || {};
  return o.parentRun && o.parentTask ? { run: o.parentRun, task: o.parentTask } : null;
}

// Who attempt `n` reports to: the orch task that started that attempt.
function attemptParent(run, task, n) {
  const map = task.attemptStartedBy;
  return map && Object.hasOwn(map, n) ? map[n] || null : parentOf(run, task);
}

// The `startedBy` that `start` records: the calling orch task, when it exists and is not the task
// itself.
export function startedByCaller(run, id) {
  const caller = callerTask();
  if (!caller || (caller.run === run.id && caller.task === id)) return null;
  return fs.existsSync(path.join(RUNS_DIR, caller.run, "tasks", caller.task, "task.json")) ? caller : null;
}

// The watcher waits in a shell, which costs far less memory than an idle Node process, and runs
// this file only once the relay is gone. `$1` is the relay's PID; `$2` its start time (`ps -o
// lstart=`), read here when empty, which tells the relay apart from a later process that reuses
// its PID; the rest is the command to run, which gets the start time as its last argument. A PID
// that has gone, or that now belongs to a process started at another time (checked at once and
// every 10 seconds), means the relay ended. An unreadable start time proves nothing either way.
export const WAIT_SCRIPT = 'id=$2; [ -n "$id" ] || id=$(ps -o lstart= -p "$1" 2>/dev/null); n=0; while kill -0 "$1" 2>/dev/null; do if [ $((n % 10)) -eq 0 ]; then now=$(ps -o lstart= -p "$1" 2>/dev/null); [ -n "$id" ] || id=$now; if [ -n "$now" ] && [ "$now" != "$id" ]; then break; fi; fi; sleep 1; n=$((n+1)); done; shift 2; exec "$@" "$id"';

// Start the watcher for a task's new attempt; called by `start` once the task record is saved. The
// relay already runs, so a watcher that cannot start never fails the start: it returns null.
export function watchForFinish(run, task) {
  let log = null;
  try {
    log = fs.openSync(path.join(task.outDir, NOTICE_LOG), "a");
    const send = [process.execPath, SCRIPT, run.dir, task.id, String(task.attempt), String(task.pid)];
    const child = spawn("/bin/sh", ["-c", WAIT_SCRIPT, "finish-notice", String(task.pid), "", ...send], {
      cwd: run.dir,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  } finally {
    if (log !== null) fs.closeSync(log);
  }
}

const question = (d) => {
  if (typeof d === "string") return d;
  const options = Array.isArray(d?.options) && d.options.length ? ` (options: ${d.options.join(" | ")})` : "";
  return `${d?.question || JSON.stringify(d)}${options}${d?.recommendation ? `; recommended: ${d.recommendation}` : ""}`;
};

// The notice text for a finished attempt's row from describe(). `current` is the task's latest
// attempt, which may have started since this one ended.
export function noticeText(run, row, current = row.attempt) {
  // A named task (`rename`) is named, and addressed in each command, by its name; commands take either.
  const ref = row.name || row.id;
  const name = `${run.id}/${ref}`;
  const read = `node ${CLI_PATH} result ${run.id} ${ref}`;
  const head = `Agent ${name} (attempt ${row.attempt})`;
  const later = current > row.attempt
    ? `\nAttempt ${current} has started since, so \`result\` shows that one; this attempt's report is in ${path.join(row.outDir || "", "result.json")}.`
    : "";
  if (row.state === "needs-decision" || row.phase === "needs-decision") {
    const asked = row.decisions?.length ? row.decisions : (row.report?.decisions || []).map(question);
    const resume = `node ${CLI_PATH} start ${run.id} ${ref} --agent ${row.agent} --brief <answer-file>${row.session ? ` -- --session ${row.session}` : ""}`;
    return [
      `${head} needs a decision and is waiting on you:`,
      ...(asked.length ? asked : ["(read its final message)"]).map((q) => `- ${q}`),
      `Read it with \`${read}\`. Decide what your brief covers and resume it with \`${resume}\`; pass a decision beyond your brief up at once with \`node ${CLI_PATH} ask "<question>"\`.${later}`,
    ].join("\n");
  }
  if (row.state === "completed") {
    const outcome = row.report?.outcome && !row.report.invalid ? ` It reported ${row.report.outcome}.` : "";
    return `${head} completed and is ready for your review.${outcome}\nRead it with \`${read}\`, review it, and record \`accept\` or \`verdict\`.${later}`;
  }
  const error = firstLine(row.result?.error, 200) || firstLine(row.result?.finalMessage, 200) || (row.result ? "no error given" : "the relay exited without a result");
  const why = row.limitHit ? "stopped on a usage limit" : `failed (${row.state})`;
  const retry = row.health === "transient-error" ? " It was a transient error: your next `wait` on its run resumes it once." : "";
  return `${head} ${why}: ${error}\nRead it with \`${read}\`.${retry} Then fix and resume it, or close it.${later}`;
}

// The row of attempt `n` once its relay (PID `pid`) has ended, from that attempt's own folder and
// result, even when a later attempt has started since. describe() decides "running" from the PID
// alone, so when the PID now belongs to another relay, the attempt's result says how it ended.
function endedRow(run, task, n, pid) {
  const outDir = path.join(taskDir(run, task.id), `attempt-${n}`);
  const own = n === task.attempt && (!pid || pid === task.pid)
    ? task
    : { ...task, attempt: n, agent: attemptAgent(task, n), outDir, pid: pid || task.pid, startedAt: null };
  const row = describe(run, own);
  if (row.state !== "running") return row;
  const result = readJson(path.join(outDir, "result.json"));
  const decisions = result?.status === "completed" ? decisionsIn(result.finalMessage) : null;
  const state = !result ? "aborted" : decisions ? "needs-decision" : result.status || "unknown";
  return { ...row, state, phase: null, health: null, report: null, limitHit: false, decisions, result, session: result?.sessionId || result?.threadId || row.session };
}

// Send the notice for attempt `attempt` of task `id` in the run at `runDir`, once, after its relay
// (PID `pid`, started at `started`) has ended. Returns what was recorded in the claim file, or null
// when another process already claimed it.
export function sendFinishNotice(runDir, id, attempt, { pid = null, started = null } = {}) {
  const run = { ...readJson(path.join(runDir, "run.json")), dir: runDir };
  const task = loadTask(run, id);
  if (!task) return null;
  const claim = path.join(taskDir(run, id), `attempt-${attempt}`, NOTICE_FILE);
  const record = { attempt, claimedAt: new Date().toISOString(), ...(started ? { relayStarted: started } : {}) };
  try {
    fs.writeFileSync(claim, `${JSON.stringify(record)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
  const parent = attemptParent(run, task, attempt);
  try {
    // Whether this attempt parked comes from its own final message, even when a later attempt has
    // started since; only a park that is still the task's current one gets a watcher.
    const own = readJson(path.join(taskDir(run, id), `attempt-${attempt}`, "result.json"));
    const parked = Boolean((task.babysit || task.plan?.type === "babysit") && own?.status === "completed" && parkedSignal(own.finalMessage));
    if (parked) {
      const current = attempt === task.attempt && (!pid || pid === task.pid) && describe(run, task).phase === "parked";
      const watcher = current ? spawnParkWatcher(run, task, { by: "park" }) : null;
      Object.assign(record, {
        parked: true,
        watcher: watcher?.pid ?? null,
        skipped: current
          ? "the babysitter parked: it still runs as far as its parent can tell, and its watcher resumes it on the next event"
          : "the babysitter parked this attempt, and a later attempt has started or its park has ended since",
      });
    } else if (!parent) record.skipped = "a top-level run: the user's own session is the parent";
    else {
      const row = endedRow(run, task, attempt, pid);
      const parentRun = runById(parent.run);
      record.to = `${parent.run}/${parent.task}`;
      record.state = row.state;
      if (task.attempt > attempt) record.later = task.attempt;
      if (!parentRun) record.skipped = `the parent's run ${parent.run} is gone`;
      else {
        const sent = deliverMessage(parentRun, parent.task, noticeText(run, row, task.attempt || attempt), {
          from: `agent:${run.id}/${id}`, kind: "finished", about: { run: run.id, task: id, attempt },
        });
        Object.assign(record, { sentAt: sent.message.time, message: sent.message.id, reaches: sent.reaches });
      }
    }
  } catch (error) {
    if (!(error instanceof SendError)) throw error;
    record.skipped = error.message;
  } finally {
    writeJson(claim, record);
  }
  return record;
}

const exists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
// A process's start time, which tells it apart from a later process with the same PID; null when
// `ps` cannot read it.
const startTime = (pid) => spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim() || null;

// The watcher's shell runs this once the relay is gone; run directly, it waits itself, with the
// same checks as WAIT_SCRIPT. STARTED is the relay's start time, read now when not given.
async function main([runDir, id, attempt, pid, started]) {
  const n = Number(attempt), relay = Number(pid);
  if (!runDir || !id || !(n > 0) || !(relay > 0)) throw new Error("usage: finish-notice.mjs RUN_DIR TASK ATTEMPT PID [STARTED]");
  let identity = String(started || "").trim() || startTime(relay);
  for (let i = 0; exists(relay); i++) {
    if (i % 10 === 0) {
      const now = startTime(relay);
      identity ||= now;
      if (now && now !== identity) break; // the PID now belongs to another process
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  // The claim file records what happened; its final write is the watcher's last.
  sendFinishNotice(runDir, id, n, { pid: relay, started: identity });
}

const real = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
if (process.argv[1] && real(process.argv[1]) === real(SCRIPT)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${new Date().toISOString()} finish notice: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
