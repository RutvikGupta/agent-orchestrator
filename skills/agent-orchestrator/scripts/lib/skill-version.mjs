// Skill version: tells a running session or task that the skill's instructions changed after it read
// them. A session keeps working from the copy it loaded earlier, so every `orch.mjs` command checks.
//
// The fingerprint covers the files an agent reads: SKILL.md, policy.json and every file under
// references/. Each caller (a main session, or a delegated task) has a record under the state root,
// kept per skill folder, with the fingerprint it saw, each file's size, modification time and hash,
// and, in a git checkout, the commit then. The first command of a caller writes the record. A later
// command compares the files with it: sizes and modification times first, so an unchanged skill
// costs a few stat calls and no hashing, and only a file whose stat differs is read and hashed. When
// the fingerprint differs, the command prints a notice on stderr (never stdout, so `--json` stays
// valid) and runs on. `orch.mjs skill --loaded` records the current fingerprint and ends the notice.
//
// A file edited in place with the same size and the same modification time goes unseen; no editor
// or checkout does that.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CACHE_PATH, CLI_PATH, SKILL_DIR, STATE_ROOT } from "./config.mjs";
import { detectOrchestrator } from "./runs.mjs";
import { readJson, writeJson } from "./util.mjs";

const RECORD_VERSION = 1;
export const RECORDS_DIR = path.join(STATE_ROOT, "skill-seen");
export const RECORD_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // a record unused for this long is removed
const REFRESH_AFTER_MS = 24 * 3600 * 1000; // a record in use is touched when it is this old, so it survives
const MAX_COMMITS = 5;
const MAX_FILES_SHOWN = 10;
// Paths, relative to the skill folder, that the commit list covers.
const INSTRUCTION_PATHS = ["SKILL.md", "policy.json", "references"];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// The instruction files of a skill folder, as sorted paths relative to it.
export function listInstructionFiles(dir) {
  const out = [];
  const add = (rel) => {
    if (CACHE_PATH.test(rel)) return;
    try {
      if (fs.statSync(path.join(dir, rel)).isFile()) out.push(rel);
    } catch {}
  };
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else add(child);
    }
  };
  add("SKILL.md");
  add("policy.json");
  walk("references");
  return out.sort();
}

// The fingerprint of a skill folder and what it was made from: { fingerprint, files, hashed }, with
// `files` mapping each path to { size, mtimeMs, hash }. `previous` is an earlier `files`: a file
// whose size and modification time match it keeps its hash without being read, and `hashed` counts
// the files that were read.
export function scan(dir, previous = null) {
  const files = {};
  let hashed = 0;
  for (const rel of listInstructionFiles(dir)) {
    const file = path.join(dir, rel);
    try {
      // The stat comes first: a file that changes after it is seen as changed by the next scan.
      const st = fs.statSync(file);
      const old = previous?.[rel];
      let hash = old && old.size === st.size && old.mtimeMs === st.mtimeMs ? old.hash : null;
      if (!hash) {
        hash = sha256(fs.readFileSync(file));
        hashed++;
      }
      files[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
    } catch {}
  }
  const fingerprint = sha256(Object.keys(files).sort().map((rel) => `${rel}\0${files[rel].hash}\n`).join(""));
  return { fingerprint, files, hashed };
}

// Which files differ between two `files` maps (an earlier one and the current one), by content.
export function diffFiles(before = {}, after = {}) {
  const changed = Object.keys(after).filter((rel) => before[rel] && before[rel].hash !== after[rel].hash);
  const added = Object.keys(after).filter((rel) => !before[rel]);
  const removed = Object.keys(before).filter((rel) => !after[rel]);
  return { changed, added, removed };
}

// Who is calling, as { key, label }, or null for a caller with no identity (a plain terminal). A
// delegated task is named by AGENT_ORCH_RUN and AGENT_ORCH_TASK; a main session by its Claude Code
// or Codex session id. When both hosts' variables are set (a Codex session started from Claude Code
// inherits Claude's), the nearest host decides, as detectOrchestrator finds it; that costs a `ps`,
// so it is asked only then.
export function skillCaller(env = process.env) {
  if (env.AGENT_ORCH_DEPTH) {
    const { AGENT_ORCH_RUN: run, AGENT_ORCH_TASK: task } = env;
    return run && task ? { key: `task:${run}/${task}`, label: `task ${task} of run ${run}` } : null;
  }
  const claude = env.CLAUDE_CODE_SESSION_ID || null;
  const codex = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
  let agent = null;
  let id = null;
  if (claude && codex) {
    const found = detectOrchestrator();
    ({ agent, sessionId: id } = found);
  } else if (claude || codex) {
    agent = claude ? "claude" : "codex";
    id = claude || codex;
  }
  return id && agent ? { key: `${agent}:${id}`, label: `${agent} session ${id}` } : null;
}

// Whether commands check on their own. AGENT_ORCH_SKILL_NOTICE=0|off turns the check off and =1|on
// turns it on. Unset, it is on, except where AGENT_ORCH_SKILLS_DIR pins the skills folder, which
// is how tests and experiments isolate themselves from the user's setup.
export function noticeEnabled(env = process.env) {
  const v = String(env.AGENT_ORCH_SKILL_NOTICE ?? "").trim().toLowerCase();
  if (["0", "off", "no", "false"].includes(v)) return false;
  if (["1", "on", "yes", "true"].includes(v)) return true;
  return !env.AGENT_ORCH_SKILLS_DIR;
}

// One record per caller and skill folder: a caller that runs another copy of the skill (a checkout
// it is editing) is not told that the copy differs from the live one.
export const recordFile = (caller, dir = SKILL_DIR) => path.join(RECORDS_DIR, `${sha256(`${caller.key}\0${dir}`).slice(0, 32)}.json`);

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000 });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
}

const SHA = /^[0-9a-f]{40,64}$/;

// The commit HEAD names, read from the .git files without starting git (a spawn is the largest part
// of a first command's cost): the checkout above `dir`, plain or a linked worktree, with HEAD a branch
// (loose or packed) or a commit. null: no checkout. undefined: a checkout this cannot read, as with
// a newer ref format, so git is asked.
function readHead(dir) {
  for (let d = dir, up = 0; up < 8; d = path.dirname(d), up++) {
    const dot = path.join(d, ".git");
    try {
      let gitDir = dot;
      if (fs.statSync(dot).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"));
        if (!m) return undefined;
        gitDir = path.resolve(d, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (SHA.test(head)) return head;
      const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
      if (!ref) return undefined;
      let common = gitDir; // a linked worktree keeps its refs in the main checkout's folder
      try {
        common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
      } catch {}
      for (const base of [gitDir, common]) {
        try {
          const sha = fs.readFileSync(path.join(base, ref), "utf8").trim();
          if (SHA.test(sha)) return sha;
        } catch {}
      }
      try {
        for (const line of fs.readFileSync(path.join(common, "packed-refs"), "utf8").split("\n")) {
          const [sha, name] = line.split(" ");
          if (name?.trim() === ref && SHA.test(sha)) return sha;
        }
      } catch {}
      return undefined;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return undefined;
    }
    if (path.dirname(d) === d) break;
  }
  return null;
}

// The commit a checkout is at, or null when the skill folder is not in a git checkout.
export function headCommit(dir = SKILL_DIR) {
  const quick = readHead(dir);
  return quick === undefined ? git(dir, ["rev-parse", "HEAD"]) || null : quick;
}

// The subjects of the commits that touched the instruction files after `since`, newest first, at most
// MAX_COMMITS, with whether older ones were left out; null when git cannot say (no checkout, or a
// commit it no longer has).
export function commitsSince(since, dir = SKILL_DIR) {
  if (!since) return null;
  const out = git(dir, ["log", "--format=%s", `--max-count=${MAX_COMMITS + 1}`, `${since}..HEAD`, "--", ...INSTRUCTION_PATHS]);
  if (out === null) return null;
  const subjects = out ? out.split("\n") : [];
  return { subjects: subjects.slice(0, MAX_COMMITS), more: subjects.length > MAX_COMMITS };
}

function pruneRecords(now = Date.now()) {
  try {
    for (const name of fs.readdirSync(RECORDS_DIR)) {
      const file = path.join(RECORDS_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs > RECORD_MAX_AGE_MS) fs.rmSync(file, { force: true });
      } catch {}
    }
  } catch {}
}

// Write the caller's record for what `scanned` found, and drop records unused for 30 days.
function saveRecord(caller, scanned, dir) {
  const record = {
    version: RECORD_VERSION, key: caller.key, skillDir: dir, recordedAt: new Date().toISOString(),
    fingerprint: scanned.fingerprint, commit: headCommit(dir), files: scanned.files,
  };
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  writeJson(recordFile(caller, dir), record);
  pruneRecords();
  return record;
}

const readRecord = (caller, dir) => {
  const record = readJson(recordFile(caller, dir));
  return record?.version === RECORD_VERSION && record.fingerprint && record.files ? record : null;
};

// The caller's standing: { dir, caller, recorded, current, changed, files }. `recorded` is its record
// (null if it has none), `current` what the files are now, `changed` whether they differ (null with
// no record), and `files` which ones.
export function skillState(dir = SKILL_DIR, caller = skillCaller()) {
  const recorded = caller ? readRecord(caller, dir) : null;
  const current = scan(dir, recorded?.files);
  const changed = recorded ? recorded.fingerprint !== current.fingerprint : null;
  return { dir, caller, recorded, current, changed, files: diffFiles(recorded?.files, current.files) };
}

// Record the current fingerprint for the caller (`skill --loaded`). Returns the record, or null for a
// caller with no identity.
export function markLoaded(state) {
  return state.caller ? saveRecord(state.caller, state.current, state.dir) : null;
}

const shown = (list) => (list.length > MAX_FILES_SHOWN ? `${list.slice(0, MAX_FILES_SHOWN).join(", ")} and ${list.length - MAX_FILES_SHOWN} more` : list.join(", "));

// The lines that say what changed: the files, the commits since the record (in a git checkout), and
// where to read again. Shared by the notice and `skill`.
export function changeLines(state) {
  const { files, recorded, dir } = state;
  const parts = [];
  if (files.changed.length) parts.push(`changed ${shown(files.changed)}`);
  if (files.added.length) parts.push(`added ${shown(files.added)}`);
  if (files.removed.length) parts.push(`removed ${shown(files.removed)}`);
  const lines = [`Files: ${parts.join("; ") || "(none)"}`];
  const commits = commitsSince(recorded?.commit, dir);
  if (commits?.subjects.length) {
    lines.push(`Commits since you loaded it, newest first:`);
    for (const subject of commits.subjects) lines.push(`  - ${subject.length > 120 ? `${subject.slice(0, 117)}...` : subject}`);
    if (commits.more) lines.push("  - (and older ones)");
  }
  const changedPaths = [...files.changed, ...files.added].filter((rel) => rel !== "SKILL.md");
  lines.push(`Read again: ${path.join(dir, "SKILL.md")}${changedPaths.length ? `, then ${changedPaths.length === 1 ? "this file" : "these files"} under ${dir}: ${shown(changedPaths)}` : ""}.`);
  return lines;
}

export const noticeText = (state) => [
  "orch: the skill changed since this session loaded it.",
  ...changeLines(state),
  `After you have read it, run: node ${CLI_PATH} skill --loaded (this notice repeats on every orch.mjs command until then).`,
].join("\n  ") + "\n";

// The check every command runs first, before its own output. Never fails the command. The first
// command of a caller writes its record; a later one with a different fingerprint prints the notice
// (not for `skill`, which reports the same thing itself).
export function checkSkill(command, { dir = SKILL_DIR, env = process.env } = {}) {
  try {
    if (!noticeEnabled(env)) return;
    const caller = skillCaller(env);
    if (!caller) return;
    const state = skillState(dir, caller);
    if (!state.recorded) {
      saveRecord(caller, state.current, dir);
      return;
    }
    const file = recordFile(caller, dir);
    if (!state.changed) {
      // Same content, but a file was touched or rewritten: remember its new stat, so the next check
      // does not read it again. The record keeps its own time and commit.
      if (state.current.hashed) writeJson(file, { ...state.recorded, files: state.current.files });
      else if (Date.now() - fs.statSync(file).mtimeMs > REFRESH_AFTER_MS) fs.utimesSync(file, new Date(), new Date());
      return;
    }
    if (Date.now() - fs.statSync(file).mtimeMs > REFRESH_AFTER_MS) fs.utimesSync(file, new Date(), new Date());
    if (command !== "skill") process.stderr.write(noticeText(state));
  } catch {}
}
