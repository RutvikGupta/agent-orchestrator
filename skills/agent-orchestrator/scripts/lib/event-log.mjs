// A session's event log for the dashboard's detail panel: each relay event, or each line of a
// host's transcript, as a { kind, text } entry.

import fs from "node:fs";
import path from "node:path";
import { claudeTool } from "./claude.mjs";
import { REPLY_PREFIX, readInbox, readReplies } from "./inbox.mjs";
import { compact, formatElapsed, relPath, shortText, unwrapShell } from "./format.mjs";
import { attemptAgent, taskDir } from "./runs.mjs";
import { tailText } from "./util.mjs";

function eventText(agent, e, cwd) {
  if (agent === "codex") {
    if (e.type === "thread.started") return ["session", `started thread ${e.thread_id}`];
    if (e.type === "turn.completed") {
      const u = e.usage || {};
      return ["usage", `turn done · ${compact(u.input_tokens)} in (${compact(u.cached_input_tokens)} cached) / ${compact(u.output_tokens)} out`];
    }
    if (e.type === "turn.failed" || e.type === "error") return ["error", e.error?.message || e.message || "error"];
    if (e.type === "item.started" && e.item?.type === "command_execution") return ["tool", `$ ${unwrapShell(e.item.command)}`];
    if (e.type !== "item.completed" || !e.item) return null;
    const it = e.item;
    if (it.type === "command_execution") {
      const out = String(it.aggregated_output ?? "").trim();
      return out || it.exit_code ? ["output", `${out}${it.exit_code ? `${out ? "\n" : ""}(exit ${it.exit_code})` : ""}`] : null;
    }
    if (it.type === "file_change") return ["edit", (it.changes || []).map((c) => `${c.kind || "change"} ${relPath(c.path, cwd)}`).join(", ")];
    if (it.type === "agent_message") return ["says", it.text || ""];
    if (it.type === "reasoning") return ["thinking", it.text || ""];
    if (it.type === "web_search") return ["tool", `search ${it.query || ""}`];
    if (it.type === "mcp_tool_call") return ["tool", `${it.server}.${it.tool}`];
    if (it.type === "todo_list") return ["plan", (it.items || []).map((i) => `${i.completed ? "✓" : "·"} ${i.text}`).join("  ")];
    if (it.type === "error") return ["error", it.message || ""];
    return null;
  }
  if (e.type === "system" && e.subtype === "init") return ["session", `started ${e.session_id} · ${e.model}`];
  if (e.type === "result") {
    return ["usage", `done: ${e.subtype} · ${e.num_turns ?? "?"} turns`];
  }
  if (e.type === "assistant" && e.message) {
    const parts = [];
    for (const b of e.message.content || []) {
      if (b.type === "tool_use") parts.push(["tool", claudeTool(b.name, b.input || {}, cwd, 0)]);
      else if (b.type === "text" && b.text?.trim()) parts.push(["says", b.text]);
      else if (b.type === "thinking" && b.thinking?.trim()) parts.push(["thinking", b.thinking]);
    }
    return parts.length ? parts : null;
  }
  if (e.type === "user" && typeof e.message?.content === "string") return e.isMeta ? null : ["user", e.message.content];
  if (e.type === "user" && Array.isArray(e.message?.content)) {
    const r = e.message.content.find((b) => b.type === "tool_result");
    if (!r) {
      const text = e.isMeta ? "" : e.message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
      return text ? ["user", text] : null;
    }
    const body = Array.isArray(r.content) ? r.content.map((c) => c.text || "").join(" ") : String(r.content ?? "");
    return [r.is_error ? "error" : "output", body];
  }
  return null;
}

// One line of a Codex rollout as a log entry. Commands, messages, and edits come from Codex's
// completed items; tool output comes from the model-facing tool results.
function codexRolloutText(e, cwd) {
  const p = e.payload || {};
  const joined = (parts) =>
    `${(parts || []).map((c) => c.text || "").join("\n").trim()}${(parts || []).some((c) => c.type === "encrypted_content") ? " (encrypted)" : ""}`;
  // Codex encrypts message payloads between its agents; show that rather than the ciphertext.
  const args = (raw) => {
    try {
      return JSON.stringify(JSON.parse(raw), (k, v) => (typeof v === "string" && /^gAAAAA[\w-]{40,}/.test(v) ? "(encrypted)" : v));
    } catch {
      return String(raw ?? "");
    }
  };
  if (e.type === "event_msg" && p.type === "item_completed" && p.item) {
    const it = p.item;
    if (it.type === "UserMessage") return ["user", joined(it.content)];
    if (it.type === "AgentMessage") return ["says", joined(it.content)];
    if (it.type === "Reasoning") return it.summary_text?.length ? ["thinking", it.summary_text.join("\n")] : null;
    if (it.type === "CommandExecution") {
      const command = Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command;
      return ["tool", `$ ${unwrapShell(command)}${it.exit_code != null ? `  → exit ${it.exit_code}` : ""}`];
    }
    if (it.type === "FileChange") return ["edit", Object.entries(it.changes || {}).map(([f, c]) => `${c.type || "change"} ${relPath(f, cwd)}`).join(", ")];
    if (it.type === "McpToolCall") return ["tool", `${it.server}.${it.tool} ${shortText(args(JSON.stringify(it.arguments || {})), 200)}`];
    if (it.type === "Extension") return ["tool", `${it.kind} ${it.query || ""}`];
    if (it.type === "SubAgentActivity") return ["session", `sub-agent ${it.agent_path || it.agent_thread_id || ""} ${it.kind || ""}`];
    if (it.type === "ContextCompaction") return ["session", "context compacted"];
    return null;
  }
  if (e.type === "event_msg") {
    if (p.type === "task_complete") return ["usage", `turn done${p.duration_ms ? ` in ${formatElapsed(p.duration_ms)}` : ""}`];
    if (p.type === "turn_aborted") return ["error", `turn aborted${p.reason ? `: ${p.reason}` : ""}`];
    if (p.type === "error" || p.type === "stream_error") return ["error", p.message || "error"];
    return null;
  }
  if (e.type !== "response_item") return null;
  if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
    let text = (Array.isArray(p.output) ? p.output.map((c) => c.text || "").join("") : String(p.output ?? ""))
      .replace(/^Script completed\nWall time [^\n]*\nOutput:\n/, "")
      .trim();
    // A command's result arrives as JSON: {"output": ..., "exit_code": ...}.
    try {
      const r = JSON.parse(text);
      if (typeof r?.output === "string") text = `${r.output.trim()}${r.exit_code ? `\n(exit ${r.exit_code})` : ""}`;
    } catch {}
    return text ? ["output", text] : null;
  }
  // `wait` only polls a running command; its output still shows.
  if (p.type === "function_call" && p.name !== "wait") return ["tool", `${p.name} ${shortText(args(p.arguments), 200)}`];
  if (p.type === "agent_message") return ["message", `${p.author} → ${p.recipient}: ${joined(p.content)}`];
  return null;
}

// Log of a session that orch.mjs did not start, read from its host's transcript. A Codex
// sub-agent's rollout opens with a copy of its parent's history; Codex ids are time-ordered
// (UUIDv7), so turns older than the thread itself belong to that copy and are skipped.
export function transcriptLog(file, codex, limit) {
  const text = tailText(file);
  if (text == null) return [];
  const own = codex ? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] : null;
  let turn = null;
  let cwd = null;
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    let r;
    if (codex) {
      const p = e.payload || {};
      turn = p.turn_id || p.internal_chat_message_metadata_passthrough?.turn_id || turn;
      if (e.type === "turn_context" && p.cwd) cwd = p.cwd;
      if (!turn || (own && turn < own)) continue;
      r = codexRolloutText(e, cwd);
    } else {
      r = eventText("claude", e, e.cwd || null);
    }
    if (!r) continue;
    for (const [kind, body] of Array.isArray(r[0]) ? r : [r]) if (String(body).trim()) out.push({ kind, text: String(body).slice(0, 4000) });
  }
  return out.slice(-limit);
}

export function eventLog(run, task, attempt, limit) {
  const file = path.join(taskDir(run, task.id), `attempt-${attempt}`, "events.jsonl");
  const text = tailText(file);
  // Messages to the agent go in the log at the size it had when each was sent, and again where the
  // agent read it: the stream itself never records them.
  const marks = [];
  for (const m of readInbox(taskDir(run, task.id))) {
    if ((m.attempt || 1) !== attempt) continue;
    const who = m.from === "user" ? "You" : "Orchestrator";
    const said = String(m.body ?? m.text);
    const images = m.images?.length ? `\n(${m.images.length === 1 ? "1 image" : `${m.images.length} images`} attached)` : "";
    if (Number.isInteger(m.logOffset)) marks.push({ at: m.logOffset, order: 0, kind: "sent", text: `${who}: ${said}${images}`.slice(0, 4000) });
    if (Number.isInteger(m.readOffset)) marks.push({ at: m.readOffset, order: 1, kind: "received", text: `The agent received ${m.from === "user" ? "your" : "the orchestrator's"} message: ${shortText(said, 160)}` });
  }
  for (const r of readReplies(taskDir(run, task.id))) {
    if ((r.attempt || 1) === attempt && Number.isInteger(r.logOffset)) marks.push({ at: r.logOffset, order: 2, kind: "reply", text: r.text.slice(0, 4000) });
  }
  marks.sort((a, b) => a.at - b.at || a.order - b.order);
  if (text == null && !marks.length) return [];
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {}
  // tailText starts at a line boundary; count bytes from the end to find each line's offset.
  let offset = size - Buffer.byteLength(text || "", "utf8");
  const out = [];
  const flush = (upTo) => {
    while (marks.length && marks[0].at <= upTo) {
      const { kind, text: body } = marks.shift();
      out.push({ kind, text: body });
    }
  };
  for (const line of (text || "").split("\n")) {
    flush(offset);
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const r = eventText(attemptAgent(task, attempt), e, task.cd);
    if (!r) continue;
    for (const [kind, body] of Array.isArray(r[0]) ? r : [r]) {
      const said = String(body);
      // An agent without a shell answers the user in a message that starts with REPLY_PREFIX.
      if (kind === "says" && said.trimStart().startsWith(REPLY_PREFIX)) out.push({ kind: "reply", text: said.trimStart().slice(REPLY_PREFIX.length).trim().slice(0, 4000) });
      else out.push({ kind, text: said.slice(0, 4000) });
    }
  }
  flush(Infinity);
  return out.slice(-limit);
}
