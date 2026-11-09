// Attention first wakes the orchestrator's wait. If it stays unhandled, the dashboard tells whoever
// must act (addresseeOf in dashboard-state.mjs) once per task, attempt and kind (and, for a stuck
// task, episode; for a question, each question). The user gets a notice only for an item addressed
// to the user. An orch task gets an inbox message instead; a launching session gets nothing here,
// since its `wait` wakes on the item. Once that agent is gone, or cannot take the message, the item
// is the user's, and its notice says so. Pending timers and sent notices survive restarts.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SendError, deliverMessage } from "./commands/inbox.mjs";
import { CLI_PATH, STATE_ROOT } from "./config.mjs";
import { attentionOf } from "./dashboard-state.mjs";
import { runById } from "./finish-notice.mjs";
import { agoText } from "./format.mjs";
import { parseDuration, writeJson } from "./util.mjs";

// What an item of each kind waits for, after "<task> has waited 25m".
const WAITS_FOR = { "awaiting-review": "for review", question: "for an answer", "needs-decision": "for a decision", stuck: "while stuck", silent: "while silent", dead: "since its relay died" };

// The notice for an item that went to the user because its agent is gone or cannot take it:
// "orchestrator session 425c2bc2 is gone (…); review-me has waited 25m for review".
export function goneText(id, item, waitedMs, state = `is gone (${item.gone})`) {
  const what = WAITS_FOR[item.kind] || `since it ended (${item.label})`;
  return `${item.agent} ${state}; ${id} has waited ${agoText(waitedMs)} ${what}`;
}

// The inbox message an orch task gets about an item of a task it started, with what to do.
export function agentNoticeText(run, task, item, waitedMs) {
  const cmd = (rest) => `\`node ${CLI_PATH} ${rest} ${run} ${task.id}\``;
  const todo = {
    "awaiting-review": `Read it with ${cmd("result")}, then ${cmd("accept")} once its work is committed, or record ${cmd("verdict").replace(/`$/, ' changes --note "<fixes>"`')} and resume it, or ${cmd("close")}.`,
    "needs-decision": `Read it with ${cmd("result")}, decide what your brief covers, and resume it; pass a decision beyond your brief up at once with \`node ${CLI_PATH} ask "<question>"\`.`,
    stuck: `Read its log with ${cmd("log")}, then give it a hint with ${cmd("send").replace(/`$/, ' "<hint>" --steer`')}, or ${cmd("stop")} it.`,
    silent: `Check it with ${cmd("log")}, then nudge it with ${cmd("send").replace(/`$/, ' "<message>"`')}, or ${cmd("stop")} it.`,
    question: `Answer it with ${cmd("send").replace(/`$/, ' "<answer>"`')}.`,
  }[item.kind] || `Read it with ${cmd("result")}, then fix and resume it, or ${cmd("close")} it.`;
  return `Agent ${run}/${task.id} (attempt ${task.attempt || 1}), which you started, has waited ${agoText(waitedMs)} on you: ${item.label} — ${item.reason}.\n${todo}`;
}

// `review` includes results nobody has collected yet. `wait` leaves them out (a finished task
// already wakes it), but escalation to the user includes them: an orchestrator that never picks
// up a finished result stalls the whole run.
export function taskAttention(row, closed, { review = false } = {}) {
  // Board rows omit the raw result; their existing attention preserves its exact error reason.
  const item = closed ? null : row.attention === undefined ? attentionOf(row, closed) : row.attention;
  if (!item || (item.kind === "awaiting-review" && !review)) return null;
  return { ...item, kind: item.label === "dead" ? "dead" : item.kind, reason: item.reason || item.label };
}

// No shell: both the configured command and AppleScript get literal argument arrays. Bound
// runtime and captured errors even for a broken notification program.
function deliver(command, input, done) {
  let child;
  let stderr = "";
  let inputError = null;
  let settled = false;
  let timer;
  const stop = () => { if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.off("exit", stop);
    done(error);
  };
  try {
    child = spawn(command[0], command.slice(1), { stdio: ["pipe", "ignore", "pipe"] });
    process.once("exit", stop);
    timer = setTimeout(() => {
      stop();
      child.stdin.destroy();
      child.stderr.destroy();
      finish("timed out after 60 seconds");
    }, 60_000);
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4096); });
    child.on("error", (error) => finish(error.message));
    child.stdin.on("error", (error) => { inputError = `stdin: ${error.message}`; });
    child.on("close", (code, signal) => finish(code === 0 ? inputError : `exit ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    child.stdin.end(input);
  } catch (error) {
    finish(error.message);
  }
}

// How long an item waits before it goes to the user. A decision or a question stalls an agent that
// waits on someone, so it goes after AGENT_ORCH_DECISION_ESCALATE_AFTER (default 2 minutes, or the
// general delay when that is shorter); every other kind after AGENT_ORCH_ESCALATE_AFTER (10 minutes).
const DECISION_KINDS = new Set(["needs-decision", "question"]);
export function escalationDelays() {
  const after = parseDuration(process.env.AGENT_ORCH_ESCALATE_AFTER ?? "10m");
  const set = process.env.AGENT_ORCH_DECISION_ESCALATE_AFTER;
  return { after, decisionAfter: set ? parseDuration(set) : Math.min(after, 2 * 60_000) };
}
export const escalationDelay = (kind, delays = escalationDelays()) => (DECISION_KINDS.has(kind) ? delays.decisionAfter : delays.after);

// How often the dashboard checks for items to escalate: a tenth of the shorter delay, between 1
// and 10 seconds. Each check builds the whole board, so checking every second for a 10-minute
// delay costs a steady share of a CPU core for nothing.
export function escalationCheckMs() {
  const { after, decisionAfter } = escalationDelays();
  return Math.min(10_000, Math.max(1000, Math.round(Math.min(after, decisionAfter) / 10)));
}

export function createEscalator({ url, broadcast }) {
  const file = path.join(STATE_ROOT, "escalations.json");
  let records = {};
  // Refuse to forget sent notices on a damaged/unreadable ledger: log it and try again on
  // the next server start instead of accidentally notifying everyone a second time.
  if (fs.existsSync(file)) {
    records = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("invalid escalation ledger");
  }
  const delays = escalationDelays();
  const save = () => writeJson(file, records);
  const failure = (key, channel, error) => {
    records[key].deliveries[channel] = { at: Date.now(), error };
    if (error) process.stderr.write(`orch: escalation ${channel} for ${records[key].task}: ${error}\n`);
    try { save(); } catch (e) { process.stderr.write(`orch: cannot record escalation delivery: ${e.message}\n`); }
  };
  const send = (key, message) => {
    const record = records[key];
    try { broadcast(message); } catch (error) { failure(key, "browser", error.message); }
    if (process.platform === "darwin" && process.env.AGENT_ORCH_NOTIFY !== "off") {
      const literal = (text) => JSON.stringify(String(text).replace(/[\r\n\t]/g, " "));
      const script = `display notification ${literal(message.text)} with title ${literal("Agent Orchestrator needs attention")}`;
      deliver(["osascript", "-e", script], "", (error) => failure(key, "macos", error));
    }
    const config = path.join(STATE_ROOT, "notify.json");
    if (!fs.existsSync(config)) return;
    try {
      const { command } = JSON.parse(fs.readFileSync(config, "utf8"));
      if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !path.isAbsolute(command[0])) {
        throw new Error("notify.json command must be an array with an absolute program path and string arguments");
      }
      const { run, task, kind, reason, waited } = record;
      deliver(command, JSON.stringify({ run, task, kind, reason, waited, url }) + "\n", (error) => failure(key, "command", error));
    } catch (error) {
      failure(key, "command", error.message);
    }
  };

  return (sections, now = Date.now()) => {
    const before = records;
    records = Object.fromEntries(Object.entries(records).map(([key, record]) => [key, { ...record }]));
    const active = new Set();
    const pending = [];
    const tellAgent = [];
    let changed = false;
    for (const section of sections) for (const task of section.tasks) {
      // The board already applies explicit closedAt (describe().closed also includes completed
      // tasks). Do not use the row's closed flag to discard a decision in its structured report.
      const item = task.attention && taskAttention(task, false, { review: true });
      if (!item) continue;
      const run = task.run || section.id;
      // A stuck task can get stuck again in the same attempt; each episode, named by its first
      // failure's place in the event stream, notifies once. So does each question an agent asks.
      const episode = item.kind === "stuck" ? [task.stuck?.firstIndex ?? null] : item.kind === "question" ? [task.question?.id ?? null] : [];
      const key = JSON.stringify([run, task.id, task.attempt || 0, item.kind, ...episode]);
      active.add(key);
      if (!records[key]) {
        records[key] = { run, task: task.id, attempt: task.attempt || 0, kind: item.kind, reason: item.reason, since: now };
        changed = true;
      }
      const record = records[key];
      const due = now - record.since >= escalationDelay(item.kind, delays);
      const title = section.runs?.find((r) => r.id === run)?.goal || section.goal || run;
      const notice = (reason) => {
        Object.assign(record, { reason, waited: now - record.since, escalatedAt: now, deliveries: {} });
        return [key, { ...record, url, key: `${section.id}/${task.key}`, text: `${task.id} · ${title} · ${reason}` }];
      };
      // An item for an agent goes to that agent, never to the user. A session learns it from its
      // `wait`; an orch task gets one inbox message when the user would have been told. The timer
      // keeps running, so the item goes to the user at once if that agent is gone by then.
      if (item.to === "agent") {
        if (!item.agentTask || record.agentNoticeAt != null || !due) continue;
        record.agentNoticeAt = now;
        changed = true;
        tellAgent.push({ key, item, task, run, notice });
        continue;
      }
      if (record.escalatedAt != null || !due) continue;
      changed = true;
      pending.push(notice(item.gone && item.agent ? goneText(task.id, item, now - (item.sinceMs || record.since)) : item.reason));
    }
    for (const [key, record] of Object.entries(records)) {
      if (record.escalatedAt == null && record.agentNoticeAt == null && !active.has(key)) {
        delete records[key];
        changed = true;
      }
    }
    // Claim before delivering: a server restart never repeats a sent notice, even if a delivery
    // fails. Such failures stay in the ledger rather than causing a notification retry loop.
    if (changed) {
      try { save(); }
      catch (error) { records = before; throw error; }
    }
    // An agent that cannot take its notice (it stopped, or will not read messages) leaves it to the
    // user. Its record, and any notice that falls back to the user, are saved before that goes out.
    for (const { key, item, task, run, notice } of tellAgent) {
      const { run: parentRun, task: parentTask } = item.agentTask;
      const to = `${parentRun}/${parentTask}`;
      let why = null;
      try {
        const target = runById(parentRun);
        if (!target) throw new SendError(`its run ${parentRun} is gone`, 404);
        const sent = deliverMessage(target, parentTask, agentNoticeText(run, task, item, now - (item.sinceMs || records[key].since)), {
          from: `agent:${run}/${task.id}`, kind: "attention", about: { run, task: task.id, attempt: task.attempt || 0 },
        });
        records[key].agentNotice = { to, message: sent.message.id, at: sent.message.time };
        if (!sent.reaches) why = "it will not read messages";
      } catch (error) {
        // Not running, gone, or an unwritable inbox: whatever stops the message, the user hears.
        why = String(error?.message || error).replace(/; resume it .*$/, "");
        records[key].agentNotice = { to, error: why };
      }
      if (why) pending.push(notice(goneText(task.id, item, now - (item.sinceMs || records[key].since), `cannot take it (${why})`)));
    }
    if (tellAgent.length) {
      try { save(); } catch (error) { process.stderr.write(`orch: cannot record agent notices: ${error.message}\n`); }
    }
    for (const [key, message] of pending) send(key, message);
  };
}
