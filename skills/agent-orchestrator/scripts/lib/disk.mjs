// Free disk space: one reading of the volume that holds a folder, and the minimum below which no
// worktree is created (AGENT_ORCH_MIN_FREE_DISK). A full disk can crash the whole machine, and
// worktrees are what fills it, so worktree creation refuses below the minimum (worktree-gc.mjs,
// ensureDisk), automatic collection works faster while the disk is low, and the dashboard shows it.

import fs from "node:fs";
import path from "node:path";
import { CLI_PATH, STATE_ROOT } from "./config.mjs";

export const DEFAULT_MIN_FREE = "15GB";
const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };

// A size setting: bytes, or a number with a unit, as the memory settings take it: KB, MB, GB and TB
// count in powers of 1000, KiB, MiB, GiB and TiB in powers of 1024 ("15GB", "500 MB", "20GiB").
export function parseSize(value, name) {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/i.exec(String(value).trim());
  if (!m) throw new Error(`${name} needs bytes or a size such as 15GB, 500MB or 20GiB (0 turns the check off), not "${value}"`);
  return Math.round(Number(m[1]) * UNITS[(m[2] || "B").toUpperCase()]);
}

// The least free space at which a worktree may be created: AGENT_ORCH_MIN_FREE_DISK, default 15GB;
// 0 turns the guard off. Throws on a value it cannot read.
export function minFreeBytes(env = process.env) {
  const value = env.AGENT_ORCH_MIN_FREE_DISK;
  return parseSize(value === undefined || value === "" ? DEFAULT_MIN_FREE : value, "AGENT_ORCH_MIN_FREE_DISK");
}

// statfs needs a path that exists: the folder, or the nearest folder above it.
function existingDir(dir) {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

// The volume's free space (what an unprivileged process may still write) and its size.
export function statfsReading(dir) {
  const s = fs.statfsSync(existingDir(dir));
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}

// A test sets the free space with AGENT_ORCH_DISK_FREE_BYTES: one number, or a comma-separated list
// taken one per reading in this process, the last repeating, so that space can appear after a
// collection. AGENT_ORCH_DISK_TOTAL_BYTES sets the volume's size. No real reading is taken then.
let forcedReads = 0;
function forcedReading(env) {
  const list = env.AGENT_ORCH_DISK_FREE_BYTES;
  if (list === undefined || list === "") return null;
  const values = String(list).split(",").map((v) => parseSize(v, "AGENT_ORCH_DISK_FREE_BYTES"));
  const freeBytes = values[Math.min(forcedReads++, values.length - 1)];
  const total = env.AGENT_ORCH_DISK_TOTAL_BYTES;
  return { freeBytes, totalBytes: total ? Math.max(freeBytes, parseSize(total, "AGENT_ORCH_DISK_TOTAL_BYTES")) : freeBytes };
}

// The disk state of the volume that holds `dir` (default: the state root): { dir, freeBytes,
// totalBytes, minBytes, low, critical }. `critical` is free space below the minimum, `low` below
// twice it; with a minimum of 0 neither ever holds. A reading that fails is not low: `error` says
// why, and the free and total sizes are null. Throws on an invalid setting. `read` replaces the
// statfs reading (a test's injected reading).
export function diskState(dir = STATE_ROOT, { read = statfsReading, env = process.env } = {}) {
  const minBytes = minFreeBytes(env);
  let reading;
  try {
    reading = forcedReading(env) || read(dir);
  } catch (error) {
    if (/^AGENT_ORCH_/.test(error.message)) throw error;
    return { dir, freeBytes: null, totalBytes: null, minBytes, low: false, critical: false, error: error.message };
  }
  const { freeBytes, totalBytes } = reading;
  return { dir, freeBytes, totalBytes, minBytes, low: minBytes > 0 && freeBytes < 2 * minBytes, critical: minBytes > 0 && freeBytes < minBytes };
}

// A disk size as the system shows it, in powers of 1000: "42 GB", "9.2 GB", "659 MB".
export function diskSize(bytes) {
  const units = [["TB", 1e12], ["GB", 1e9], ["MB", 1e6], ["KB", 1e3]];
  const [unit, size] = units.find(([, n]) => bytes >= n) || ["bytes", 1];
  if (unit === "bytes") return `${bytes} bytes`;
  const value = bytes / size;
  return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${unit}`;
}

// "disk 42 GB free", the dashboard header's words.
export function diskSummary(state) {
  return state.freeBytes == null ? "disk unknown" : `disk ${diskSize(state.freeBytes)} free`;
}

// The commands that free space, one per line.
export function freeSpaceCommands() {
  return [
    `node ${CLI_PATH} gc --dry-run   (lists what gc would remove)`,
    `node ${CLI_PATH} gc   (removes the worktrees of idle runs that you own or whose session has ended)`,
    `node ${CLI_PATH} close RUN TASK...   (closes tasks you are done with, which removes their worktrees)`,
    "git worktree remove PATH   (removes a worktree you made by hand)",
  ];
}

// Where the free space and its minimum stand, in one sentence.
export function diskLevelText(state) {
  if (state.error) return `the free disk space could not be read (${state.error})`;
  const level = state.critical ? "below the minimum" : state.low ? "low, under twice the minimum" : "above twice the minimum";
  return `${diskSize(state.freeBytes)} free of ${diskSize(state.totalBytes)} on the volume that holds ${state.dir}: ${level} of ${diskSize(state.minBytes)} (AGENT_ORCH_MIN_FREE_DISK)`;
}

// The refusal when the disk stays below the minimum: the free space, the minimum, what automatic
// collection did, and the commands that free space. `collected` is { removed, bytesFreed }.
export function diskRefusal(state, { what = "create a worktree", collected = null } = {}) {
  return [
    `refusing to ${what}: only ${diskSize(state.freeBytes)} of disk is free on the volume that holds ${state.dir}, below the minimum of ${diskSize(state.minBytes)} (AGENT_ORCH_MIN_FREE_DISK).`,
    ...(collected ? [`Automatic collection removed ${collected.removed} worktree${collected.removed === 1 ? "" : "s"} first and freed ${diskSize(collected.bytesFreed)}, which was not enough.`] : []),
    "Free space, then try again:",
    ...freeSpaceCommands().map((line) => `  ${line}`),
    "Nothing was created.",
  ].join("\n  ");
}
