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
// starts no watcher there, except beside a pull-request babysitter, and beside a task that started
// tasks or recorded a wake condition (ensureFinishWatcher): an attempt that ends parked sends no
// notice (it still runs, as far as its parent can tell), and its watcher starts the park watcher
// that resumes it (park.mjs). A babysitter's watch attempt that ends with `NEEDS FIX:` sends no
// notice either: its watcher starts the fix attempt, in the same session (startFix).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decisionsIn, fixBrief } from "./briefs.mjs";
import { CLI_PATH, RUNS_DIR } from "./config.mjs";
import { startDetached } from "./detach.mjs";
import { firstLine } from "./format.mjs";
import { coldResume, handoffBrief, handoffCheck, handoffOf, handoffRecord, spawnParkWatcher, tierModel, withCeiling } from "./park.mjs";
import { BABYSIT_FIX_TIER, BABYSIT_WATCH_TIER, ceilingFor, strongerThan, tierText } from "./policy.mjs";
import { resumeLock } from "./steer.mjs";
import { NOTICE_FILE, attemptAgent, describe, endedByStop, isBabysitter, loadTask, needsFixSignal, parkBasis, parkedSignal, processStarted, resumeFile, taskDir } from "./runs.mjs";
import { readJson, writeJson } from "./util.mjs";
import { SendError, deliverMessage } from "./commands/inbox.mjs";

export { NOTICE_FILE };
const NOTICE_LOG = "parent-notice.log";
// Created by whoever starts an attempt's finish watcher, so that it starts once (ensureFinishWatcher).
export const FINISH_WATCHER_FILE = "finish-watcher.json";
// How long a fix attempt that the machine has no room for keeps trying to start (start exits 7).
const FIX_ADMISSION_MS = 10 * 60000;
// Created once by the process that sends a notice an interrupt left taken (sendFinishNotice).
const RECOVERY_FILE = "parent-notice-recovery.json";
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

// Start the watcher for a task's new attempt, detached (on macOS through launchd, outside the
// terminal application; detach.mjs); called by `start` once the task record is saved. The relay
// already runs, so a watcher that cannot start never fails the start: it returns null.
export function watchForFinish(run, task) {
  try {
    const send = [process.execPath, SCRIPT, run.dir, task.id, String(task.attempt), String(task.pid)];
    const pid = startDetached({
      command: "/bin/sh",
      args: ["-c", WAIT_SCRIPT, "finish-notice", String(task.pid), "", ...send],
      cwd: run.dir,
      near: [run.repo, task.cd],
      env: process.env,
      stdout: path.join(task.outDir, NOTICE_LOG),
    }).pid;
    try {
      writeJson(path.join(task.outDir, FINISH_WATCHER_FILE), { pid: pid ?? null, at: new Date().toISOString() });
    } catch {}
    return pid;
  } catch {
    return null;
  }
}

// Start the finish watcher of a task's current attempt unless one was started for it: a task that
// will park needs one to start its park watcher, also in a top-level run (where `start` starts none
// beside a task that is not a babysitter). Only while the attempt's relay still runs. Returns the
// watcher's PID, or null.
export function ensureFinishWatcher(run, task) {
  if (!task?.outDir || !task.pid) return null;
  try {
    fs.writeFileSync(path.join(task.outDir, FINISH_WATCHER_FILE), `${JSON.stringify({ by: "ensure", at: new Date().toISOString() })}\n`, { flag: "wx" });
  } catch {
    return null; // one was started already, or the folder cannot be written
  }
  return watchForFinish(run, task);
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
  // A stop ended it on purpose (runs.mjs, endedByStop): it did not fail.
  if (row.state === "stopped") {
    const how = /^stopped by /.test(row.now || "") ? row.now : "stopped";
    return `${head} was ${how}; it did not fail.\nResume it with \`start\` if its work is still needed, or close it.${later}`;
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
  // An earlier attempt's stop is in attemptStops, since `start` clears the task's own.
  const own = n === task.attempt && (!pid || pid === task.pid)
    ? task
    : { ...task, attempt: n, agent: attemptAgent(task, n), outDir, pid: pid || task.pid, startedAt: null, ...(n === task.attempt ? {} : { stoppedAt: task.attemptStops?.[n] ?? null }) };
  const row = describe(run, own);
  if (row.state !== "running") return row;
  const result = readJson(path.join(outDir, "result.json"));
  const decisions = result?.status === "completed" ? decisionsIn(result.finalMessage) : null;
  // A stop of this attempt is recorded as the task's stop while it is the current attempt, and in
  // attemptStops once a later one has started.
  const state = endedByStop(own, result) ? "stopped" : !result ? "aborted" : decisions ? "needs-decision" : result.status || "unknown";
  return { ...row, state, phase: null, health: null, report: null, limitHit: false, decisions, result, session: result?.sessionId || result?.threadId || row.session };
}

// An interrupt's helper (steer.mjs, runInterrupt) takes an attempt's notice before it stops the
// relay, since the session goes on in the next attempt, and names itself and its resume claim in the
// claim file (`interrupt`). A helper that ended before it started that attempt, because it died or
// failed between its steps, leaves the notice taken with no one to send it. Such a claim is stranded:
// its helper is gone, and its resume claim records no relay and no saved attempt. A relay that the
// resume started means the session goes on, even when the helper died before saving it
// (steer.mjs, adoptResume).
function stranded(dir, record) {
  const by = record?.interrupt;
  if (!by?.generation || helperAlive(by)) return false;
  const resume = readJson(resumeFile(dir, by.generation));
  return !resume?.attempt && !resume?.relay;
}

// The text of a final message before its orch-result block, quoted line by line.
const quoted = (message) => String(message || "").split(/^[\t ]*```orch-result[\t ]*\r?$/m)[0].trim().split("\n").map((l) => `> ${l}`).join("\n");

// Start the fix attempt of a babysitter whose watch attempt `n` (result `own`) ended with
// `NEEDS FIX: <reason>`: the next attempt, at the fix tier, in the same session, with a brief that
// says what to fix and quotes the watch attempt's message. This is the orchestrator's policy, not
// an agent choosing a stronger model, so the caller's tier does not bound it; a ceiling inherited
// through AGENT_ORCH_MAX_TIER does. A model switch reads no prompt cache, so with a current handoff
// note and a session above the cold handoff limit the fix attempt starts a fresh session from the
// babysitter's brief, the note and the fix brief instead (park.mjs, handoffOf). Returns { started }
// with the saved task, or { refused } with why none started: the ceiling forbids the fix tier, the
// watch attempt ran at it already, the task was stopped, closed or resumed another way, or the
// start failed. `start` is commands/start.mjs.
//
// The start claims the watch attempt (steer.mjs, resumeLock) before it writes anything, and holds
// that claim across every try while the machine has no room: a `stop` or `close` meanwhile finds
// the claim (stopResume), marks the task and waits for it, and any other start of the task is
// refused. Between tries it gives the claim back at once, starting nothing, when the task was
// stopped or closed since it claimed, or a newer attempt exists.
function startFix(run, task, n, own, reason, start) {
  if (!start) return { refused: "the fix attempt can only be started by the attempt's finish watcher" };
  const watchTier = task.watchTier || BABYSIT_WATCH_TIER;
  const ranTier = task.attemptTiers?.[n] || task.tier || watchTier;
  const fixTier = { agent: "claude", tier: BABYSIT_FIX_TIER };
  if (!strongerThan(fixTier, { agent: "claude", tier: ranTier })) {
    return { refused: `attempt ${n} already ran at the ${ranTier} tier, which a fix attempt (${BABYSIT_FIX_TIER}) does not exceed` };
  }
  // The ceiling of this process, and the one the task was started under, whoever revived its
  // watcher (park.mjs, withCeiling); the start below runs under it too.
  const env = withCeiling(task, process.env);
  const cap = env.AGENT_ORCH_MAX_TIER;
  if (cap !== undefined) {
    try {
      if (strongerThan(fixTier, { agent: "claude", tier: ceilingFor(cap).tier })) return { refused: `the inherited ceiling AGENT_ORCH_MAX_TIER=${cap} forbids ${tierText("claude", BABYSIT_FIX_TIER)}, which a fix attempt runs` };
    } catch (error) {
      return { refused: error.message };
    }
  }
  for (const key of ["AGENT_ORCH_MAX_TIER", "AGENT_ORCH_MAX_EFFORT"]) if (env[key] !== undefined) process.env[key] = env[key];
  const dir = path.join(taskDir(run, task.id), `attempt-${n}`);
  const model = tierModel("claude", BABYSIT_FIX_TIER);
  const { cold, why } = coldResume(own.finishedAt, task.model, model);
  const handoff = handoffOf(run, task, dir, { cold, coldWhy: why });
  const session = own.sessionId || own.threadId;
  if (!session && !handoff.fresh) return { refused: "the watch attempt's result has no session id to resume" };
  const brief = path.join(dir, "fix-brief.md");
  const body = fixBrief({ reason, watchTier, fixTier: BABYSIT_FIX_TIER, model: model || BABYSIT_FIX_TIER, handoffFile: handoff.file });
  const claim = resumeLock(run, task, "fix");
  if (!claim) return { refused: `attempt ${n}'s folder is gone` };
  // Another start, an interrupt or a retry resumed the task first: nothing is left to decide.
  if (claim.refused) return { refused: claim.refused, overtaken: true };
  // Why the fix must not start any more, or null: the task changed since the claim.
  const overtaken = () => {
    const latest = loadTask(run, task.id);
    if (!latest || latest.attempt !== n) return `the task moved on to attempt ${latest?.attempt ?? "?"} meanwhile`;
    if (latest.closedAt && latest.closedAt !== claim.since?.closedAt) return "the task was closed meanwhile";
    if (latest.stoppedAt && latest.stoppedAt !== claim.since?.stoppedAt) return "the task was stopped meanwhile";
    return null;
  };
  const giveUp = (why) => {
    claim.release(why);
    return { refused: why, overtaken: true };
  };
  fs.writeFileSync(brief, handoff.fresh ? handoffBrief(handoff, body, { from: "watch" }) : body);
  const at = new Date().toISOString();
  const until = Date.now() + FIX_ADMISSION_MS;
  for (;;) {
    const why = overtaken();
    if (why) return giveUp(why);
    try {
      const { task: started } = start.startTask({
        _: [run.dir, task.id], agent: "claude", tier: BABYSIT_FIX_TIER, brief,
        briefData: `## The watch attempt's message\n\n${quoted(own.finalMessage)}`,
        passthrough: handoff.fresh ? [] : ["--session", session], fromHandoff: handoff.fresh,
        // The watch attempt held its place in the run's parallel limit; a fix keeps its tier.
        force: true, "no-escalate": true, parkClaim: claim,
      }, {
        attemptReason: "fix",
        fixes: { ...(task.fixes || {}), [n + 1]: { fromAttempt: n, reason, at } },
        handoffChecks: { ...(task.handoffChecks || {}), [n + 1]: handoffCheck(handoff) },
        ...(handoff.fresh ? { handoffs: { ...(task.handoffs || {}), [n + 1]: handoffRecord(handoff, n, at) } } : {}),
      });
      return { started };
    } catch (error) {
      if (!(error instanceof start.StartRefused)) {
        claim.release(error.message);
        return { refused: `starting it failed: ${error.message}` };
      }
      // The machine has no room now (memory, or its agent limit): try again for a while, still
      // holding the claim, and looking each second for a stop, a close or a newer attempt.
      if (error.code === 7 && Date.now() < until) {
        for (let i = 0; i < 5; i++) {
          const later = overtaken();
          if (later) return giveUp(later);
          spawnSync("sleep", ["1"]);
        }
        continue;
      }
      claim.release(error.message);
      return { refused: error.message };
    }
  }
}

// Send the notice for attempt `attempt` of task `id` in the run at `runDir`, once, after its relay
// (PID `pid`, started at `started`) has ended. Returns what was recorded in the claim file, or null
// when another process already claimed it. A stranded interrupt's claim is taken over by one process
// only, the one that creates the attempt's recovery file. `start` (commands/start.mjs, which the
// watcher loads) lets it start a babysitter's fix attempt.
export function sendFinishNotice(runDir, id, attempt, { pid = null, started = null, start = null } = {}) {
  const run = { ...readJson(path.join(runDir, "run.json")), dir: runDir };
  const task = loadTask(run, id);
  if (!task) return null;
  const claim = path.join(taskDir(run, id), `attempt-${attempt}`, NOTICE_FILE);
  const record = { attempt, claimedAt: new Date().toISOString(), ...(started ? { relayStarted: started } : {}) };
  try {
    fs.writeFileSync(claim, `${JSON.stringify(record)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const taken = readJson(claim);
    if (!stranded(path.dirname(claim), taken)) return null;
    // Several processes may find the claim stranded at once: the one that creates the recovery file
    // takes it over, and the others leave it.
    const generation = taken.interrupt.generation;
    try {
      fs.writeFileSync(path.join(path.dirname(claim), RECOVERY_FILE), `${JSON.stringify({ generation, pid: process.pid, at: new Date().toISOString() })}\n`, { flag: "wx" });
    } catch (other) {
      if (other.code === "EEXIST") return null;
      throw other;
    }
    record.recovered = `the interrupt that took this notice (resume claim ${generation}) ended before it resumed the session`;
    writeJson(claim, record);
  }
  const parent = attemptParent(run, task, attempt);
  try {
    // Whether this attempt parked comes from its own final message and what could wake it, even
    // when a later attempt has started since; only a park that is still the task's current one gets
    // a watcher.
    const own = readJson(path.join(taskDir(run, id), `attempt-${attempt}`, "result.json"));
    const parked = own?.status === "completed" && Boolean(parkedSignal(own.finalMessage)) && attemptAgent(task, attempt) !== "command" && Boolean(parkBasis(run, task, own, attempt));
    const who = isBabysitter(task) ? "the babysitter" : "the task";
    const current = attempt === task.attempt && (!pid || pid === task.pid);
    const fixReason = isBabysitter(task) && own?.status === "completed" ? needsFixSignal(own.finalMessage) : null;
    let fixRefused = false;
    if (fixReason && current && !task.closedAt && !task.stoppedAt) {
      const fix = startFix(run, task, attempt, own, fixReason, start);
      if (fix.started) {
        Object.assign(record, { fix: { attempt: fix.started.attempt, reason: fixReason }, skipped: `the babysitter needs a fix: its fix attempt ${fix.started.attempt} runs at the ${fix.started.tier} tier in the same session` });
      } else if (fix.overtaken) {
        // Stopped, closed or resumed another way: no decision is left to hand back.
        record.fixAbandoned = fix.refused;
        writeJson(claim, record);
        fixRefused = true;
      } else {
        // Recorded at once, so that the row below reads as the decision it now is (runs.mjs, fixOf).
        record.fixRefused = fix.refused;
        writeJson(claim, record);
        fixRefused = true;
      }
    }
    if (record.fix) {
      // The babysitter still runs as far as its parent can tell.
    } else if (parked && !fixRefused) {
      const parkedNow = current && describe(run, task).phase === "parked";
      const watcher = parkedNow ? spawnParkWatcher(run, task, { by: "park" }) : null;
      Object.assign(record, {
        parked: true,
        watcher: watcher?.pid ?? null,
        skipped: parkedNow
          ? `${who} parked: it still runs as far as its parent can tell, and its watcher resumes it on the next event`
          : `${who} parked this attempt, and a later attempt has started or its park has ended since`,
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
// Whether the interrupt's helper a notice claim names ({ pid, started }, as processStarted() writes
// the start time) still runs. An unreadable start time proves nothing.
function helperAlive(helper) {
  if (!helper?.pid || !exists(helper.pid)) return false;
  const now = processStarted(helper.pid);
  return !helper.started || !now || now === helper.started;
}

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
  // An interrupt's helper that took the notice either resumes the session, and the notice stays
  // taken, or ends without doing so, and the notice goes out (stranded). Wait for it to end.
  const claim = path.join(runDir, "tasks", id, `attempt-${n}`, NOTICE_FILE);
  while (helperAlive(readJson(claim)?.interrupt)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  // The claim file records what happened; its final write is the watcher's last. Starting a
  // babysitter's fix attempt needs `start`, loaded here, since `start` loads this module.
  const start = await import("./commands/start.mjs");
  sendFinishNotice(runDir, id, n, { pid: relay, started: identity, start });
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
