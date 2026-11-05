// Codex event and rollout parsing: the relay's `codex exec --json` events, and Codex's own session
// logs (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl), which also hold its sub-agents.

import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME } from "./config.mjs";
import { relPath, shortText, unwrapShell } from "./format.mjs";

export function applyCodexEvent(s, e, cwd) {
  if (e.type === "thread.started") {
    s.sessionId = e.thread_id || s.sessionId;
  } else if (e.type?.startsWith("item.") && e.item) {
    const it = e.item;
    const done = e.type === "item.completed";
    const counted = ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(it.type);
    if (done && counted && !s.seen.has(it.id)) {
      s.seen.add(it.id);
      s.steps += 1;
    }
    if (it.type === "command_execution") s.activity = `$ ${shortText(unwrapShell(it.command))}`;
    else if (it.type === "file_change") s.activity = `edit ${(it.changes || []).map((c) => relPath(c.path, cwd)).join(", ")}`;
    else if (it.type === "agent_message" && it.text) s.activity = `says: ${shortText(it.text, 50)}`;
    else if (it.type === "reasoning") s.activity = "thinking";
    else if (it.type === "web_search") s.activity = `search ${shortText(it.query, 40)}`;
    else if (it.type === "mcp_tool_call") s.activity = `${it.server}.${it.tool}`;
    else if (it.type === "todo_list") s.activity = "planning";
    else if (it.type === "error") s.error = shortText(it.message);
  } else if (e.type === "turn.completed" && e.usage) {
    s.tokens.input += e.usage.input_tokens || 0;
    s.tokens.cached += e.usage.cached_input_tokens || 0;
    s.tokens.output += e.usage.output_tokens || 0;
    s.exact = true;
  } else if (e.type === "turn.failed" || e.type === "error") {
    s.error = shortText(e.error?.message || e.message);
  }
}

// One relay event's part in the shell commands a session ran (events.mjs, commandRuns): each
// command_execution item, with the exit code its completion reports. `s` is { runs, byId }.
export function codexCommandEvent(s, e) {
  const it = e.item;
  if (!e.type?.startsWith("item.") || it?.type !== "command_execution") return;
  let run = s.byId.get(it.id);
  if (!run || run.done) {
    run = { cmd: String(it.command ?? ""), atMs: Date.parse(e.timestamp || "") || null, exitCode: null };
    s.byId.set(it.id, run);
    s.runs.push(run);
  }
  if (e.type === "item.completed") {
    run.done = true;
    if (it.status === "declined") run.denied = true;
    if (typeof it.exit_code === "number") run.exitCode = it.exit_code;
  }
}

// One relay event's part in stuck detection (events.mjs, addAction): each completed command, with
// its exit code, or failed without one, and each file change that completed. A declined command
// never ran. A completion is counted once: one that no started event announced is skipped when the
// ring already holds its item. `t` is the summary's tracker, as for claudeActionEvent.
export function codexActionEvent(e, t) {
  const it = e.item;
  if (!e.type?.startsWith("item.") || !it?.id || !["command_execution", "file_change"].includes(it.type)) return;
  if (e.type === "item.started") t.start(it.id, { started: true });
  if (e.type !== "item.completed" || !(t.finish(it.id) || !t.seen(it.id))) return;
  const ms = Date.parse(e.timestamp || "") || null;
  if (it.type === "file_change") {
    if ((it.status ?? "completed") === "completed") t.act({ id: it.id, edit: true, ms });
  } else if (it.status !== "declined") {
    const exitCode = typeof it.exit_code === "number" ? it.exit_code : null;
    t.act({ id: it.id, command: String(it.command ?? ""), exitCode, failed: it.status === "failed", ok: it.status === "completed", output: it.aggregated_output, ms });
  }
}

export function applyCodexRolloutEvent(s, e) {
  const p = e.payload || {};
  if (e.timestamp) s.lastAt = e.timestamp;
  if (e.type === "turn_context") {
    s.model = p.model || s.model;
    s.effort = p.effort || s.effort;
  } else if (p.type === "token_count" && p.info?.total_token_usage) {
    const u = p.info.total_token_usage;
    s.tokens = { input: u.input_tokens || 0, cached: u.cached_input_tokens || 0, output: u.output_tokens || 0 };
    s.exact = true;
  } else if (p.type === "task_started") {
    s.busy = true;
  } else if (p.type === "task_complete" || p.type === "turn_aborted") {
    s.busy = false;
  } else if (p.type === "item_completed" && p.item) {
    const it = p.item;
    if (it.type === "CommandExecution") {
      s.steps += 1;
      s.activity = `$ ${shortText(Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command)}`;
    } else if (it.type === "FileChange") {
      s.steps += 1;
      s.activity = `edit ${Object.keys(it.changes || {}).map((f) => path.basename(f)).join(", ")}`;
    } else if (it.type === "McpToolCall" || it.type === "Extension") {
      s.steps += 1;
      s.activity = it.type === "McpToolCall" ? `${it.server}.${it.tool}` : `${it.kind} ${shortText(it.query, 40)}`;
    } else if (it.type === "AgentMessage") {
      const text = (it.content || []).map((c) => c.text || "").join("\n").trim();
      if (text) {
        s.activity = `says: ${shortText(text, 50)}`;
        s.lastMessage = text;
      }
    } else if (it.type === "Reasoning") {
      s.activity = "thinking";
    }
  }
}

const codexMetaCache = new Map(); // rollout path -> its session_meta payload, which never changes

function firstJsonLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    for (let pos = 0, total = 0; total < 8 * 1024 * 1024; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      if (nl !== -1) break;
      pos += n;
      total += n;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// A rollout Codex has just created may not hold its first line yet, so only a found one is cached.
export function codexMeta(file) {
  if (codexMetaCache.has(file)) return codexMetaCache.get(file);
  const meta = firstJsonLine(file)?.payload || null;
  if (meta) codexMetaCache.set(file, meta);
  return meta;
}

// Every rollout file with its day (YYYYMMDD). One dashboard build asks several times, so the
// listing is kept for a second; after that, a folder is listed again only once it has changed
// (a folder's mtime moves when an entry is added or removed), so a refresh mostly just stats.
const ROLLOUT_LISTING_MS = 1000;
let rolloutListing = { at: 0, root: null, files: [] };
const folderNames = new Map(); // folder -> { mtimeMs, names }
function namesIn(dir) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    folderNames.delete(dir);
    return [];
  }
  const known = folderNames.get(dir);
  if (known?.mtimeMs === mtimeMs) return known.names;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  folderNames.set(dir, { mtimeMs, names });
  return names;
}
function allRollouts() {
  const root = path.join(CODEX_HOME, "sessions");
  if (rolloutListing.root === root && Date.now() - rolloutListing.at < ROLLOUT_LISTING_MS) return rolloutListing.files;
  const sub = (dir) => namesIn(dir).filter((n) => /^\d+$/.test(n));
  const files = [];
  for (const y of sub(root)) {
    for (const m of sub(path.join(root, y))) {
      for (const day of sub(path.join(root, y, m))) {
        const dir = path.join(root, y, m, day);
        for (const n of namesIn(dir)) if (n.endsWith(".jsonl")) files.push({ day: `${y}${m}${day}`, file: path.join(dir, n) });
      }
    }
  }
  rolloutListing = { at: Date.now(), root, files };
  return files;
}

export function codexRolloutsSince(sinceMs) {
  const d = new Date(sinceMs);
  const since = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return allRollouts().filter((r) => r.day >= since).map((r) => r.file);
}

// The rollout file of Codex thread `id` (cached once found: a thread keeps its file).
const rolloutFiles = new Map();
export function codexRolloutFor(id, sinceMs) {
  if (rolloutFiles.has(id)) return rolloutFiles.get(id);
  const file = codexRolloutsSince(Math.min(sinceMs, codexThreadStart(id) || sinceMs)).find((f) => f.endsWith(`-${id}.jsonl`)) || null;
  if (file) rolloutFiles.set(id, file);
  return file;
}

// Start time of a Codex thread, from its own rollout file (cached; the name never changes).
const codexStartCache = new Map();
export function codexThreadStart(threadId) {
  if (codexStartCache.has(threadId)) return codexStartCache.get(threadId);
  const file = codexRolloutsSince(0).find((f) => f.endsWith(`-${threadId}.jsonl`));
  const started = file ? Date.parse(codexMeta(file)?.timestamp || "") || fs.statSync(file).birthtimeMs : null;
  if (started) codexStartCache.set(threadId, started);
  return started;
}
