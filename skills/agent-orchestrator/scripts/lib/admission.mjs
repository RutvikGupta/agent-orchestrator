// Machine-wide admission for agent relays. Command tasks do not consume a place.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { STATE_ROOT } from "./config.mjs";
import { availableMemory, memoryPressure, memoryThreshold, processInfo, processStart, sameStart, lockStart } from "./heavy.mjs";
import { listRuns, listTaskRecords, relayAlive, resumeClaim, parkClaim, interruptHeld } from "./runs.mjs";

export function totalLimit(value = process.env.AGENT_ORCH_MAX_TOTAL, bytes = os.totalmem()) {
  if (value === undefined || value === "") return Math.max(4, Math.round(0.75 * bytes / 1024 ** 3));
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`AGENT_ORCH_MAX_TOTAL needs a whole number (0 turns the limit off), not ${JSON.stringify(value)}`);
  return Number(value);
}

const MIN_FREE_DEFAULT = "1.5GB";
const minFree = (value) => memoryThreshold(value, "AGENT_ORCH_MIN_FREE_AGENT");

// What is wrong with the admission settings, as one line, or null. `start`, `dispatch` and `agents`
// refuse a malformed setting as a usage error before they read anything else.
export function admissionSettingsError(env = process.env) {
  const problems = [];
  try { totalLimit(env.AGENT_ORCH_MAX_TOTAL); } catch (error) { problems.push(error.message); }
  try { if (env.AGENT_ORCH_MIN_FREE_AGENT) minFree(env.AGENT_ORCH_MIN_FREE_AGENT); }
  catch (error) { problems.push(`${error.message}, not ${JSON.stringify(env.AGENT_ORCH_MIN_FREE_AGENT)}`); }
  return problems.length ? problems.join("; ") : null;
}

// The settings as admission uses them. A malformed one never throws here: a background resume (a
// retry from `wait`, a park watcher's) prints one note and uses the default.
function limitSetting() {
  try { return totalLimit(); } catch (error) {
    const fallback = totalLimit("");
    admissionNote(`${error.message}; using the default ${fallback}`);
    return fallback;
  }
}
function minFreeSetting(limit) {
  const value = process.env.AGENT_ORCH_MIN_FREE_AGENT;
  if (limit === 0 && !value) return null;
  try { return minFree(value || MIN_FREE_DEFAULT); } catch (error) {
    admissionNote(`${error.message}, not ${JSON.stringify(value)}; using the default ${MIN_FREE_DEFAULT}`);
    return minFree(MIN_FREE_DEFAULT);
  }
}

export function machineStatus() {
  const pids = new Set();
  let interrupted = 0;
  for (const run of listRuns()) {
    for (const task of listTaskRecords(run)) {
      const candidates = [task];
      // A resume may die after spawning and before saving its task. Its claim records that
      // relay so it remains visible until recovery adopts it. Deduplicate by live relay PID.
      if (task.outDir) candidates.push(resumeClaim(task.outDir).record?.task, parkClaim(task.outDir).record?.task);
      let live = false;
      for (const candidate of candidates) {
        if (candidate && ["claude", "codex"].includes(candidate.agent) && relayAlive(candidate.pid, candidate.startedAt, candidate.outDir)) {
          pids.add(candidate.pid);
          live = true;
        }
      }
      // An interrupt keeps its existing place between its old and replacement relays.
      if (!live && ["claude", "codex"].includes(task.agent) && interruptHeld(task)?.state === "live") interrupted++;
    }
  }
  const limit = limitSetting();
  return { running: pids.size + interrupted, limit, availableBytes: availableMemory(),
    minFreeBytes: minFreeSetting(limit), pressure: memoryPressure() };
}

const gb = (bytes) => bytes === null ? "unknown" : `${(bytes / 1e9).toFixed(2)}GB`;
const notes = new Set();
function admissionNote(message) {
  if (!notes.has(message)) { notes.add(message); process.stderr.write(`agent admission: ${message}\n`); }
}
export const admissionEnabled = () => limitSetting() !== 0 || Boolean(process.env.AGENT_ORCH_MIN_FREE_AGENT);
export function admissionKinds(status, { replacement = false } = {}) {
  return [!replacement && status.limit && status.running >= status.limit && "count",
    status.minFreeBytes !== null && status.availableBytes !== null && status.availableBytes < status.minFreeBytes && "memory",
    status.minFreeBytes !== null && status.pressure >= 4 && "pressure"].filter(Boolean);
}

export function admissionReason(status = machineStatus(), { replacement = false } = {}) {
  const reasons = [];
  if (!replacement && status.limit && status.running >= status.limit) reasons.push(`${status.running} agent tasks run on this machine; the limit is ${status.limit} (AGENT_ORCH_MAX_TOTAL)`);
  if (status.minFreeBytes !== null && status.availableBytes === null) admissionNote("available memory could not be read; skipping the available-memory check");
  if (status.minFreeBytes !== null && status.availableBytes !== null && status.availableBytes < status.minFreeBytes) reasons.push(`available memory is ${gb(status.availableBytes)}; the minimum is ${gb(status.minFreeBytes)} (AGENT_ORCH_MIN_FREE_AGENT)`);
  if (status.minFreeBytes !== null && status.pressure >= 4) reasons.push(`macOS memory pressure is critical (level ${status.pressure}); available memory is ${gb(status.availableBytes)}`);
  return reasons.length ? `${reasons.join("; ")}. Wait for an agent to finish (wait returns when one does), use start --wait [DUR], or change the named setting; critical memory pressure must clear.` : null;
}

// Each contender owns a unique ticket. Removing a dead contender cannot unlink a newer owner's
// lock. PID plus process start time prevents a reused PID from keeping a dead holder's ticket.
// Keep this synchronous because park, retry and interrupt callers share synchronous startTask.
const folder = path.join(STATE_ROOT, "admission", "locks");
export class AdmissionRevoked extends Error {}
const MARK = ".revoked";
const quietRm = (file) => { try { fs.rmSync(file, { force: true }); } catch {} };
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
function tickets(self) {
  const entries = fs.readdirSync(folder), present = new Set(entries);
  for (const name of entries) {
    if (name.endsWith(MARK) && !present.has(name.slice(0, -MARK.length))) quietRm(path.join(folder, name));
  }
  const names = entries.filter((name) => name !== self && /^\d+-[a-f0-9-]+$/.test(name));
  const info = processInfo(names.map((name) => Number(name.split("-")[0])));
  return names.flatMap((name) => {
    const file = path.join(folder, name), pid = Number(name.split("-")[0]), current = info.get(pid);
    if (current?.state === "gone" || (current?.start && !sameStart(current.start, lockStart(name)))) {
      fs.rmSync(file, { force: true });
      quietRm(`${file}${MARK}`);
      return [];
    }
    if (current?.state === "stopped") {
      fs.writeFileSync(`${file}${MARK}`, "");
      if (processInfo([pid]).get(pid)?.state === "stopped") return [];
    }
    try {
      const value = fs.readlinkSync(file);
      return [{ name, ticket: value === "choosing" ? null : Number(value) }];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  });
}

// Run `fn(owner, locked)` under the machine-wide lock. When the lock stays busy until `deadline`
// (tried at least once), `busy(reason)` decides: a new start refuses, so it never runs uncounted.
// Without `busy` (the replacement of an agent that held a place), `fn` runs without the lock.
// A lock that cannot be read or written, or an unknown process start time, always runs `fn` unlocked.
export function withAdmissionLock(fn, { deadline = Date.now() + 3000, cancel = () => {}, busy = null } = {}) {
  let file, tmp, mark;
  const unlocked = (why) => {
    admissionNote(`${why}; starting without the machine count check`);
    return fn(() => {}, false);
  };
  // Acquisition failures are fail-open. Exceptions from the start itself must still propagate.
  try {
    let start;
    try { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); start = processStart(process.pid); }
    catch (error) { return unlocked(`machine lock unavailable (${error.code || error.message})`); }
    if (!start) return unlocked("cannot read this process's start time");
    const name = `${process.pid}-${randomUUID()}-${Buffer.from(start).toString("hex")}`;
    file = path.join(folder, name); tmp = `${file}.tmp`; mark = `${file}${MARK}`;
    const owner = () => {
      cancel();
      if (fs.existsSync(mark)) throw new AdmissionRevoked("admission was revoked while stopped");
    };
    let acquired = false, failed = null, timedOut = false;
    try {
      fs.symlinkSync("choosing", file);
      const ticket = Math.max(0, ...tickets(name).map((row) => row.ticket || 0)) + 1;
      fs.symlinkSync(String(ticket), tmp);
      fs.renameSync(tmp, file);
      for (;;) {
        owner();
        if (!tickets(name).some((row) => row.ticket === null || row.ticket < ticket || (row.ticket === ticket && row.name < name))) { acquired = true; break; }
        if (Date.now() >= deadline) { failed = "machine lock wait timed out"; timedOut = true; break; }
        pause();
      }
    } catch (error) {
      if (error instanceof AdmissionRevoked || error.code === 6) throw error;
      failed = `machine lock unavailable (${error.code || error.message})`;
    }
    if (!acquired) {
      quietRm(file); quietRm(tmp); quietRm(mark);
      if (timedOut && busy) return busy(`the machine-wide admission lock (${folder}) stayed busy: another start held it until this start's deadline, so the running agents could not be counted. Start again, or use start --wait [DUR]; a holder that ends releases the lock.`);
      return unlocked(failed);
    }
    owner();
    return fn(owner, true);
  } finally {
    for (const item of [file, tmp, mark].filter(Boolean)) quietRm(item);
  }
}
