#!/usr/bin/env node
// Demo relay for docs/demo/seed.mjs. The seed copies this file to claude-delegate/scripts/relay.mjs
// and codex-delegate/scripts/relay.mjs in its temporary skills folder, where `orch.mjs start` finds
// it through AGENT_ORCH_SKILLS_DIR. It never runs a model: it plays back a scripted session
// (`-- --demo-script FILE`) as the real relays' files, events.jsonl in the agent's own stream format,
// then final.txt and result.json. A "running" session stays alive until it is stopped (SIGTERM) or
// the seed that started it is gone, keeping its event stream fresh so it never looks silent.
//
// `start` checks the real relay's source for these options before it passes them, so they are
// named here: "--allow-domain" "--allow-publish" "--no-sandbox"

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const out = flag("--out-dir");
const cwd = flag("--cd") || process.cwd();
const model = flag("--model");
const effort = flag("--effort");
const script = JSON.parse(fs.readFileSync(flag("--demo-script"), "utf8"));
const claude = process.argv[1].includes("claude-delegate");
const runId = process.env.AGENT_ORCH_RUN || "";
const taskId = process.env.AGENT_ORCH_TASK || "";
const cli = process.env.DEMO_ORCH_CLI;
const eventsFile = path.join(out, "events.jsonl");
const fill = (text) => String(text ?? "").replaceAll("{run}", runId).replaceAll("{task}", taskId);
const abs = (file) => (path.isAbsolute(file) ? file : path.join(cwd, file));

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "invocation.json"), JSON.stringify({ argv, cwd, depth: process.env.AGENT_ORCH_DEPTH, run: runId, task: taskId }));
const emit = (event) => fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);

// Steady pseudo-random numbers per session, so a re-seeded board shows the same counts.
let seed = createHash("sha256").update(script.session).digest().readUInt32LE(0) || 1;
const rand = (lo, hi) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return lo + (seed % (hi - lo + 1));
};

// Token use grows like a real session's context: each model call re-reads the conversation so far.
const usage = script.usage || {};
let context = usage.base || 18000;
const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0 };
function nextUsage() {
  const grow = rand(usage.growLo || 900, usage.growHi || 4200);
  const u = { input_tokens: rand(2, 40), cache_creation_input_tokens: grow, cache_read_input_tokens: context, output_tokens: rand(usage.outLo || 120, usage.outHi || 1400) };
  context += grow;
  totals.input += u.input_tokens;
  totals.cacheWrite += u.cache_creation_input_tokens;
  totals.cacheRead += u.cache_read_input_tokens;
  totals.output += u.output_tokens;
  totals.calls += 1;
  return u;
}

// ---- Claude Code's stream-json events -------------------------------------------------------

let pendingClaude = null; // the tool call whose result has not arrived yet
const toolUse = (step) => {
  const id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  if (step.t === "read") return { id, name: "Read", input: { file_path: abs(step.file) } };
  if (step.t === "grep") return { id, name: "Grep", input: { pattern: step.pattern, path: abs(step.path || "src"), output_mode: "content" } };
  if (step.t === "glob") return { id, name: "Glob", input: { pattern: step.pattern } };
  if (step.t === "edit") return { id, name: "Edit", input: { file_path: abs(step.file), old_string: step.old || "", new_string: step.new || "" } };
  if (step.t === "write") return { id, name: "Write", input: { file_path: abs(step.file), content: step.content || "" } };
  if (step.t === "todo") return { id, name: "TodoWrite", input: { todos: step.items.map((text, i) => ({ content: text, status: i < (step.done || 0) ? "completed" : i === (step.done || 0) ? "in_progress" : "pending", activeForm: text })) } };
  return { id, name: "Bash", input: { command: fill(step.cmd), description: step.why || "Run a command" } };
};
const toolOutput = (step) => {
  if (step.out != null) return fill(step.out);
  if (step.t === "edit") return `The file ${step.file} has been updated.`;
  if (step.t === "write") return `File created successfully at: ${step.file}`;
  if (step.t === "todo") return "Todos have been modified successfully.";
  return "";
};
function claudeResult(tool, step) {
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: toolOutput(step), is_error: Boolean(step.exit) }] }, session_id: script.session });
}
function claudeStep(step) {
  if (pendingClaude) {
    claudeResult(pendingClaude.tool, pendingClaude.step);
    pendingClaude = null;
  }
  const message = (content, stop) => ({ type: "assistant", message: { id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model, content, stop_reason: stop, usage: nextUsage() }, session_id: script.session });
  if (step.t === "think") return emit(message([{ type: "thinking", thinking: fill(step.text), signature: "" }], null));
  if (step.t === "say") return emit(message([{ type: "text", text: fill(step.text) }], null));
  const tool = toolUse(step);
  emit(message([{ type: "tool_use", ...tool }], "tool_use"));
  if (step.pending) pendingClaude = { tool, step };
  else claudeResult(tool, step);
}

// ---- Codex's `exec --json` events -----------------------------------------------------------

let item = 0;
let pendingCodex = null;
const shell = (cmd) => `/bin/zsh -lc '${fill(cmd).replace(/'/g, "'\\''")}'`;
const codexCommand = (step) => {
  if (step.t === "read") return `sed -n '${step.lines || "1,200"}p' ${step.file}`;
  if (step.t === "grep") return `rg -n "${step.pattern}" ${step.path || "src"}`;
  if (step.t === "glob") return `rg --files -g '${step.pattern}'`;
  return step.cmd;
};
function codexStep(step) {
  if (pendingCodex) {
    emit({ type: "item.completed", item: { ...pendingCodex.item, aggregated_output: fill(pendingCodex.step.out || ""), exit_code: pendingCodex.step.exit || 0, status: pendingCodex.step.exit ? "failed" : "completed" } });
    pendingCodex = null;
  }
  const id = `item_${item++}`;
  if (step.t === "think") return emit({ type: "item.completed", item: { id, type: "reasoning", text: fill(step.text) } });
  if (step.t === "say") return emit({ type: "item.completed", item: { id, type: "agent_message", text: fill(step.text) } });
  if (step.t === "search") return emit({ type: "item.completed", item: { id, type: "web_search", query: step.query } });
  if (step.t === "todo") return emit({ type: "item.completed", item: { id, type: "todo_list", items: step.items.map((text, i) => ({ text, completed: i < (step.done || 0) })) } });
  if (step.t === "edit" || step.t === "write") {
    const files = [].concat(step.files || step.file);
    return emit({ type: "item.completed", item: { id, type: "file_change", changes: files.map((f) => ({ path: abs(f), kind: step.t === "write" ? "add" : "update" })), status: "completed" } });
  }
  const started = { id, type: "command_execution", command: shell(codexCommand(step)), aggregated_output: "", exit_code: null, status: "in_progress" };
  emit({ type: "item.started", item: started });
  if (step.pending) pendingCodex = { item: started, step };
  else emit({ type: "item.completed", item: { ...started, aggregated_output: fill(step.out || ""), exit_code: step.exit || 0, status: step.exit ? "failed" : "completed" } });
}
// A Codex turn reports its usage once, when it ends; these are that turn's counts.
function codexUsage() {
  const steps = script.steps.length;
  for (let i = 0; i < steps * 3; i++) nextUsage();
  return { input_tokens: totals.input + totals.cacheWrite + totals.cacheRead, cached_input_tokens: totals.cacheRead, output_tokens: totals.output };
}

// Codex also keeps its own session log (a rollout), which `status` reads for a running task's live
// token count and the dashboard for Codex's usage limits.
function codexRollout(final) {
  const home = process.env.CODEX_HOME;
  if (!home || !script.rollout) return;
  const started = new Date(script.startedAt);
  const p = (n) => String(n).padStart(2, "0");
  const day = path.join(home, "sessions", String(started.getFullYear()), p(started.getMonth() + 1), p(started.getDate()));
  const stamp = `${started.getFullYear()}-${p(started.getMonth() + 1)}-${p(started.getDate())}T${p(started.getHours())}-${p(started.getMinutes())}-${p(started.getSeconds())}`;
  fs.mkdirSync(day, { recursive: true });
  const at = (ms) => new Date(ms).toISOString();
  const u = final || codexUsage();
  const r = script.rollout;
  const lines = [
    { timestamp: at(started), type: "session_meta", payload: { id: script.session, timestamp: at(started), cwd, originator: "codex_exec", cli_version: "0.98.0", source: "exec", model_provider: "openai" } },
    { timestamp: at(started), type: "turn_context", payload: { turn_id: script.turnId, cwd, model, effort, approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } },
    { timestamp: at(started), type: "event_msg", payload: { type: "task_started", turn_id: script.turnId, model_context_window: 400000 } },
    { timestamp: at(Date.parse(r.readAt || script.startedAt)), type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { ...u, reasoning_output_tokens: Math.round(u.output_tokens * 0.6), total_tokens: u.input_tokens + u.output_tokens }, model_context_window: 400000 },
      rate_limits: { primary: { used_percent: r.fiveHour, window_minutes: 300, resets_at: Math.round(Date.parse(r.fiveHourResets) / 1000) }, secondary: { used_percent: r.week, window_minutes: 10080, resets_at: Math.round(Date.parse(r.weekResets) / 1000) } } } },
    ...(script.end.status === "running" ? [] : [{ timestamp: script.end.finishedAt, type: "event_msg", payload: { type: "task_complete", turn_id: script.turnId, last_agent_message: script.end.finalMessage || null } }]),
  ];
  fs.writeFileSync(path.join(day, `rollout-${stamp}-${script.session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ---- The session ----------------------------------------------------------------------------

const step = claude ? claudeStep : codexStep;
if (claude) {
  emit({ type: "system", subtype: "init", cwd, session_id: script.session, model, permissionMode: "default", tools: ["Bash", "Edit", "Glob", "Grep", "Read", "TodoWrite", "Write"] });
  if (script.rateLimits) {
    const l = script.rateLimits;
    emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: {
      five_hour: { utilization: l.fiveHour / 100, resetsAt: Math.round(Date.parse(l.fiveHourResets) / 1000) },
      seven_day: { utilization: l.week / 100, resetsAt: Math.round(Date.parse(l.weekResets) / 1000) },
    } }, session_id: script.session });
  }
} else {
  emit({ type: "thread.started", thread_id: script.session });
  emit({ type: "turn.started" });
}
for (const s of script.steps) step(s);

// Work the agent committed on its branch, as implementers do by default.
function commit() {
  const c = script.commit;
  if (!c) return;
  for (const [file, text] of Object.entries(c.files)) {
    fs.mkdirSync(path.dirname(abs(file)), { recursive: true });
    fs.writeFileSync(abs(file), text);
  }
  const git = (args) => spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", c.message]);
}

function writeResult(result) {
  fs.writeFileSync(path.join(out, "result.json.tmp"), JSON.stringify(result));
  fs.renameSync(path.join(out, "result.json.tmp"), path.join(out, "result.json"));
  process.exit(result.exitCode);
}

function finish(status) {
  const end = script.end;
  const finalMessage = fill(end.finalMessage || "");
  if (claude) {
    if (pendingClaude) claudeResult(pendingClaude.tool, pendingClaude.step);
    emit({ type: "assistant", message: { id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model, content: [{ type: "text", text: finalMessage }], stop_reason: "end_turn", usage: nextUsage() }, session_id: script.session });
    emit({ type: "result", subtype: status === "completed" ? "success" : "error_during_execution", is_error: status !== "completed", num_turns: totals.calls, result: end.error || finalMessage,
      session_id: script.session, duration_ms: Date.parse(end.finishedAt) - Date.parse(script.startedAt),
      usage: { input_tokens: totals.input, cache_creation_input_tokens: totals.cacheWrite, cache_read_input_tokens: totals.cacheRead, output_tokens: totals.output },
      total_cost_usd: Number(((totals.input + totals.cacheWrite) * 6e-6 + totals.cacheRead * 6e-7 + totals.output * 3e-5).toFixed(2)) });
  } else {
    if (finalMessage) emit({ type: "item.completed", item: { id: `item_${item++}`, type: "agent_message", text: finalMessage } });
    const u = codexUsage();
    emit({ type: "turn.completed", usage: u });
    if (status !== "completed" && end.error) emit({ type: "turn.failed", error: { message: end.error } });
    codexRollout(u);
  }
  fs.writeFileSync(path.join(out, "final.txt"), finalMessage);
  writeResult({
    schema: "delegate-relay.result.v1", status, exitCode: status === "completed" ? 0 : 1, signal: null, finalMessage,
    ...(claude ? { sessionId: script.session } : { threadId: script.session }),
    model, effort, touchedFiles: end.touchedFiles || [], startedAt: script.startedAt,
    finishedAt: end.finishedAt, readOnlyViolation: false, error: end.error || null,
  });
}

if (script.end.status !== "running") {
  commit();
  finish(script.end.status);
}

// ---- A running session ----------------------------------------------------------------------

if (!claude) codexRollout(null);
// Stopped (`orch.mjs stop` or `close`, or the seed's cleanup): record it as the real relays do.
process.on("SIGTERM", () => writeResult({
  schema: "delegate-relay.result.v1", status: "stopped", exitCode: 1, signal: "SIGTERM", finalMessage: "",
  ...(claude ? { sessionId: script.session } : { threadId: script.session }),
  model, effort, touchedFiles: [], startedAt: script.startedAt, finishedAt: new Date().toISOString(), readOnlyViolation: false, error: null,
}));
fs.writeFileSync(path.join(out, "ready"), "");

// The user's message reaches a Claude agent through the orch-inbox hook after its pending tool
// call returns; the agent answers with `orch.mjs reply` and carries on. This one answers the first
// message only, so a later one stays queued, unread.
const taskDir = path.dirname(out);
let answered = !script.inbox;
function answerInbox() {
  let text = "";
  try {
    text = fs.readFileSync(path.join(taskDir, "inbox.jsonl"), "utf8");
  } catch {
    return;
  }
  if (!text.includes('"from":"user"')) return;
  answered = true;
  if (pendingClaude) {
    claudeResult(pendingClaude.tool, pendingClaude.step);
    pendingClaude = null;
  }
  spawnSync(process.execPath, [path.join(path.dirname(cli), "hooks", "orch-inbox.mjs"), "PostToolUse"], { env: process.env, stdio: "ignore" });
  for (const s of script.inbox.before || []) step(s);
  const reply = fill(script.inbox.reply);
  const tool = toolUse({ t: "bash", cmd: `node ~/.agents/skills/agent-orchestrator/scripts/orch.mjs reply {run} {task} "${reply.replace(/"/g, '\\"')}"`, why: "Answer the user's message" });
  emit({ type: "assistant", message: { id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", ...tool }], stop_reason: "tool_use", usage: nextUsage() }, session_id: script.session });
  const said = spawnSync(process.execPath, [cli, "reply", runId, taskId, reply], { env: process.env, encoding: "utf8" });
  claudeResult(tool, { t: "bash", out: (said.stdout || said.stderr || "").trim() });
  for (const s of script.inbox.after || []) step(s);
  fs.writeFileSync(path.join(out, "demo-inbox-done"), "");
}

// A session waiting in a command with a timeout (a babysitter's pr-watch) sees it return, and runs
// it again.
if (script.repeat) {
  const again = () => step(script.steps.at(-1));
  setTimeout(() => {
    again();
    setInterval(again, script.repeat.everyMs);
  }, script.repeat.firstMs);
}

const seedPid = Number(process.env.DEMO_SEED_PID || 0);
let beat = 0;
setInterval(() => {
  // Never outlive the seed: if it is gone, so is the board this session belongs to.
  if (seedPid) {
    try {
      process.kill(seedPid, 0);
    } catch {
      process.exit(0);
    }
  }
  if (!answered) answerInbox();
  // Keep the stream fresh, as a working agent's is; a session that waits quietly by design (a
  // babysitter in pr-watch) is left alone.
  if (!script.quiet && ++beat % 20 === 0) {
    const now = new Date();
    try {
      fs.utimesSync(eventsFile, now, now);
    } catch {}
  }
}, 500);
