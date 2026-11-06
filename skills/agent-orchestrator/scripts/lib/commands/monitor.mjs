// `status`, `wait`, and `watch`: follow a run's tasks while they run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INBOX_FILE, QUESTIONS_FILE, inboxWake } from "../inbox.mjs";
import { acceptedNow, lifecycleHints } from "../lifecycle.mjs";
import { reportHints } from "../report.mjs";
import { retryTask } from "../retry.mjs";
import { taskAttention } from "../escalate.mjs";
import { CLI_PATH, RUNS_DIR } from "../config.mjs";
import { listRuns, listTasks, loadRun, loadTask } from "../runs.mjs";
import { die, emit, parseDuration, writeJson } from "../util.mjs";
import { renderTree, statusText } from "../views.mjs";

export function cmdStatus(args) {
  const run = loadRun(args._[0]);
  const tasks = listTasks(run);
  emit(args, { run: run.id, dir: run.dir, tasks }, statusText(run, tasks));
}

// Replace the waiting Node process with a small shell, then resume the same command and PID.
// Keep state in a private file rather than argv/environment (large inboxes can exceed ARG_MAX).
// Older Node releases and Windows retain the ordinary timer loop.
export function parkHelper(deadline, command, args, state, { pids = [], files = [], checkedAt = Date.now() } = {}) {
  if (typeof process.execve !== "function" || process.platform === "win32") return false;
  // Do not discard a retry notice still buffered behind a slow stdout/stderr consumer.
  if (process.stdout.writableLength || process.stderr.writableLength) return false;
  const max = parseDuration(process.env.AGENT_ORCH_PARK_MAX ?? "30s");
  if (!(max > 0) || !Number.isFinite(max)) die("AGENT_ORCH_PARK_MAX must be a finite positive duration", 2);
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-park-"));
    const file = path.join(dir, "state.json");
    const marker = path.join(dir, "marker");
    fs.writeFileSync(file, JSON.stringify({ args, state, execArgv: process.execArgv }), { mode: 0o600 });
    fs.writeFileSync(marker, "", { mode: 0o600 });
    // Bash 3.2's -nt compares whole seconds. Start before the Node snapshot so changes
    // during that snapshot or in the marker's second cannot disappear in the handoff.
    // Check only after sleeping: a recently read file causes at most one extra poll.
    const stamp = Math.floor(checkedAt / 1000) - 1;
    fs.utimesSync(marker, stamp, stamp);
    const module = command === "cmdWait" ? import.meta.url : new URL("./inbox.mjs", import.meta.url).href;
    const source = `import fs from 'node:fs'; const file=process.argv[1]; const {args,state,execArgv}=JSON.parse(fs.readFileSync(file,'utf8')); fs.rmSync(process.argv[2],{recursive:true}); process.execArgv=execArgv; const mod=await import(${JSON.stringify(module)}); await mod.${command}(args,state);`;
    // Only sleep forks. PID checks, file tests and the bounded countdown are shell builtins.
    // Function arguments retain each path literally, including whitespace and newlines.
    const script = `file=$1; dir=$2; ticks=$3; tail=$4; marker=$dir/marker; shift 4
pids=; n=$1; shift
while [ "$n" -gt 0 ]; do pids="$pids $1"; shift; n=$((n-1)); done
child=
trap '[ -z "$child" ] || kill "$child" 2>/dev/null; rm -rf "$dir"; trap - TERM; kill -TERM "$$"' TERM
trap '[ -z "$child" ] || kill "$child" 2>/dev/null; rm -rf "$dir"; trap - INT; kill -INT "$$"' INT
changed() {
  for pid in $pids; do kill -0 "$pid" 2>/dev/null || return 0; done
  n=$1; shift
  for f do
    [ "$n" -gt 0 ] || break
    [ "$f" -nt "$marker" ] && return 0
    n=$((n-1))
  done
  return 1
}
woke=0
while [ "$ticks" -gt 0 ]; do
  sleep 1 & child=$!; wait "$child"; child=
  ticks=$((ticks-1))
  if changed "$@"; then woke=1; break; fi
done
if [ "$woke" -eq 0 ] && [ "$tail" != 0 ]; then sleep "$tail" & child=$!; wait "$child"; child=; fi
n=$1; shift
while [ "$n" -gt 0 ]; do shift; n=$((n-1)); done
exec "$@" "$file" "$dir"`;
    const ms = Math.min(max, Math.max(0, deadline - Date.now()));
    const watchedPids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    const watchedFiles = [...new Set(files)];
    process.execve("/bin/sh", ["sh", "-c", script, `${CLI_PATH} ${command === "cmdWait" ? "wait" : "nap"} ${args._.join(" ")}`,
      file, dir, String(Math.floor(ms / 1000)), String((ms % 1000) / 1000),
      String(watchedPids.length), ...watchedPids.map(String), String(watchedFiles.length), ...watchedFiles,
      process.execPath, ...process.execArgv, "--input-type=module", "-e", source], process.env);
  } catch {
    // A missing execve facility or unwritable temporary folder must not break waiting.
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  return false;
}

export async function cmdWait(args, resumed = null) {
  const wake = inboxWake(resumed?.inbox);
  const run = loadRun(args._[0]);
  const ids = args._.slice(1);
  const timeout = args.timeout === undefined ? 9 * 60000 : parseDuration(args.timeout);
  const deadline = resumed ? (resumed.deadline ?? Infinity) : timeout === 0 ? Infinity : Date.now() + timeout;
  const snapshot = () => {
    const rows = listTasks(run);
    // The relay can write its result and exit between describe()'s result read and process
    // check. Health then sees that file; reread this inconsistent snapshot before waking wait.
    return rows.some((t) => t.state === "aborted" && !t.result && t.health === "ok") ? listTasks(run) : rows;
  };
  const attention = (tasks) => tasks.flatMap((t) => {
    const item = taskAttention(t, Boolean(loadTask(run, t.id)?.closedAt));
    return item ? [{ task: t.id, attempt: t.attempt, ...item }] : [];
  });
  const key = (item) => JSON.stringify([item.task, item.attempt, item.kind]);
  let previous = resumed ? new Set(resumed.previous) : null;
  let polled = Boolean(resumed);
  // By default wait returns as soon as any watched task has an unread result: it finished, and
  // nobody has collected it with `result`, closed it, accepted it, or resolved its decision. That
  // includes a task that finished while no wait was running, for example while the orchestrator
  // reviewed an earlier one, so re-arming wait never strands it. --all keeps the old behavior:
  // return only when every watched task has finished.
  const unread = (t) => {
    if (["running", "prepared"].includes(t.state)) return false;
    const record = loadTask(run, t.id) || {};
    if (record.closedAt || acceptedNow(record) || record.decisionResolvedAttempt === t.attempt) return false;
    return t.state !== "needs-decision" || record.decisionSeenAttempt !== t.attempt;
  };
  for (;;) {
    const checkedAt = Date.now();
    let tasks = snapshot().filter((t) => (ids.length ? ids.includes(t.id) : t.state !== "prepared"));
    if (!tasks.length) die(ids.length ? `no tasks named ${ids.join(", ")}` : "no started tasks in this run");
    // Snapshot before retries, so attention already present at entry never wakes a repeated wait.
    previous ??= new Set(attention(tasks).map(key));
    let retried = false;
    for (const task of tasks) {
      const message = retryTask(run, task);
      if (message) {
        (args.json ? process.stderr : process.stdout).write(`${message}\n`);
        retried = true;
      }
    }
    if (retried) tasks = snapshot().filter((t) => tasks.some((previous) => previous.id === t.id));
    const finishedNow = tasks.filter(unread);
    const needing = attention(tasks);
    const newAttention = needing.some((item) => !previous.has(key(item)));
    previous = new Set(needing.map(key));
    const running = tasks.filter((t) => t.state === "running");
    const done = running.length === 0 || (!args.all && finishedNow.length > 0);
    // A finish notice about a task this wait watches is no reason to wake: the finished result
    // wakes it (exit 0) and names the task. The notice stays unread for the hook or `inbox`.
    const message = wake.check((m) => m.kind === "finished" && m.about?.run === run.id && tasks.some((t) => t.id === m.about.task));
    if (newAttention || done || message || Date.now() >= deadline) {
      const asking = tasks.filter((t) => t.state === "needs-decision").map((t) => t.id);
      const questions = needing.filter((item) => item.kind === "question").map((item) => item.task);
      const limited = tasks.filter((t) => t.limitHit).map((t) => `${t.id} (${t.agent})`);
      const hint =
        needing.map((item) => `\n${item.task}: ${item.label} — ${item.reason}`).join("") +
        (questions.length ? `\n${questions.join(", ")} asked a question and ${questions.length > 1 ? "keep" : "keeps"} working: answer what the user's request covers with \`node ${CLI_PATH} send ${run.id} <task> "<answer>"\`, and ask the user the rest (SKILL.md, "Decisions agents hand back")` : "") +
        (asking.length ? `\n${asking.join(", ")} handed back a decision: read \`result\`, decide, and resume (SKILL.md, "Decisions agents hand back")` : "") +
        (limited.length ? `\n${limited.join(", ")} stopped on a usage limit: ping the user, and resume on the other agent if it is ready (SKILL.md, "Usage limits")` : "") +
        [...lifecycleHints(run, tasks), ...reportHints(run, tasks)].map((line) => `\n${line}`).join("");
      emit(args, { run: run.id, finished: done, tasks, attention: needing, ...(message ? { message } : {}) }, `${statusText(run, tasks)}${hint}${newAttention ? "\n(a task needs attention)" : done ? (finishedNow.length ? `\n(${finishedNow.map((t) => t.id).join(", ")} finished and nobody has read ${finishedNow.length > 1 ? "their results" : "its result"}: review ${finishedNow.length > 1 ? "them" : "it"} now with \`result\`, or \`close\` what you handled another way${running.length ? `, then wait again for ${running.map((t) => t.id).join(", ")}` : ""})` : "") : message ? "" : "\n(still running: wait timed out)"}${message ? `\n${message.hint}` : ""}`);
      if (message) {
        if (newAttention || done) writeJson(wake.pendingPath, { id: message.id });
        else fs.rmSync(wake.pendingPath, { force: true });
      }
      process.exit(newAttention ? 5 : done ? 0 : message ? 6 : 3);
    }
    if (polled) {
      const files = [...wake.files];
      const pids = [];
      for (const task of tasks) {
        const dir = path.join(run.dir, "tasks", task.id);
        files.push(path.join(dir, INBOX_FILE), path.join(dir, QUESTIONS_FILE), path.join(dir, "task.json"));
        if (task.outDir) files.push(path.join(task.outDir, "result.json"));
        // Parked babysitters remain running without a relay. A dead PID only asks Node
        // for another snapshot; it never decides whether any task has finished.
        if (task.state === "running" && task.phase !== "parked") pids.push(loadTask(run, task.id)?.pid);
      }
      parkHelper(deadline, "cmdWait", { ...args, _: [run.dir, ...ids] },
        { deadline: Number.isFinite(deadline) ? deadline : null, previous: [...previous], inbox: wake.snapshot },
        { pids, files, checkedAt });
    }
    // Short waits usually finish within the first interval; avoid a handoff for those.
    polled = true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export async function cmdWatch(args) {
  const tty = process.stdout.isTTY && !args.once;
  const interval = Math.max(1, Number(args.interval || 2)) * 1000;
  const pick = () => {
    if (args._[0]) return [loadRun(args._[0])];
    const runs = listRuns();
    if (args.all) return runs;
    // Default: every run with a running task, else the most recent run.
    const active = runs.filter((r) => listTasks(r).some((t) => t.state === "running"));
    return active.length ? active : runs.slice(0, 1);
  };
  for (;;) {
    const runs = pick();
    const body = runs.length ? renderTree(runs, tty) : `no runs in ${RUNS_DIR}`;
    const header = `agent-orchestrator · ${new Date().toLocaleTimeString()}${tty ? ` · every ${interval / 1000}s · Ctrl-C to exit` : ""}`;
    process.stdout.write(tty ? `\x1b[H\x1b[2J${header}\n\n${body}\n` : `${header}\n\n${body}\n`);
    if (!tty) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
