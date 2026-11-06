// Reclaim only daemons with an unambiguous workspace in their process title: Pants
// `pantsd [/absolute/workspace]`. Other build tools stay untouched. Gradle daemons are
// shared across builds, and a Bazel server's arguments do not prove which work owns it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RUNS_DIR } from "./config.mjs";
import { readJson } from "./util.mjs";

const real = (dir) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// ps and lsof print dates and messages in the caller's locale; the parsers expect the C locale.
const inspect = (bin, args, options) => spawnSync(bin, args, { encoding: "utf8", ...options, env: { ...process.env, LC_ALL: "C", LANG: "C" } });

function ps(pid) {
  const r = inspect("ps", [pid ? "-p" : "-axww", ...(pid ? [String(pid), "-ww"] : []), "-o", "pid=,uid=,rss=,stat=,lstart=,command="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && !pid)) throw new Error(`cannot inspect processes: ${r.error?.message || r.stderr}`);
  return (r.stdout || "").split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
    return m && !m[4].startsWith("Z") ? [{ pid: Number(m[1]), uid: Number(m[2]), bytes: Number(m[3]) * 1024, started: m[5], command: m[6].trimEnd() }] : [];
  });
}

export function daemonDirectory(command) {
  const pants = /^pantsd \[(\/[^\n\0]+)\]$/.exec(command);
  return pants ? { kind: "pantsd", directory: real(pants[1]) } : null;
}

function workingDirectories(rows) {
  const dirs = new Map();
  if (process.platform === "linux") {
    for (const row of rows) {
      try { dirs.set(row.pid, real(fs.readlinkSync(`/proc/${row.pid}/cwd`))); } catch {}
    }
  } else {
    // One lsof per batch, not per PID. -a intersects PID and cwd selections;
    // NUL field delimiters preserve spaces in checkout paths.
    for (let i = 0; i < rows.length; i += 200) {
      const r = inspect("lsof", ["-a", "-d", "cwd", "-p", rows.slice(i, i + 200).map((p) => p.pid).join(","), "-Fpn0"], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
      if (r.error || r.status > 1 || r.stderr?.trim()) throw new Error(`cannot inspect working directories: ${r.error?.message || r.stderr}`);
      let pid = null;
      for (const raw of (r.stdout || "").split("\0")) {
        const field = raw.replace(/^\n+/, "");
        if (field.startsWith("p")) pid = Number(field.slice(1));
        if (field.startsWith("n/") && pid) dirs.set(pid, real(field.slice(1)));
      }
    }
  }
  return dirs;
}

function runningDirectories(rows) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const dirs = [];
  let runs;
  try { runs = fs.readdirSync(RUNS_DIR); } catch (e) { if (e.code === "ENOENT") return dirs; throw e; }
  for (const run of runs) {
    const tasks = path.join(RUNS_DIR, run, "tasks");
    let ids;
    try { ids = fs.readdirSync(tasks); } catch { continue; }
    for (const id of ids) {
      const task = readJson(path.join(tasks, id, "task.json"));
      const proc = byPid.get(task?.pid);
      if (!proc) continue;
      const age = Date.now() - Date.parse(task.startedAt);
      if (!proc.command.includes("relay.mjs") && !(age >= 0 && age < 10000)) continue;
      for (const dir of [task.cd, task.worktree?.path].filter(Boolean)) dirs.push(real(dir));
    }
  }
  return dirs;
}

// One look at what could still use a daemon: every process's working directory and every
// running task. Taken again right before each stop, so work that began meanwhile counts.
function survey(rows = ps()) {
  const uid = process.getuid?.();
  const daemonPids = new Set(rows.filter((r) => daemonDirectory(r.command)).map((r) => r.pid));
  const cwd = workingDirectories(rows.filter((r) => !daemonPids.has(r.pid)));
  const running = runningDirectories(rows);
  // An inaccessible cwd of one of our live processes prevents proving the daemon idle.
  // Other users' visible cwds still protect their work; we never signal their daemons.
  const unknown = rows.filter((r) => r.uid === uid && !daemonPids.has(r.pid) && !cwd.has(r.pid));
  const stillUnknown = unknown.length ? new Set(ps().map((r) => r.pid)) : new Set();
  return { rows, cwd, running, uncertain: unknown.some((r) => stillUnknown.has(r.pid)) };
}

// Why a daemon must stay, or null when nothing uses it. A running task protects a daemon in,
// above or below its directory: a task in a checkout uses the daemons of its subprojects too.
function inUse(look, daemon) {
  const owners = [...look.cwd].filter(([, dir]) => inside(dir, daemon.directory)).map(([pid]) => pid);
  if (owners.length) return { reason: "live working directory", owners };
  if (look.running.some((dir) => inside(dir, daemon.directory) || inside(daemon.directory, dir))) return { reason: "running task", owners };
  if (look.uncertain) return { reason: "working directory unavailable", owners };
  return null;
}

// The same process, not a new one that reused its PID: same command and start time.
const same = (row, current) => Boolean(current) && current.command === row.command && current.started === row.started;
const sameProcess = (row) => same(row, ps(row.pid)[0]);

function stop(row, graceMs) {
  try {
    process.kill(row.pid, "SIGTERM");
    const until = Date.now() + graceMs;
    while (Date.now() < until && sameProcess(row)) sleep(50);
    let signal = "SIGTERM";
    if (sameProcess(row)) {
      // Work that began during the grace period keeps a daemon that ignored SIGTERM.
      const kept = inUse(survey(), row);
      if (kept) return { ...row, action: "kept", ...kept, signal };
    }
    if (sameProcess(row)) {
      process.kill(row.pid, "SIGKILL");
      signal = "SIGKILL";
      const killedUntil = Date.now() + 1000;
      while (Date.now() < killedUntil && sameProcess(row)) sleep(25);
    }
    return { ...row, action: sameProcess(row) ? "failed" : "stopped", signal };
  } catch (error) {
    return { ...row, action: error.code === "ESRCH" ? "gone" : "failed", error: error.message };
  }
}

export function reclaim({ directory = null, dryRun = false, graceMs = 2000 } = {}) {
  if (process.env.AGENT_ORCH_RECLAIM === "off") return { disabled: true, dryRun, daemons: [], bytes: 0 };
  const uid = process.getuid?.(), target = directory && real(directory);
  const rows = ps();
  const candidates = rows.flatMap((row) => {
    if (row.uid !== uid) return [];
    const match = daemonDirectory(row.command);
    return match && (!target || match.directory === target) ? [{ ...row, ...match }] : [];
  });
  if (!candidates.length) return { dryRun, daemons: [], bytes: 0 };
  let look = dryRun ? survey(rows) : null;
  const daemons = candidates.map((row) => {
    // Each stop takes a fresh survey: a process or task may have started using this
    // daemon while an earlier one was stopping. A dry run stops nothing, so one suffices.
    if (!dryRun) look = survey();
    if (!same(row, look.rows.find((r) => r.pid === row.pid))) return { ...row, action: "gone" };
    const kept = inUse(look, row);
    if (kept) return { ...row, action: "kept", ...kept };
    if (dryRun) return { ...row, action: "would-stop" };
    if (!sameProcess(row)) return { ...row, action: "gone" };
    return stop(row, graceMs);
  });
  return { dryRun, daemons, bytes: daemons.filter((r) => r.action === (dryRun ? "would-stop" : "stopped")).reduce((sum, r) => sum + r.bytes, 0) };
}

export function reclaimText(result) {
  if (result.disabled) return "reclaim disabled (AGENT_ORCH_RECLAIM=off)";
  return result.daemons.length ? result.daemons.map((r) => `${r.action}: ${r.kind} pid ${r.pid} (${(r.bytes / 1024 / 1024).toFixed(1)} MiB) ${r.directory}${r.reason ? ` — ${r.reason}` : ""}${r.error ? ` — ${r.error}` : ""}`).join("\n") + `\n${result.dryRun ? "would reclaim" : "reclaimed"} ${(result.bytes / 1024 / 1024).toFixed(1)} MiB` : "no orphan build daemons";
}

// The worktree `orch worktree` made for this task inside its run folder, or null. Never the
// main checkout, a task's --cd, or a --path outside the run folder: other work may use those.
export function managedWorktree(run, task) {
  const recorded = task?.worktree?.path;
  if (!run?.dir || typeof recorded !== "string" || !path.isAbsolute(recorded)) return null;
  const root = real(run.dir), dir = real(recorded);
  if (dir === root || !inside(dir, root) || (run.repo && dir === real(run.repo))) return null;
  // A linked worktree has a .git file; a main checkout has a .git directory.
  try { return fs.lstatSync(path.join(dir, ".git")).isFile() ? dir : null; } catch { return null; }
}

export function reclaimTask(run, task) {
  if (process.env.AGENT_ORCH_RECLAIM === "off") return;
  const directory = managedWorktree(run, task);
  if (!directory) return;
  try {
    const result = reclaim({ directory });
    if (result.daemons.some((d) => ["stopped", "failed"].includes(d.action))) process.stderr.write(`${reclaimText(result)}\n`);
  } catch (error) { process.stderr.write(`orch: reclaim skipped: ${error.message}\n`); }
}
