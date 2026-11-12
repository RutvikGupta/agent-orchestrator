// Claude transcript parsing: the relay's `--output-format stream-json` events and Claude Code's
// own session and sub-agent transcripts share one shape, folded into a summary (see events.mjs).

import { relPath, shortText } from "./format.mjs";
import { claudeLimits } from "./limits.mjs";

export function claudeTool(name, input, cwd, width = 60) {
  if (name === "Bash") return `$ ${width ? shortText(input.command, width) : input.command}`;
  if (input.file_path) return `${name} ${relPath(input.file_path, cwd)}`;
  if (input.pattern) return `${name} ${shortText(input.pattern, 40)}`;
  return name;
}

// The text of a Claude Code user line, whether its content is a string or a list of blocks.
function userText(e) {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text || "").join("\n") : "";
}

// /model and /effort run inside Claude Code and send nothing to the model, so no reply carries
// the new setting until the next turn. Their output line does: "Set model to `Fable 5.2` and
// saved ..." and "Set effort level to high (saved ...): ...". A model is named for display, so
// its id is built from the family and version; a name with neither leaves the model as it was.
const LOCAL_OUTPUT = "<local-command-stdout>";
function applyLocalCommand(s, text) {
  const out = text.slice(LOCAL_OUTPUT.length).replace(/\x1b\[[0-9;]*m/g, "");
  const effort = /^Set effort level to ([a-z]+)\b/.exec(out)?.[1];
  if (effort) s.effort = effort;
  const name = /^Set model to `?([^`<\n]+)/.exec(out)?.[1];
  if (!name) return;
  const id = /\bclaude-[a-z0-9.-]*[a-z0-9]/.exec(name)?.[0];
  const named = /\b(fable|mythos|opus|sonnet|haiku)\s+(\d+)(?:\.(\d+))?/i.exec(name);
  if (id) s.model = id;
  else if (named) s.model = `claude-${named[1].toLowerCase()}-${named[2]}${named[3] ? `-${named[3]}` : ""}`;
}

// Where the relay's session is in its turn, for steering (steer.mjs) and the idle state (runs.mjs).
// `claude -p` ends each turn with a `result` event. While a background command the agent started is
// pending, its process stays alive after that, and the next turn starts with a task notification:
// `turnEnded` holds from a `result` until an event of a next turn arrives. `openTool` is the latest
// tool call that has no result yet ({ id, name, command, background }), or null.
function applyTurn(s, e) {
  if (e.type === "result") {
    s.turnEnded = true;
    s.openTool = null;
    return;
  }
  if (e.type === "assistant" || e.type === "user" || (e.type === "system" && e.subtype === "task_notification")) s.turnEnded = false;
  const content = Array.isArray(e.message?.content) ? e.message.content : [];
  if (e.type === "assistant") {
    for (const b of content) {
      if (b?.type === "tool_use" && b.id) s.openTool = { id: b.id, name: b.name || null, command: b.name === "Bash" ? String(b.input?.command ?? "") : null, background: Boolean(b.input?.run_in_background) };
    }
  } else if (e.type === "user" && s.openTool && content.some((b) => b?.type === "tool_result" && b.tool_use_id === s.openTool.id)) {
    s.openTool = null;
  }
}

export function applyClaudeEvent(s, e, cwd) {
  applyTurn(s, e);
  if (e.timestamp && (e.type === "assistant" || (e.type === "user" && !e.isCompactSummary && !e.isVisibleInTranscriptOnly))) s.lastAt = e.timestamp;
  // A command Claude Code runs itself (/model, /effort) is recorded as two user lines: the command,
  // then its output. The command line reads as a prompt, so it opens a turn below, as a command
  // that sends a prompt must. Its output shows that nothing went to the model, so the session
  // goes back to how it was before the command: an idle session stays idle.
  const before = s.beforeCommand;
  s.beforeCommand = null;
  const text = e.type === "user" && typeof e.message?.content === "string" ? e.message.content : "";
  if (text.startsWith(LOCAL_OUTPUT) || text.startsWith("<local-command-stderr>")) {
    if (before) Object.assign(s, before);
    if (text.startsWith(LOCAL_OUTPUT)) applyLocalCommand(s, text);
    return;
  }
  if (text.startsWith("<command-name>")) s.beforeCommand = { busy: s.busy, ended: s.ended, interrupted: s.interrupted };
  if (e.type === "system" && e.subtype === "init") {
    s.sessionId = e.session_id || s.sessionId;
    s.model = e.model || s.model;
  } else if (e.type === "assistant" && e.message) {
    const m = e.message;
    s.model = m.model || s.model;
    s.effort = e.perTurnEffort || e.effort || s.effort; // Claude Code records each reply's effort
    // A message's usage can be recorded more than once while it streams; keep the largest counts.
    if (m.id && m.usage) {
      const prev = s.messages.get(m.id) || {};
      const merged = { ...prev };
      for (const [k, v] of Object.entries(m.usage)) if (typeof v === "number") merged[k] = Math.max(prev[k] || 0, v);
      s.messages.set(m.id, merged);
    }
    for (const b of m.content || []) {
      if (b.type === "tool_use" && b.name === "SubagentHandback") {
        s.lastMessage = String(b.input?.message || "").trim() || s.lastMessage; // a sub-agent's final report
        s.activity = "handed back its report";
      } else if (b.type === "tool_use") {
        if (!s.seen.has(b.id)) s.steps += 1;
        s.seen.add(b.id);
        s.activity = claudeTool(b.name, b.input || {}, cwd);
      } else if (b.type === "text" && b.text?.trim()) {
        s.activity = `says: ${shortText(b.text, 50)}`;
        s.lastMessage = b.text.trim();
      } else if (b.type === "thinking") {
        s.activity = "thinking";
      }
    }
    // A sub-agent is done once it replies without calling a tool, or hands its report back.
    const tools = (m.content || []).filter((b) => b.type === "tool_use").map((b) => b.name);
    s.ended = tools.length ? tools.includes("SubagentHandback") : Boolean(m.stop_reason) && m.stop_reason !== "tool_use";
    s.busy = !s.ended;
    if (!s.exact) {
      const t = { input: 0, cached: 0, output: 0 };
      for (const u of s.messages.values()) {
        t.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        t.cached += u.cache_read_input_tokens || 0;
        t.output += u.output_tokens || 0;
      }
      s.tokens = t;
    }
  } else if (e.type === "system" && (e.subtype === "turn_duration" || e.subtype === "stop_hook_summary")) {
    s.busy = false; // Claude Code writes these when a turn ends
  } else if (e.type === "api-request" || (e.type === "user" && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === "tool_result"))) {
    s.busy = true;
  } else if (e.type === "user" && (e.isCompactSummary || e.isVisibleInTranscriptOnly)) {
    // A compaction summary is not a prompt: compacting an idle session leaves it idle.
  } else if (e.type === "user" && userText(e).startsWith("[Request interrupted by user")) {
    s.busy = false; // the user pressed Esc or rejected a tool: the turn ended unfinished
    s.interrupted = true;
  } else if (e.type === "user" && !e.isMeta && (typeof e.message?.content === "string" || e.message?.content?.some?.((b) => b.type === "text"))) {
    s.ended = false; // a new message resumes the session
    s.interrupted = false;
    s.busy = true;
  } else if (e.type === "result") {
    const u = e.usage || {};
    s.tokens = {
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    };
    if (typeof e.total_cost_usd === "number") s.costUsd = e.total_cost_usd;
    s.exact = true;
    s.sessionId = e.session_id || s.sessionId;
    if (e.is_error) s.error = shortText(e.result || e.subtype);
  } else if (e.type === "rate_limit_event") {
    s.limits = claudeLimits(e.rate_limit_info);
  }
}

// One relay event's part in the shell commands a session ran (events.mjs, commandRuns): each Bash
// call, with its exit code from its result ("Exit code N" on failure), or, for a background
// command, from its task notification. `s` is { runs, byId }.
export function claudeCommandEvent(s, e) {
  if (e.type === "assistant") {
    for (const b of e.message?.content || []) {
      if (b.type !== "tool_use" || b.name !== "Bash" || s.byId.has(b.id)) continue;
      const run = { cmd: String(b.input?.command ?? ""), atMs: Date.parse(e.timestamp || "") || null, exitCode: null, background: Boolean(b.input?.run_in_background) };
      s.byId.set(b.id, run);
      s.runs.push(run);
    }
  } else if (e.type === "user" && Array.isArray(e.message?.content)) {
    for (const b of e.message.content) {
      const run = b.type === "tool_result" ? s.byId.get(b.tool_use_id) : null;
      if (!run) continue;
      const text = Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : String(b.content ?? "");
      if (b.is_error) {
        const code = /^(?:Error: )?Exit code (\d+)/.exec(text);
        if (code) run.exitCode = Number(code[1]);
        else if (/^(?:Error: )?Permission to use [\s\S]* has been denied/.test(text)) run.denied = true;
      } else if (run.background || e.tool_use_result?.backgroundTaskId) {
        run.background = true; // its exit code comes with its task notification
      } else if (!e.tool_use_result?.interrupted) {
        run.exitCode = 0;
      }
    }
  } else if (e.type === "system" && e.subtype === "permission_denied") {
    const run = s.byId.get(e.tool_use_id);
    if (run) run.denied = true;
  } else if (e.type === "system" && e.subtype === "task_notification") {
    const run = s.byId.get(e.tool_use_id);
    const code = /exit code (\d+)/i.exec(e.summary || "");
    if (run) run.exitCode = code ? Number(code[1]) : e.status === "completed" ? 0 : null;
  }
}

// One relay event's part in stuck detection (events.mjs, addAction): each Bash call with its exit
// code, and each successful Edit, Write, MultiEdit or NotebookEdit. An exit code comes only from the
// first line of an error result ("Exit code N" or "Error: Exit code N"); a successful result exits 0,
// unless it ran in the background or was interrupted. A call its permissions denied never ran.
// `t` is the summary's tracker: start(id, call), finish(id) returning the call, and act(action).
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DENIED = /^(?:Error: )?Permission to use [\s\S]* has been denied/;
export function claudeActionEvent(e, t) {
  const ms = Date.parse(e.timestamp || "") || null;
  const sub = Boolean(e.parent_tool_use_id);
  if (e.type === "assistant") {
    for (const b of e.message?.content || []) {
      if (b.type !== "tool_use" || !b.id) continue;
      if (b.name === "Bash") t.start(b.id, { command: String(b.input?.command ?? ""), background: Boolean(b.input?.run_in_background), sub });
      else if (EDIT_TOOLS.has(b.name)) t.start(b.id, { edit: true });
    }
  } else if (e.type === "user" && Array.isArray(e.message?.content)) {
    for (const b of e.message.content) {
      const call = b.type === "tool_result" && b.tool_use_id ? t.finish(b.tool_use_id) : null;
      if (!call) continue;
      if (call.edit) {
        if (!b.is_error) t.act({ edit: true, ms });
        continue;
      }
      const text = Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : String(b.content ?? "");
      if (b.is_error && DENIED.test(text)) continue;
      // A background run has not finished yet, and an interrupted one did not finish.
      const unsettled = !b.is_error && Boolean(call.background || e.tool_use_result?.backgroundTaskId || e.tool_use_result?.interrupted);
      const code = b.is_error ? /^(?:Error: )?Exit code (\d+)\b/.exec(text.split("\n", 1)[0]) : null;
      const exitCode = code ? Number(code[1]) : b.is_error || unsettled ? null : 0;
      t.act({ command: call.command, exitCode, interrupted: unsettled, output: text, sub: call.sub || sub, ms });
    }
  } else if (e.type === "system" && e.subtype === "permission_denied" && e.tool_use_id) {
    t.finish(e.tool_use_id);
  }
}

// Most of a Claude Code transcript is copies of each model request. A line whose first key is its
// type can be judged without parsing it; the rest are parsed. Returns true when a line is done.
const CLAUDE_SKIPPED = new Set(["api-request-blob", "api-request-shape", "file-history-snapshot", "file-history-delta", "mode", "permission-mode", "atis-latch", "last-prompt", "ai-title", "cost-state", "queue-operation", "pr-link"]);
export function claudeLineShortcut(s, line) {
  const type = /^\{"type":"([^"]+)"/.exec(line)?.[1];
  if (type === "api-request") s.busy = true; // the session sent a model request: a turn is open
  return type === "api-request" || CLAUDE_SKIPPED.has(type);
}
