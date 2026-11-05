// `verify` and `verdict`: the coordinator's own receipts for a task's review. `verify` reruns a
// gate in the task's working directory and records the outcome in verifications.jsonl; `verdict`
// records one review round in reviews.jsonl, and `reject` closes the task.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { CLI_PATH, TASK_ID } from "../config.mjs";
import { formatElapsed, shortText } from "../format.mjs";
import { reviewRoundsOf, reviewsPath, unlinkedVerifications, verificationsOf, verificationsPath } from "../lifecycle.mjs";
import { resumeCommand, treeState } from "../report.mjs";
import { describe, loadRun, loadTask, validTask } from "../runs.mjs";
import { die, emit, parseDuration } from "../util.mjs";
import { closeTask } from "./task.mjs";

const CLI = `node ${CLI_PATH}`;
const TAIL_BYTES = 4096;
const GRACE_MS = 5000; // between a timeout's SIGTERM and its SIGKILL
const VERDICTS = ["clean", "changes", "reject"];
const short = (sha) => String(sha || "").slice(0, 12);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const quote = (value) => (/^[\w./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
const SHELL = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

function append(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// The task, refused while it runs: its working directory is still changing.
function finishedTask(args, what, code) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const row = describe(run, task);
  if (row.state === "running") die(`task ${id} is still running; ${what} once it finishes (${CLI} wait ${run.id} ${id})`, code);
  return { run, id, task, row };
}

// Run COMMAND in the task's working directory, in its own process group so that a timeout stops
// everything it started. Resolves with its exit code (null when a signal ended it).
function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    const keep = (chunk) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    // Detached: the command leads its own process group, so a timeout reaches all it started.
    const child = spawn(SHELL, ["-c", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    };
    let timedOut = false;
    let groupDone = true; // false from a timeout until no process of the group is left
    let closed = null;
    const finish = () => {
      if (!closed || !groupDone) return;
      // A cut through a multi-byte character leaves a replacement character first; drop it.
      const outputTail = `${tail.toString("utf8").replace(/^�+/, "")}${closed.error ? `${closed.error.message}\n` : ""}`;
      resolve({ exitCode: closed.code, signal: closed.signal, timedOut, outputTail });
    };
    // On timeout, SIGTERM the whole group, then SIGKILL it after GRACE_MS. Only an empty group
    // cancels the SIGKILL: the shell exiting first does not, since what it started may live on.
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      groupDone = false;
      signalGroup("SIGTERM");
      const deadline = Date.now() + GRACE_MS;
      const poll = setInterval(() => {
        const alive = groupAlive();
        if (alive && Date.now() < deadline) return;
        if (alive) signalGroup("SIGKILL");
        clearInterval(poll);
        groupDone = true;
        finish();
      }, 100);
    }, timeoutMs) : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      closed = { code: null, signal: null, error };
      finish();
    });
    child.on("close", (code, signal) => {
      if (timer && !timedOut) clearTimeout(timer);
      closed = { code, signal };
      finish();
    });
  });
}

export async function cmdVerify(args) {
  if (!args.passthrough.length) die("missing COMMAND after --: the gate to rerun, for example -- npm test", 2);
  const timeoutMs = parseDuration(args.timeout ?? "30m");
  // A refusal exits 2, so that exit 1 always means the command failed.
  const { run, id, task, row } = finishedTask(args, "verify it", 2);
  const cwd = row.cd || run.repo;
  if (!fs.existsSync(cwd)) die(`task ${id}'s working directory is gone: ${cwd}`, 2);
  // One argument is a shell command as written; several are quoted into one.
  const cmd = args.passthrough.length === 1 ? args.passthrough[0] : args.passthrough.map(quote).join(" ");
  const tree = treeState(cwd);
  const startedAt = new Date();
  const outcome = await runCommand(cmd, cwd, timeoutMs);
  const file = verificationsPath(run, id);
  // A command that ran out of time failed, even if it exited 0 when it was stopped.
  const passed = outcome.exitCode === 0 && !outcome.timedOut;
  const record = {
    id: `v${verificationsOf(run, id).length + 1}`,
    cmd,
    exitCode: outcome.exitCode,
    passed,
    commit: tree.commit,
    dirty: tree.dirty,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    by: "coordinator",
    outputTail: outcome.outputTail,
    attempt: task.attempt || 0,
    ...(outcome.signal ? { signal: outcome.signal } : {}),
    ...(outcome.timedOut ? { timedOut: true } : {}),
  };
  append(file, record);
  const how = passed ? "passed" : outcome.timedOut ? `FAILED: timed out after ${formatElapsed(timeoutMs)}` : `FAILED: exit ${record.exitCode ?? outcome.signal ?? "unknown"}`;
  const at = tree.commit ? ` at ${short(tree.commit)}${tree.dirty ? " (dirty)" : ""}` : "";
  emit(args, { ...record, file },`${id} ${record.id} ${how} in ${formatElapsed(record.durationMs)}${at}: ${shortText(cmd, 80)}`);
  process.exitCode = passed ? 0 : 1;
}

export function cmdVerdict(args) {
  const verdict = args._[2];
  if (!VERDICTS.includes(verdict)) die(`missing or unknown verdict "${verdict ?? ""}" (choose: ${VERDICTS.join(", ")})`, 2);
  const note = args.note === undefined ? null : String(args.note).trim() || die("--note needs text", 2);
  const reviewer = args.reviewer ?? "coordinator";
  const { run, id, task, row } = finishedTask(args, "review it", 1);
  if (row.state === "prepared") die(`task ${id} has not started, so there is nothing to review`);
  if (reviewer !== "coordinator" && (!TASK_ID.test(reviewer) || !loadTask(run, reviewer))) {
    die(`--reviewer must be "coordinator" or a task id of run ${run.id}, not "${reviewer}"`, 2);
  }
  const rounds = reviewRoundsOf(run, id);
  const record = {
    round: rounds.length + 1,
    attempt: row.attempt,
    verdict,
    note,
    reviewer,
    at: new Date().toISOString(),
    verifications: unlinkedVerifications(verificationsOf(run, id), rounds),
  };
  append(reviewsPath(run, id), record);
  let closed = null;
  if (verdict === "reject") closed = closeTask(run, task, { rejectedAt: record.at, rejectedAttempt: row.attempt, rejectNote: note });
  const next = {
    clean: `next: commit its work if needed, then ${CLI} accept ${run.id} ${id} --note "<why>"`,
    changes: `next: resume it with a delta brief naming the fixes; the next attempt counts as a rework: ${resumeCommand(run, row)}`,
    reject: `${id}: ${closed}, as rejected`,
  }[verdict];
  const linked = record.verifications.length ? `, ${plural(record.verifications.length, "verification")} (${record.verifications.join(", ")})` : "";
  emit(args, { id, ...record, ...(closed ? { closed: true } : {}) }, `${id} round ${record.round} (attempt ${record.attempt}): ${verdict} by ${reviewer}${linked}${note ? ` — ${shortText(note, 100)}` : ""}\n${next}`);
}
