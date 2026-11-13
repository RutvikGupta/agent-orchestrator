// Machine-wide admission for agent relays. Command tasks do not consume a place.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { STATE_ROOT } from "./config.mjs";
import { freeMemory, memoryPressure, memoryThreshold, processInfo, processStart, sameStart, lockStart } from "./heavy.mjs";
import { listRuns, listTaskRecords, relayAlive, resumeClaim, parkClaim } from "./runs.mjs";

export function totalLimit(value = process.env.AGENT_ORCH_MAX_TOTAL, bytes = os.totalmem()) {
  if (value === undefined || value === "") return Math.max(4, Math.round(0.75 * bytes / 1024 ** 3));
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("AGENT_ORCH_MAX_TOTAL needs a whole number (0 turns the limit off)");
  return Number(value);
}

export function machineStatus() {
  const pids = new Set();
  for (const run of listRuns()) {
    for (const task of listTaskRecords(run)) {
      const candidates = [task];
      // A resume may die after spawning and before saving its task. Its claim records that
      // relay so it remains visible until recovery adopts it. Deduplicate by live relay PID.
      if (task.outDir) candidates.push(resumeClaim(task.outDir).record?.task, parkClaim(task.outDir).record?.task);
      for (const candidate of candidates) {
        if (candidate && ["claude", "codex"].includes(candidate.agent) && relayAlive(candidate.pid, candidate.startedAt, candidate.outDir)) pids.add(candidate.pid);
      }
    }
  }
  return { running: pids.size, limit: totalLimit(), availableBytes: freeMemory(),
    minFreeBytes: memoryThreshold(process.env.AGENT_ORCH_MIN_FREE_AGENT || "1.5GB", "AGENT_ORCH_MIN_FREE_AGENT"),
    pressure: memoryPressure() };
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)}GB`;
export function admissionReason(status = machineStatus(), { replacement = false } = {}) {
  const reasons = [];
  if (!replacement && status.limit && status.running >= status.limit) reasons.push(`${status.running} agent tasks run on this machine; the limit is ${status.limit} (AGENT_ORCH_MAX_TOTAL)`);
  if (status.availableBytes < status.minFreeBytes) reasons.push(`available memory is ${gb(status.availableBytes)}; the minimum is ${gb(status.minFreeBytes)} (AGENT_ORCH_MIN_FREE_AGENT)`);
  if (status.pressure >= 4) reasons.push(`macOS memory pressure is critical (level ${status.pressure}); available memory is ${gb(status.availableBytes)}`);
  return reasons.length ? `${reasons.join("; ")}. Wait for an agent to finish (wait returns when one does), use start --wait [DUR], or change the named setting; critical memory pressure must clear.` : null;
}

// Each contender owns a unique ticket. Removing a dead contender cannot unlink a newer owner's
// lock. PID plus process start time prevents a reused PID from keeping a dead holder's ticket.
// Keep this synchronous because park, retry and interrupt callers share synchronous startTask.
const folder = path.join(STATE_ROOT, "admission", "locks");
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
function tickets(self) {
  const names = fs.readdirSync(folder).filter((name) => name !== self && /^\d+-[a-f0-9-]+$/.test(name));
  const info = processInfo(names.map((name) => Number(name.split("-")[0])));
  return names.flatMap((name) => {
    const file = path.join(folder, name), pid = Number(name.split("-")[0]), current = info.get(pid);
    if (current?.state === "gone" || (current?.start && !sameStart(current.start, lockStart(name)))) {
      fs.rmSync(file, { force: true });
      return [];
    }
    try {
      const value = fs.readlinkSync(file);
      return [{ name, ticket: value === "choosing" ? null : Number(value) }];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  });
}

export function withAdmissionLock(fn) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const start = processStart(process.pid);
  if (!start) throw new Error("agent admission: cannot read this process's start time");
  const name = `${process.pid}-${randomUUID()}-${Buffer.from(start).toString("hex")}`;
  const file = path.join(folder, name), tmp = `${file}.tmp`;
  fs.symlinkSync("choosing", file);
  try {
    const ticket = Math.max(0, ...tickets(name).map((row) => row.ticket || 0)) + 1;
    fs.symlinkSync(String(ticket), tmp);
    fs.renameSync(tmp, file);
    while (tickets(name).some((row) => row.ticket === null || row.ticket < ticket || (row.ticket === ticket && row.name < name))) pause();
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(tmp, { force: true });
  }
}
