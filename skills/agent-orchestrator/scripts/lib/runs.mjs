// Runs and tasks: where they live, how they are loaded and saved, and what state each task is in.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLI_PATH, DEPTH, QUIET_AFTER_MS, RUNS_DIR, TASK_ID } from "./config.mjs";
import { asksDecision, decisionsIn } from "./briefs.mjs";
import { failureHistory } from "./escalation.mjs";
import { inboxFields, readInbox } from "./inbox.mjs";
import { attemptReasonOf, isClosedPreparation, lifecycleFields, verificationsOf, verificationsPath } from "./lifecycle.mjs";
import { reportFields } from "./report.mjs";
import { codexRolloutFor } from "./codex.mjs";
import { attemptCost, attemptModel } from "./cost.mjs";
import { commandRuns, newSummary, shellNow, summarizeEvents, summarizeRollout } from "./events.mjs";
import { firstLine, formatElapsed, shortText } from "./format.mjs";
import { COMMAND_AGENT, modelLabel } from "./policy.mjs";
import { die, readJson, tailText, writeJson } from "./util.mjs";

export function resolveRunDir(ref) {
  if (!ref) die("missing RUN (a run id, a run directory, or 'latest')", 2);
  if (ref === "latest") {
    const runs = listRuns();
    if (!runs.length) die(`no runs in ${RUNS_DIR}`);
    return runs[0].dir;
  }
  if (fs.existsSync(path.join(ref, "run.json"))) return path.resolve(ref);
  const dir = path.join(RUNS_DIR, ref);
  if (fs.existsSync(path.join(dir, "run.json"))) return dir;
  die(`unknown run "${ref}" (see: node orch.mjs runs)`);
}

export function loadRun(ref) {
  const dir = resolveRunDir(ref);
  return { ...readJson(path.join(dir, "run.json")), dir };
}

export function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .map((id) => path.join(RUNS_DIR, id))
    .filter((dir) => fs.existsSync(path.join(dir, "run.json")))
    .map((dir) => ({ ...readJson(path.join(dir, "run.json")), dir }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function validTask(id) {
  if (!id) die("missing TASK id", 2);
  if (!TASK_ID.test(id)) die(`task id "${id}" must match ${TASK_ID} (lowercase, digits, . _ -)`, 2);
  return id;
}

export function taskDir(run, id) {
  return path.join(run.dir, "tasks", id);
}

export function loadTask(run, id) {
  return readJson(path.join(taskDir(run, id), "task.json"));
}

export function saveTask(run, task) {
  fs.mkdirSync(taskDir(run, task.id), { recursive: true });
  writeJson(path.join(taskDir(run, task.id), "task.json"), task);
}

// Names (`rename`). A task's id is the stable key of everything it has: its folder, its relay's
// --out-dir, AGENT_ORCH_TASK in its shell, its inbox, worktree, branch and nested runs. A name is
// what people and agents see and type instead: the views show it in place of the id, and every
// command that takes a task accepts it, for that run. An id always wins over a name.

// The task of `run` whose current name is `name`, or null.
export function taskNamed(run, name) {
  if (!name || !TASK_ID.test(name)) return null;
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(run.dir, "tasks"));
  } catch {
    return null;
  }
  for (const id of ids) {
    const task = loadTask(run, id);
    if (task?.name === name) return task;
  }
  return null;
}

// The task id that `ref` names in `run`: a task's own id, which always wins, or a task's current
// name. Anything else comes back unchanged, for the command to report as it always has.
export function taskIdOf(run, ref) {
  if (!ref || typeof ref !== "string" || !TASK_ID.test(ref)) return ref;
  if (fs.existsSync(path.join(taskDir(run, ref), "task.json"))) return ref;
  return taskNamed(run, ref)?.id ?? ref;
}

// What views show for a task or a row: its name, or its id when it has none.
export const shownName = (t) => t?.name || t?.id;

// A task's names before its current one, oldest first, each once.
export function earlierNames(task) {
  const names = (task?.names || []).map((n) => n?.name).filter((n) => n && n !== task.name);
  return [...new Set(names)];
}

// One `ps` lists every process's parent and command for all the tasks a refresh checks, instead
// of one `ps` per task. A PID missing from a snapshot (a process started since) refreshes it. In
// the dashboard server, which answers every request from one thread, an expired snapshot refreshes
// in the background and checks keep using it meanwhile; only a missing PID waits for `ps`.
const PROCESS_TABLE_MS = 1000;
const PS_ARGS = ["-axww", "-o", "pid=,ppid=,command="];
let processTable = { at: 0, rows: null }, backgroundTable = false, tableLoading = false;
export function readProcessesInBackground() {
  backgroundTable = true;
}
function parseTable(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}
function refreshTableInBackground() {
  if (tableLoading) return;
  tableLoading = true;
  let out = "";
  const child = spawn("ps", PS_ARGS, { stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
  child.on("error", () => { tableLoading = false; });
  child.on("close", (code) => {
    tableLoading = false;
    if (code === 0) processTable = { at: Date.now(), rows: parseTable(out) };
  });
}
function readTable() {
  const r = spawnSync("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 5000 });
  if (r.status !== 0) return null;
  processTable = { at: Date.now(), rows: parseTable(r.stdout) };
  return processTable.rows;
}

// The shared snapshot when it is fresh, without reading a new one; otherwise null.
export function freshProcessTable() {
  return Date.now() - processTable.at < PROCESS_TABLE_MS ? processTable.rows : null;
}

// Every process, as a map from PID to { ppid, command }, from the same shared snapshot.
export function processSnapshot() {
  if (Date.now() - processTable.at < PROCESS_TABLE_MS) return processTable.rows;
  if (backgroundTable && processTable.rows) {
    refreshTableInBackground();
    return processTable.rows;
  }
  return readTable();
}

// A process's command line from the shared snapshot: null when the process is not in the table,
// undefined when `ps` could not read the table (it times out on a heavily loaded machine).
function processCommand(pid) {
  const before = processTable.at;
  let rows = processSnapshot();
  if (rows && !rows.has(pid) && processTable.at === before) rows = readTable();
  if (!rows) return undefined;
  return rows.get(pid)?.command ?? null;
}

// Whether a relay's command line is the one that writes to attempt folder `outDir`: every relay
// is started with `--out-dir <its attempt folder>`.
export const relayOf = (command, outDir) => {
  const at = command.indexOf(`--out-dir ${outDir}`);
  const next = at < 0 ? null : command[at + `--out-dir ${outDir}`.length];
  return at >= 0 && (next === undefined || next === " ");
};

export function relayAlive(pid, startedAt = null, outDir = null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  // Guard against PID reuse: the live process must still be a relay, and this task's own: one
  // started for another task's attempt folder is a later process that was given the same PID, so
  // the task has ended, and nothing may signal that PID on its behalf. Right after `start` forks
  // it, the child still shows the parent's command until it execs, so a process that exists
  // within a few seconds of the recorded start counts as the relay.
  const command = processCommand(pid);
  // `ps` failed while the PID exists: trust the PID, as before start times were checked. Calling a
  // live relay dead would report it aborted and let `start` launch a second agent for the task.
  if (command === undefined) return true;
  if (command?.includes("relay.mjs")) return outDir ? relayOf(command, outDir) : true;
  const age = startedAt ? Date.now() - Date.parse(startedAt) : Infinity;
  return command !== null && age >= 0 && age < 10000;
}

// Wait until a stopped relay has exited, so a following `start` of the same task does not race it.
export function waitForExit(pid, ms = 15000, outDir = null) {
  const until = Date.now() + ms;
  while (relayAlive(pid, null, outDir) && Date.now() < until) spawnSync("sleep", ["0.2"]);
  return !relayAlive(pid, null, outDir);
}

// A task may switch agents between attempts, so each attempt is parsed as its own agent's stream.
export function attemptAgent(task, n) {
  return task.attemptAgents?.[n] || task.agent;
}

// A command task's argument vector as one line a shell would read back: words with only safe
// characters as they are, others in single quotes.
export function commandText(argv) {
  return (Array.isArray(argv) ? argv : []).map((word) => {
    const text = String(word);
    return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
  }).join(" ");
}

// A command task's progress (command-relay.mjs): its latest non-blank output line, or null, and how
// many lines it has printed, from the newest output events at the end of its events.jsonl. Each
// event is small, so a short tail holds the latest; read again only when the file changes.
const progressMemo = new Map(); // events.jsonl path -> { size, mtimeMs, value }
function commandProgress(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { line: null, lines: 0 };
  }
  const hit = progressMemo.get(file);
  if (hit?.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  const value = { line: null, lines: 0 };
  const events = (tailText(file, 131_072) || "").split("\n");
  for (let i = events.length - 1; i >= 0 && !value.line; i--) {
    if (!events[i].includes('"command_output"')) continue;
    try {
      const e = JSON.parse(events[i]);
      if (!value.lines) value.lines = Number(e.command_output?.last) || 0;
      value.line = String(e.message?.content?.[0]?.content ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) || null;
    } catch {
      // A line still being written.
    }
  }
  if (progressMemo.size >= 500) progressMemo.delete(progressMemo.keys().next().value);
  progressMemo.set(file, { size: st.size, mtimeMs: st.mtimeMs, value });
  return value;
}

// A finished command task's activity line: its last line of output, after the reason it failed.
function commandOutcome(result) {
  const last = String(result.finalMessage || "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) || "";
  const error = typeof result.error === "string" ? result.error : "";
  return shortText(result.status === "completed" || !error ? last : last ? `${error} · ${last}` : error, 300);
}

function attemptDirs(run, task) {
  const dirs = [];
  for (let n = 1; n <= (task.attempt || 0); n++) dirs.push({ dir: path.join(taskDir(run, task.id), `attempt-${n}`), agent: attemptAgent(task, n) });
  return dirs;
}

// The outcome word of a final message's last orch-result block (done, partial, blocked or parked),
// whether it hands back decisions, and whether the message has such a block at all (`present`, also
// for one that does not parse); report.mjs parses the current attempt's report in full.
function reportOutcome(message) {
  let last;
  for (const block of String(message || "").matchAll(/^[\t ]*```orch-result[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*(?=\r?$)/gm)) last = block[1];
  if (last === undefined) return { present: false, outcome: null, decisions: false };
  try {
    const value = JSON.parse(last.trim());
    return { present: true, failedCheck: Array.isArray(value?.checks) && value.checks.some((c) => c?.result === "fail"), outcome: ["done", "partial", "blocked", "parked"].includes(value?.outcome) ? value.outcome : null, decisions: Array.isArray(value?.decisions) && value.decisions.some(asksDecision) };
  } catch {
    return { present: true, outcome: null, decisions: false };
  }
}

// Parking (park.mjs). A task that has nothing left to do but wait ends its turn with a final
// message whose first (or last) line starts with `PARKED:` (and an orch-result outcome `parked`).
// Its relay and agent exit, and a small watcher resumes the same session on the next event. Until
// then describe() reports the task as running, in phase `parked`, so `wait` keeps waiting for it.
// A pull-request babysitter always parks that way; any other Claude or Codex task parks only when
// something can wake it (parkBasis): a wake condition it recorded with `park-until` in that attempt
// (park-until.json in the attempt's folder), or a task it started that was still running when the
// attempt ended (children.jsonl in the task's folder, one line per start). Each parked attempt's
// folder holds the park's files: park-watcher-<k>.json, one per watcher started (the highest k is
// the current one); park-check.json, the latest check; and park-claim-<k>.json, the claims that end
// the park (a resume, `stop` or `close`), each created exclusively with the next k, so exactly one
// claimant wins, and recording its owner's PID and start time.
export const PARK_CHECK_FILE = "park-check.json";
export const PARK_UNTIL_FILE = "park-until.json";
export const CHILDREN_FILE = "children.jsonl";
// The finish watcher's claim on an attempt's notice (finish-notice.mjs), which also records the
// fix attempt it started for a babysitter's NEEDS FIX, or why it started none.
export const NOTICE_FILE = "parent-notice.json";
const PARK_WATCHER_RE = /^park-watcher-(\d+)\.json$/;
const PARK_CLAIM_RE = /^park-claim-(\d+)\.json$/;
export const parkWatcherFile = (dir, generation) => path.join(dir, `park-watcher-${generation}.json`);
export const parkClaimFile = (dir, generation) => path.join(dir, `park-claim-${generation}.json`);
const PARKED_RE = /^PARKED:\s*(.*?)\s*$/;
const NEEDS_FIX_RE = /^NEEDS FIX:\s*(.*?)\s*$/;
const WATCHER_GRACE_MS = 15000;
const CLAIM_GRACE_MS = 60000; // a claim that names no owner counts as live this long
// A babysitter's watch attempt that ended with NEEDS FIX shows as running while its fix attempt
// starts; when none has started this long after, it is handed to the orchestrator instead.
const FIX_GRACE_MS = 15 * 60000;

// The match of `re` on a final message's first line, or on the last line of its text (before an
// orch-result block), as `exec` returns it; null when neither line matches. The line must start
// with the marker itself, neither quoted nor indented: agents asked to "end with" a line put it
// last, and a marker quoted or in the middle of the text is only mentioned.
function edgeLine(message, re) {
  const body = String(message || "").split(/^[\t ]*```orch-result[\t ]*\r?$/m)[0];
  const lines = body.split("\n").filter((line) => line.trim());
  return [lines[0], lines[lines.length - 1]].map((line) => (line ? re.exec(line.replace(/\r$/, "")) : null)).find(Boolean) || null;
}

// What a final message says the task waits for ("PR #42 waits for a human review"), or null when it
// does not park. A line that starts with `PARKED:` must be the message's first line, or the last
// line of its text (edgeLine): a babysitter that meant to park must not end unwatched. A `PARKED:`
// line in the middle does not park. When the message has an orch-result block, that block's
// outcome must be `parked` too: a message whose two signals disagree does not park. A message that
// hands back a decision, or asks for a fix (needsFixSignal), does not park.
export function parkedSignal(message) {
  const said = parkedText(message);
  return said === null ? null : said || "its pull request";
}

// The text after a parking final message's `PARKED:`, which may be empty; null when it does not park.
function parkedText(message) {
  const text = String(message || "");
  const m = edgeLine(text, PARKED_RE);
  if (!m || edgeLine(text, NEEDS_FIX_RE)) return null;
  const report = reportOutcome(text);
  if ((report.present && report.outcome !== "parked") || report.decisions || decisionsIn(text)) return null;
  return m[1];
}

// What a babysitter's final message says needs fixing ("PR #42 the unit check fails on a renamed
// import"), or null. The `NEEDS FIX:` line follows the rules of the `PARKED:` line (edgeLine). A
// watch attempt that runs below the complex tier ends with it to hand a code change or a
// substantive reply to a fix attempt (finish-notice.mjs). A message that hands back a decision, or
// whose orch-result outcome is `parked`, asks for no fix.
export function needsFixSignal(message) {
  const text = String(message || "");
  const m = edgeLine(text, NEEDS_FIX_RE);
  if (!m) return null;
  const report = reportOutcome(text);
  if (report.outcome === "parked" || report.decisions || decisionsIn(text)) return null;
  return m[1] || "a fix";
}

// Whether a task babysits a pull request.
export const isBabysitter = (task) => Boolean(task?.babysit || task?.plan?.type === "babysit");

// Whether a task's current attempt ended because of a stop: `stop`, or `close` of a task that still
// ran, recorded it on the task (stoppedAt), no later `start` cleared it, and the attempt did not end
// on its own first. That holds when the relay left no result, when its result is an unsuccessful one
// written as the stop came or after (a relay records `aborted` on SIGTERM), and when it is a parked
// babysitter's completed one, whose park the stop ended. A result that completed is the agent's own
// end, and one that came before the stop (a command task's relay that died and left processes that
// `stop` ended) is too. `result` is the attempt's result.json, or null.
export function endedByStop(task, result) {
  // A babysitter's watch attempt that asked for a fix waits for its fix attempt, as a park does.
  const parked = result?.status === "completed" && Boolean(parkedSignal(result.finalMessage) || (isBabysitter(task) && needsFixSignal(result.finalMessage)));
  return stopEnded(task?.stoppedAt, result && { status: result.status, finishedAt: result.finishedAt, parked });
}

// The same for any attempt: `stoppedAt` is the stop recorded for it, and `end` what its result says
// ({ status, finishedAt, parked }), or null when it has none.
function stopEnded(stoppedAt, end) {
  if (!stoppedAt) return false;
  if (!end) return true;
  if (end.status === "completed") return Boolean(end.parked);
  return !(Date.parse(end.finishedAt) < Date.parse(stoppedAt));
}

// Who recorded a stop (stoppedBy, as ownership.mjs's actorOf() writes it), in a few words.
function stopperText(actor) {
  if (!actor) return null;
  if (typeof actor === "string") return actor;
  if (actor.agent === "delegated-agent") return `task ${actor.run}/${actor.task}`;
  return `${actor.agent || "an agent"} session${actor.sessionId ? ` ${String(actor.sessionId).slice(0, 8)}` : ""}`;
}

// Whether a task can be parked now: a Claude or Codex task's started attempt, neither closed nor
// stopped (a command task has no session to resume). `close` and `stop` mark the task itself
// (closedAt, stoppedAt), whatever its attempt, and only a `start` by hand clears them.
// Every agent task may park (Claude, Codex, Gemini: their relays resume a session with --session);
// a command task never does.
const PARKING_AGENTS = new Set(["claude", "codex", "gemini"]);
const parkable = (task) => Boolean(task?.attempt && !task.closedAt && !task.stoppedAt && (isBabysitter(task) || PARKING_AGENTS.has(attemptAgent(task, task.attempt))));

// `ps` prints start times in the local time zone and language: read them in UTC and the C locale, so
// that processes with other settings record and compare the same text.
const PS_ENV = () => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });

// A process's start time (`ps -o lstart=`), which tells it apart from a later process with the same
// PID; null when `ps` cannot read it.
export function processStarted(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: PS_ENV(), timeout: 5000 });
  // A timed-out ps may have printed part of a start time; that is no start time.
  if (r.error) return null;
  return r.stdout?.replace(/\s+/g, " ").trim() || null;
}

// A process's start time (as processStarted() writes it) and command line: { started, command };
// null when the PID is gone; undefined when `ps` cannot read a process that exists.
export function processInfo(pid) {
  if (!pid || !exists(pid)) return null;
  const r = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8", env: PS_ENV(), timeout: 5000 });
  // A timed-out `ps` may have printed part of a line: that is no answer.
  const m = r.error ? null : /^\s*(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s(.*)$/.exec((r.stdout || "").trim());
  if (m) return { started: m[1].replace(/\s+/g, " "), command: m[2].trim() };
  return exists(pid) ? undefined : null;
}

// Every process's start time and command line, from one `ps` call: a Map from PID to
// { started, command }, or null when `ps` fails. Park checks share it, so that reviving the parked
// tasks of a run costs a single `ps`.
export function parkProcessTable() {
  const r = spawnSync("ps", ["-axww", "-o", "pid=,lstart=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: PS_ENV(), timeout: 5000 });
  if (r.status !== 0) return null;
  const rows = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { started: m[2].replace(/\s+/g, " "), command: m[3] });
  }
  return rows;
}

export const exists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// The highest k of the files in `dir` that `re` matches, or 0.
function highest(dir, re) {
  let generation = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = re.exec(name);
      if (m) generation = Math.max(generation, Number(m[1]));
    }
  } catch {}
  return generation;
}

// The current watcher of a parked attempt's folder: { generation, pid, state }, where state is
// `alive`, `starting` (spawned in the last few seconds), `dead`, or `none` when none was started.
// `table` (parkProcessTable) saves a `ps` per watcher.
export function parkWatcher(dir, table = null) {
  const generation = highest(dir, PARK_WATCHER_RE);
  if (!generation) return { generation: 0, pid: null, state: "none" };
  const record = readJson(parkWatcherFile(dir, generation)) || {};
  // Just after the spawn, the record may lack its PID, or `ps` may not show the process yet.
  const young = Date.now() - (Date.parse(record.createdAt) || 0) < WATCHER_GRACE_MS;
  const alive = parkWatcherAlive(dir, generation, record.pid, table);
  const state = alive ? "alive" : young && (!record.pid || alive === null) ? "starting" : "dead";
  return { generation, pid: record.pid || null, state };
}

// Whether `pid` is the watcher of generation `generation` for the attempt folder `dir`: it exists,
// and its command line is that watcher's, so a reused PID never counts. Null when the process
// exists without that command line shown, as for a moment while a watcher starts.
export function parkWatcherAlive(dir, generation, pid, table = null) {
  if (!pid || !exists(pid)) return false;
  const command = table ? table.get(pid)?.command : processCommand(pid);
  return command?.includes(" park-watch ") && command.includes(` ${dir} ${generation} `) ? true : null;
}

// Whether a claim's owner ({ pid, started }) still runs: its PID exists, with the same start time.
function ownerAlive(owner, table) {
  if (!owner?.pid || !exists(owner.pid)) return false;
  const started = table ? table.get(owner.pid)?.started ?? null : processStarted(owner.pid);
  return !owner.started || !started || started === owner.started; // an unreadable time proves nothing
}

// The claim on a parked attempt's folder, from its highest park-claim-<k>.json: { generation,
// record, state }. The state is `none` (no claim, or the last was released), `done` (a resume saved
// the next attempt, or a stop or close ended the park), `live` (its owner still runs, or it names no
// owner and is under a minute old), or `abandoned`: its owner is gone without saving anything, so
// the next claimant may take it over. Claims are created whole (park.mjs), so an empty or unreadable
// one comes from outside; past a minute it is abandoned too. Callers ask only about the task's
// current attempt, so an abandoned claim's attempt was never saved.
export function parkClaim(dir, table = null) {
  const generation = highest(dir, PARK_CLAIM_RE);
  if (!generation) return { generation: 0, record: null, state: "none" };
  const file = parkClaimFile(dir, generation);
  const record = readJson(file);
  let state;
  if (!record) {
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {}
    state = age < CLAIM_GRACE_MS ? "live" : "abandoned";
  } else if (record.released) state = "none";
  else if (record.attempt || record.ended) state = "done";
  else if (record.owner?.pid) state = ownerAlive(record.owner, table) ? "live" : "abandoned";
  else state = Date.now() - (Date.parse(record.claimedAt) || 0) < CLAIM_GRACE_MS ? "live" : "abandoned";
  return { generation, record, state };
}

// The parked state of a task's current attempt, from its result, or null when it is not parked: a
// completed attempt whose final message parks (parkedSignal) and that something can wake
// (parkBasis), while the task is not closed and the park was not ended. `condition` is the wake
// condition the attempt recorded, and `children` the tasks it waits for.
export function parkedOf(run, task, result) {
  if (!parkable(task) || result?.status !== "completed") return null;
  const said = parkedText(result.finalMessage);
  if (said === null) return null;
  const basis = parkBasis(run, task, result);
  if (!basis) return null;
  const dir = path.join(taskDir(run, task.id), `attempt-${task.attempt}`);
  const check = readJson(path.join(dir, PARK_CHECK_FILE));
  const claim = parkClaim(dir);
  const watcher = parkWatcher(dir);
  const condition = basis.condition ? { command: commandText(basis.condition.command), every: basis.condition.every, until: basis.condition.until, why: basis.condition.why || null } : null;
  const waitsFor = said || (basis.babysit ? "its pull request" : condition?.why || (condition ? `\`${shortText(condition.command, 80)}\`` : "the tasks it started"));
  return {
    attempt: task.attempt,
    pr: basis.babysit ? task.pr?.number ?? null : null,
    url: basis.babysit ? task.pr?.url ?? null : null,
    waitsFor,
    since: result.finishedAt || null,
    ...(condition ? { condition } : {}),
    ...(basis.children?.length ? { children: basis.children } : {}),
    watcher: watcher.state,
    watcherPid: watcher.pid,
    generation: watcher.generation,
    lastCheckAt: check?.at || null,
    lastCheckError: check?.error || null,
    resumeWaits: check?.waiting || null,
    // When the first refusal of the current streak happened (park.mjs records it as `waitingSince`);
    // an older record has none, and its last check's time is the earliest refusal it proves.
    resumeWaitsSince: check?.waiting ? check.waitingSince || check.at || null : null,
    claim: claim.state,
    resuming: ["live", "done"].includes(claim.state) ? claim.record?.by || "another command" : null,
  };
}

// Whether a task's current attempt is parked, from its records alone, without looking at processes.
export function isParked(run, task) {
  if (!parkable(task) || !task.outDir) return false;
  const result = readJson(path.join(task.outDir, "result.json"));
  return result?.status === "completed" && parkedText(result.finalMessage) !== null && Boolean(parkBasis(run, task, result));
}

// How long a finished child's notice may take to be written: its finish watcher checks every second.
// Past this, the parent's park watcher writes it instead (lateNotices; park.mjs, checkPark).
export const NOTICE_GRACE_MS = 2 * 60000;

// What can wake a task whose attempt `n` (default: its current one) ended parked, with that
// attempt's result: { babysit: true } for a babysitter, which its pull request wakes; else
// { condition } when the attempt recorded a wake condition with `park-until`; else { children:
// ["<run>/<task>", ...] }, the tasks it started (in any attempt; children.jsonl records each start,
// the task's intent to wait for it) whose ending the attempt had not taken in when it ended; else
// null, and the attempt does not park. From the records alone, a child counts while it has no
// result or is parked, and once it has ended until its finish notice is consumed: while the notice
// is not written yet, however late it comes, while it is unread, and when it was read only after
// this attempt ended. A child can end after its parent has decided to park but before the
// parent's result is written: its unread notice is then the event that wakes the parent.
export function parkBasis(run, task, result, n = task.attempt) {
  if (isBabysitter(task)) return { babysit: true };
  const condition = readJson(path.join(taskDir(run, task.id), `attempt-${n}`, PARK_UNTIL_FILE));
  if (Array.isArray(condition?.command) && condition.command.length) return { condition };
  const ended = Date.parse(result?.finishedAt) || Date.now();
  const children = [];
  let inbox = null;
  for (const child of childrenOf(run, task.id)) {
    const childRun = { ...readJson(path.join(RUNS_DIR, child.run, "run.json")), dir: path.join(RUNS_DIR, child.run) };
    const record = childRun.id ? loadTask(childRun, child.task) : null;
    if (!record?.attempt) continue;
    const dir = path.join(taskDir(childRun, child.task), `attempt-${record.attempt}`);
    const own = readJson(path.join(dir, "result.json"));
    if (!own || isParked(childRun, record)) {
      children.push(`${child.run}/${child.task}`);
      continue;
    }
    const notice = readJson(path.join(dir, NOTICE_FILE));
    let pending;
    if (notice?.message) {
      inbox ??= readInbox(taskDir(run, task.id));
      const m = inbox.find((x) => x.id === notice.message);
      pending = Boolean(m) && (!m.read || Date.parse(m.readAt) > ended);
    } else {
      // Not written yet, or being written: the parent waits for it, and its park watcher writes it
      // when it is late (lateNotices). A notice that went nowhere (skipped) wakes nothing.
      pending = !notice?.skipped;
    }
    if (pending) children.push(`${child.run}/${child.task}`);
  }
  return children.length ? { children } : null;
}

// The finish notices of the tasks a parked task started that ended more than NOTICE_GRACE_MS ago
// and have none written, not even claimed: their finish watchers are gone (after a reboot, say), so
// nothing would wake the parent. [{ runDir, task, attempt }], for the parent's park watcher to send.
export function lateNotices(run, task) {
  const late = [];
  for (const child of childrenOf(run, task.id)) {
    const runDir = path.join(RUNS_DIR, child.run);
    const record = fs.existsSync(path.join(runDir, "run.json")) ? loadTask({ dir: runDir }, child.task) : null;
    if (!record?.attempt) continue;
    const dir = path.join(runDir, "tasks", child.task, `attempt-${record.attempt}`);
    const own = readJson(path.join(dir, "result.json"));
    if (!own || fs.existsSync(path.join(dir, NOTICE_FILE))) continue;
    if (Date.now() - (Date.parse(own.finishedAt) || Date.now()) > NOTICE_GRACE_MS) late.push({ runDir, task: child.task, attempt: record.attempt });
  }
  return late;
}

// The tasks a task started, once each: { run, task } from its children.jsonl.
export function childrenOf(run, id) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(taskDir(run, id), CHILDREN_FILE), "utf8");
  } catch {
    return [];
  }
  const seen = new Map();
  for (const line of text.split("\n")) {
    try {
      const c = JSON.parse(line);
      if (TASK_ID.test(c?.task || "") && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c?.run || "")) seen.set(`${c.run}/${c.task}`, { run: c.run, task: c.task });
    } catch {}
  }
  return [...seen.values()];
}

// The tasks that task `id` of `run` started and that wait on it: finished and awaiting its review,
// or asking it to decide, and not closed. A finish notice reaches only a running agent, so one that
// came while the agent was between attempts is lost; its next attempt's brief lists these instead.
export function childrenWaitingOn(run, id) {
  const waiting = [];
  for (const c of childrenOf(run, id)) {
    try {
      const childRun = { ...readJson(path.join(RUNS_DIR, c.run, "run.json")), dir: path.join(RUNS_DIR, c.run) };
      const task = loadTask(childRun, c.task);
      if (!task || task.closedAt || String(task.mode || "").startsWith("babysit") || task.babysit) continue;
      const row = describe(childRun, task);
      const kind = row.state === "needs-decision" ? "needs your decision" : row.phase === "awaiting-review" ? "awaiting your review" : null;
      if (kind) waiting.push({ run: c.run, task: c.task, name: task.name || null, state: row.state, kind });
    } catch {
      // A child run that is gone or unreadable waits on nobody.
    }
  }
  return waiting;
}

// Record that task `parent` (of run `parentRun`) started `child` of run `run`, for parkBasis.
export function recordChild(parentRun, parent, run, child, attempt) {
  fs.appendFileSync(path.join(taskDir(parentRun, parent), CHILDREN_FILE), `${JSON.stringify({ run: run.id, task: child, attempt, at: new Date().toISOString() })}\n`);
}

// Why a completed attempt whose final message says `PARKED:` did not park, or null.
function notParkedWhy(run, task, result) {
  if (result?.status !== "completed" || task.closedAt || task.stoppedAt) return null;
  if (parkedText(result.finalMessage) === null) {
    // A PARKED: line elsewhere in the message: the agent meant to park, and would otherwise end
    // completed with nothing to wake it and nothing to say why.
    const body = String(result.finalMessage || "").split(/^[\t ]*```orch-result[\t ]*\r?$/m)[0];
    return /^PARKED:/m.test(body) ? "its final message has a `PARKED:` line, but not as the first line or the last line before the orch-result block, so it did not park" : null;
  }
  if (attemptAgent(task, task.attempt) === COMMAND_AGENT) return "a command task never parks";
  if (parkBasis(run, task, result)) return null;
  return `its final message says PARKED:, but nothing would wake it: it recorded no wake condition with \`park-until\` in this attempt, and no task it started was still running when it ended. It ended as completed`;
}

// A babysitter's watch attempt that ended with `NEEDS FIX:`: { reason, since } while its fix attempt
// starts (finish-notice.mjs), or { reason, refused } once none can start: the ceiling forbids the
// complex tier, the attempt ran complex itself, the start failed, or nothing started it within
// FIX_GRACE_MS. Null for any other attempt.
function fixOf(task, result) {
  if (!isBabysitter(task) || result?.status !== "completed" || task.closedAt || task.stoppedAt || !task.outDir) return null;
  const reason = needsFixSignal(result.finalMessage);
  if (!reason) return null;
  const notice = readJson(path.join(task.outDir, NOTICE_FILE));
  if (notice?.fixRefused) return { reason, refused: notice.fixRefused };
  if (!notice?.fix && Date.now() - (Date.parse(result.finishedAt) || 0) > FIX_GRACE_MS) {
    return { reason, refused: `no fix attempt started within ${FIX_GRACE_MS / 60000} minutes of the watch attempt's end; resume it by hand` };
  }
  return { reason, since: result.finishedAt || null };
}

// Whether a task's current attempt is a babysitter's watch attempt that asked for a fix whose fix
// attempt has not started yet (nor been refused): `stop` marks it stopped, which keeps that fix
// from starting (finish-notice.mjs, startFix), also before the fix start holds any claim.
export function pendingFix(task) {
  if (!task?.outDir) return false;
  const fix = fixOf(task, readJson(path.join(task.outDir, "result.json")));
  return Boolean(fix && !fix.refused);
}

// Resume claims (steer.mjs, resumeLock). Every way a task is resumed (a `start` by hand, a retry, a
// rework, an interrupt) claims the attempt it replaces first: resume-<k>.json in that attempt's
// folder, created whole and exclusively with the next k, naming its owner (PID and start time) and
// its `kind` ("start", "retry" or "interrupt"; "adopt" for a claimant that took over a relay a dead
// resume left running, steer.mjs, adoptResume). So two of them never both start the next attempt. A
// parked babysitter's resume claims its park instead (park.mjs), and an interrupt never resumes one.
// The highest k is the current claim: `released` when the resume failed or was refused (with
// `error`), `attempt` once the resumed attempt is saved. An interrupt stops the running relay first,
// so while its claim is live, describe() reports the task as running: `wait`, the parallel limit and
// the plan never see the gap between the two relays.
const RESUME_RE = /^resume-(\d+)\.json$/;
export const resumeFile = (dir, generation) => path.join(dir, `resume-${generation}.json`);
// An interrupt's sender hands its claim to the helper it starts: resume-<k>.handoff.json names the
// helper ({ pid, started }) as the claim's owner. The sender writes it once and never touches the
// claim again, and the helper never writes it, so neither overwrites the other's record.
export const resumeHandoffFile = (dir, generation) => path.join(dir, `resume-${generation}.handoff.json`);
const RESUME_GRACE_MS = 60000; // a claim whose owner cannot be read counts as live this long

// The current resume claim of an attempt's folder: { generation, record, state }, where state is
// `none`, `live` (its owner still runs), `done` (the resumed attempt is saved), `released`, or
// `abandoned` (its owner is gone without saving anything). Folders that were never resumed cost one
// `stat`.
export function resumeClaim(dir) {
  if (!dir || !fs.existsSync(resumeFile(dir, 1))) return { generation: 0, record: null, state: "none" };
  const generation = highest(dir, RESUME_RE);
  const record = readJson(resumeFile(dir, generation));
  let state;
  if (!record) state = "live"; // created whole, so only a moment's read race leaves it unreadable
  else if (record.released) state = "released";
  else if (record.attempt) state = "done";
  else {
    // The owner is whoever the claim was handed to, else whoever its record names.
    const handoff = readJson(resumeHandoffFile(dir, generation));
    const owner = handoff?.pid ? handoff : record.owner;
    if (owner?.pid) state = ownerAlive(owner) ? "live" : "abandoned";
    else state = Date.now() - (Date.parse(record.claimedAt) || 0) < RESUME_GRACE_MS ? "live" : "abandoned";
  }
  return { generation, record, state };
}

// Whether an interrupt is resuming the task's session: a live or finished interrupt claim on its
// current attempt's folder. Other resumes start only once the relay has ended, as before.
export function interruptHeld(task) {
  const claim = resumeClaim(task?.outDir);
  return claim.record?.kind === "interrupt" && ["live", "done"].includes(claim.state) ? claim : null;
}

// The interrupt that holds a task whose relay has exited, or null.
function interruptOf(task) {
  const claim = interruptHeld(task);
  return claim ? { at: claim.record?.claimedAt || null, by: claim.record?.by || null, was: claim.record?.was || null } : null;
}

// A Claude relay whose turn ended (claude.mjs, applyTurn) while its process lives on waits on a
// background work: it reads no message until its next turn starts. Its own background command, an
// open child call, or any sub-agent event since the turn ended proves it is waiting. Otherwise the process may still be exiting, so the
// state counts only once the session has been quiet this long.
const IDLE_GRACE_MS = 5000;
function idleOf(run, task, file, lastEventMs, summary) {
  const pending = commandRuns("claude", file).filter((r) => r.background && r.exitCode === null).at(-1);
  const child = Boolean(summary.childAfterTurn) || Object.values(summary.openTools || {}).some((tool) => tool.sub);
  if (!pending && !child && !(Date.now() - (lastEventMs || Date.now()) >= IDLE_GRACE_MS)) return null;
  return {
    since: lastEventMs ? new Date(lastEventMs).toISOString() : null,
    background: pending ? shortText(pending.cmd, 200) : null,
    steer: `node ${CLI_PATH} steer ${run.id} ${task.id}`,
  };
}

// An idle row's activity line.
export function idleText(idle) {
  return `idle: ended its turn and waits on its own background ${idle.background ? `command \`${shortText(idle.background, 80)}\`` : "work"}`;
}

// How long a watcher's tries to resume a parked task may all be refused before the task needs
// attention (dashboard-state.mjs, attentionOf): AGENT_ORCH_RESUME_BLOCKED_AFTER (90s, 10m, ...),
// default 10m. A bad value falls back to the default rather than stopping the caller.
export function resumeBlockedMs(value = process.env.AGENT_ORCH_RESUME_BLOCKED_AFTER) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"] : 600000;
}

// A parked row's activity line: what it waits for, and its watcher when that needs saying. A resume
// the watcher has been refused for resumeBlockedMs() is said first, so the status table's cut keeps it.
function parkedNow(p) {
  const watcher = p.resuming ? "resuming" : p.watcher === "dead" || p.watcher === "none" ? "watcher not running (status, start or the dashboard restarts it)" : null;
  const since = Date.parse(p.resumeWaitsSince) || 0;
  const blocked = p.resumeWaits && since && Date.now() - since >= resumeBlockedMs() ? `resume blocked for ${formatElapsed(Date.now() - since)}: ${p.resumeWaits}` : null;
  const extra = [watcher, blocked ? null : p.resumeWaits ? `resume waits: ${p.resumeWaits}` : null, p.lastCheckError ? `last check failed: ${p.lastCheckError}` : null].filter(Boolean);
  return shortText(`parked${blocked ? ` · ${blocked}` : ""} · ${p.waitsFor}${extra.length ? ` · ${extra.join(" · ")}` : ""}`, 300);
}

// What an earlier attempt's result.json says, reread only when the file changes: the dashboard
// describes every task each second, and only the current attempt's result changes.
const attemptResults = new Map(); // result.json path -> { mtimeMs, size, value }
function attemptResult(dir) {
  const file = path.join(dir, "result.json");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    attemptResults.delete(file);
    return null;
  }
  const hit = attemptResults.get(file);
  if (hit?.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const result = readJson(file);
  const report = reportOutcome(result?.finalMessage);
  const value = result && {
    status: result.status || "unknown",
    error: firstLine(typeof result.error === "string" ? result.error : result.error ? JSON.stringify(result.error) : "", 160) || null,
    decisions: result.status === "completed" && Boolean(decisionsIn(result.finalMessage) || report.decisions),
    outcome: report.outcome,
    failedCheck: Boolean(report.failedCheck),
    limitHit: result.status !== "completed" && USAGE_LIMIT_RE.test([result.error && (typeof result.error === "string" ? result.error : JSON.stringify(result.error)), result.stderrTail, result.finalMessage].filter(Boolean).join("\n")),
    parked: result.status === "completed" && Boolean(parkedSignal(result.finalMessage)),
    needsFix: result.status === "completed" && Boolean(needsFixSignal(result.finalMessage)),
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || null,
    model: result.model || null,
    session: result.threadId || result.sessionId || null,
    resumedFrom: typeof result.session === "string" ? result.session : null,
    resumed: Boolean(result.resumed || result.resumeLast || result.session),
  };
  if (attemptResults.size >= 2000) attemptResults.delete(attemptResults.keys().next().value);
  attemptResults.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

// A relay that exited before writing a result may leave its usage error only in its log.
// Cache that bounded tail too; running and prepared attempts never enter this path.
const abortedLimits = new Map();
function abortedLimit(dir, error) {
  if (USAGE_LIMIT_RE.test(error || "")) return true;
  const file = path.join(dir, "relay.log");
  let st;
  try { st = fs.statSync(file); } catch { abortedLimits.delete(file); return false; }
  const hit = abortedLimits.get(file);
  if (hit?.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = USAGE_LIMIT_RE.test(tailText(file, 16384) || "");
  if (abortedLimits.size >= 2000) abortedLimits.delete(abortedLimits.keys().next().value);
  abortedLimits.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

// An attempt's brief does not change once its relay starts, so its size is read once.
const briefSizes = new Map(); // orch-brief.md path -> bytes
function briefBytes(dir) {
  const file = path.join(dir, "orch-brief.md");
  if (briefSizes.has(file)) return briefSizes.get(file);
  try {
    const { size } = fs.statSync(file);
    if (briefSizes.size >= 2000) briefSizes.delete(briefSizes.keys().next().value);
    briefSizes.set(file, size);
    return size;
  } catch {
    return null;
  }
}

// One compact line per attempt, newest first, for the dashboard's receipts: why it started, its
// agent and model, time and tokens, how it ended and the outcome its report gave. `seen` holds each
// attempt's event summary and tokens from describe(); `row` is the finished row, whose state,
// report and result describe the current attempt.
function attemptsOf(task, seen, row) {
  const current = task.attempt || 0;
  const sessions = [];
  const list = seen.map(({ dir, agent, summary, tokens }, i) => {
    const n = i + 1;
    const now = n === current;
    const r = now ? null : attemptResult(dir);
    const result = now ? row.result : null;
    const session = now ? row.session : r?.session || summary.sessionId || null;
    // The session this attempt resumed: the relay records it for Codex; the current attempt's
    // relay arguments name it for both; a Claude result says only that it resumed, so its own
    // session counts when an earlier attempt had the same one.
    // A command task's arguments are its command's, which resume nothing.
    const argv = now && Array.isArray(task.argv) && agent !== COMMAND_AGENT ? task.argv : [];
    const named = argv.includes("--session") ? argv[argv.indexOf("--session") + 1] : null;
    const explicit = (now ? (typeof result?.session === "string" ? result.session : null) : r?.resumedFrom) || named || null;
    const flagged = now ? Boolean(result?.resumed || result?.resumeLast || argv.includes("--resume-last")) : Boolean(r?.resumed);
    const from = explicit || (flagged && session && sessions.includes(session) ? session : null);
    const resumedAttempt = from ? sessions.lastIndexOf(from) + 1 || null : null;
    sessions.push(session);
    let state = now ? (row.phase === "parked" ? "parked" : row.state) : r ? r.status : "aborted";
    // An attempt an interrupt stopped to resume its session (steer.mjs) did not fail: the next one
    // continues it.
    if (!now && attemptReasonOf(task, n + 1) === "interrupt") state = "interrupted";
    // An earlier attempt that a stop ended (`start` keeps the stop in attemptStops) did not fail either.
    else if (!now && stopEnded(task.attemptStops?.[n], r && { ...r, parked: r.parked || (isBabysitter(task) && r.needsFix) })) state = "stopped";
    else if (!now && state === "completed" && r.decisions && task.decisionResolvedAttempt !== n) state = "needs-decision";
    // An earlier attempt parked when a babysitter's did, or another task's that recorded a wake
    // condition or had started tasks (parkBasis decided it then; the files show it now).
    else if (!now && state === "completed" && r.parked && (isBabysitter(task) || fs.existsSync(path.join(dir, PARK_UNTIL_FILE)) || fs.existsSync(path.join(path.dirname(dir), CHILDREN_FILE)))) state = "parked";
    // A babysitter's watch attempt that handed its work to the fix attempt after it.
    else if (!now && state === "completed" && r.needsFix && attemptReasonOf(task, n + 1) === "fix") state = "needs-fix";
    const startedAt = now ? row.startedAt : r?.startedAt || null;
    const finishedAt = now ? result?.finishedAt || null : r?.finishedAt || null;
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const errorText = now ? (typeof result?.error === "string" ? result.error : result?.error ? JSON.stringify(result.error) : "") : r?.error || "";
    const failed = !["completed", "needs-decision", "running", "prepared", "parked", "needs-fix", "interrupted", "stopped"].includes(state);
    return {
      n,
      limitHit: now ? row.limitHit || (state === "aborted" && !result && abortedLimit(dir, summary.error)) : Boolean(r?.limitHit || (r && r.status !== "completed" && USAGE_LIMIT_RE.test(summary.error || "")) || (!r && state === "aborted" && abortedLimit(dir, summary.error))),
      failedCheck: now ? Boolean(row.report?.checks?.some((c) => c?.result === "fail")) : Boolean(r?.failedCheck),
      reason: attemptReasonOf(task, n),
      agent,
      model: now ? row.model : r?.model || summary.model || null,
      startedAt,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : null,
      tokensIn: tokens.input,
      tokensOut: tokens.output,
      state,
      error: failed ? firstLine(errorText, 160) || firstLine(summary.error, 160) || null : null,
      outcome: now ? (row.report && !row.report.invalid ? row.report.outcome : null) : r?.outcome || null,
      session,
      resumed: from || (flagged ? true : null),
      resumedAttempt,
      briefBytes: briefBytes(dir),
    };
  });
  return list.reverse();
}

function taskStatus(task) {
  const readResult = () => (task.outDir ? readJson(path.join(task.outDir, "result.json")) : null);
  let result = readResult();
  const running = relayAlive(task.pid, task.startedAt, task.outDir);
  // The relay writes result.json and exits; if it did both between the read above and the check,
  // read again before calling the task aborted.
  if (!running && !result && task.pid) result = readResult();
  return { result, running };
}

function eventTime(task) {
  try {
    return fs.statSync(path.join(task.outDir, "events.jsonl")).mtimeMs;
  } catch {
    return task.startedAt ? Date.parse(task.startedAt) : null;
  }
}

function activityTime(task, result, running, lastEventMs) {
  return running ? lastEventMs || Date.now() : (result?.finishedAt && Date.parse(result.finishedAt)) || lastEventMs || (task.startedAt && Date.parse(task.startedAt)) || 0;
}

// Recovery's date filter needs timestamps, not event summaries or review history. Share the
// same process/result race check and timestamp precedence as the full task description.
export function taskLastActivity(task) {
  const { result, running } = taskStatus(task);
  return activityTime(task, result, running, eventTime(task));
}

export function describe(run, task) {
  let { result, running } = taskStatus(task);
  // An interrupt that stopped the relay to resume its session (steer.mjs): the task still runs, and
  // the stopped relay's result is not the task's.
  const interrupting = !running && task.pid ? interruptOf(task) : null;
  if (interrupting) result = null;
  let state;
  if (!task.pid) state = isClosedPreparation(task) ? "closed" : "prepared";
  else if (running || interrupting) state = "running";
  // An attempt that a stop ended did not fail: it reads `stopped`, whatever the relay recorded. A
  // stopped park has ended too (a stop keeps a babysitter from parking: parkable).
  else if (endedByStop(task, result)) state = "stopped";
  else if (result) state = result.status || "unknown";
  else state = "aborted"; // exited without result.json: usage error, kill, or crash; see the log
  // A session that ended by handing back a question is waiting on its orchestrator, not done.
  let decisions = state === "completed" ? decisionsIn(result.finalMessage) : null;
  if (decisions) state = "needs-decision";
  // A babysitter's watch attempt that asked for a fix still runs while its fix attempt starts; one
  // whose fix attempt cannot start waits on its orchestrator, as a decision.
  const fix = state === "completed" ? fixOf(task, result) : null;
  if (fix?.refused) {
    state = "needs-decision";
    decisions = [`NEEDS FIX: ${fix.reason}`, `No fix attempt was started: ${fix.refused}`];
  } else if (fix) state = "running";
  // A parked task still runs as far as anyone waiting on it can tell.
  const parked = state === "completed" ? parkedOf(run, task, result) : null;
  if (parked) state = "running";
  const notParked = state === "completed" ? notParkedWhy(run, task, result) : null;
  const started = task.startedAt ? Date.parse(task.startedAt) : null;
  const ended = running || interrupting ? Date.now() : result?.finishedAt ? Date.parse(result.finishedAt) : null;
  const elapsedMs = started && ended ? ended - started : null;

  // Tokens and cost add up across attempts; activity and session come from the current attempt.
  // Cost is what Claude reported for a finished attempt, else an estimate from tokens (cost.mjs).
  const tokens = { input: 0, cached: 0, output: 0 };
  let costUsd = null, costExact = true;
  let exact = true;
  let current = newSummary();
  const attempts = attemptDirs(run, task);
  const seen = []; // each attempt's summary and tokens, for its line in `attempts`
  const byThread = new Map(); // Codex thread id -> tokens already counted for it
  for (const [i, { dir, agent }] of attempts.entries()) {
    const s = summarizeEvents(agent, path.join(dir, "events.jsonl"), task.cd);
    let t = s.tokens;
    // `codex exec --json` reports usage only when a turn ends; while one runs, the thread's own
    // rollout has the live count (less what earlier attempts on the same thread already counted).
    if (agent === "codex" && running && i === attempts.length - 1 && s.sessionId) {
      const file = codexRolloutFor(s.sessionId, started || 0);
      const live = file ? summarizeRollout(file).tokens : null;
      const before = byThread.get(s.sessionId) || { input: 0, cached: 0, output: 0 };
      if (live && live.input - before.input > t.input) t = { input: live.input - before.input, cached: live.cached - before.cached, output: live.output - before.output };
    }
    if (agent === "codex" && s.sessionId) {
      const b = byThread.get(s.sessionId) || { input: 0, cached: 0, output: 0 };
      byThread.set(s.sessionId, { input: b.input + t.input, cached: b.cached + t.cached, output: b.output + t.output });
    }
    tokens.input += t.input;
    tokens.cached += t.cached;
    tokens.output += t.output;
    // Gemini reports usage only when an attempt ends, and not always then (a stopped Cursor run): an
    // attempt without that reading has unknown tokens and cost, never an exact zero.
    if (agent === "gemini" && !s.exact) {
      exact = false;
      costExact = false;
      current = s;
      seen.push({ dir, agent, summary: s, tokens: t });
      continue;
    }
    const cost = attemptCost(agent, { ...s, tokens: t }, attemptModel(task, i + 1, agent, null, dir));
    if (cost) {
      costUsd = (costUsd || 0) + cost.usd;
      if (!cost.exact) costExact = false;
    } else if (t.input || t.output) costExact = false;
    if (!s.exact && (s.tokens.input || s.tokens.output)) exact = false;
    current = s;
    seen.push({ dir, agent, summary: s, tokens: t });
  }
  const lastEventMs = eventTime(task);
  // A command task (command-relay.mjs) shows its latest output line as its activity, and counts
  // lines of output as its steps.
  const command = attemptAgent(task, task.attempt) === COMMAND_AGENT;
  const progress = command && task.outDir ? commandProgress(path.join(task.outDir, "events.jsonl")) : null;
  const quietMs = running && lastEventMs ? Date.now() - lastEventMs : null;
  // When the session last did anything: its latest event while running, else when it finished.
  const lastActiveMs = activityTime(task, result, running, lastEventMs);
  // A task that stopped because its agent ran out of usage: the one case where limits matter.
  const finishedText = [current.error, result?.error, result?.finalMessage, result?.stderrTail].filter(Boolean).join("\n");
  // Only the error counts: a full window or a limit status still leaves the team plans' extra usage.
  const limitHit = !running && !interrupting && !parked && !fix && !["prepared", "completed", "needs-decision", "stopped"].includes(state) && USAGE_LIMIT_RE.test(finishedText);
  // Where a running agent is in its turn: the foreground shell command it is in, if any, and, for a
  // Claude relay that ended its turn and stays alive on a background command of its own, `idle`
  // ({ since, background, steer }): it reads no message until that command ends.
  const agentNow = attemptAgent(task, task.attempt);
  const shell = running && !command ? shellNow(agentNow, current) : null;
  const idle = running && agentNow === "claude" && current.turnEnded && task.outDir ? idleOf(run, task, path.join(task.outDir, "events.jsonl"), lastEventMs, current) : null;
  let now;
  const activity = command ? progress?.line || `$ ${shortText(commandText(task.command), 200)}` : current.activity || "starting";
  if (running) now = `${quietMs > QUIET_AFTER_MS ? `quiet ${formatElapsed(quietMs)} · ` : ""}${idle ? idleText(idle) : activity}`;
  else if (interrupting) now = "interrupted to deliver a message: resuming its session";
  else if (decisions) now = firstLine(`asks: ${decisions.join(" · ")}`);
  else if (fix) now = shortText(`needs a fix · ${fix.reason} · starting its fix attempt at the complex tier`, 300);
  else if (parked) now = parkedNow(parked);
  else if (state === "stopped") now = `stopped${task.stoppedBy ? ` by ${stopperText(task.stoppedBy)}` : ""}`;
  else if (result && command) now = commandOutcome(result) || "(no output)";
  else if (result) now = firstLine(result.finalMessage) || current.error || "(empty final message)";
  else now = state === "closed" ? "closed before it started" : state === "prepared" ? "worktree ready" : "relay exited without a result; see log";

  const row = {
    id: task.id,
    // The name `rename` gave the task, which views show in place of its id, and every name it had,
    // with when and by whom it was set (a null name records that the name was removed).
    name: task.name || null,
    names: Array.isArray(task.names) ? task.names : [],
    agent: task.agent || "-",
    mode: !task.pid
      ? "-"
      : `${task.babysit ? "babysit" : task.readOnly ? "read-only" : "write"}${task.network === "off" && !task.readOnly ? "+offline" : task.sandboxed && !task.readOnly ? "+sandbox" : ""}`,
    state,
    attempt: task.attempt || 0,
    elapsed: task.pid ? formatElapsed(elapsedMs) : "-",
    steps: task.pid ? (command ? progress?.lines || result?.lines || 0 : current.steps) : "-",
    tokensIn: tokens.input,
    tokensCached: tokens.cached,
    tokensOut: tokens.output,
    tokensExact: exact,
    costUsd,
    costExact: costUsd === null ? null : costExact,
    model: task.model || result?.model || current.model || null,
    tier: task.tier || null,
    startedAt: task.startedAt || null,
    lastActiveMs,
    modelLabel: modelLabel(task),
    why: task.why || null,
    session: result?.threadId || result?.sessionId || current.sessionId || null,
    // A command often prints nothing while an agent it started works, so it is never flagged
    // silent (report.mjs); --timeout bounds one that hangs.
    quietMs: command ? null : quietMs,
    touched: Array.isArray(result?.touchedFiles) ? result.touchedFiles.length : "-",
    now,
    cd: task.cd || task.worktree?.path || null,
    branch: task.worktree?.branch || null,
    ...(command ? { command: commandText(task.command) } : {}),
    outDir: task.outDir || null,
    // Closed: finished, and either completed or its result collected, or closed with `close`.
    closed: !["running", "prepared"].includes(state) && (state === "completed" || Boolean(task.closedAt)),
    decisions,
    limitHit,
    result,
    ...(shell ? { shell } : {}),
    ...(idle ? { idle } : {}),
    ...(interrupting ? { interrupting } : {}),
    ...(parked ? { parked } : {}),
    ...(fix && !fix.refused ? { fixing: fix } : {}),
    ...(notParked ? { notParked } : {}),
    // Set when this attempt began a fresh session from the babysitter's handoff note (park.mjs).
    ...(task.handoffs?.[task.attempt] ? { handoff: task.handoffs[task.attempt] } : {}),
    // How this attempt's start weighed a fresh session against its session's size, fresh or not.
    ...(task.handoffChecks?.[task.attempt] ? { handoffCheck: task.handoffChecks[task.attempt] } : {}),
    // The context window at which Claude Code compacted this attempt's session (start.mjs).
    ...(task.compactWindows?.[task.attempt] ? { compactWindow: task.compactWindows[task.attempt] } : {}),
  };
  const reported = { ...row, ...reportFields(run, task, row) };
  // A relay that a stop ended without a result is not dead: the stop says why it is gone.
  if (state === "stopped") reported.health = "ok";
  const staged = { ...reported, ...lifecycleFields(run, task, reported) };
  if (parked) Object.assign(staged, { phase: "parked", awaitingReviewMs: null });
  const described = { ...staged, ...inboxFields(run, task, staged) };
  described.attempts = attemptsOf(task, seen, described);
  const history = failureHistory(task, described.attempts, described.reviewRounds, verificationFacts(run, task.id));
  described.failureCount = history.failureCount;
  described.attempts = described.attempts.map((a) => ({ ...a, ...history.attempts.find((h) => h.n === a.n) }));
  return described;
}

const verificationMemo = new Map();
function verificationFacts(run, id) {
  const file = verificationsPath(run, id);
  let st;
  try { st = fs.statSync(file); } catch { verificationMemo.delete(file); return []; }
  const hit = verificationMemo.get(file);
  if (hit?.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = verificationsOf(run, id);
  if (verificationMemo.size >= 2000) verificationMemo.delete(verificationMemo.keys().next().value);
  verificationMemo.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

// Errors that mean the agent's usage window is used up, as Claude Code and Codex word them.
const USAGE_LIMIT_RE = /usage limit|limit reached|hit your (?:usage )?limit|hit your spend cap|rate_limit_reached|(?:5-hour|five[_ -]hour|weekly|seven[_ -]day) limit/i;

export function listTaskRecords(run) {
  const dir = path.join(run.dir, "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => loadTask(run, id))
    .filter(Boolean)
    .sort((a, b) => String(a.startedAt || a.createdAt).localeCompare(String(b.startedAt || b.createdAt)));
}

export function listTasks(run) {
  return listTaskRecords(run).map((task) => describe(run, task));
}

// "claude" or "codex" when a command line runs that host (its program, or the script a `node`
// launcher runs), else null.
export function agentOfCommand(command) {
  const argv0 = String(command || "").trim().split(/\s+/).slice(0, 2).map((a) => path.basename(a));
  if (argv0.includes("codex") || argv0.includes("codex.js")) return "codex";
  if (argv0.includes("claude")) return "claude";
  return null;
}

// The nearest claude or codex ancestor process is the orchestrator. Environment variables alone
// are ambiguous: a Codex session started from Claude Code inherits Claude's variables. Without such
// an ancestor (or a readable process table), a session variable still names the session. `started`
// adds the host process's start time, which tells it apart from a later process with the same PID;
// `new` records it, so ownership.mjs can tell when the launcher has gone.
export function detectOrchestrator({ started = false } = {}) {
  const env = process.env;
  if (env.AGENT_ORCH_DEPTH) {
    return { agent: "delegated-agent", sessionId: null, parentRun: env.AGENT_ORCH_RUN || null, parentTask: env.AGENT_ORCH_TASK || null, depth: DEPTH };
  }
  const claudeId = env.CLAUDE_CODE_SESSION_ID || null;
  const codexId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
  // Ancestors come from the shared snapshot when a fresh one holds them (as after `status` read its
  // relays), else from one `ps` each, which also gives the host's start time. This never reads a new
  // snapshot: one read before describe() would serve its relay checks up to a second stale.
  const table = freshProcessTable();
  let pid = process.ppid;
  for (let hops = 0; pid > 1 && hops < 20; hops++) {
    let row = table?.get(pid);
    if (!row) {
      const r = spawnSync("ps", ["-o", "ppid=,lstart=,command=", "-p", String(pid)], { encoding: "utf8", env: PS_ENV(), timeout: 5000 });
      const m = r.error ? null : /^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s(.*)$/.exec((r.stdout || "").trim());
      if (!m) break;
      row = { ppid: Number(m[1]), started: m[2].replace(/\s+/g, " "), command: m[3] };
    }
    const agent = agentOfCommand(row.command);
    if (agent) {
      const when = row.started || (started ? processStarted(pid) : null);
      return { agent, sessionId: agent === "codex" ? codexId : claudeId, pid, ...(when ? { started: when } : {}) };
    }
    pid = row.ppid;
  }
  if (claudeId) return { agent: "claude", sessionId: claudeId, pid: null };
  if (codexId) return { agent: "codex", sessionId: codexId, pid: null };
  return { agent: "terminal", sessionId: null };
}
