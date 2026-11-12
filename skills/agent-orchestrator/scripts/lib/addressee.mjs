// Who must act on an attention item (its addressee), and how items reach the launching main session
// of a top-level run. That session has no inbox, so they reach it through its `wait` on the run:
//
// - A question that `ask` sends it has `to: "orchestrator"` in the asker's questions.jsonl. It shows
//   as a `question` attention item for the session and wakes its `wait` (exit 5).
// - A note that `tell` sends it goes into the run's notes.jsonl, one {id, time, from, about, text}
//   per line. It needs no answer, so it does not end the session's `wait`: the wait prints every
//   unread note, oldest first, with its next exit of any other kind (a result, attention, a message
//   or the timeout). `wait --notes` instead ends at the first new note (exit 6). notes-read.jsonl
//   records each note a wait has printed, one {id, time} per line, so none prints twice.
// - Each poll of a `wait` that the session runs (one that no orch task runs) records the time in the
//   run's main-wait.json, {pid, at}; `ps` shows a wait parked in its shell. A session with no live
//   `wait` on its run for AGENT_ORCH_AGENT_GRACE (15 minutes, and never less than twice
//   AGENT_ORCH_PARK_MAX) is gone, and its items go to the user.
//
// The Stop hook (hooks/orch-stop.mjs) imports this module, so it loads only config.mjs and util.mjs.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDuration, readJson, writeJson } from "./util.mjs";

// The `to` of a question for the launching main session of a top-level run.
export const ORCHESTRATOR = "orchestrator";
export const MAIN_WAIT_FILE = "main-wait.json";
export const NOTES_FILE = "notes.jsonl";
export const NOTES_READ_FILE = "notes-read.jsonl";

// Read when used, so a test or a session can set them per command. A parked `wait` records itself
// only when it returns to Node, at least every AGENT_ORCH_PARK_MAX (30s), so the grace is never
// shorter than two of those intervals, whatever AGENT_ORCH_AGENT_GRACE says.
export function agentGraceMs() {
  const grace = parseDuration(process.env.AGENT_ORCH_AGENT_GRACE || "15m");
  // `wait` itself rejects a bad AGENT_ORCH_PARK_MAX; here it only falls back to the default.
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(process.env.AGENT_ORCH_PARK_MAX || "30s").trim());
  const park = m ? Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] || "s"] : 30_000;
  return Math.max(grace, 2 * (park > 0 && Number.isFinite(park) ? park : 30_000));
}
export const reviewRemindMs = () => parseDuration(process.env.AGENT_ORCH_REVIEW_REMIND || "10m");

// The Claude Code or Codex session that launched a top-level run, or null: a run started from a
// terminal has the user as its orchestrator, and a nested run has an orch task.
export function mainSession(run) {
  const o = run?.orchestrator;
  return o && (o.agent === "claude" || o.agent === "codex") && !o.parentRun ? o : null;
}

// How the dashboard and notices name that session: "orchestrator session 425c2bc2".
export function sessionLabel(o) {
  return `orchestrator session ${o.sessionId ? String(o.sessionId).slice(0, 8) : `(${o.agent}${o.pid ? `, pid ${o.pid}` : ""})`}`;
}

const exists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Called on every poll of a `wait` that the main session runs, and as it exits.
export function noteMainWait(run, now = Date.now()) {
  try {
    writeJson(path.join(run.dir, MAIN_WAIT_FILE), { pid: process.pid, at: new Date(now).toISOString() });
  } catch {}
}

// When a `wait` of the main session was last live on the run, in ms since the epoch, or null.
export function mainWaitSeenMs(run) {
  return Date.parse(readJson(path.join(run.dir, MAIN_WAIT_FILE))?.at || "") || null;
}

const minutes = (ms) => `${Math.max(1, Math.round(ms / 60000))}m`;

// Every process as a map from PID to its command line, from one `ps`, or null when `ps` fails.
export function processCommands() {
  const r = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 1000 });
  if (r.status !== 0) return null;
  const table = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), m[2]);
  }
  return table;
}

// Whether a `wait` on the run is live now, from a process table (PID to command line): a process
// whose command line is a wait on the run (waitsOn), parked or not, or the process that
// main-wait.json names while it still runs a wait (a `wait latest` names its run only once it parks).
export function waitLive(run, table) {
  if (!table) return false;
  for (const command of table.values()) if (waitsOn(command, run)) return true;
  const pid = Number(readJson(path.join(run.dir, MAIN_WAIT_FILE))?.pid);
  return Boolean(pid) && String(table.get(pid) ?? "").includes("orch.mjs wait");
}

// Why the main session no longer takes its items, or null while it does. It takes them while one
// of its waits on the run is live: recorded within the grace (agentGraceMs), or seen in `ps`, which
// also finds a wait parked in its shell. Past that, it is gone when its process has ended or when no
// wait has been live for the grace. A run's age stands in for a wait that never ran. A resumed
// session runs in a new process, so a live wait outweighs the old PID. `table` is a process table
// from processCommands(); without one, it runs `ps` itself, only when the record is too old.
export function sessionGone(run, session = mainSession(run), now = Date.now(), table = undefined) {
  const grace = agentGraceMs();
  const seen = mainWaitSeenMs(run);
  if (seen && now - seen < grace) return null;
  if (waitLive(run, table === undefined ? processCommands() : table)) return null;
  if (session?.pid && !exists(session.pid)) return "its process has ended";
  const since = seen ?? (Date.parse(run.createdAt) || now);
  if (now - since < grace) return null;
  return seen ? `no wait on its run for ${minutes(now - seen)}` : `no wait on its run in ${minutes(now - since)}`;
}

// The JSON lines of a file. A missing file has none, and a torn or corrupt line is skipped.
function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const value = line.trim() ? JSON.parse(line) : null;
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function appendNote(run, entry) {
  const note = { id: randomUUID().slice(0, 8), time: new Date().toISOString(), ...entry };
  fs.appendFileSync(path.join(run.dir, NOTES_FILE), `${JSON.stringify(note)}\n`);
  return note;
}

// The run's notes for its main session that no wait has printed yet, oldest first.
export function unreadNotes(run) {
  const read = new Set(readLines(path.join(run.dir, NOTES_READ_FILE)).map((r) => r.id));
  return readLines(path.join(run.dir, NOTES_FILE)).filter((n) => typeof n.id === "string" && typeof n.text === "string" && !read.has(n.id));
}

export function markNotesRead(run, ids) {
  if (!ids.length) return;
  const time = new Date().toISOString();
  fs.appendFileSync(path.join(run.dir, NOTES_READ_FILE), ids.map((id) => `${JSON.stringify({ id, time })}\n`).join(""));
}

// A note as `wait` prints it.
export const noteText = (n) => `note from ${String(n.from || "an agent").replace(/^agent:/, "agent ")} (${n.time}): ${n.text}`;

// Whether a process's command line is a `wait` on the run: `orch.mjs wait <run> ...`, the shell it
// parks in between checks (whose name is that command, with the run's folder), or the Node process
// that shell resumes (whose source starts with that command in a comment). A `wait latest` names its
// run only once it parks. `ps` shows the parked shell's newlines as \012.
export function waitsOn(command, run) {
  const text = String(command || "");
  const at = text.indexOf("orch.mjs wait ");
  if (at < 0) return false;
  const rest = ` ${text.slice(at + "orch.mjs wait ".length)} `;
  return rest.includes(` ${run.dir} `) || rest.includes(` ${run.dir}/ `) || rest.includes(` ${run.id} `);
}
