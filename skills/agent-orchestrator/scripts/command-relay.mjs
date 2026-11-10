#!/usr/bin/env node
// The relay of a command task (`orch.mjs start RUN TASK --agent command -- COMMAND [ARG...]`): it
// runs one command, with no model, and writes the files a delegate relay writes, so that every
// reader of a task (status, wait, result, log, the finish notice, the dashboard) works on it as is.
//
// Usage: node command-relay.mjs --out-dir DIR [--cd DIR] [--done MARKER] [--timeout DUR] -- COMMAND [ARG...]
//
// The command runs as an argument vector, with no shell, in DIR, with this process's environment
// (`start` gives it the AGENT_ORCH_* variables a relay's agent gets, so agents it starts are linked
// to the task). It leads its own process group, which is recorded in command-group.json
// (lib/command-group.mjs), and its stdout and stderr both go straight to relay.log, which keeps the
// full output. This relay reads that file as it grows, a chunk at a time, and writes:
//
// - events.jsonl: a `command.started` event, then the output lines in events of at most 200 lines
//   or 64 KB, written while it reads. A line longer than 4 KB is cut there and marked truncated.
//   An event has the shape of a Claude tool result, so the dashboard's event log shows the output;
//   `start` and `steer` never mistake it for a shell command of an agent.
// - result.json: `status` (completed, failed, timeout or aborted), `exitCode`, `signal`, `error`
//   when it did not complete, the last 40 lines of output as `finalMessage`, and `leftover`: how
//   many processes the command left running in its group.
//
// With --done, a run whose output never printed MARKER fails, even when it exits 0; the marker is
// found wherever it falls in the output. With --timeout, the command is stopped after DUR. SIGTERM,
// SIGINT or SIGHUP (from `stop` or `close`) stops the command's process group: SIGTERM, then
// SIGKILL after 5 seconds. When the command exits, whatever it left running in its group is ended
// the same way before the result is written. Exit codes: 2 for a usage error, before result.json;
// otherwise 0 when completed, else the command's exit code (or 1).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendExternalRecord, headlessKind, externalLauncher, externalAgentLabel, GRACE_MS, endGroup, processStart, readGroup, writeGroup } from "./lib/command-group.mjs";

const SCHEMA = "orch-command.result.v1";
const TAIL_LINES = 40; // lines of output kept as the final message
const POLL_MS = 500; // how often new output is read into events.jsonl
const READ_CHUNK = 256 * 1024; // bytes of relay.log read at a time
const MAX_LINE = 4096; // characters of one line kept in an event or the final message
const KEEP_RAW = 2 * MAX_LINE; // characters of a line kept before color codes are removed
const MAX_BATCH = 200; // lines per output event
const MAX_EVENT_CHARS = 64 * 1024; // characters of output per event

function usage(message) {
  process.stderr.write(`command-relay: ${message}\nusage: node command-relay.mjs --out-dir DIR [--cd DIR] [--done MARKER] [--timeout DUR] -- COMMAND [ARG...]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { outDir: null, cd: process.cwd(), done: null, timeout: null, command: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      opts.command = argv.slice(i + 1);
      break;
    }
    const value = () => (i + 1 < argv.length ? argv[++i] : usage(`${arg} needs a value`));
    if (arg === "--out-dir") opts.outDir = value();
    else if (arg === "--cd") opts.cd = value();
    else if (arg === "--done") opts.done = value();
    else if (arg === "--timeout") opts.timeout = value();
    else usage(`unknown option ${arg}`);
  }
  if (!opts.outDir) usage("--out-dir is required");
  if (!opts.command.length || !opts.command[0]) usage("no command after --");
  if (opts.done === "") usage("--done needs a marker");
  return opts;
}

function durationMs(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!m) usage(`bad --timeout "${text}" (use e.g. 90s, 10m, 2h)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"];
}

// Terminal control sequences (colors, cursor moves) say nothing in a log line; a carriage return
// redraws the line, so only the text after the last one is what a terminal would show.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const clean = (line) => {
  const text = line.replace(/\r+$/, "");
  return text.slice(text.lastIndexOf("\r") + 1).replace(ANSI, "");
};

const opts = parseArgs(process.argv.slice(2));
const timeoutMs = opts.timeout ? durationMs(opts.timeout) : 0;
const outDir = path.resolve(opts.outDir);
const cwd = path.resolve(opts.cd);
fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, "relay.log");
const eventsPath = path.join(outDir, "events.jsonl");
const resultPath = path.join(outDir, "result.json");
const startedAt = new Date().toISOString();

// Poll the process group for direct evidence and recover short runs from durable session files.
// Guesses stay within the command folder or an observed agent folder, and never override a known owner. File notifications
// also find quick resumes whose rollout still lives in an older date folder.
function commandAgents() {
  const claude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const codex = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const state = process.env.AGENT_ORCH_HOME || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agent-orchestrator");
  const file = path.join(state, "external.jsonl");
  const since = Date.parse(startedAt);
  const launchedCommand = opts.command.join(" ");
  const launchedKind = headlessKind(launchedCommand);
  const directResume = launchedKind === "codex" && opts.command[opts.command.indexOf("exec") + 1] === "resume";
  const known = new Map(), saved = new Map(), pending = new Map(), headers = new Map();
  const directories = new Set();
  const excluded = new Set(), changed = new Set(), watchers = new Map();
  let live = new Map(), members = new Set(), blockedCodex = new Set();
  let safeCodex = true, lastFiles = 0, warned = false;
  function real(dir) { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } }
  function json(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
  function addDirectory(dir) {
    if (!dir) return;
    const resolved = real(dir);
    if (resolved !== path.parse(resolved).root && resolved !== real(os.homedir())) directories.add(resolved);
  }
  addDirectory(cwd);
  const commandRoot = directories.has(real(cwd)) ? real(cwd) : null;
  function accepts(dir) {
    if (!dir) return false;
    const resolved = real(dir);
    return directories.has(resolved) || Boolean(commandRoot && resolved.startsWith(commandRoot + path.sep));
  }
  const roots = [path.join(claude, "projects"), path.join(codex, "sessions")];
  function watch() {
    for (const root of roots) {
      if (watchers.has(root)) continue;
      try {
        const watcher = fs.watch(root, { recursive: true, persistent: false }, (_, name) => {
          if (name && String(name).endsWith(".jsonl")) changed.add(path.join(root, String(name)));
        });
        watcher.on("error", () => { watcher.close(); watchers.delete(root); });
        watchers.set(root, watcher);
      } catch {} // The first invocation of a CLI may create its session directory later.
    }
  }
  watch();
  function list(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.jsonl?$/.test(e.name)).map((e) => path.join(dir, e.name)); }
    catch { return []; }
  }
  // Search each new chunk once and retain partial lines between polls. Once found, a session
  // header is immutable across appended turns, so later polls need not reread its large prompt.
  function header(file, agent) {
    let fd;
    try {
      let h = headers.get(file);
      if (h?.value) return h.value;
      const stat = fs.statSync(file);
      if (!h || h.ino !== stat.ino || stat.size < h.offset) {
        h = { ino: stat.ino, offset: 0, parts: [], value: null };
        headers.set(file, h);
      }
      const initialOffset = h.offset;
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(64 * 1024);
      const parse = () => {
        try {
          const e = JSON.parse(Buffer.concat(h.parts).toString("utf8"));
          if (agent === "codex" && e.type === "session_meta") h.value = e.payload;
          if (agent === "claude" && e.cwd && e.timestamp && !e.isSidechain) h.value = e;
        } catch {}
      };
      while (h.offset < Math.min(stat.size, 8 * 1024 * 1024)) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, stat.size - h.offset, 8 * 1024 * 1024 - h.offset), h.offset);
        if (!n) break;
        h.offset += n;
        const chunk = buf.subarray(0, n);
        let from = 0, end;
        while ((end = chunk.indexOf(10, from)) !== -1) {
          h.parts.push(Buffer.from(chunk.subarray(from, end)));
          parse();
          if (h.value) { h.parts = []; return h.value; }
          h.parts = [];
          from = end + 1;
        }
        if (from < n) h.parts.push(Buffer.from(chunk.subarray(from, n)));
      }
      // A complete final JSON value can have no newline. Keep an incomplete value for a later append.
      if (h.parts.length && h.offset === stat.size && h.offset > initialOffset) parse();
      if (h.value) h.parts = [];
      return h.value;
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
    return null;
  }
  function recent(file) {
    try { return fs.statSync(file).mtimeMs >= since; } catch { return false; }
  }
  function record(agent, sessionId, meta, transcript, observed = null) {
    const key = `${agent}:${sessionId}`;
    const startedMs = Number(meta.startedAt) || Date.parse(meta.timestamp);
    if (!sessionId || !Number.isFinite(startedMs)) return;
    if (!observed) {
      if (excluded.has(key) || !accepts(meta.cwd)) return;
      if (agent === "codex" && (!safeCodex || blockedCodex.has(real(meta.cwd)))) return;
      // Resumes retain the first session header. A changed transcript proves activity in this
      // invocation's window even though the original session started earlier.
      if (startedMs > Date.now() || startedMs < since && !(transcript && recent(transcript))) return;
    }
    if (observed && live.has(observed.pid) && !members.has(observed.pid)) return;
    const command = observed?.command?.slice(0, 300) || (launchedKind === agent ? launchedCommand.slice(0, 300) : agent === "claude" ? "claude -p" : "codex exec");
    const r = {
      key, agent, sessionId, file: transcript, cwd: meta.cwd || observed?.cwd || cwd,
      // Only a live group observation confers ownership. A leftover PID file is a guess too.
      pid: observed?.pid || null, command, startedMs, seenMs: Date.now(),
      ...externalAgentLabel(agent, command, observed?.via || null),
      parent: { run: process.env.AGENT_ORCH_RUN || null, task: process.env.AGENT_ORCH_TASK || null,
        claude: process.env.CLAUDE_CODE_SESSION_ID || null, codex: process.env.CODEX_THREAD_ID || null, nearest: null },
    };
    const prior = saved.get(key);
    if (prior && (!observed || prior.pid === r.pid && prior.file === transcript)) return;
    if (appendExternalRecord(file, r) !== false) { saved.set(key, r); pending.delete(key); }
    else pending.set(key, r);
  }
  const isCodex = (command) => command.split(/\s+/).slice(0, 2).some((w) => /^codex(\.js|-(aarch64|x86_64|arm64)\S*)?$/.test(path.basename(w)));
  function processes(pgid, checkOutside = false) {
    const r = spawnSync("ps", ["-Aww", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 16 << 20 });
    if (r.error || r.status !== 0) { safeCodex = false; return false; }
    live = new Map(); members = new Set(); blockedCodex = new Set();
    for (const line of r.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const row = { pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] };
      live.set(row.pid, row);
      if (row.pgid === pgid) members.add(row.pid);
    }
    for (const [pid, row] of known) {
      const now = live.get(pid);
      if (now && (!members.has(pid) || now.command !== row.command)) known.delete(pid);
    }
    const outside = checkOutside ? [...live.values()].filter((r) => !members.has(r.pid) && isCodex(r.command) && (directResume || headlessKind(r.command) === "codex")) : [];
    const agents = [...members].filter((pid) => headlessKind(live.get(pid).command));
    const pids = new Set([...agents, ...outside.map((r) => r.pid)]);
    for (const row of live.values()) if (agents.includes(row.ppid) || outside.some((p) => p.pid === row.ppid)) pids.add(row.pid);
    safeCodex = true;
    if (pids.size) {
      const open = spawnSync("lsof", ["-nP", "-Fpcfn", "-p", [...pids].join(",")], { encoding: "utf8", timeout: 5000, maxBuffer: 16 << 20 });
      safeCodex = !open.error && (open.status === 0 || open.status === 1);
      if (safeCodex) {
        let row, descriptor;
        for (const line of (open.stdout || "").split("\n")) {
          if (line[0] === "p") row = live.get(Number(line.slice(1)));
          else if (line[0] === "f") descriptor = line.slice(1);
          else if (line[0] === "n" && row && pids.has(row.pid)) {
            if (descriptor === "cwd") row.cwd = line.slice(1);
            else if (/[/\\]rollout-[^/\\]*\.jsonl$/.test(line)) row.rollout = line.slice(1);
          }
        }
      }
    }
    for (const row of live.values()) {
      if (!pids.has(row.pid)) continue;
      try { row.cwd ||= fs.readlinkSync(`/proc/${row.pid}/cwd`); } catch {}
      row.rollout ||= [...live.values()].find((p) => p.ppid === row.pid && p.rollout)?.rollout;
      if (!members.has(row.pid) && (isCodex(row.command) || outside.some((p) => p.pid === row.ppid))) {
        // Other Codex homes cannot own a candidate in this relay's sessions folder.
        if (row.rollout && !real(row.rollout).startsWith(real(path.join(codex, "sessions")) + path.sep)) continue;
        const meta = row.rollout && header(row.rollout, "codex");
        if (meta?.id) excluded.add(`codex:${meta.id}`);
        else if (outside.some((p) => p.pid === row.pid) && row.cwd) blockedCodex.add(real(row.cwd));
      }
    }
    const group = new Map([...live].filter(([pid]) => members.has(pid)));
    for (const [pid, row] of group) {
      const agent = headlessKind(row.command);
      if (!agent) continue;
      addDirectory(row.cwd);
      if (headlessKind(live.get(row.ppid)?.command || "") === agent) continue;
      known.set(pid, { ...known.get(pid), ...row, agent, via: externalLauncher(pid, group) });
    }
    return true;
  }
  const capture = (pgid, final = false) => {
    try {
      watch();
      if (!processes(pgid)) return;
      // Inspect all live Claude PID files before any fallback, so a transcript cannot undo an
      // outside-process or interactive-session exclusion made by its PID record.
      const sessions = [];
      for (const f of list(path.join(claude, "sessions"))) {
        const s = json(f);
        if (!s?.sessionId) continue;
        const pid = Number(s.pid || path.basename(f, ".json"));
        if (s.entrypoint === "cli" || live.has(pid) && !members.has(pid)) excluded.add(`claude:${s.sessionId}`);
        else sessions.push({ s, pid });
      }
      for (const { s, pid } of sessions) {
        const observed = known.get(pid);
        if (observed) {
          excluded.delete(`claude:${s.sessionId}`);
          record("claude", s.sessionId, s, null, observed);
        }
      }
      for (const row of known.values()) if (row.agent === "codex" && row.rollout) {
        const m = header(row.rollout, "codex");
        if (m?.id) { excluded.delete(`codex:${m.id}`); record("codex", m.id, m, row.rollout, row); }
      }
      if (!final && Date.now() - lastFiles < 2000) return;
      lastFiles = Date.now();
      const projects = new Set([...directories].map((d) => path.join(claude, "projects", d.replace(/[^A-Za-z0-9]/g, "-"))));
      if (commandRoot) {
        const prefix = commandRoot.replace(/[^A-Za-z0-9]/g, "-");
        try {
          for (const e of fs.readdirSync(path.join(claude, "projects"), { withFileTypes: true })) {
            if (e.isDirectory() && (e.name === prefix || e.name.startsWith(prefix + "-"))) projects.add(path.join(claude, "projects", e.name));
          }
        } catch {}
      }
      const candidates = new Set([...projects].flatMap(list));
      // Codex uses local calendar dates. Include adjacent days for clock and timezone boundaries.
      const day = new Date(since), until = new Date();
      day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - 1);
      until.setHours(0, 0, 0, 0); until.setDate(until.getDate() + 1);
      for (; day <= until; day.setDate(day.getDate() + 1)) {
        const date = [String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")];
        for (const f of list(path.join(codex, "sessions", ...date))) candidates.add(f);
      }
      for (const f of changed) {
        if (f.startsWith(path.join(codex, "sessions") + path.sep) || projects.has(path.dirname(f))) candidates.add(f);
      }
      const recoveries = [];
      for (const f of candidates) {
        if (!recent(f)) continue;
        const agent = f.startsWith(path.join(codex, "sessions") + path.sep) ? "codex" : "claude";
        const m = header(f, agent);
        // An explicitly launched exec resume can append to a session that began interactively.
        const resumedInteractive = directResume && changed.has(f) && m?.source === "cli";
        if (!m || agent === "codex" && m.originator !== "codex_exec" && m.source !== "exec" && !resumedInteractive) continue;
        recoveries.push({ agent, id: agent === "claude" ? m.sessionId || path.basename(f, ".jsonl") : m.id, m, f });
      }
      // The process snapshot at the start of this sweep predates these files. Check owners
      // again after reading candidates: an outsider may have started while lsof was running.
      const pendingPidFiles = sessions.some(({ s, pid }) => !known.has(pid) && accepts(s.cwd) && Number(s.startedAt) >= since);
      if (!recoveries.length && !pendingPidFiles) return;
      if (!processes(pgid, true)) return;
      for (const f of list(path.join(claude, "sessions"))) {
        const s = json(f);
        if (!s?.sessionId) continue;
        const pid = Number(s.pid || path.basename(f, ".json"));
        if (s.entrypoint === "cli" || live.has(pid) && !members.has(pid)) excluded.add(`claude:${s.sessionId}`);
        else record("claude", s.sessionId, s, null, known.get(pid));
      }
      for (const { agent, id, m, f } of recoveries) record(agent, id, m, f);
    } catch (error) {
      if (!warned) fs.appendFileSync(logPath, `\ncommand-relay: could not record an agent: ${error.message}\n`);
      warned = true;
    }
  };
  capture.flush = async (pgid) => {
    const until = Date.now() + 3000;
    // Old-date resumes depend on file notifications, which can arrive after the child exit.
    const awaitingResume = () => directResume && !saved.size;
    while ((pending.size || awaitingResume()) && Date.now() < until) {
      if (awaitingResume() && changed.size) capture(pgid, true);
      for (const [key, record] of pending) {
        if (!record.pid && excluded.has(key)) { pending.delete(key); continue; }
        if (appendExternalRecord(file, record) !== false) { saved.set(key, record); pending.delete(key); }
        if (Date.now() >= until) break;
      }
      if ((pending.size || awaitingResume()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (pending.size) fs.appendFileSync(logPath, `\ncommand-relay: could not record ${pending.size} agent(s): external record lock stayed busy\n`);
  };
  capture.close = () => { for (const w of watchers.values()) w.close(); };
  return capture;
}
const captureAgents = commandAgents();

function writeEvent(event) {
  fs.appendFileSync(eventsPath, `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);
}

function writeResult(fields) {
  const result = {
    schema: SCHEMA,
    tool: "command",
    command: opts.command,
    workdir: cwd,
    done: opts.done,
    timeout: opts.timeout,
    pid: child?.pid ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    eventsPath,
    logPath,
    ...fields,
  };
  const tmp = `${resultPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(tmp, resultPath);
  return result;
}

// The output read so far. `offset` is how far relay.log has been read. The line being read keeps
// its first KEEP_RAW characters (`head`) and its full `length`. `carry` holds the last characters
// read, one fewer than the --done marker has, so a marker split between two reads is still found.
// `batch` holds the lines not yet written as an event, the first of them line `batchFirst`.
const output = {
  offset: 0, decoder: new StringDecoder("utf8"), buf: Buffer.alloc(READ_CHUNK),
  lines: 0, tail: [], doneSeen: false, carry: "",
  head: "", length: 0,
  batch: [], batchChars: 0, batchFirst: 1, batchTruncated: 0,
};

function flushBatch() {
  if (!output.batch.length) return;
  const last = output.batchFirst + output.batch.length - 1;
  writeEvent({
    type: "user",
    command_output: { first: output.batchFirst, last, ...(output.batchTruncated ? { truncated: output.batchTruncated } : {}) },
    message: { role: "user", content: [{ type: "tool_result", content: output.batch.join("\n") }] },
  });
  Object.assign(output, { batch: [], batchChars: 0, batchFirst: last + 1, batchTruncated: 0 });
}

// The line being read is complete: keep it in the tail and the next event, cut to MAX_LINE.
function endLine() {
  const cleaned = clean(output.head);
  const cut = output.length > KEEP_RAW || cleaned.length > MAX_LINE;
  const line = cut ? `${cleaned.slice(0, MAX_LINE)} … [truncated: the line has ${output.length} characters; relay.log has it whole]` : cleaned;
  output.head = "";
  output.length = 0;
  output.lines += 1;
  output.tail.push(line);
  if (output.tail.length > TAIL_LINES) output.tail.shift();
  if (output.batch.length >= MAX_BATCH || output.batchChars + line.length > MAX_EVENT_CHARS) flushBatch();
  output.batch.push(line);
  output.batchChars += line.length + 1;
  if (cut) output.batchTruncated += 1;
}

// Take decoded text from relay.log: look for the marker, and split it into lines.
function feed(text) {
  if (!text) return;
  if (opts.done && !output.doneSeen) {
    const seen = output.carry + text;
    output.doneSeen = seen.includes(opts.done);
    output.carry = output.doneSeen ? "" : seen.slice(seen.length - (opts.done.length - 1));
  }
  for (let at = 0; ;) {
    const nl = text.indexOf("\n", at);
    const end = nl === -1 ? text.length : nl;
    output.length += end - at;
    if (output.head.length < KEEP_RAW) output.head += text.slice(at, Math.min(end, at + KEEP_RAW - output.head.length));
    if (nl === -1) break;
    endLine();
    at = nl + 1;
  }
}

// Read what the command wrote since the last call, a chunk at a time, writing events as batches
// fill; `final` also takes a last line without its newline.
function readOutput(final = false) {
  let fd;
  try {
    fd = fs.openSync(logPath, "r");
    const size = fs.fstatSync(fd).size;
    while (output.offset < size) {
      const n = fs.readSync(fd, output.buf, 0, Math.min(READ_CHUNK, size - output.offset), output.offset);
      if (n <= 0) break;
      output.offset += n;
      feed(output.decoder.write(output.buf.subarray(0, n)));
    }
  } catch {
    // relay.log is gone or unreadable: the result says what is known.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (final) {
    feed(output.decoder.end());
    if (output.length) endLine();
  }
  flushBatch();
}

let child = null;
let exited = false;
let stopSignal = null;
let timedOut = false;
let settled = false;
let poll = null;
let timeoutTimer = null;
let killTimer = null;

// Signal the whole group through its ID. Only while the command runs: until it is reaped, the group
// exists, so its ID cannot belong to anyone else. After that, endGroup() checks each process.
function signalGroup(signal) {
  if (!child?.pid || exited) return;
  try {
    process.kill(-child.pid, signal); // the command leads its own process group
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function stopCommand() {
  signalGroup("SIGTERM");
  if (!killTimer) killTimer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
}

const signalCode = (name) => 128 + (os.constants.signals[name] || 15);

function settle({ code = null, signal = null, error = null, left = null } = {}) {
  if (settled) return;
  settled = true;
  clearInterval(poll);
  clearTimeout(timeoutTimer);
  clearTimeout(killTimer);
  captureAgents.close();
  readOutput(true);
  let exitCode = code ?? (signal ? signalCode(signal) : 1);
  let status = "completed";
  let reason = null;
  if (error) {
    status = "failed";
    exitCode = error.code === "ENOENT" ? 127 : error.code === "EACCES" ? 126 : 1;
    reason = `could not run ${opts.command[0]}: ${error.message}`;
  } else if (stopSignal) {
    status = "aborted";
    exitCode = signalCode(stopSignal);
    reason = `the relay was stopped by ${stopSignal} and ended the command`;
  } else if (timedOut) {
    status = "timeout";
    reason = `the command did not finish within --timeout ${opts.timeout}; the relay stopped it`;
  } else if (exitCode !== 0) {
    status = "failed";
    reason = code === null && signal ? `the command was killed by ${signal}` : `the command exited with code ${exitCode}`;
  } else if (opts.done && !output.doneSeen) {
    status = "failed";
    reason = `the command exited 0 but never printed the done marker "${opts.done}"`;
  }
  const notes = [];
  if (left?.found) notes.push(`command-relay: the command left ${left.found} process${left.found === 1 ? "" : "es"} running in its group; stopped ${left.killed ? `them, ${left.killed} with SIGKILL` : "them with SIGTERM"}`);
  if (reason && status !== "completed") notes.push(`command-relay: ${status}: ${reason}`);
  if (notes.length) fs.appendFileSync(logPath, `\n${notes.join("\n")}\n`);
  writeResult({
    status,
    exitCode,
    signal: stopSignal || signal || null,
    lines: output.lines,
    doneSeen: opts.done ? output.doneSeen : null,
    leftover: left ? left.found : null,
    leftoverKilled: left ? left.killed : null,
    finalMessage: output.tail.join("\n").trim() ? output.tail.join("\n") : "(the command printed nothing)",
    ...(reason ? { error: reason } : {}),
  });
  process.exit(status === "completed" ? 0 : exitCode || 1);
}

// The command has exited: end what it left running in its group, record it, then settle.
async function onExit(code, signal) {
  exited = true;
  clearInterval(poll);
  clearTimeout(timeoutTimer);
  clearTimeout(killTimer);
  captureAgents(child.pid);
  const left = endGroup(child.pid, GRACE_MS);
  // Let pending file notifications identify old-date resumes before the final sweep.
  await new Promise((resolve) => setImmediate(resolve));
  captureAgents(child.pid, true);
  await captureAgents.flush(child.pid);
  captureAgents.close();
  try {
    writeGroup(outDir, { ...readGroup(outDir), endedAt: new Date().toISOString(), leftover: left.found, killed: left.killed, cleared: true, clearedBy: "relay" });
  } catch {}
  settle({ code, signal, left });
}

// Stopping the relay stops the command, which then ends the run as aborted. Once the command has
// exited, its group is already being ended.
for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(name, () => {
    if (settled || exited) return;
    stopSignal ||= name;
    if (child?.pid) stopCommand();
    else settle();
  });
}

let log;
try {
  log = fs.openSync(logPath, "a");
  output.offset = fs.fstatSync(log).size;
  child = spawn(opts.command[0], opts.command.slice(1), { cwd, env: process.env, stdio: ["ignore", log, log], detached: true });
} catch (error) {
  settle({ error });
} finally {
  if (log !== undefined) fs.closeSync(log);
}
child.on("error", (error) => settle({ error }));
child.on("exit", onExit);
if (child.pid) {
  writeGroup(outDir, { pgid: child.pid, leaderStarted: processStart(child.pid), relay: process.pid, recordedAt: new Date().toISOString() });
  writeEvent({ type: "command.started", command: opts.command, cwd, pid: child.pid, done: opts.done, timeout: opts.timeout });
  captureAgents(child.pid);
  poll = setInterval(() => { readOutput(); captureAgents(child.pid); }, POLL_MS);
  if (timeoutMs) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopCommand();
    }, timeoutMs);
  }
}
