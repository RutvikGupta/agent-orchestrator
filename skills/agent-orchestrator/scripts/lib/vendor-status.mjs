// Supported status readers. Row builders are synchronous, so each refresh is bounded and
// cached (including failures). Unknown or unreported sessions must use their transcripts.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const CACHE_MS = 5000;
const TIMEOUT_MS = 1900;
const MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map();
const self = fileURLToPath(import.meta.url);

// The dashboard server answers every request from one thread, so a status command must not
// block it. Its first read waits (the server makes it while starting, before it takes requests);
// after that, a refresh runs in the background and rows keep the last answer until the new one
// lands. One-shot commands such as `status` always wait for the answer.
let background = false;
export function readVendorStatusInBackground() {
  background = true;
}

// `command(bin)` names the command to run ({ cmd, args }); `parse` turns its JSON output into
// the status map. A failure caches null, so rows fall back to their transcripts.
function cached(agent, command, parse) {
  const bin = process.env[`AGENT_ORCH_${agent.toUpperCase()}_BIN`] || agent;
  const key = JSON.stringify([agent, bin, process.env.HOME, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < CACHE_MS) return previous.value;
  if (background && previous) {
    if (previous.pending) return previous.value;
    const value = previous.value;
    let spec;
    try { spec = command(bin); } catch { cache.set(key, { at: Date.now(), value: null }); return value; }
    cache.set(key, { at: previous.at, value, pending: true });
    jsonCommandAsync(spec.cmd, spec.args, (output) => {
      let next = null;
      try { next = output == null ? null : parse(output); } catch { /* invalid output */ }
      cache.set(key, { at: Date.now(), value: next });
    });
    return value;
  }
  let value = null;
  try {
    const spec = command(bin);
    value = parse(jsonCommand(spec.cmd, spec.args));
  } catch { /* unsupported command, missing binary, or invalid output */ }
  cache.set(key, { at: Date.now(), value });
  return value;
}

function jsonCommand(bin, args) {
  const result = spawnSync(bin, args, {
    encoding: "utf8", timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) throw new Error("vendor status unavailable");
  return JSON.parse(result.stdout);
}

// jsonCommand without blocking: `done` gets the parsed output, or null on any failure.
function jsonCommandAsync(bin, args, done) {
  let child, out = "", size = 0, finished = false;
  const finish = (value) => { if (!finished) { finished = true; clearTimeout(timer); done(value); } };
  const timer = setTimeout(() => { child?.kill("SIGKILL"); finish(null); }, TIMEOUT_MS);
  timer.unref?.();
  try {
    child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return finish(null);
  }
  child.on("error", () => finish(null));
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BYTES) { child.kill("SIGKILL"); return finish(null); }
    out += chunk;
  });
  child.on("close", (code) => {
    if (code !== 0) return finish(null);
    try { finish(JSON.parse(out)); } catch { finish(null); }
  });
}

export function claudeSessions() {
  return cached("claude", (bin) => ({ cmd: bin, args: ["agents", "--json", "--all"] }), (sessions) => {
    if (!Array.isArray(sessions)) return null;
    const result = new Map();
    for (const session of sessions) {
      if (!session || typeof session.sessionId !== "string") continue;
      // Background state describes the whole job; an idle process may still be working
      // between loop iterations. A live waiting prompt always needs attention.
      const waiting = session.status === "waiting" || session.state === "blocked";
      const state = waiting ? "needs-decision"
        : ({ working: "running", done: "completed", failed: "failed", stopped: "stopped" })[session.state]
          || ({ busy: "running", idle: "idle" })[session.status];
      if (!state) continue;
      result.set(session.sessionId, { state, waiting, waitingFor: session.waitingFor || null,
        cwd: session.cwd || null, model: session.model || null });
    }
    return result;
  });
}

export function codexThreads() {
  // Live state belongs to the server that owns the session. Keep this opt-in: other
  // app servers and standalone exec tasks still need transcript-based status.
  if (process.env.AGENT_ORCH_CODEX_APP_SERVER !== "1") return null;
  return cached("codex", () => {
    // Resolve the daemon's symlink as well as checking existence. Its target can be
    // shorter than CODEX_HOME, which matters for the Unix socket path length limit.
    const socketPath = fs.realpathSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "app-server-control", "app-server-control.sock"));
    return { cmd: process.execPath, args: [self, "--read-codex-status", socketPath] };
  }, (threads) => {
    if (!Array.isArray(threads)) return null;
    const result = new Map();
    for (const thread of threads) {
      if (!thread || typeof thread.id !== "string") continue;
      const status = thread.status;
      const waiting = status?.type === "active" && (status.activeFlags || []).some((flag) =>
        flag === "waitingOnApproval" || flag === "waitingOnUserInput");
      const state = waiting ? "needs-decision"
        : ({ active: "running", idle: "idle", systemError: "failed" })[status?.type];
      if (!state) continue; // notLoaded is absence of runtime knowledge, never stopped
      result.set(thread.id, { state, waiting, waitingFor: waiting ? status.activeFlags.join(", ") : null,
        cwd: thread.cwd || null, model: thread.model || null });
    }
    return result;
  });
}

// The synchronous row builder uses a short-lived Node helper, never a new Codex
// server. Unix app-server sockets use WebSocket text frames after HTTP Upgrade.
// Each refresh disconnects: metadata reads do not subscribe, so retaining a socket
// would add lifecycle work without improving the five-second snapshot cache.
async function readCodex(socketPath) {
  const pending = new Map();
  let serial = 0, buffer = Buffer.alloc(0), bytes = 0, failed = false;
  let socket, upgradeReject, fragments = null;
  const key = randomBytes(16).toString("base64");
  const upgrade = http.request({ socketPath, path: "/", headers: {
    Host: "localhost", Connection: "Upgrade", Upgrade: "websocket",
    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
  } });
  const fail = () => {
    failed = true;
    const error = new Error("Codex status unavailable");
    upgradeReject?.(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    upgrade.destroy();
    socket?.destroy();
  };
  // Leave startup and reaping headroom inside the caller's 1900ms deadline.
  const timer = setTimeout(fail, 1600);
  process.once("SIGTERM", fail);
  upgrade.on("error", fail);
  upgrade.on("response", fail);

  // Client frames must be masked, even on a local Unix socket (RFC 6455).
  const send = (payload, opcode = 1) => {
    if (failed) throw new Error("Codex connection closed");
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    const prefix = data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10;
    const frame = Buffer.alloc(prefix + 4 + data.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (prefix === 2 ? data.length : prefix === 4 ? 126 : 127);
    if (prefix === 4) frame.writeUInt16BE(data.length, 2);
    if (prefix === 10) frame.writeBigUInt64BE(BigInt(data.length), 2);
    const mask = randomBytes(4);
    mask.copy(frame, prefix);
    for (let i = 0; i < data.length; i++) frame[prefix + 4 + i] = data[i] ^ mask[i % 4];
    socket.write(frame);
  };
  const message = (data) => {
    const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Invalid reply");
    const request = pending.get(reply.id);
    if (!request) return; // notifications do not change this metadata snapshot
    pending.delete(reply.id);
    if (reply.error || !reply.result || typeof reply.result !== "object")
      request.reject(new Error("Codex request failed"));
    else request.resolve(reply.result);
  };
  const receive = (chunk) => {
    try {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error("Codex response too large");
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0], second = buffer[1], opcode = first & 15, final = Boolean(first & 128);
        if ((first & 112) || (second & 128)) throw new Error("Invalid server frame");
        let size = second & 127, offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2); offset = 4;
        } else if (size === 127) {
          if (buffer.length < 10) return;
          const large = buffer.readBigUInt64BE(2);
          if (large > BigInt(MAX_BYTES)) throw new Error("Codex frame too large");
          size = Number(large); offset = 10;
        }
        if (size > MAX_BYTES || (opcode >= 8 && (!final || size > 125))) throw new Error("Invalid frame size");
        if (buffer.length < offset + size) return;
        const data = buffer.subarray(offset, offset + size);
        buffer = buffer.subarray(offset + size);
        if (opcode === 8) return fail();
        if (opcode === 9) { send(data, 10); continue; }
        if (opcode === 10) continue;
        if (opcode === 1 && fragments === null) fragments = [data];
        else if (opcode === 0 && fragments !== null) fragments.push(data);
        else throw new Error("Invalid text frame");
        if (final) { const complete = Buffer.concat(fragments); fragments = null; message(complete); }
      }
    } catch { fail(); }
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failed) return reject(new Error("Codex connection closed"));
    const id = ++serial;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  try {
    await new Promise((resolve, reject) => {
      upgradeReject = reject;
      upgrade.once("upgrade", (response, stream, head) => {
        socket = stream;
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== "websocket"
          || response.headers["sec-websocket-accept"] !== accept
          || response.headers["sec-websocket-extensions"] || response.headers["sec-websocket-protocol"]) return fail();
        socket.on("error", fail).on("close", fail).on("end", fail).on("data", receive);
        if (head.length) receive(head);
        resolve();
      });
      upgrade.end();
    });
    upgradeReject = null;
    await request("initialize", { clientInfo: { name: "agent_orchestrator_status", version: "1" } });
    send({ method: "initialized" });
    const threads = [], seen = new Set();
    let cursor = null;
    do {
      const page = await request("thread/loaded/list", { cursor, limit: 100 });
      if (!Array.isArray(page.data)) throw new Error("Invalid loaded thread list");
      for (const id of page.data) {
        if (typeof id !== "string") throw new Error("Invalid thread id");
        const result = await request("thread/read", { threadId: id, includeTurns: false });
        const thread = result.thread;
        if (thread?.id !== id || typeof thread.status?.type !== "string"
          || (thread.status.type === "active" && (!Array.isArray(thread.status.activeFlags)
            || thread.status.activeFlags.some((flag) => typeof flag !== "string")))) throw new Error("Invalid thread status");
        threads.push(thread);
      }
      cursor = page.nextCursor;
      if (cursor != null && typeof cursor !== "string") throw new Error("Invalid pagination cursor");
      if (cursor && seen.has(cursor)) throw new Error("Repeated pagination cursor");
      seen.add(cursor);
    } while (cursor);
    return threads;
  } finally {
    clearTimeout(timer);
    fail(); // disconnect only; never stop the daemon or change any thread
    process.removeListener("SIGTERM", fail);
  }
}

if (process.argv[1] === self && process.argv[2] === "--read-codex-status") {
  try { process.stdout.write(JSON.stringify(await readCodex(process.argv[3]))); }
  catch { process.stdout.write("null"); }
}
