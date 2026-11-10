// A command task's process group (command-relay.mjs). The command leads its own group, and what it
// starts joins that group unless it makes its own. The relay records the group in the attempt's
// folder (GROUP_FILE): { pgid, leaderStarted, relay, recordedAt }, and once the command has exited
// and the relay has ended what it left running: { endedAt, leftover, killed, cleared: true }.
//
// Ending a group sends SIGTERM to each process still in it, waits up to the grace for them to go,
// then sends SIGKILL to the survivors. Each process is checked just before it is signalled: it must
// still have the PID, process group and start time it was found with, so a reused PID is never
// signalled. `stop` and `close` end a recorded group whose relay has gone without clearing it, even
// after the command that led it has exited. This module uses only Node's standard library, so the
// relay loads it without the rest of the orchestrator.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { shortText, slug } from "./format.mjs";

const words = (command) => String(command || "").trim().split(/\s+/);
const base = (word) => path.basename(word || "");
const isAgent = (command) => words(command).slice(0, 2).map(base).some((n) => /^(claude|codex)(\.js)?$/.test(n));

// "claude" for a headless Claude Code process, "codex" for `codex exec`, otherwise null. A Node
// launcher (`node .../bin/codex exec ...`) counts as the script it runs. For Codex, `exec` must be
// its first word that is neither an option nor an option's value, so a prompt that merely
// contains "exec" does not count.
export function headlessKind(command) {
  let w = words(command);
  if (["node", "bun"].includes(base(w[0]))) w = w.slice(1);
  const name = base(w[0]);
  if (name === "claude") return w.includes("-p") || w.includes("--print") ? "claude" : null;
  if (!/^codex(\.js|-(aarch64|x86_64|arm64)\S*)?$/.test(name)) return null;
  for (let i = 1; i < Math.min(w.length, 60); i++) {
    if (w[i] === "exec") return "codex";
    if (!w[i].startsWith("-") && !(w[i - 1].startsWith("-") && !w[i - 1].includes("="))) return null;
  }
  return null;
}

// The script that started the agent, such as `bash codex_review.sh ...`: the nearest process above
// it that runs a file, below the session that ran the command. An orchestrator relay is not such a
// script: an agent a command task runs directly has no launcher, so it is not named after the relay.
const SCRIPT = /\.(sh|bash|zsh|py|mjs|cjs|js|ts|rb|pl)$/;
const RELAY = /skills\/(agent-orchestrator|claude-delegate|codex-delegate)\/scripts\/(command-relay|relay)\.mjs$/;
const INTERPRETER = /^((ba|z|da)?sh|python3?(\.\d+)?|node|bun|deno|ruby|perl)$/;
export function externalLauncher(pid, table) {
  for (let p = table.get(pid)?.ppid, hops = 0; p > 1 && hops < 6; hops++) {
    const row = table.get(p);
    if (!row || isAgent(row.command)) return null;
    const w = words(row.command);
    const file = SCRIPT.test(w[0]) ? w[0] : INTERPRETER.test(base(w[0])) && w[1] && !w[1].startsWith("-") ? w[1] : null;
    if (file && RELAY.test(file)) return null;
    if (file) return { name: base(file).replace(/\.[a-z]+$/, ""), command: row.command };
    p = row.ppid;
  }
  return null;
}

export function externalAgentLabel(agent, command, via) {
  const w = words(command);
  const sub = agent === "codex" ? w[w.indexOf("exec") + 1] : null;
  const fallback = agent === "codex" ? `codex-exec${["review", "resume"].includes(sub) ? `-${sub}` : ""}` : "claude-headless";
  return { name: slug(via?.name || fallback).slice(0, 28), launcher: via ? shortText(via.command, 160) : null };
}

export const GROUP_FILE = "command-group.json";
export const GRACE_MS = 5000;

// `ps` prints start times in the local time zone and language: read them in UTC and the C locale.
const PS_ENV = () => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*$/;

function ps(args, timeout = 5000) {
  const r = spawnSync("ps", args, { encoding: "utf8", env: PS_ENV(), maxBuffer: 16 * 1024 * 1024, timeout });
  return r.error ? null : r.stdout || "";
}

// "Tue Nov 10 18:47:48 2026": a process's start time, which tells it apart from a later process
// with the same PID; null when it is gone or `ps` cannot read it.
export function processStart(pid, timeout = 5000) {
  const out = ps(["-o", "lstart=", "-p", String(pid)], timeout);
  return out?.replace(/\s+/g, " ").trim() || null;
}

// One process, { pid, pgid, started }, or null when it is gone or has exited (a zombie).
function processInfo(pid) {
  const m = ROW.exec(ps(["-o", "pid=,pgid=,stat=,lstart=", "-p", String(pid)])?.trim() || "");
  if (!m || m[3].startsWith("Z")) return null;
  return { pid: Number(m[1]), pgid: Number(m[2]), started: m[4].replace(/\s+/g, " ") };
}

// The live processes of process group `pgid`, as [{ pid, pgid, started }]; null when `ps` fails.
export function groupMembers(pgid) {
  const out = ps(["-A", "-o", "pid=,pgid=,stat=,lstart="]);
  if (out === null) return null;
  const members = [];
  for (const line of out.split("\n")) {
    const m = ROW.exec(line);
    if (m && Number(m[2]) === pgid && !m[3].startsWith("Z")) members.push({ pid: Number(m[1]), pgid, started: m[4].replace(/\s+/g, " ") });
  }
  return members;
}

// Send `signal` to each member that still has its PID, group and start time. Returns how many got it.
function signalChecked(members, signal) {
  let sent = 0;
  for (const m of members) {
    const now = processInfo(m.pid);
    if (!now || now.pgid !== m.pgid || now.started !== m.started) continue;
    try {
      process.kill(m.pid, signal);
      sent += 1;
    } catch {
      // Gone since the check.
    }
  }
  return sent;
}

// End what is left of process group `pgid`: SIGTERM to each member, up to `graceMs` for them to
// exit, then SIGKILL to each survivor, including any started meanwhile. It blocks while it waits.
// Returns { found, killed }: the members found at first, and how many needed SIGKILL.
export function endGroup(pgid, graceMs = GRACE_MS) {
  const found = groupMembers(pgid) || [];
  if (!found.length) return { found: 0, killed: 0 };
  signalChecked(found, "SIGTERM");
  const until = Date.now() + graceMs;
  let left = found;
  while (left.length && Date.now() < until) {
    spawnSync("sleep", ["0.2"]);
    left = groupMembers(pgid) || [];
  }
  return { found: found.length, killed: left.length ? signalChecked(left, "SIGKILL") : 0 };
}

export const readGroup = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, GROUP_FILE), "utf8"));
  } catch {
    return null;
  }
};

export function writeGroup(dir, record) {
  const file = path.join(dir, GROUP_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// For `stop` and `close`: end the group recorded in attempt folder `dir` when its relay has gone
// without clearing it, as after the relay was killed. Nothing is done for a cleared group, nor for
// one whose ID now belongs to another process than the command (the ID was reused). Returns
// { pgid, found, killed }, or null when there was no group of the command's to end.
export function endRecordedGroup(dir) {
  const record = readGroup(dir);
  const pgid = Number(record?.pgid);
  if (!record || record.cleared || !(pgid > 1)) return null;
  const leader = processStart(pgid);
  if (leader && record.leaderStarted && leader !== record.leaderStarted) return null;
  const ended = endGroup(pgid);
  writeGroup(dir, { ...record, endedAt: new Date().toISOString(), leftover: ended.found, killed: ended.killed, cleared: true, clearedBy: "stop or close" });
  return { pgid, ...ended };
}

// Our process identity is stable for its lifetime; caching it avoids a ps subprocess per write.
let externalProcessStart = null;

// Serialize record updates. A prepared nonempty directory makes rename an exclusive acquisition.
// The reaper guard serializes removal with release; a crashed guard expires after ten seconds.
function withExternalLock(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, guard = `${lock}.reap`;
  const ready = fs.mkdtempSync(`${lock}.${process.pid}.`);
  const deadline = Date.now() + 750;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const start = externalProcessStart ||= processStart(process.pid, 300);
  const token = randomUUID();
  fs.writeFileSync(path.join(ready, "owner.json"), JSON.stringify({ pid: process.pid, start, token }));
  const wait = () => Atomics.wait(pause, 0, 0, Math.min(10, Math.max(0, deadline - Date.now())));
  const guarded = (fn) => {
    try { fs.mkdirSync(guard); } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(guard).mtimeMs > 10000) fs.rmSync(guard, { recursive: true, force: true }); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
      return false;
    }
    const guardIdentity = fs.statSync(guard).ino;
    try { fn(); } finally {
      try { if (fs.statSync(guard).ino === guardIdentity) fs.rmSync(guard, { recursive: true, force: true }); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return true;
  };
  // Retire the directory atomically before removing its contents. Removing owner.json in
  // place briefly leaves an empty lock directory that another ready directory could replace.
  const retire = (expected) => {
    let actual;
    try { actual = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch {}
    if (expected.token) {
      if (actual?.token !== expected.token) return;
    } else {
      // Legacy or incomplete owners have no token. Require the same directory and owner
      // contents, and only retire after the caller has established it is dead or stale.
      if (fs.statSync(lock).ino !== expected.ino || JSON.stringify(actual) !== expected.owner) return;
    }
    const retired = `${ready}.retired`;
    fs.renameSync(lock, retired);
    fs.rmSync(retired, { recursive: true, force: true });
  };
  const checkedOwners = new Map();
  let acquired = false;
  try {
    while (Date.now() < deadline) {
      try { fs.renameSync(ready, lock); acquired = true; break; }
      catch (e) { if (!["EEXIST", "ENOTEMPTY"].includes(e.code)) throw e; }
      // Inspect the owner without holding the guard, so its writer can release promptly.
      try {
          const stat = fs.statSync(lock);
          let owner;
          try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch {}
          let alive = false;
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
          }
          const stale = Date.now() - stat.mtimeMs > 10000;
          const remaining = deadline - Date.now();
          let current = checkedOwners.get(owner?.pid) || (owner?.pid === process.pid ? start : null);
          if (!current && !stale && alive && owner.start && remaining > 0) {
            current = processStart(owner.pid, Math.min(300, remaining));
            if (current) checkedOwners.set(owner.pid, current);
          }
          if (stale || !alive || (current && current !== owner.start)) {
            guarded(() => {
              try { retire({ token: owner?.token, ino: stat.ino, owner: JSON.stringify(owner) }); }
              catch (e) { if (e.code !== "ENOENT") throw e; }
            });
          }
      } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (Date.now() < deadline) wait();
    }
    if (!acquired) return false;
    action();
    return true;
  } finally {
    if (acquired) {
      // Do not remove a replacement owner's directory, even if this lock expired during action.
      do {
        if (guarded(() => {
          try { retire({ token }); }
          catch (e) { if (e.code !== "ENOENT") throw e; }
        })) break;
        if (Date.now() >= deadline) break;
        wait();
      } while (true);
    } else fs.rmSync(ready, { recursive: true, force: true });
  }
}

function mergeExternal(previous, next) {
  if (!previous) return next;
  if (next.pid == null) return previous;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (key === "parent") {
      merged.parent = next.pid === previous.pid && previous.parent
        ? { ...value, run: value?.run ?? previous.parent.run, task: value?.task ?? previous.parent.task }
        : value;
    }
    else if (value !== null && value !== undefined && value !== "") merged[key] = value;
  }
  const starts = [previous.startedMs, next.startedMs].filter(Number.isFinite);
  if (starts.length) merged.startedMs = Math.min(...starts);
  const seen = [previous.seenMs, next.seenMs].filter(Number.isFinite);
  if (seen.length) merged.seenMs = Math.max(...seen);
  return merged;
}

function readExternal(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return new Map(); throw e; }
  const records = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.key === "string") records.set(record.key, mergeExternal(records.get(record.key), record));
    } catch {} // Ignore malformed legacy lines, as the dashboard reader does.
  }
  return records;
}

function writeExternal(file, records) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, [...records.values()].map((r) => `${JSON.stringify(r)}\n`).join(""));
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

// One line per session key, merging recovery metadata without losing known values.
export function appendExternalRecord(file, record) {
  if (!record || typeof record.key !== "string" || !record.key) throw new TypeError("external record needs a key");
  return withExternalLock(file, () => {
    const records = readExternal(file);
    if (records.has(record.key) && record.pid == null) return;
    records.set(record.key, mergeExternal(records.get(record.key), record));
    writeExternal(file, records);
  });
}

// Drop expired records while holding the same lock used by writers.
export function compactExternalRecords(file, sinceMs) {
  return withExternalLock(file, () => {
    const records = readExternal(file);
    for (const [key, record] of records) if (!(record.seenMs > sinceMs)) records.delete(key);
    writeExternal(file, records);
  });
}
