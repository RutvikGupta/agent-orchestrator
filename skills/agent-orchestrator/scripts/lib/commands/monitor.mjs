// `status`, `wait`, and `watch`: follow a run's tasks while they run.

import fs from "node:fs";
import { inboxWake } from "../inbox.mjs";
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

export async function cmdWait(args) {
  const wake = inboxWake();
  const run = loadRun(args._[0]);
  const ids = args._.slice(1);
  const timeout = args.timeout === undefined ? 9 * 60000 : parseDuration(args.timeout);
  const deadline = timeout === 0 ? Infinity : Date.now() + timeout;
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
  let previous = null;
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
