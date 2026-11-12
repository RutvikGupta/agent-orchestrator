// `send` and `inbox`: steer a running agent with a message, and read a task's messages. The
// orchestrator sends; the agent reads them through the orch-inbox hook (Claude) or `inbox --ack`.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLI_PATH } from "../config.mjs";
import { ORCHESTRATOR, mainSession, sessionGone } from "../addressee.mjs";
import { CLAUDE_SETTINGS, REPLY_PREFIX, USER_FIRST, appendMessage, appendReply, briefNoted, childHint, fromAgent, inboxHookRegistered, inboxWake, markRead, markSteered, openQuestions, readInbox, readQuestions, readReplies, recordAnswers, replyHint, senderLabel, steeredNote } from "../inbox.mjs";
import { actorLabel, guard, recordChange } from "../ownership.mjs";
import { describe, interruptState, isParked, loadRun, loadTask, relayAlive, taskDir, validTask } from "../runs.mjs";
import { awaitInterrupt, claimInterrupt, launchInterrupt, planSteer, shorten, stopCommand } from "../steer.mjs";
import { die, emit, parseDuration, readJson } from "../util.mjs";

// How a message reaches this attempt of the task: { delivery, reaches }. An attempt started before
// messages existed has no inbox note in its brief, so it never runs `inbox`. `row`, the task's
// describe() row when the caller has it, tells a task that ended its turn and waits on a background
// command of its own (`idle`): it reads the message only once that command ends.
function delivery(run, task, row = null) {
  const resume = "stop it and resume it with a delta brief instead";
  if (row?.idle && run) {
    const on = row.idle.background ? `background command \`${shorten(row.idle.background)}\`` : "background work";
    return { delivery: `the agent ended its turn and waits on its own ${on}, so it does not read this message until that wait ends. Deliver it now with \`node ${CLI_PATH} steer ${run.id} ${task.id}\`; next time, send with --steer: \`node ${CLI_PATH} send ${run.id} ${task.id} "<message>" --steer\``, reaches: true };
  }
  const noted = briefNoted(task.outDir);
  const will = (text) => ({ delivery: text, reaches: !text.includes("will not read it") });
  if (task.agent === "codex") {
    return will(noted
      ? "Codex reads it the next time it runs `inbox`: after each gate run, and at least every 10 commands"
      : `this attempt's brief has no inbox note, so Codex will not read it; ${resume}`);
  }
  if (inboxHookRegistered()) return will("the orch-inbox hook adds it to Claude's context after its next tool call");
  const unhooked = `the orch-inbox hook is not registered in ${CLAUDE_SETTINGS}`;
  if (task.readOnly) return will(`${unhooked}, and a read-only Claude agent has no shell to run \`inbox\`, so it will not read it; ${resume}`);
  if (!noted) return will(`${unhooked}, and this attempt's brief has no inbox note, so Claude will not read it; ${resume}`);
  return will(`${unhooked}, so Claude reads it the next time it runs \`inbox\`, at its next gate run`);
}

// How a message sent now would reach this attempt of the task, and whether it would be read.
export function messageReach(task, run = null, row = null) {
  return delivery(run, task, row);
}

// Interrupt a task's session to deliver its unread messages now (steer.mjs, "Interrupts"): claim
// the attempt and start the helper that resumes it. `plan` is planSteer()'s { resume }. Returns the
// answer's `steer`: { resuming, was, doing, attempt, generation } once the helper started; BUSY when
// another interrupt is already resuming it; or { waiting } when the helper could not start.
function interrupt(run, task, plan, g) {
  const claim = claimInterrupt(task, { by: g ? actorLabel(g.actor) : null, ...plan.resume });
  return claim.busy ? BUSY : startClaimed(run, task, plan, g, claim);
}

// Start the helper for an interrupt this process has claimed.
function startClaimed(run, task, plan, g, claim) {
  if (!launchInterrupt(run, task, claim)) return { waiting: readJson(claim.file)?.error || "the interrupt could not start" };
  recordChange(run, g, { task: task.id, attempt: task.attempt || null, action: "interrupted" });
  return { resuming: true, was: plan.resume.was, doing: plan.resume.doing, attempt: task.attempt, generation: claim.generation };
}

// The answer while another interrupt resumes the task's session.
const BUSY = Object.freeze({ resuming: true, busy: true, note: "another interrupt is already resuming its session, which delivers the unread messages with it, or after its next tool call" });

// For the command line: wait for an interrupt that `steer` started to resume the session, and say
// how it ended: { resumed: attempt, pid } added, or { failed: error }; unchanged when it is still
// starting after the wait.
function settleInterrupt(run, id, steer) {
  if (!steer?.resuming || steer.busy) return steer;
  const record = awaitInterrupt(path.join(taskDir(run, id), `attempt-${steer.attempt}`), steer.generation);
  const { resuming, ...rest } = steer;
  if (record?.attempt) return { ...rest, resumed: record.attempt, pid: record.pid ?? null };
  if (record?.released) return { ...rest, failed: record.error || "the resume failed" };
  return steer;
}

// The line `send` and `steer` print about an interrupt.
function interruptLine(steer, what) {
  if (steer.resumed) return `steered: the agent ${steer.doing}, so its session was stopped and resumed in attempt ${steer.resumed} (pid ${steer.pid}) with ${what} as its next prompt`;
  if (steer.failed) return `not steered: the agent ${steer.doing}, and resuming its session failed: ${steer.failed}; ${what === "this message" ? "the message stays" : "they stay"} unread`;
  if (steer.busy) return `steered: ${steer.note}`;
  return `steered: the agent ${steer.doing}, so its session is being stopped and resumed with ${what} as its next prompt (still starting; see \`status\`)`;
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
// `steer` delivers the message now (steer.mjs): it stops the agent's pending shell command, or,
// when the agent is not in one, interrupts its session to resume it with the message. `wakeIdle`
// (the dashboard's box) does the same without `steer` for a task that ended its turn and waits on a
// background command of its own, which nothing else would reach. The answer's `steer` says what
// happened: { stopped, seconds }, { resuming, was, doing, attempt, generation } (or { resuming,
// busy, note } while another interrupt resumes it), or { waiting } (with `refused` when an interrupt
// would do harm). A message from an agent the task started (finish-notice.mjs, `ask`) has `from`
// "agent:<run>/<task>", `kind` and `about`; one that an orch task sent records that task in `by`.
// Steering is guarded (ownership.mjs): `caller` is who steers, this command's caller by default, or
// the dashboard (DASHBOARD_CALLER) for the user's clicks. The message records who stopped the
// command (`steeredBy`), and a steer by anyone but the owner leaves the owner a notice.
// `prepare`, when given, runs once every check has passed and just before the message is written,
// with { id, delivery, reaches }: the message's id and how it would reach the agent. `ask` records
// its question there, so the question exists before its notice can be read. If it throws, nothing
// is written and the error propagates.
export function deliverMessage(run, id, text, { from = null, images = [], steer = false, wakeIdle = false, kind = null, about = null, caller = null, prepare = null } = {}) {
  const task = loadTask(run, id);
  if (!task) throw new SendError(`no task ${id} in run ${run.id}`, 404);
  text = String(text ?? "").trim();
  if (!text && !images.length) throw new SendError("the message is empty", 400);
  const kinds = images.map(imageKind);
  if (kinds.some((kind) => !kind)) throw new SendError("attachments must be PNG, JPEG, GIF or WebP images", 400);
  // A message reaches only a running agent; a finished one gets it in the brief that resumes it. A
  // parked babysitter counts as running: its watcher resumes it with the message (park.mjs). So does
  // a task whose session an interrupt is resuming: the resume, or the hook after it, delivers it.
  const alive = relayAlive(task.pid, task.startedAt, task.outDir);
  const parked = !alive && isParked(run, task);
  const resuming = !alive && !parked && Boolean(task.pid) && ["live", "done"].includes(interruptState(task.outDir).state);
  if (!alive && !parked && !resuming) {
    const row = describe(run, task);
    if (!task.pid) throw new SendError(`task ${id} has not started; put the message in its brief`, 409);
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
  // The plan is made before the message is written, so the agent learns its command was stopped,
  // and an interrupt claims the attempt first, so its resume finds the message.
  const row = alive ? describe(run, task) : null;
  const plan = alive && (steer || (wakeIdle && row?.idle)) ? planSteer(task, row) : null;
  const g = plan?.stop || plan?.resume ? guard(run, `steer task ${id} of run ${run.id}`, caller ? { caller } : {}) : null;
  const claim = plan?.resume ? claimInterrupt(task, { by: actorLabel(g.actor), ...plan.resume }) : null;
  const answers = from === "user" ? shownToUser(run, task, dir) : [];
  const { delivery: how, reaches } = parked
    ? { delivery: "the task is parked: its watcher resumes it within a few seconds, with this message in its brief", reaches: true }
    : resuming || claim?.busy
      ? { delivery: "an interrupt is resuming the agent's session: it reads this message with that resume, or after its next tool call", reaches: true }
      : plan?.resume
        ? { delivery: "an interrupt resumes the agent's session with this message as its next prompt", reaches: true }
        : messageReach(task, run, row);
  const messageId = randomUUID().slice(0, 8);
  try {
    if (prepare) prepare({ id: messageId, delivery: how, reaches });
  } catch (error) {
    if (claim?.file) fs.rmSync(claim.file, { force: true }); // nothing was written: give the claim back
    throw error;
  }
  // The orch task whose shell sends the message, if any (finish-notice.mjs, callerTask).
  const by = !from && !kind && process.env.AGENT_ORCH_RUN && process.env.AGENT_ORCH_TASK ? `${process.env.AGENT_ORCH_RUN}/${process.env.AGENT_ORCH_TASK}` : null;
  const message = appendMessage(dir, task.attempt || 1, sent, { id: messageId, from, by: by === `${run.id}/${id}` ? null : by, body: text, images: paths, steered: plan?.stop ? plan.stop.command : null, steeredBy: g?.actor ?? null, kind, about, answers });
  // A typed message may answer the task's questions: append the answers it gives to answers.jsonl
  // now (recordAnswers). A notice (`kind`) never answers. A failed write loses nothing, since
  // answerOf finds the answer from the messages, so it never fails the send.
  if (!kind) {
    try {
      recordAnswers(dir, { message: message.id });
    } catch {}
  }
  let steered = null;
  if (plan?.stop) steered = stopCommand(plan).length ? { stopped: shorten(plan.stop.command), seconds: plan.stop.seconds } : { waiting: "its command had already finished" };
  else if (claim?.busy) steered = BUSY;
  else if (claim) steered = startClaimed(run, task, plan, g, claim);
  else if (plan) steered = { waiting: plan.wait, ...(plan.refused ? { refused: true } : {}) };
  else if (steer && resuming) steered = BUSY;
  else if (steer && parked) steered = { waiting: "the task is parked: its watcher resumes it with this message within a few seconds, so it is not interrupted", refused: true };
  if (steered?.stopped) recordChange(run, g, { task: id, attempt: task.attempt || null, action: "steered" });
  return { message, delivery: how, reaches, steer: steered };
}

// "Send now" for messages already waiting: deliver them now, by stopping the agent's current shell
// command or, when it is not in one, by interrupting its session (deliverMessage's `steer`).
// `caller` is who steers, as in deliverMessage().
export function steerQueued(run, id, { caller = null } = {}) {
  const task = loadTask(run, id);
  if (!task) throw new SendError(`no task ${id} in run ${run.id}`, 404);
  const alive = relayAlive(task.pid, task.startedAt, task.outDir);
  const resuming = !alive && Boolean(task.pid) && ["live", "done"].includes(interruptState(task.outDir).state);
  if (!alive && !resuming) throw new SendError(`task ${id} is not running`, 409);
  const dir = taskDir(run, id);
  const queued = readInbox(dir).filter((m) => !m.read).map((m) => m.id);
  if (!queued.length) throw new SendError(`task ${id} has no queued messages`, 409);
  if (resuming) return { queued: queued.length, steer: BUSY };
  const plan = planSteer(task, describe(run, task));
  if (plan.resume) return { queued: queued.length, steer: interrupt(run, task, plan, guard(run, `steer task ${id} of run ${run.id}`, caller ? { caller } : {})) };
  if (!plan.stop) return { queued: queued.length, steer: { waiting: plan.wait, ...(plan.refused ? { refused: true } : {}) } };
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
  const { queued } = result;
  const steer = settleInterrupt(run, id, result.steer);
  const them = `its ${queued} queued message${queued === 1 ? "" : "s"}`;
  emit(args, { run: run.id, task: id, ...result, steer }, steer.stopped
    ? `stopped \`${steer.stopped}\` so ${id} reads ${them} now`
    : steer.resuming || steer.resumed || steer.failed ? interruptLine(steer, them) : `not stopped: ${steer.waiting}`);
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
  const { message, delivery: how } = sent;
  const steer = sent.steer ? settleInterrupt(run, id, sent.steer) : null;
  const steerLine = steer?.stopped ? `\nsteered: stopped \`${steer.stopped}\` so the agent reads it now`
    : steer?.resuming || steer?.resumed || steer?.failed ? `\n${interruptLine(steer, "this message")}`
      : steer?.waiting ? `\nnot steered: ${steer.waiting}` : "";
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
  // Someone looking for what a task asked often tries the run alone: point them at `questions`.
  if (!args._[1]) die(`missing TASK id: inbox shows one task's messages (inbox ${run.id} TASK). To list the run's open questions in full, run: node ${CLI_PATH} questions ${run.id}`, 2);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const dir = taskDir(run, id);
  const messages = readInbox(dir);
  const shown = args.all ? messages : messages.filter((m) => !m.read);
  const unread = shown.filter((m) => !m.read).map((m) => m.id);
  // Whoever looks at the queue (no --ack or --all), when it is not the agent itself, is told when the
  // agent reads them (inbox.mjs, readsWhen), and how to deliver them now where an interrupt does.
  const self = process.env.AGENT_ORCH_RUN === run.id && process.env.AGENT_ORCH_TASK === id;
  const waiting = unread.length && !self && !args.ack && !args.all ? describe(run, task).inbox?.delivery || null : null;
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
    if (waiting) lines.push(waiting.text, ...(waiting.steer ? [`interrupt: ${waiting.steer}`] : []));
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
  emit(args, { run: run.id, task: id, messages: shown, acked: args.ack && !ackError ? unread : [], ...(waiting ? { delivery: waiting } : {}) }, lines.join("\n"));
}
