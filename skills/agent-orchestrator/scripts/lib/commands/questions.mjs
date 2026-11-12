// `questions`: the questions a run's agents asked with `ask`, in full. `wait`, the dashboard and the
// Stop hook show only a line of each; this prints the whole text, every option and the
// recommendation, and, with --all, the questions already answered, with when and by which message.
//
// A question is open while nobody has answered it (answerOf, inbox.mjs) and the attempt that asked
// it still runs. Once that attempt has ended, an unanswered question can no longer be answered
// with `send`, so it is listed with --all as not answered.

import fs from "node:fs";
import path from "node:path";
import { ORCHESTRATOR } from "../addressee.mjs";
import { CLI_PATH } from "../config.mjs";
import { agoText } from "../format.mjs";
import { answerOf, readInbox, readQuestions } from "../inbox.mjs";
import { isParked, loadRun, loadTask, relayAlive, shownName, taskDir, taskIdOf, validTask } from "../runs.mjs";
import { die, emit } from "../util.mjs";

const STATES = ["open", "answered", "unanswered"];

// Every question task `task` asked, oldest first, each with its `state`: open, answered, or
// unanswered (its attempt ended first). An answered one has `answeredAt`, `answerMessage` (the id of
// the answering message in the task's inbox, or null when its record lacks it) and `answeredVia`,
// "send" or "dashboard" (null when that message is not in the inbox).
function questionsOf(run, task) {
  const dir = taskDir(run, task.id);
  const questions = readQuestions(dir);
  if (!questions.length) return [];
  const messages = readInbox(dir);
  const running = relayAlive(task.pid, task.startedAt, task.outDir) || isParked(run, task);
  const attempt = task.attempt || 1;
  return questions.map((q) => {
    const answer = answerOf(q, messages);
    const by = answer?.message ? messages.find((m) => m.id === answer.message) : null;
    return {
      task: task.id, name: task.name || null, id: q.id, attempt: q.attempt ?? null, time: q.time, to: q.to ?? null,
      question: q.question, options: Array.isArray(q.options) ? q.options : [], recommend: q.recommend ?? null,
      state: answer ? "answered" : running && q.attempt === attempt ? "open" : "unanswered",
      ...(answer ? { answeredAt: answer.at, answerMessage: answer.message, answeredVia: by ? (by.from === "user" ? "dashboard" : "send") : null } : {}),
      ...(q.fallback ? { fallback: q.fallback } : {}),
    };
  });
}

// The run's tasks, or the one TASK names (an id or a name), in the order they started.
function tasksOf(run, ref) {
  if (ref) {
    const id = validTask(taskIdOf(run, ref));
    return [loadTask(run, id) || die(`no task ${id} in run ${run.id}`)];
  }
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(run.dir, "tasks"));
  } catch {}
  return ids.map((id) => loadTask(run, id)).filter(Boolean)
    .sort((a, b) => String(a.startedAt || a.createdAt).localeCompare(String(b.startedAt || b.createdAt)));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ago = (time) => (Date.parse(time) ? ` (${agoText(Date.now() - Date.parse(time))} ago)` : "");

function addressee(to) {
  if (to === ORCHESTRATOR) return "the session that launched the run";
  if (to === "user") return "the user";
  if (String(to || "").startsWith("agent:")) return `its parent, agent ${to.slice("agent:".length)}`;
  return "its orchestrator";
}

// One question as the command prints it: nothing is cut short.
function block(run, q) {
  const who = q.name ? `${q.name} (task ${q.task})` : q.task;
  const lines = [`[${q.id}] ${who}, attempt ${q.attempt ?? "?"}, asked ${addressee(q.to)} at ${q.time}${ago(q.time)}:`, q.question];
  if (q.options.length) lines.push("Options:", ...q.options.map((o) => `  - ${o}`));
  if (q.recommend) lines.push(`Recommended: ${q.recommend}`);
  if (q.fallback) lines.push(`It went to the user because its parent could not take it: ${q.fallback}`);
  if (q.state === "answered") {
    const via = q.answeredVia === "dashboard" ? ", from the user on the dashboard" : q.answeredVia === "send" ? ", sent with `send`" : "";
    lines.push(`Answered at ${q.answeredAt}${ago(q.answeredAt)}${q.answerMessage ? ` by message ${q.answerMessage}` : ""}${via}.`);
  } else if (q.state === "unanswered") lines.push(`Not answered: attempt ${q.attempt ?? "?"} ended first.`);
  else if (q.to === "user") lines.push("The user answers it from the message box on the dashboard.");
  else lines.push(`Answer it with: node ${CLI_PATH} send ${run.id} ${q.name || q.task} "<answer>"`);
  return lines.join("\n");
}

export function cmdQuestions(args) {
  const run = loadRun(args._[0]);
  const tasks = tasksOf(run, args._[1]);
  const all = tasks.flatMap((task) => questionsOf(run, task)).sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const counts = Object.fromEntries(STATES.map((s) => [s, all.filter((q) => q.state === s).length]));
  const shown = args.all ? all : all.filter((q) => q.state === "open");
  const where = `${args._[1] ? `for ${shownName(tasks[0])} ` : ""}in run ${run.id}`;
  const lines = [];
  if (!args.all) {
    const others = counts.answered + counts.unanswered;
    const rest = others ? ` (${plural(others, "earlier question")}: --all lists ${others === 1 ? "it" : "them"} with ${others === 1 ? "its" : "their"} answers)` : "";
    lines.push(shown.length ? `${plural(shown.length, "open question")} ${where}:` : `no open questions ${where}${rest}`);
    for (const q of shown) lines.push("", block(run, q));
    if (shown.length && rest) lines.push("", rest.trim().replace(/^\(|\)$/g, ""));
  } else if (!all.length) lines.push(`no questions ${where}`);
  else {
    lines.push(`${plural(all.length, "question")} ${where}: ${counts.open} open, ${counts.answered} answered, ${counts.unanswered} not answered before their attempt ended`);
    const titles = { open: "Open:", answered: "Answered:", unanswered: "Not answered (the attempt that asked has ended):" };
    for (const state of STATES) {
      const list = all.filter((q) => q.state === state);
      if (!list.length) continue;
      lines.push("", `== ${titles[state]}`);
      for (const q of list) lines.push("", block(run, q));
    }
  }
  emit(args, { run: run.id, task: args._[1] ? tasks[0].id : null, counts, questions: shown }, lines.join("\n"));
}
