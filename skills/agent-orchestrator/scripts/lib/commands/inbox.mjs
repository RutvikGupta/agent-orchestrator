// `send` and `inbox`: steer a running agent with a message, and read a task's messages. The
// orchestrator sends; the agent reads them through the orch-inbox hook (Claude) or `inbox --ack`.

import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS, CLI_PATH } from "../config.mjs";
import { ORCHESTRATOR, mainSession, sessionGone } from "../addressee.mjs";
import { INBOX_HEADING, REPLY_PREFIX, USER_FIRST, appendMessage, appendReply, childHint, fromAgent, inboxWake, markRead, markSteered, openQuestions, readInbox, readQuestions, readReplies, replyHint, senderLabel, steeredNote } from "../inbox.mjs";
import { guard, recordChange } from "../ownership.mjs";
import { describe, isParked, loadRun, loadTask, relayAlive, taskDir, validTask } from "../runs.mjs";
import { planSteer, shorten, stopCommand } from "../steer.mjs";
import { die, emit, parseDuration } from "../util.mjs";

// Claude Code's user settings, where the orchestrator registers the orch-inbox hook.
const CLAUDE_SETTINGS = path.join(path.dirname(CLAUDE_PROJECTS), "settings.json");

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// How a message reaches this attempt of the task. An attempt started before messages existed has
// no inbox note in its brief, so it never runs `inbox`.
function delivery(task) {
  const noted = readText(path.join(task.outDir || "", "orch-brief.md")).includes(INBOX_HEADING);
  const resume = "stop it and resume it with a delta brief instead";
  if (task.agent === "codex") {
    return noted
      ? "Codex reads it the next time it runs `inbox`: after each gate run, and at least every 10 commands"
      : `this attempt's brief has no inbox note, so Codex will not read it; ${resume}`;
  }
  if (readText(CLAUDE_SETTINGS).includes("orch-inbox.mjs")) return "the orch-inbox hook adds it to Claude's context after its next tool call";
  const unhooked = `the orch-inbox hook is not registered in ${CLAUDE_SETTINGS}`;
  if (task.readOnly) return `${unhooked}, and a read-only Claude agent has no shell to run \`inbox\`, so it will not read it; ${resume}`;
  if (!noted) return `${unhooked}, and this attempt's brief has no inbox note, so Claude will not read it; ${resume}`;
  return `${unhooked}, so Claude reads it the next time it runs \`inbox\`, at its next gate run`;
}

// How a message sent now would reach this attempt of the task, and whether it would be read.
export function messageReach(task) {
  const how = delivery(task);
  return { delivery: how, reaches: !how.includes("will not read it") };
}

// A message the task cannot take now, with the HTTP status the dashboard answers with.
export class SendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The file type of an image, from its first bytes (never from what the sender claims), or null.
export function imageKind(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return null;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

// The open questions for the launching session that the user is shown, because that session is
// gone (addressee.mjs): a reply from the user answers them too. Its own questions it answers anyway.
function shownToUser(run, task, dir) {
  const theirs = openQuestions(readQuestions(dir), readInbox(dir), task.attempt || 1).filter((q) => q.to === ORCHESTRATOR);
  const session = theirs.length ? mainSession(run) : null;
  return session && sessionGone(run, session) ? theirs.map((q) => q.id) : [];
}

// Append `text` to a running task's inbox. `send` and the dashboard both deliver through this.
// Attached images (Buffers that imageKind accepts) are saved in the task's folder, where only the
// user can read them, and their paths are added to the text the agent receives.
// `steer` stops the agent's pending command so the message reaches it now (see steer.mjs); the
// answer's `steer` says what happened: { stopped, seconds } or { waiting }. A message from an agent
// the task started (finish-notice.mjs, `ask`) has `from` "agent:<run>/<task>", `kind` and `about`.
// Steering is guarded (ownership.mjs): `caller` is who steers, this command's caller by default, or
// the dashboard (DASHBOARD_CALLER) for the user's clicks. The message records who stopped the
// command (`steeredBy`), and a steer by anyone but the owner leaves the owner a notice.
export function deliverMessage(run, id, text, { from = null, images = [], steer = false, kind = null, about = null, caller = null } = {}) {
  const task = loadTask(run, id);
  if (!task) throw new SendError(`no task ${id} in run ${run.id}`, 404);
  text = String(text ?? "").trim();
  if (!text && !images.length) throw new SendError("the message is empty", 400);
  const kinds = images.map(imageKind);
  if (kinds.some((kind) => !kind)) throw new SendError("attachments must be PNG, JPEG, GIF or WebP images", 400);
  // A message reaches only a running agent; a finished one gets it in the brief that resumes it. A
  // parked babysitter counts as running: its watcher resumes it with the message (park.mjs).
  const parked = !relayAlive(task.pid, task.startedAt) && isParked(run, task);
  if (!relayAlive(task.pid, task.startedAt) && !parked) {
    const row = describe(run, task);
    if (row.state === "prepared") throw new SendError(`task ${id} has not started; put the message in its brief`, 409);
    throw new SendError(
      `task ${id} is not running (${row.state}); resume it with a delta brief instead: node ${CLI_PATH} start ${run.id} ${id} --agent ${task.agent} --brief <delta>${row.session ? ` -- --session ${row.session}` : ""}`,
      409,
    );
  }
  const dir = taskDir(run, id);
  const paths = [];
  if (images.length) {
    const folder = path.join(dir, "attachments");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const prefix = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${Math.random().toString(16).slice(2, 8)}`;
    images.forEach((data, i) => {
      const file = path.join(folder, `${prefix}-${i + 1}.${kinds[i]}`);
      fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
      paths.push(file);
    });
  }
  const sent = paths.length
    ? [text || `The ${from === "user" ? "user" : "orchestrator"} attached ${paths.length === 1 ? "an image" : `${paths.length} images`}.`, "",
      `Attached ${paths.length === 1 ? "image" : "images"}: open ${paths.length === 1 ? "it" : "each"} with your image-viewing tool (Claude: Read; Codex: view_image).`,
      ...paths.map((file) => `- ${file}`)].join("\n")
    : text;
  // The plan is made before the message is written, so the agent learns its command was stopped.
  const plan = steer && !parked ? planSteer(task) : null;
  const g = plan?.stop ? guard(run, `steer task ${id} of run ${run.id}`, caller ? { caller } : {}) : null;
  const answers = from === "user" ? shownToUser(run, task, dir) : [];
  const message = appendMessage(dir, task.attempt || 1, sent, { from, body: text, images: paths, steered: plan?.stop ? plan.stop.command : null, steeredBy: g?.actor ?? null, kind, about, answers });
  const { delivery: how, reaches } = parked
    ? { delivery: "the task is parked: its watcher resumes it within a few seconds, with this message in its brief", reaches: true }
    : messageReach(task);
  let steered = null;
  if (plan?.stop) steered = stopCommand(plan).length ? { stopped: shorten(plan.stop.command), seconds: plan.stop.seconds } : { waiting: "its command had already finished" };
  else if (plan) steered = { waiting: plan.wait };
  if (steered?.stopped) recordChange(run, g, { task: id, attempt: task.attempt || null, action: "steered" });
  return { message, delivery: how, reaches, steer: steered };
}

// "Send now" for messages already waiting: stop the agent's current command so it reads them.
// `caller` is who steers, as in deliverMessage().
export function steerQueued(run, id, { caller = null } = {}) {
  const task = loadTask(run, id);
  if (!task) throw new SendError(`no task ${id} in run ${run.id}`, 404);
  if (!relayAlive(task.pid, task.startedAt)) throw new SendError(`task ${id} is not running`, 409);
  const dir = taskDir(run, id);
  const queued = readInbox(dir).filter((m) => !m.read).map((m) => m.id);
  if (!queued.length) throw new SendError(`task ${id} has no queued messages`, 409);
  const plan = planSteer(task);
  if (!plan.stop) return { queued: queued.length, steer: { waiting: plan.wait } };
  const g = guard(run, `steer task ${id} of run ${run.id}`, caller ? { caller } : {});
  markSteered(dir, queued, plan.stop.command, g.actor);
  const stopped = stopCommand(plan).length;
  if (stopped) recordChange(run, g, { task: id, attempt: task.attempt || null, action: "steered" });
  return { queued: queued.length, steer: stopped ? { stopped: shorten(plan.stop.command), seconds: plan.stop.seconds } : { waiting: "its command had already finished" } };
}

export function cmdSteer(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  guard(run, `steer task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  let result;
  try {
    result = steerQueued(run, id);
  } catch (error) {
    if (error instanceof SendError) die(error.message, 2);
    throw error;
  }
  const { queued, steer } = result;
  emit(args, { run: run.id, task: id, ...result }, steer.stopped
    ? `stopped \`${steer.stopped}\` so ${id} reads its ${queued} queued message${queued === 1 ? "" : "s"} now`
    : `not stopped: ${steer.waiting}`);
}

export function cmdSend(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  if (!loadTask(run, id)) die(`no task ${id} in run ${run.id}`);
  const words = args._.slice(2);
  if (args.file && words.length) die("give the message as text or with --file, not both", 2);
  let text = words.join(" ");
  if (args.file) {
    try {
      text = fs.readFileSync(path.resolve(args.file), "utf8");
    } catch (error) {
      die(`cannot read --file: ${error.message}`, 2);
    }
  }
  if (!text.trim()) die("missing MESSAGE (or --file FILE): the message is empty", 2);
  // A message is open to anyone; stopping the agent's command to deliver it is the owner's call.
  if (args.steer) guard(run, `steer task ${id} of run ${run.id} (send without --steer is open to anyone)`, { adopt: args.adopt, refused: [id] });
  let sent;
  try {
    sent = deliverMessage(run, id, text, { steer: Boolean(args.steer) });
  } catch (error) {
    if (error instanceof SendError) die(error.message, 2);
    throw error;
  }
  const { message, delivery: how, steer } = sent;
  const steerLine = steer?.stopped ? `\nsteered: stopped \`${steer.stopped}\` so the agent reads it now` : steer?.waiting ? `\nnot steered: ${steer.waiting}` : "";
  emit(args, { run: run.id, task: id, ...message, delivery: how, ...(steer ? { steer } : {}) }, `sent message ${message.id} to ${id} (attempt ${message.attempt})\ndelivery: ${how}${steerLine}`);
}

// The agent answers the user's message, by default the latest one it has read; the dashboard shows
// the answer under that message and in the agent's log.
export function cmdReply(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const text = (args.file ? (() => { try { return fs.readFileSync(path.resolve(args.file), "utf8"); } catch (error) { return die(`cannot read --file: ${error.message}`, 2); } })() : args._.slice(2).join(" ")).trim();
  if (!text) die("missing the answer (or --file FILE)", 2);
  // Agents sometimes carry the no-shell marker over into the command; the user needs only the answer.
  const answer = text.replace(new RegExp(`^${REPLY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "").trim() || text;
  const dir = taskDir(run, id);
  const fromUser = readInbox(dir).filter((m) => m.from === "user");
  const to = args.to || (fromUser.filter((m) => m.read).at(-1) || fromUser.at(-1))?.id;
  if (!to) die(`task ${id} has no message from the user to answer`, 2);
  if (!fromUser.some((m) => m.id === to)) die(`no message ${to} from the user in task ${id}`, 2);
  const reply = appendReply(dir, task.attempt || 1, answer, to);
  emit(args, { run: run.id, task: id, ...reply }, `replied to message ${to}; the user sees it on the dashboard`);
}

// `sleep` for agents: returns after DUR (exit 0), or as soon as a message arrives for the agent
// running it (exit 6), so a waiting agent stays reachable.
export async function cmdNap(args, resumed = null) {
  const ms = parseDuration(args._[0] || "");
  if (!(ms > 0)) die("give a duration, like 30s or 5m", 2);
  let checkedAt = Date.now();
  const wake = inboxWake(resumed?.inbox);
  const until = resumed?.until ?? Date.now() + ms;
  const { parkHelper } = await import("./monitor.mjs");
  while (resumed || Date.now() < until) {
    if (!resumed) {
      const interval = Math.max(0, Math.min(1000, until - Date.now()));
      parkHelper(until, "cmdNap", args, { until, inbox: wake.snapshot }, { files: wake.files, checkedAt });
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    resumed = null;
    checkedAt = Date.now();
    const message = wake.check();
    if (message) {
      process.stdout.write(`${message.hint}\n`);
      process.exit(6);
    }
  }
}

// The agent runs this itself, from its own working directory, to read what its orchestrator sent.
export function cmdInbox(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  if (!loadTask(run, id)) die(`no task ${id} in run ${run.id}`);
  const dir = taskDir(run, id);
  const messages = readInbox(dir);
  const shown = args.all ? messages : messages.filter((m) => !m.read);
  const unread = shown.filter((m) => !m.read).map((m) => m.id);
  // A sandboxed agent may be unable to write the state folder; it still gets its messages.
  let ackError = null;
  if (args.ack) {
    try {
      markRead(dir, unread, { attempt: loadTask(run, id)?.attempt || null });
    } catch (error) {
      ackError = error.message;
    }
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [];
  if (!shown.length) lines.push(`no ${args.all ? "" : "unread "}messages for ${id}`);
  else {
    lines.push(args.all ? `${plural(shown.length, "message")} for ${id} (${unread.length} unread):` : `${plural(shown.length, "unread message")} for ${id}:`);
    const replies = readReplies(dir);
    for (const m of shown) {
      lines.push("", `[${m.id}] ${senderLabel(m)}, ${m.time}${m.read ? " (read)" : ""}`, m.text);
      for (const r of replies.filter((r) => r.to === m.id)) lines.push(`  replied ${r.time}: ${r.text}`);
      if (m.steered && !m.read) lines.push(steeredNote(m.steered));
      if (m.from === "user" && !m.read) lines.push(`${USER_FIRST} ${replyHint(run.id, id)}`);
      else if (fromAgent(m) && !m.read) lines.push(childHint(m));
    }
    if (args.ack && unread.length && !ackError) lines.push("", `marked ${plural(unread.length, "message")} as read`);
  }
  if (ackError) process.stderr.write(`orch: could not mark the messages as read (${ackError}); they will show again\n`);
  emit(args, { run: run.id, task: id, messages: shown, acked: args.ack && !ackError ? unread : [] }, lines.join("\n"));
}
