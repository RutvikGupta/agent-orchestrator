import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_HASH_BYTES = 128 * 1024 * 1024;
const MAX_HASH_MS = 5000;

function gitFields(root, args) {
  const result = spawnSync("git", args, { cwd: root, timeout: 5000, maxBuffer: MAX_GIT_OUTPUT });
  if (result.status !== 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).split("\0").slice(0, -1);
  } catch {
    return null;
  }
}

function dirtyEntries(root, excludes) {
  const fields = gitFields(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all",
    "--ignored=traditional", "--", ...excludes]);
  if (fields === null) return null;
  const paths = new Set();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4 || field[2] !== " ") return null;
    paths.add(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2))) {
      // Porcelain -z emits destination then source for a rename or copy.
      const origin = fields[++i];
      if (!origin) return null;
      paths.add(origin);
    }
  }
  return { fields, paths };
}

function indexFingerprints(root, paths) {
  if (paths.size === 0) return new Map();
  const fields = gitFields(root, ["ls-files", "--stage", "-z"]);
  if (fields === null) return null;
  const index = new Map();
  for (const field of fields) {
    const separator = field.indexOf("\t");
    if (separator < 0) return null;
    const file = field.slice(separator + 1);
    if (!paths.has(file)) continue;
    const entry = field.slice(0, separator);
    index.set(file, (index.get(file) || "") + entry + "\n");
  }
  return index;
}

function fingerprint(file, budget) {
  if (Date.now() >= budget.deadline) return null;
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(file, { encoding: "buffer" }).toString("hex")}`;
    // Git may report a nested repository as a single directory.
    if (!stat.isFile() || stat.size > budget.bytes) return null;
    const mode = fs.constants;
    fd = fs.openSync(file, mode.O_RDONLY | mode.O_NOFOLLOW | mode.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return null;
    const hash = createHash("sha256");
    const buffer = budget.buffer;
    let read;
    do {
      if (Date.now() >= budget.deadline) return null;
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      budget.bytes -= read;
      if (budget.bytes < 0) return null;
      hash.update(buffer.subarray(0, read));
    } while (read > 0);
    const after = fs.fstatSync(fd);
    if (opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) return null;
    return `file:${opened.mode & 0o7777}:${hash.digest("hex")}`;
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function snapshotReadOnly(root, excludes) {
  if (!root) return null;
  const dirty = dirtyEntries(root, excludes);
  if (!dirty) return null;
  const index = indexFingerprints(root, dirty.paths);
  const budget = { deadline: Date.now() + MAX_HASH_MS, bytes: MAX_HASH_BYTES, buffer: Buffer.allocUnsafe(64 * 1024) };
  const files = new Map([...dirty.paths].map((file) => [file, fingerprint(path.join(root, file), budget)]));
  return { entries: dirty.fields, index, files };
}

export function readOnlyVerdict(before, after, originalStatus, currentStatus) {
  // A proven change wins even when one of the other checks has incomplete coverage.
  if (originalStatus && currentStatus && JSON.stringify(originalStatus) !== JSON.stringify(currentStatus)) return true;
  if (!before || !after) return null;
  if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) return true;
  let complete = Boolean(originalStatus && currentStatus && before.index && after.index);
  for (const [file, original] of before.files) {
    const current = after.files.get(file);
    if (original === null || current === null) complete = false;
    else if (original !== current) return true;
    if (before.index && after.index && before.index.get(file) !== after.index.get(file)) return true;
  }
  return complete ? false : null;
}
