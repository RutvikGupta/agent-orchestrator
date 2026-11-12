// Messages sent to a running agent, by its orchestrator (orch.mjs send), by the user from the
// dashboard, or by an agent it started (a finish notice or an `ask`), and how they reach it. Each
// task folder holds inbox.jsonl, one message per line ({id, time, attempt, text, from}; `from` is
// "user" for the dashboard, "agent:<run>/<task>" for an agent it started, absent otherwise; an
// agent's message adds `kind`, "finished", "question" or "note" (`tell`), and `about`, {run, task, attempt};
// a user's message may add `answers`, the ids of questions it answers beyond its own side's), and
// inbox-read.jsonl, one {id, time} line per message the agent has read. A Claude agent receives
// them as context after a tool call, through the orch-inbox hook; a Codex agent, and Claude as a
// fallback, runs `orch.mjs inbox --ack`. The hook imports this module, so it loads only config.mjs.
// questions.jsonl holds the questions the task asked with `ask`, one
// {id, time, attempt, question, options, recommend, to, answerFrom, message} per line, and
// answers.jsonl one {question, answeredAt, answerMessage} line per answer: the question's id, when,
// and the id of the inbox message that answered it (recordAnswers). Both files are only ever
// appended to; readQuestions joins them by question id.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLI_PATH, RUNS_DIR } from "./config.mjs";

export const INBOX_FILE = "inbox.jsonl";
export const READ_FILE = "inbox-read.jsonl";
// The agent's answers to the user's messages, one {id, time, attempt, to, text, logOffset} per line.
export const REPLY_FILE = "replies.jsonl";
// Queued messages that "Send now" pushed through by stopping the agent's command: {id, command, time}.
export const STEERED_FILE = "steered.jsonl";
export const QUESTIONS_FILE = "questions.jsonl";
export const ANSWERS_FILE = "answers.jsonl";
// A read-only agent has no shell for `reply`, so it answers in a message that starts with this.
export const REPLY_PREFIX = "Reply to the user:";
// The heading of the note below; `send` looks for it to tell whether an agent's brief has the note.
export const INBOX_HEADING = "## Messages from your orchestrator";

// taskDir() in runs.mjs, which imports this module; the hook must not load runs.mjs.
const folder = (run, id) => path.join(run.dir, "tasks", id);

// The JSON lines of a file. A missing file has none, and a torn or corrupt line is skipped.
function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// Every message sent to the task folder `dir`, oldest first, each with `read` (and, once read,
// `readAt` and `readOffset`).
export function readInbox(dir) {
  const read = new Map();
  for (const r of readLines(path.join(dir, READ_FILE))) if (typeof r?.id === "string" && !read.has(r.id)) read.set(r.id, r);
  const steered = new Map();
  for (const r of readLines(path.join(dir, STEERED_FILE))) if (typeof r?.id === "string" && typeof r.command === "string") steered.set(r.id, r.command);
  return readLines(path.join(dir, INBOX_FILE))
    .filter((m) => typeof m?.id === "string" && typeof m.text === "string")
    .map((m) => {
      const r = read.get(m.id);
      const pushed = !m.steered && steered.get(m.id);
      return { ...m, ...(pushed ? { steered: pushed } : {}), read: Boolean(r), ...(r ? { readAt: r.time, ...(Number.isInteger(r.logOffset) ? { readOffset: r.logOffset } : {}) } : {}) };
    });
}

export function markSteered(dir, ids, command, by = null) {
  const time = new Date().toISOString();
  fs.appendFileSync(path.join(dir, STEERED_FILE), ids.map((id) => `${JSON.stringify({ id, command, time, ...(by ? { by } : {}) })}\n`).join(""));
}

// The size of an attempt's event stream: where a message sent or read now falls in its log.
export function logSize(dir, attempt) {
  try {
    return fs.statSync(path.join(dir, `attempt-${attempt || 1}`, "events.jsonl")).size;
  } catch {
    return 0;
  }
}

// `id` is the message's id, chosen beforehand when something must name it before it exists.
// `text` is what the agent receives. `body` is what the sender typed, kept when `text` adds to it
// (the paths of attached images); `images` lists those paths. `logOffset` places the message in
// the attempt's event log.
// `steered` is the command that was stopped so the message reaches the agent at once, and
// `steeredBy` who stopped it (ownership.mjs). `kind` and `about` mark a message from an agent the
// task started (see the header), or a notice to an owning task.
// `answers` lists the questions a message from the user answers beyond its own (openQuestions).
export function appendMessage(dir, attempt, text, { id = randomUUID().slice(0, 8), from = null, body = null, images = [], logOffset = logSize(dir, attempt), steered = null, steeredBy = null, kind = null, about = null, answers = [] } = {}) {
  const message = {
    id, time: new Date().toISOString(), attempt, text,
    ...(from === "user" || fromAgent({ from }) ? { from } : {}), ...(body != null && body !== text ? { body } : {}), ...(images.length ? { images } : {}), logOffset,
    ...(steered ? { steered } : {}), ...(steered && steeredBy ? { steeredBy } : {}), ...(kind ? { kind } : {}), ...(about ? { about } : {}), ...(answers.length ? { answers } : {}),
  };
  fs.appendFileSync(path.join(dir, INBOX_FILE), `${JSON.stringify(message)}\n`);
  return message;
}

// Whether a message came from an agent the task started: "agent:<run>/<task>".
export const fromAgent = (message) => typeof message?.from === "string" && message.from.startsWith("agent:");

// How the agent sees who sent a message.
export function senderLabel(message) {
  if (message.from === "user") return "Message from the user, sent from the orchestrator dashboard";
  if (fromAgent(message)) return `Message from ${message.from}, an agent you started`;
  return "Message from your orchestrator";
}

// What the agent is told about a message from an agent it started: that agent is waiting on it.
export const CHILD_FIRST = "It comes first: that agent is waiting on you. Handle it now, before your next step on your own work, then resume where you left off.";
// ... except for a note that agent sent with `tell`, which needs no answer.
export const CHILD_NOTE = "A note for your information: that agent is not waiting on you, so no answer is needed. Act on it only if it changes your work.";
export const childHint = (message) => (message?.kind === "note" ? CHILD_NOTE : CHILD_FIRST);

// The questions the task folder `dir` asked with `ask`, oldest first. Each answered one carries
// `answeredAt` and `answerMessage` from its line in answers.jsonl: every reader (`questions`, `wait`
// and the dashboard through inboxFields, `send`, the Stop hook) gets them here. When a question has
// several answer lines (two senders recorded it at once), the first one counts.
export function readQuestions(dir) {
  const questions = readLines(path.join(dir, QUESTIONS_FILE)).filter((q) => typeof q?.id === "string" && typeof q.question === "string");
  if (!questions.length) return questions;
  const answers = new Map();
  for (const a of readLines(path.join(dir, ANSWERS_FILE))) {
    if (typeof a?.question === "string" && typeof a.answeredAt === "string" && !answers.has(a.question)) answers.set(a.question, a);
  }
  return questions.map((q) => {
    const a = answers.get(q.id);
    return a ? { ...q, answeredAt: a.answeredAt, answerMessage: typeof a.answerMessage === "string" ? a.answerMessage : null } : q;
  });
}

export function appendQuestion(dir, entry) {
  const question = { id: randomUUID().slice(0, 8), time: new Date().toISOString(), ...entry };
  fs.appendFileSync(path.join(dir, QUESTIONS_FILE), `${JSON.stringify(question)}\n`);
  return question;
}

// Whether message `m`, sent to the asking task, answers question `q`. The answer is a message that
// the question's own side typed, sent after the question (or in the same millisecond) and in the
// same attempt:
// - for a question to the user (`answerFrom` "user"), a message from the dashboard's box;
// - for one to the launching main session ("orchestrator", addressee.mjs), a message sent with
//   `send`; or a message from the user that lists it in `answers`, because the user was shown it
//   when that session was gone (deliverMessage);
// - for one to the parent task ("agent:<run>/<task>"), a message sent with `send`, which is how
//   that agent answers.
// A notice the orchestrator writes itself (a message with a `kind`: a finish notice, a child's
// question or note, an attention or owner notice) never answers. A question recorded before
// `answerFrom` existed is answered by any later message that is not such a notice.
export function answersQuestion(q, m) {
  if (!(Date.parse(m?.time) >= Date.parse(q?.time)) || m.kind) return false;
  if (Number.isInteger(m.attempt) && Number.isInteger(q.attempt) && m.attempt !== q.attempt) return false;
  if (q.answerFrom === "user") return m.from === "user";
  if (q.answerFrom === "orchestrator") return !m.from || (m.from === "user" && Array.isArray(m.answers) && m.answers.includes(q.id));
  if (String(q.to || "").startsWith("agent:")) return !m.from;
  return true;
}

// How question `q` (from readQuestions) was answered, { at, message }, or null while nobody has.
// Its line in answers.jsonl says so once recordAnswers wrote it. A question with no such line (one
// answered before answers were recorded, or whose write failed) is answered by the first message in
// `messages` that answers it.
export function answerOf(q, messages) {
  if (typeof q.answeredAt === "string") return { at: q.answeredAt, message: typeof q.answerMessage === "string" ? q.answerMessage : null };
  const m = messages.find((m) => answersQuestion(q, m));
  return m ? { at: m.time, message: m.id } : null;
}

// Append an answers.jsonl line for each question of the task folder `dir` that has none yet and
// that a message in its inbox answers; the answer is the first such message. `message` limits this
// to the questions that message answers first: deliverMessage passes the message it just appended,
// so a question answered before answers were recorded keeps no line, and answerOf finds its answer
// from the messages. `question` limits it to one question: `ask` passes the question it just wrote,
// for an answer sent while it was writing it. A sender and the asker may both record one answer at
// once; the duplicate line names the same message, and readQuestions keeps the first. Returns the
// ids of the questions it recorded.
export function recordAnswers(dir, { message = null, question = null } = {}) {
  const open = readQuestions(dir).filter((q) => typeof q.answeredAt !== "string" && (!question || q.id === question));
  if (!open.length) return [];
  const messages = readInbox(dir);
  const lines = [];
  for (const q of open) {
    const m = messages.find((m) => answersQuestion(q, m));
    if (m && (!message || m.id === message)) lines.push({ question: q.id, answeredAt: m.time, answerMessage: m.id });
  }
  if (lines.length) fs.appendFileSync(path.join(dir, ANSWERS_FILE), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return lines.map((line) => line.question);
}

// The questions of `attempt` that went to the user, or to the launching main session of a top-level
// run ("orchestrator", addressee.mjs), and are still open: nobody has answered them (answerOf). A
// sent answer closes a question at once; the agent reads it at its next tool call.
export function openQuestions(questions, messages, attempt) {
  return questions.filter((q) => (q.to === "user" || q.to === "orchestrator") && q.attempt === attempt && !answerOf(q, messages));
}

// What the agent is told about a message from the user: it comes before the work in hand.
export const USER_FIRST = "It comes first: handle it now, before your next step on the current work, then resume where you left off.";

// What the agent is told to do with a message from the user: answer it where the user sees it.
export function replyHint(run, id) {
  return `Answer the user first with \`node ${CLI_PATH} reply ${run} ${id} "<your answer>"\` (with no shell, start a message with "${REPLY_PREFIX}"): one or two short sentences in plain words, with each link on its own line; then carry on.`;
}

// What the agent is told when its command was stopped so a message could reach it.
export function steeredNote(command) {
  return `Your command \`${command.replace(/\s+/g, " ").slice(0, 200)}\` was stopped so this message reaches you now. Run it again afterwards if you still need it, in the background if it takes long; for waits and polling loops use \`node ${CLI_PATH} nap <duration>\`, \`wait\` or \`pr-watch\`, which return as soon as a message arrives.`;
}

// Every reply the agent sent, oldest first.
export function readReplies(dir) {
  return readLines(path.join(dir, REPLY_FILE)).filter((r) => typeof r?.id === "string" && typeof r.text === "string");
}

export function appendReply(dir, attempt, text, to) {
  const reply = { id: randomUUID().slice(0, 8), time: new Date().toISOString(), attempt, to, text, logOffset: logSize(dir, attempt) };
  fs.appendFileSync(path.join(dir, REPLY_FILE), `${JSON.stringify(reply)}\n`);
  return reply;
}

// `attempt` is the attempt reading them, so the log can show where each one reached the agent.
export function markRead(dir, ids, { attempt = null } = {}) {
  if (!ids.length) return;
  const time = new Date().toISOString();
  const at = attempt ? { logOffset: logSize(dir, attempt) } : {};
  fs.appendFileSync(path.join(dir, READ_FILE), ids.map((id) => `${JSON.stringify({ id, time, ...at })}\n`).join(""));
}

// Text appended to every brief after the decisions note, telling the agent how to read its inbox.
// Codex runs hooks only once the user trusts them, so it polls; Claude gets the hook, and polls at
// gate runs in case the hook is not registered.
export function inboxNote(run, id, agent) {
  const command = `\`node ${CLI_PATH} inbox ${run.id} ${id} --ack\``;
  const how =
    agent === "codex"
      ? `After each gate run, and at least every 10 commands, run ${command} and follow any new message.`
      : `They may appear as context after a tool call. At each gate run, also run ${command} and follow any new message.`;
  return `
---

${INBOX_HEADING}

Your orchestrator, or the user from the orchestrator dashboard, may send you messages while you work. ${how} Answer each message from the user, in one or two sentences, with \`node ${CLI_PATH} reply ${run.id} ${id} "<your answer>"\` before you carry on.

Stay reachable, so a message from the user is handled before the work in hand:
- Run any command that may take more than a minute in the background (${agent === "codex" ? "send its output to a file, start it with `&`, note its PID, and stop it before you finish" : "the Bash tool's `run_in_background: true`"}), then wait for it in short steps with \`node ${CLI_PATH} nap <duration>\`.
- Wait with \`nap\` instead of \`sleep\` (in a polling loop, \`nap 30s || break\`), or with \`wait\` and \`pr-watch\`. All three return as soon as a message arrives.
- If a command of yours stops with exit code 143 (SIGTERM) that you did not stop, run ${command} at once: it was stopped so a message reaches you.
`;
}

// The task's messages for its row from describe(): counts, and the unread ones for the dashboard's
// tooltip; and `question`, the oldest question of a running task that waits on the user (`open`
// counts them all), which attentionOf() lists. Nothing when no message was ever sent or asked.
export function inboxFields(run, task, row) {
  const dir = folder(run, task.id);
  const asked = row.state === "running" && fs.existsSync(path.join(dir, QUESTIONS_FILE));
  const sent = fs.existsSync(path.join(dir, INBOX_FILE));
  if (!asked && !sent) return {};
  const messages = sent ? readInbox(dir) : [];
  const open = asked ? openQuestions(readQuestions(dir), messages, row.attempt) : [];
  // Each question keeps its own addressee. `question`, which the lane shows, is the oldest open
  // question for the user, else the oldest for the session; `sessionQuestion`, which wakes the
  // session's `wait`, is the oldest open question for the session. `open` counts that addressee's.
  const brief = (list) => ({ id: list[0].id, time: list[0].time, text: list[0].question.slice(0, 2000), options: list[0].options || [], recommend: list[0].recommend || null, open: list.length, to: list[0].to });
  const forUser = open.filter((q) => q.to === "user");
  const forSession = open.filter((q) => q.to === "orchestrator");
  const question = {
    ...(open.length ? { question: brief(forUser.length ? forUser : forSession) } : {}),
    ...(forSession.length ? { sessionQuestion: brief(forSession) } : {}),
  };
  if (!sent) return question;
  const unread = messages.filter((m) => !m.read);
  const replies = readReplies(dir);
  return {
    ...question,
    inbox: {
      unread: unread.length,
      read: messages.length - unread.length,
      lastSentAt: messages.at(-1)?.time || null,
      unreadMessages: unread.map((m) => ({ id: m.id, time: m.time, text: m.text.slice(0, 500) })),
      // The latest messages for the dashboard's details panel, oldest first.
      messages: messages.slice(-20).map((m) => {
        const answers = replies.filter((r) => r.to === m.id).map((r) => ({ time: r.time, text: r.text.slice(0, 2000) }));
        return {
          id: m.id, time: m.time, attempt: m.attempt, read: m.read, from: m.from === "user" ? "user" : "orchestrator",
          text: String(m.body ?? m.text).slice(0, 2000), ...(m.images?.length ? { images: m.images.length } : {}), ...(answers.length ? { replies: answers } : {}),
        };
      }),
      ...(replies.length ? { lastReply: { time: replies.at(-1).time, to: replies.at(-1).to, text: replies.at(-1).text.slice(0, 2000) } } : {}),
    },
  };
}

// Snapshot only unread ids at entry: an undelivered old message must not cause a busy loop.
// `check(skip)` passes over the messages `skip` returns true for, such as finish notices about
// tasks that `wait` reports itself.
export function inboxWake(snapshot = null) {
  const run = process.env.AGENT_ORCH_RUN, task = process.env.AGENT_ORCH_TASK;
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const dir = run && task && name.test(run) && name.test(task) ? path.join(RUNS_DIR, run, "tasks", task) : null;
  const unread = () => dir ? readInbox(dir).filter((m) => !m.read) : [];
  // Attention wins a simultaneous wake; remember only that deferred message for the next call.
  const pendingPath = dir ? path.join(dir, "wake-pending.json") : null;
  let pending;
  try { pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"))?.id; } catch {}
  const previous = new Set(snapshot ?? unread().filter((m) => m.id !== pending).map((m) => m.id));
  return { pendingPath, files: dir ? [path.join(dir, INBOX_FILE)] : [], get snapshot() { return [...previous]; }, check: (skip = () => false) => {
    const message = unread().find((m) => !previous.has(m.id) && !skip(m));
    if (!message) return null;
    const text = message.text.slice(0, 200);
    const hint = `message waiting (${message.time}): ${text.replace(/\s/g, " ")} — Claude receives it as context when this command returns; otherwise read it with \`node ${CLI_PATH} inbox ${run} ${task} --ack\`; then run the same command again`;
    return { id: message.id, time: message.time, text, hint };
  } };
}
