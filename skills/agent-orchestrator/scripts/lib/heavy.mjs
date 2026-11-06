// A machine-wide memory lane. Only heavy commands queue; agent counts are irrelevant.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { STATE_ROOT } from "./config.mjs";
import { inboxWake } from "./inbox.mjs";
import { readJson, writeJson } from "./util.mjs";

const lane = path.join(STATE_ROOT, "heavy");
// Set in every heavy command's environment: a heavy call nested inside one runs at once, since the
// outer command already holds its admission and queueing behind it would deadlock.
export const NESTED_MARKER = "AGENT_ORCH_HEAVY_ACTIVE";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quietRm = (file) => { try { fs.rmSync(file, { force: true }); } catch {} };

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === "EPERM"; }
  // An orphaned command may remain a zombie under a container's non-reaping PID 1.
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    } catch (e) { if (e.code === "ENOENT") return false; }
  }
  return true;
}

// A PID can be reused after a process dies without cleaning up (SIGKILL, a crash, power loss), so
// the lane never trusts a PID alone. Every lane entry and lock records the start time of its
// process, as `ps -o lstart=` prints it under the C locale and UTC ("Fri Nov  6 15:13:13 2026"). ps
// prints local time, so without a fixed TZ two wrappers started with different time zones would
// record different strings for the same process. A live process with another start time is a
// different process: the record's owner is gone.
const PS_LOCALE = { LC_ALL: "C", LANG: "C", TZ: "UTC" };
// Only for a record without a start time (see sameProcess): a file's time and ps's whole seconds
// come from different clocks, so a process counts as later than the record only by more than this.
const LEGACY_SLACK_MS = 2000;

export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3000, env: { ...process.env, ...PS_LOCALE } });
  return (r.status === 0 && r.stdout.trim()) || null;
}

// Start times are compared exactly, apart from the spacing ps pads dates with: a different time,
// even by a second, is a different process.
const squash = (text) => String(text).replace(/\s+/g, " ").trim();
export const sameStart = (a, b) => squash(a) === squash(b);
const startMs = (text) => Date.parse(`${squash(text)} UTC`);

// Is the live process that now has this PID the one a record names? `current` is its start time
// now (null when ps could not read it), `recorded` the start time stored in the record, and `at`
// the time the record was written, in ms.
//  - ps could not read it now: the PID is trusted, as it was before start times existed.
//  - the record has a start time: it must match.
//  - an older record (written before start times, or where ps was unavailable) has none, so the
//    process is trusted only if it did not start after the record was written (beyond a small
//    slack for the two clocks). A process that started afterwards cannot be the one that wrote
//    it. This cannot catch a PID reused within the slack, which is why new records carry the time.
export function sameProcess(current, recorded, at) {
  if (!current) return true;
  if (recorded) return sameStart(recorded, current);
  const began = startMs(current);
  return !(Number.isFinite(at) && Number.isFinite(began) && began > at + LEGACY_SLACK_MS);
}

// For each PID: its state, "running", "stopped" (state T: suspended by job control, SIGSTOP or a
// debugger) or "gone" (dead or a zombie), and its start time. A stopped process keeps its place
// but blocks no one. ps lists only these PIDs, and nothing is ever signaled from its output.
function processInfo(pids) {
  const info = new Map(), live = [];
  for (const pid of new Set(pids)) {
    if (alive(pid)) { info.set(pid, { state: "running", start: null }); live.push(pid); } else info.set(pid, { state: "gone", start: null });
  }
  if (!live.length) return info;
  const linux = process.platform === "linux";
  if (linux) {
    for (const pid of live) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        if (/^[Tt]/.test(stat.slice(stat.lastIndexOf(")") + 2))) info.get(pid).state = "stopped";
      } catch {}
    }
  }
  // If ps cannot run (a sandbox), every live process counts as running, as before.
  const r = spawnSync("ps", ["-o", "pid=,stat=,lstart=", "-p", live.join(",")], { encoding: "utf8", timeout: 3000, env: { ...process.env, ...PS_LOCALE } });
  for (const line of (r.stdout || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line), item = info.get(Number(m?.[1]));
    if (!m || !item) continue;
    item.start = m[3];
    if (linux) continue;
    if (m[2].startsWith("T")) item.state = "stopped";
    else if (m[2].startsWith("Z")) item.state = "gone";
  }
  return info;
}

// The state of the process a record names: "gone" when the PID is dead or belongs to another process.
function stateOf(info, pid, { start, at }) {
  const item = info.get(pid);
  return !item || item.state === "gone" || !sameProcess(item.start, start, at) ? "gone" : item.state;
}

let ownStart;
const selfStart = () => (ownStart === undefined ? (ownStart = processStart(process.pid)) : ownStart);

// vm_stat fallback on macOS: free and speculative pages only. Inactive and purgeable pages are not
// reliably reclaimable under load, and compressed pages never count.
export function parseMemory(text, platform) {
  if (platform === "darwin") {
    const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
    const pages = ["free", "speculative"].map((name) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1]));
    return page > 0 && pages.every(Number.isFinite) ? pages.reduce((a, b) => a + b, 0) * page : 0;
  }
  // Linux: the kernel's own estimate, MemAvailable (what a new workload can use without swapping),
  // when it reports one. Inactive is never added: it includes anonymous pages that cannot be freed
  // without swap, as in containers. Without MemAvailable (kernels before 3.14, some sandboxes) the
  // fallback is MemFree plus SReclaimable, slab caches the kernel frees under pressure, or MemFree
  // alone when there is no slab figure. Page cache is left out because it also holds tmpfs and
  // mapped pages. That is below the kernel's estimate, so a command waits a little longer, never
  // starts on memory that is not there.
  const kb = (name) => { const m = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text); return m ? Number(m[1]) : null; };
  const available = kb("MemAvailable");
  if (available !== null) return available * 1024;
  const free = kb("MemFree");
  return free === null ? 0 : (free + (kb("SReclaimable") ?? 0)) * 1024;
}

function sysctl(name) {
  const options = { encoding: "utf8", timeout: 3000 };
  let r = spawnSync("sysctl", ["-n", name], options);
  if (r.error?.code === "ENOENT") r = spawnSync("/usr/sbin/sysctl", ["-n", name], options);
  const value = r.status === 0 ? r.stdout.trim() : "";
  return value === "" ? null : value;
}

// The macOS kernel's own estimate: kern.memorystatus_level is the percentage of memory available.
// Null when the kernel does not report it, so the caller falls back to vm_stat.
export function darwinAvailable(read = sysctl) {
  const level = read("kern.memorystatus_level"), total = read("hw.memsize");
  if (level === null || total === null || !/^\d+$/.test(level) || !/^\d+$/.test(total)) return null;
  const percent = Number(level), bytes = Number(total);
  return percent <= 100 && bytes > 0 ? Math.floor((bytes * percent) / 100) : null;
}

export function freeMemory() {
  if (process.env.AGENT_ORCH_HEAVY_FREE_BYTES !== undefined) return Math.max(0, Number(process.env.AGENT_ORCH_HEAVY_FREE_BYTES) || 0);
  if (process.platform === "darwin") {
    const available = darwinAvailable();
    if (available !== null) return available;
    const r = spawnSync("vm_stat", [], { encoding: "utf8", timeout: 3000 });
    return r.status === 0 ? parseMemory(r.stdout, "darwin") : 0;
  }
  try { return parseMemory(fs.readFileSync("/proc/meminfo", "utf8"), "linux"); } catch { return 0; }
}

// The kernel's memory pressure: 1 normal, 2 warning, 4 critical (macOS). Critical pressure holds
// a command back while another one runs; an empty lane admits at any level, since waiting would
// not free anything. AGENT_ORCH_HEAVY_PRESSURE_LEVEL overrides the reading.
export function memoryPressure(read = sysctl, env = process.env, platform = process.platform) {
  const forced = env.AGENT_ORCH_HEAVY_PRESSURE_LEVEL;
  if (forced !== undefined && forced !== "") return Number(forced) || 0;
  if (platform !== "darwin") return 0;
  return Number(read("kern.memorystatus_vm_pressure_level")) || 0;
}

export function memoryThreshold(value = process.env.AGENT_ORCH_HEAVY_MIN_FREE || "2.5GB") {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB)?$/i.exec(value);
  if (!m) throw new Error("AGENT_ORCH_HEAVY_MIN_FREE needs bytes or a size such as 2.5GB");
  const unit = (m[2] || "B").toUpperCase();
  return Number(m[1]) * (unit.includes("I") ? 1024 : 1000) ** ({ B: 0, KB: 1, MB: 2, GB: 3, KIB: 1, MIB: 2, GIB: 3 }[unit]);
}

// The least time between two admissions, so a new command's memory shows up in the readings
// before the next one is admitted. It applies only while the command admitted last is still
// running (an empty lane admits at once), and is kept in the lane, so it holds across contenders.
export function rampMs(value = process.env.AGENT_ORCH_HEAVY_RAMP_MS) {
  if (value === undefined || value === "") return 20000;
  if (!/^\d+$/.test(value.trim())) throw new Error("AGENT_ORCH_HEAVY_RAMP_MS needs milliseconds (0 turns spacing off)");
  return Number(value);
}
const admittedFile = () => path.join(lane, "admitted.json");

// Is this running entry the command that admitted.json records? That record names the entry's
// ticket and wrapper (with their start times) and the command (PID and start time), so a later
// command of the same wrapper, or another process that took a PID, is never taken for it. A record
// written before those fields existed names only the wrapper's PID and a time: it matches the
// wrapper's running entry if that entry started no later.
function admittedBy(row, last) {
  if (row.pid !== last.pid) return false;
  if (!Number.isInteger(last.ticket)) return !(Date.parse(row.startedAt) > last.at);
  const same = (a, b) => !a || !b || sameStart(a, b);
  return row.ticket === last.ticket && row.childPid === last.childPid && same(row.pidStart, last.pidStart) && same(row.childPidStart, last.childPidStart);
}

function rampLeft(ramp, running, now = Date.now()) {
  const last = readJson(admittedFile());
  const at = Number(last?.at) || 0;
  // A time in the future (a clock change) is ignored rather than trusted.
  const left = at > now + 1000 ? 0 : Math.max(0, at + ramp - now);
  return left > 0 && running.some((row) => admittedBy(row, last)) ? left : 0;
}

// Writing the lane fails in a sandbox, on a read-only or full disk, or where a file obstructs the
// lane's folders (a file where the lane or its locks folder should be: ENOTDIR, EEXIST). Only those
// failures, on the lane's own files, let the command run without the lane; anything else is a real error.
const STORAGE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "ENOTDIR", "EISDIR", "EEXIST"]);
const inLane = (p) => typeof p === "string" && (p === lane || p.startsWith(lane + path.sep) || lane.startsWith(p + path.sep));
function storageFailure(error) {
  return STORAGE_CODES.has(error?.code) && typeof error.syscall === "string" && !error.syscall.startsWith("spawn") &&
    (inLane(error.path) || inLane(error.dest));
}

// A bakery mutex: every contender owns a unique file, publishes "choosing", then a numbered
// ticket, and waits for earlier tickets (and unfinished choices) before entry. Removing a dead
// contender never unlinks a shared lock that a new owner could hold.
//
// The file is a symlink to "choosing" or to the ticket, as it always was, so a reader from before
// start times still understands every lock. The owner's start time is in the file's name, which
// exists atomically with the file: "PID-UUID-HEX", where HEX is the start time's text in hex
// ("Fri Nov  6 15:13:13 2026" is 46726920...). The name still matches the old pattern and starts
// with the PID, so an old reader treats it like any contender. A lock whose owner's PID now belongs
// to another process is dead, and is removed like any dead owner's. A name without that last part
// is an older lock: its owner is trusted only by the link's time (see sameProcess).
//
// A stopped contender (state T) would block everyone, so its place is revoked with a marker
// file instead. The marker is checked before entry and before every write inside, so a revoked
// contender that resumes withdraws and queues again instead of acting on a stale decision.
const CONTENDER = /^\d+-[a-f0-9-]+$/;
const IDENTIFIED = /^\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-((?:[a-f0-9]{2})+)$/;
const MARK = ".revoked";
const REVOKED = Symbol("revoked");

const lockName = (id, start) => `${process.pid}-${id}-${Buffer.from(start, "utf8").toString("hex")}`;
// The start time a lock's name carries, or null for an older name or an unrecognized ending.
export function lockStart(name) {
  const hex = IDENTIFIED.exec(name)?.[1];
  const start = hex && Buffer.from(hex, "hex").toString("utf8");
  return start && /^[\x20-\x7e]+$/.test(start) ? start : null;
}

function lockTickets(folder, self) {
  const names = fs.readdirSync(folder), present = new Set(names);
  for (const name of names) {
    if (name.endsWith(MARK) && !present.has(name.slice(0, -MARK.length))) quietRm(path.join(folder, name));
  }
  const others = names.filter((n) => n !== self && CONTENDER.test(n));
  const info = processInfo(others.map((n) => Number(n.split("-")[0])));
  const tickets = [];
  for (const name of others) {
    const pid = Number(name.split("-")[0]), file = path.join(folder, name);
    // The link's own time bounds when a lock without a start time was written.
    let lock;
    try {
      const value = fs.readlinkSync(file);
      lock = { ticket: value === "choosing" ? null : Number(value), start: lockStart(name), at: fs.lstatSync(file).mtimeMs };
    } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    let state = stateOf(info, pid, lock);
    if (state === "stopped") {
      fs.writeFileSync(`${file}${MARK}`, "");
      // It may have resumed between the two reads and gone on to enter, so if it runs now, wait
      // for it like any contender: it withdraws at its next check or leaves the lock soon.
      state = stateOf(processInfo([pid]), pid, lock);
      if (state === "stopped") continue;
    }
    if (state === "gone") {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}${MARK}`, { force: true });
      continue;
    }
    tickets.push({ name, ticket: lock.ticket });
  }
  return tickets;
}

async function transaction(fn, cancelled = () => false) {
  for (;;) {
    const result = await attempt(fn, cancelled);
    if (result !== REVOKED) return result;
  }
}

async function attempt(fn, cancelled) {
  const folder = path.join(lane, "locks");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Every new lock carries its owner's start time; runHeavy does not queue without one.
  const start = selfStart();
  if (!start) throw new Error("heavy: cannot read the start time of this process");
  const name = lockName(randomUUID(), start), file = path.join(folder, name), tmp = `${file}.tmp`, mark = `${file}${MARK}`;
  const owner = () => !fs.existsSync(mark);
  fs.symlinkSync("choosing", file);
  try {
    const ticket = Math.max(0, ...lockTickets(folder, name).map((r) => r.ticket || 0)) + 1;
    fs.symlinkSync(String(ticket), tmp);
    fs.renameSync(tmp, file);
    for (;;) {
      if (!owner()) return REVOKED;
      if (cancelled()) return null;
      const before = lockTickets(folder, name).some((r) =>
        r.ticket === null || r.ticket < ticket || (r.ticket === ticket && r.name < name));
      if (!before) return owner() ? fn(owner) : REVOKED;
      await pause(100);
    }
  } finally {
    for (const f of [file, tmp, mark]) quietRm(f);
  }
}

const byTicket = (a, b) => a.ticket - b.ticket || String(a.queuedAt).localeCompare(String(b.queuedAt)) || a.pid - b.pid;

// Lane entries of live wrappers. `active` is false for a suspended wrapper or command, which
// keeps its entry but blocks no one. A dead wrapper can never clean up, so its entry is dropped
// even if its command still runs. A PID that now belongs to another process counts as dead: an
// entry records the start time of its wrapper (`pidStart`) and its command (`childPidStart`), and
// an older entry without them is trusted only if its process started before the entry was written.
function entries(prune = false) {
  let names;
  try { names = fs.readdirSync(lane); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const name of names.filter((n) => /^\d+-.*\.json$/.test(n))) {
    const file = path.join(lane, name), row = readJson(file);
    if (row) rows.push({ ...row, file });
  }
  const info = processInfo(rows.flatMap((r) => [r.pid, r.childPid]));
  const kept = [];
  for (const row of rows) {
    const holder = stateOf(info, row.pid, { start: row.pidStart, at: Date.parse(row.queuedAt) });
    if (holder === "gone") { if (prune) fs.rmSync(row.file, { force: true }); continue; }
    const command = row.state === "running" ? stateOf(info, row.childPid, { start: row.childPidStart, at: Date.parse(row.startedAt) }) : "running";
    kept.push({ ...row, active: holder === "running" && command === "running" });
  }
  return kept.sort(byTicket);
}

export function heavyStatus() {
  let rows;
  try { rows = entries().filter((r) => r.active); } catch { return { running: 0, waiting: 0 }; }
  return { running: rows.filter((r) => r.state === "running").length, waiting: rows.filter((r) => r.state === "waiting").length };
}

// The command runs as the leader of its own session and process group (`detached`, which calls
// setsid), with the caller's stdin, stdout and stderr. Signals the terminal or a supervisor sends
// to the wrapper's process group therefore never reach the command directly, and the wrapper
// forwards each terminating signal it receives exactly once, to the command's whole group, as a
// terminal would. A signal sent to the command itself reaches only the command. Ctrl-Z stops the
// command's group and then the wrapper; SIGCONT resumes the group. Nothing is ever escalated to
// SIGKILL: the wrapper waits for the command however long its cleanup takes and returns its exit
// code, or 128 + the signal number if a signal ended it. The command has no controlling terminal,
// so it cannot open /dev/tty.
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

function supervise(command) {
  let child = null, done = null, exited = false, suspended = false, signal = null;
  const toGroup = (name) => {
    if (!child?.pid || exited) return;
    try { process.kill(-child.pid, name); } catch {} // ESRCH: the group has already gone
  };
  const handlers = [
    ...FORWARDED.map((name) => [name, () => { signal ||= name; toGroup(name); }]),
    ["SIGWINCH", () => toGroup("SIGWINCH")],
    // A group in another session ignores SIGTSTP, so stop it with SIGSTOP, then stop the wrapper.
    ["SIGTSTP", () => {
      if (child?.pid && !exited) { toGroup("SIGSTOP"); suspended = true; }
      process.kill(process.pid, "SIGSTOP");
    }],
    ["SIGCONT", () => { if (suspended) { suspended = false; toGroup("SIGCONT"); } }],
  ];
  for (const [name, fn] of handlers) process.on(name, fn);
  return {
    get signal() { return signal; },
    get started() { return Boolean(child); },
    get pid() { return child?.pid; },
    start() {
      if (child) throw new Error("heavy: the command was already started");
      child = spawn(command[0], command.slice(1), { stdio: "inherit", detached: true, env: { ...process.env, [NESTED_MARKER]: "1" } });
      done = new Promise((resolve) => {
        child.once("error", (error) => { exited = true; process.stderr.write(`heavy: ${error.message}\n`); resolve(error.code === "ENOENT" ? 127 : 126); });
        child.once("exit", (code, sig) => { exited = true; resolve(code ?? (128 + (os.constants.signals[sig] || 1))); });
      });
      return child;
    },
    get done() { return done; },
    dispose() { for (const [name, fn] of handlers) process.removeListener(name, fn); },
  };
}

// Queue for admission. Resolves null once the command has started, or an exit code when it ends
// without running: 6 for a new message, 128 + the signal number for a signal.
async function queue(run, label, { threshold, ramp }, track) {
  const wake = inboxWake();
  const self = selfStart();
  let message = null;
  const cancelled = () => Boolean(run.signal || (message = wake.check()));
  const row = await transaction((owner) => {
    const counter = path.join(lane, "sequence.json");
    // Live entries put a floor under the counter, so a stale write never reuses their tickets.
    const ticket = Math.max(readJson(counter)?.ticket || 0, ...entries().map((r) => r.ticket || 0)) + 1;
    if (!owner()) return REVOKED;
    writeJson(counter, { ticket });
    const file = path.join(lane, `${ticket}-${process.pid}.json`);
    const record = { ticket, pid: process.pid, label, state: "waiting", queuedAt: new Date().toISOString(), pidStart: self };
    if (!owner()) return REVOKED;
    writeJson(file, record);
    track(file);
    return record;
  }, cancelled);
  let nextReport = 0, lastReason = null;
  while (row && !cancelled()) {
    const admitted = await transaction((owner) => {
      const all = entries(true).filter((r) => r.active);
      const waiting = all.filter((r) => r.state === "waiting"), running = all.filter((r) => r.state === "running");
      let reason = null;
      if (waiting[0]?.pid === process.pid) {
        // An empty lane always admits, whatever the memory readings or spacing say: nothing is
        // running that waiting would let go of. Otherwise critical pressure, the spacing after the
        // command admitted last (while it runs) and too little free memory each hold the command.
        if (running.length) {
          const pressure = memoryPressure(), left = rampLeft(ramp, running);
          if (pressure >= 4) reason = `memory pressure level ${pressure}`;
          else if (left > 0) reason = `next admission in ${Math.ceil(left / 1000)}s`;
          else if (freeMemory() <= threshold) reason = "waiting for memory";
        }
        if (!reason) {
          if (!owner()) return REVOKED;
          // Start under the lock so the next admission sees the command's PID as well. The
          // command is running from here on: later bookkeeping failures must not abandon it.
          run.start();
          const startedAt = new Date().toISOString(), childStart = processStart(run.pid);
          try {
            const identity = { pidStart: self, childPid: run.pid, ...(childStart ? { childPidStart: childStart } : {}) };
            writeJson(path.join(lane, `${row.ticket}-${process.pid}.json`), { ...row, state: "running", childPid: run.pid, ...(childStart ? { childPidStart: childStart } : {}), startedAt });
            writeJson(admittedFile(), { at: Date.now(), label, pid: process.pid, ticket: row.ticket, ...identity });
          } catch {}
          return true;
        }
      }
      const kind = reason?.replace(/\d+s$/, "");
      if (Date.now() >= nextReport || kind !== lastReason) {
        const place = waiting.findIndex((r) => r.pid === process.pid) + 1;
        process.stderr.write(`heavy: ${label}: waiting, place ${place} (${running.length} running)${reason ? `, ${reason}` : ""}\n`);
        nextReport = Date.now() + 30000;
        lastReason = kind;
      }
      return false;
    }, cancelled);
    if (admitted) return null;
    await pause(250);
  }
  if (message) process.stderr.write(`${message.hint}\n`);
  return run.signal ? 128 + os.constants.signals[run.signal] : 6;
}

export async function runHeavy(command, { label = command[0] } = {}) {
  const run = supervise(command);
  let file = null;
  try {
    // A nested call already runs under its outer command's admission.
    if (!process.env[NESTED_MARKER]) {
      const limits = { threshold: memoryThreshold(), ramp: rampMs() };
      // Every entry and lock names its process by PID and start time. Without the start time (ps
      // cannot run) this wrapper could only leave PID-only records, which a reused PID would turn
      // into a stuck lane, so it does not join the lane.
      if (!selfStart()) {
        process.stderr.write(`heavy: ${label}: lane skipped (cannot read this process's start time with ps); running the command without it\n`);
      } else {
        try {
          const code = await queue(run, label, limits, (f) => { file = f; });
          if (code !== null) return code;
        } catch (error) {
          if (run.started) process.stderr.write(`heavy: ${label}: ${error.message}\n`);
          else if (!storageFailure(error)) throw error;
          else if (run.signal) return 128 + os.constants.signals[run.signal];
          else {
            // A waiting entry left behind would hold up everyone queued after it.
            if (file) { quietRm(file); file = null; }
            process.stderr.write(`heavy: ${label}: lane skipped (${error.code}: cannot write ${error.dest || error.path}); running the command without it\n`);
          }
        }
      }
    }
    if (!run.started) run.start();
    return await run.done;
  } finally {
    if (file) quietRm(file);
    run.dispose();
  }
}
