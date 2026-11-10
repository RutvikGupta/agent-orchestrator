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

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { GRACE_MS, endGroup, processStart, readGroup, writeGroup } from "./lib/command-group.mjs";

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
function onExit(code, signal) {
  exited = true;
  clearTimeout(killTimer);
  const left = endGroup(child.pid, GRACE_MS);
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
  poll = setInterval(() => readOutput(), POLL_MS);
  if (timeoutMs) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopCommand();
    }, timeoutMs);
  }
}
