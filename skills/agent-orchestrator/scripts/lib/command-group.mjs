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
import fs from "node:fs";
import path from "node:path";

export const GROUP_FILE = "command-group.json";
export const GRACE_MS = 5000;

// `ps` prints start times in the local time zone and language: read them in UTC and the C locale.
const PS_ENV = () => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*$/;

function ps(args) {
  const r = spawnSync("ps", args, { encoding: "utf8", env: PS_ENV(), maxBuffer: 16 * 1024 * 1024, timeout: 5000 });
  return r.error ? null : r.stdout || "";
}

// "Tue Nov 10 18:47:48 2026": a process's start time, which tells it apart from a later process
// with the same PID; null when it is gone or `ps` cannot read it.
export function processStart(pid) {
  const out = ps(["-o", "lstart=", "-p", String(pid)]);
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
