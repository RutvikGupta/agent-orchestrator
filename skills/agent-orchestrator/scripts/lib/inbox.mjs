// Messages sent to a running agent, by its orchestrator (orch.mjs send) or by the user from the
// dashboard, and how they reach it. Each task folder holds inbox.jsonl, one message per line
// ({id, time, attempt, text, from}; `from` is "user" for the dashboard, absent otherwise), and
// inbox-read.jsonl, one {id, time} line per message the agent has read. A Claude agent receives
// them as context after a tool call, through the orch-inbox hook; a Codex agent, and Claude as a
// fallback, runs `orch.mjs inbox --ack`. The hook imports this module, so it loads only config.mjs.

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

export function markSteered(dir, ids, command) {
  const time = new Date().toISOString();
  fs.appendFileSync(path.join(dir, STEERED_FILE), ids.map((id) => `${JSON.stringify({ id, command, time })}\n`).join(""));
}

// The size of an attempt's event stream: where a message sent or read now falls in its log.
export function logSize(dir, attempt) {
  try {
    return fs.statSync(path.join(dir, `attempt-${attempt || 1}`, "events.jsonl")).size;
  } catch {
    return 0;
  }
}

// `text` is what the agent receives. `body` is what the sender typed, kept when `text` adds to it
// (the paths of attached images); `images` lists those paths. `logOffset` places the message in
// the attempt's event log.
// `steered` is the command that was stopped so the message reaches the agent at once.
export function appendMessage(dir, attempt, text, { from = null, body = null, images = [], logOffset = logSize(dir, attempt), steered = null } = {}) {
  const message = {
    id: randomUUID().slice(0, 8), time: new Date().toISOString(), attempt, text,
    ...(from === "user" ? { from } : {}), ...(body != null && body !== text ? { body } : {}), ...(images.length ? { images } : {}), logOffset,
    ...(steered ? { steered } : {}),
  };
  fs.appendFileSync(path.join(dir, INBOX_FILE), `${JSON.stringify(message)}\n`);
  return message;
}

// How the agent sees who sent a message.
export function senderLabel(message) {
  return message.from === "user" ? "Message from the user, sent from the orchestrator dashboard" : "Message from your orchestrator";
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
// tooltip. Nothing when no message was ever sent.
export function inboxFields(run, task, row) {
  const dir = folder(run, task.id);
  if (!fs.existsSync(path.join(dir, INBOX_FILE))) return {};
  const messages = readInbox(dir);
  const unread = messages.filter((m) => !m.read);
  const replies = readReplies(dir);
  return {
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
export function inboxWake() {
  const run = process.env.AGENT_ORCH_RUN, task = process.env.AGENT_ORCH_TASK;
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const dir = run && task && name.test(run) && name.test(task) ? path.join(RUNS_DIR, run, "tasks", task) : null;
  const unread = () => dir ? readInbox(dir).filter((m) => !m.read) : [];
  // Attention wins a simultaneous wake; remember only that deferred message for the next call.
  const pendingPath = dir ? path.join(dir, "wake-pending.json") : null;
  let pending;
  try { pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"))?.id; } catch {}
  const previous = new Set(unread().filter((m) => m.id !== pending).map((m) => m.id));
  return { pendingPath, check: () => {
    const message = unread().find((m) => !previous.has(m.id));
    if (!message) return null;
    const text = message.text.slice(0, 200);
    const hint = `message waiting (${message.time}): ${text.replace(/\s/g, " ")} — Claude receives it as context when this command returns; otherwise read it with \`node ${CLI_PATH} inbox ${run} ${task} --ack\`; then run the same command again`;
    return { id: message.id, time: message.time, text, hint };
  } };
}
