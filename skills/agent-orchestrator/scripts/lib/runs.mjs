// Runs and tasks: where they live, how they are loaded and saved, and what state each task is in.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEPTH, QUIET_AFTER_MS, RUNS_DIR, TASK_ID } from "./config.mjs";
import { asksDecision, decisionsIn } from "./briefs.mjs";
import { failureHistory } from "./escalation.mjs";
import { inboxFields } from "./inbox.mjs";
import { attemptReasonOf, isClosedPreparation, lifecycleFields, verificationsOf, verificationsPath } from "./lifecycle.mjs";
import { reportFields } from "./report.mjs";
import { codexRolloutFor } from "./codex.mjs";
import { newSummary, summarizeEvents, summarizeRollout } from "./events.mjs";
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

function processCommand(pid) {
  const before = processTable.at;
  let rows = processSnapshot();
  if (rows && !rows.has(pid) && processTable.at === before) rows = readTable();
  return rows?.get(pid)?.command ?? null;
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

// Parking (park.mjs). A pull-request babysitter that has nothing left to do ends its turn with a
// final message whose first line starts with `PARKED:` (and an orch-result outcome `parked`). Its
// relay and agent exit, and a small watcher resumes the same session on the next event. Until then
// describe() reports the task as running, in phase `parked`, so `wait` keeps waiting for it. Each
// parked attempt's folder holds the park's files: park-watcher-<k>.json, one per watcher started
// (the highest k is the current one); park-check.json, the latest check; and park-claim-<k>.json,
// the claims that end the park (a resume, `stop` or `close`), each created exclusively with the
// next k, so exactly one claimant wins, and recording its owner's PID and start time.
export const PARK_CHECK_FILE = "park-check.json";
const PARK_WATCHER_RE = /^park-watcher-(\d+)\.json$/;
const PARK_CLAIM_RE = /^park-claim-(\d+)\.json$/;
export const parkWatcherFile = (dir, generation) => path.join(dir, `park-watcher-${generation}.json`);
export const parkClaimFile = (dir, generation) => path.join(dir, `park-claim-${generation}.json`);
const PARKED_RE = /^PARKED:\s*(.*?)\s*$/;
const WATCHER_GRACE_MS = 15000;
const CLAIM_GRACE_MS = 60000; // a claim that names no owner counts as live this long

// What a final message says the babysitter waits for ("PR #42 waits for a human review"), or null
// when it does not park. Its first line must start with `PARKED:` itself, neither quoted nor
// indented. When it has an orch-result block, that block's outcome must be `parked` too: a message
// whose two signals disagree does not park. A message that hands back a decision does not park.
export function parkedSignal(message) {
  const text = String(message || "");
  const first = text.split("\n").find((line) => line.trim());
  const m = first ? PARKED_RE.exec(first.replace(/\r$/, "")) : null;
  if (!m) return null;
  const report = reportOutcome(text);
  if ((report.present && report.outcome !== "parked") || report.decisions || decisionsIn(text)) return null;
  return m[1] || "its pull request";
}

// Whether a task can be parked now: a babysitter's started attempt, neither closed nor stopped.
// `close` and `stop` mark the task itself (closedAt, stoppedAt), whatever its attempt, and only a
// `start` by hand clears them.
const parkable = (task) => Boolean((task?.babysit || task?.plan?.type === "babysit") && task.attempt && !task.closedAt && !task.stoppedAt);

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
// babysitter's completed attempt whose final message parks (parkedSignal), while the task is not
// closed and the park was not ended.
export function parkedOf(run, task, result) {
  if (!parkable(task) || result?.status !== "completed") return null;
  const waitsFor = parkedSignal(result.finalMessage);
  if (!waitsFor) return null;
  const dir = path.join(taskDir(run, task.id), `attempt-${task.attempt}`);
  const check = readJson(path.join(dir, PARK_CHECK_FILE));
  const claim = parkClaim(dir);
  const watcher = parkWatcher(dir);
  return {
    attempt: task.attempt,
    pr: task.pr?.number ?? null,
    url: task.pr?.url ?? null,
    waitsFor,
    since: result.finishedAt || null,
    watcher: watcher.state,
    watcherPid: watcher.pid,
    generation: watcher.generation,
    lastCheckAt: check?.at || null,
    lastCheckError: check?.error || null,
    resumeWaits: check?.waiting || null,
    claim: claim.state,
    resuming: ["live", "done"].includes(claim.state) ? claim.record?.by || "another command" : null,
  };
}

// Whether a task's current attempt is parked, from its records alone, without looking at processes.
export function isParked(run, task) {
  if (!parkable(task) || !task.outDir) return false;
  const result = readJson(path.join(task.outDir, "result.json"));
  return result?.status === "completed" && Boolean(parkedSignal(result.finalMessage));
}

// A parked row's activity line: what it waits for, and its watcher when that needs saying.
function parkedNow(p) {
  const watcher = p.resuming ? "resuming" : p.watcher === "dead" || p.watcher === "none" ? "watcher not running (status, start or the dashboard restarts it)" : null;
  const extra = [watcher, p.resumeWaits ? `resume waits: ${p.resumeWaits}` : null, p.lastCheckError ? `last check failed: ${p.lastCheckError}` : null].filter(Boolean);
  return shortText(`parked · ${p.waitsFor}${extra.length ? ` · ${extra.join(" · ")}` : ""}`, 300);
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
    if (!now && state === "completed" && r.decisions && task.decisionResolvedAttempt !== n) state = "needs-decision";
    else if (!now && state === "completed" && r.parked && (task.babysit || task.plan?.type === "babysit")) state = "parked";
    const startedAt = now ? row.startedAt : r?.startedAt || null;
    const finishedAt = now ? result?.finishedAt || null : r?.finishedAt || null;
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const errorText = now ? (typeof result?.error === "string" ? result.error : result?.error ? JSON.stringify(result.error) : "") : r?.error || "";
    const failed = !["completed", "needs-decision", "running", "prepared", "parked"].includes(state);
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

export function describe(run, task) {
  const readResult = () => (task.outDir ? readJson(path.join(task.outDir, "result.json")) : null);
  let result = readResult();
  const running = relayAlive(task.pid, task.startedAt, task.outDir);
  // The relay writes result.json and exits; if it did both between the read above and the check,
  // read again before calling the task aborted.
  if (!running && !result && task.pid) result = readResult();
  let state;
  if (!task.pid) state = isClosedPreparation(task) ? "closed" : "prepared";
  else if (running) state = "running";
  else if (result) state = result.status || "unknown";
  else state = "aborted"; // exited without result.json: usage error, kill, or crash; see the log
  // A session that ended by handing back a question is waiting on its orchestrator, not done.
  const decisions = state === "completed" ? decisionsIn(result.finalMessage) : null;
  if (decisions) state = "needs-decision";
  // A parked babysitter still runs as far as anyone waiting on it can tell; a stopped park has ended.
  const parked = state === "completed" ? parkedOf(run, task, result) : null;
  if (parked) state = "running";
  else if (state === "completed" && task.stoppedAt && parkedSignal(result.finalMessage)) state = "stopped";
  const started = task.startedAt ? Date.parse(task.startedAt) : null;
  const ended = running ? Date.now() : result?.finishedAt ? Date.parse(result.finishedAt) : null;
  const elapsedMs = started && ended ? ended - started : null;

  // Tokens and cost add up across attempts; activity and session come from the current attempt.
  const tokens = { input: 0, cached: 0, output: 0 };
  let costUsd = null;
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
    if (s.costUsd != null) costUsd = (costUsd || 0) + s.costUsd;
    if (!s.exact && (s.tokens.input || s.tokens.output)) exact = false;
    current = s;
    seen.push({ dir, agent, summary: s, tokens: t });
  }
  let lastEventMs = null;
  try {
    lastEventMs = fs.statSync(path.join(task.outDir, "events.jsonl")).mtimeMs;
  } catch {
    lastEventMs = started;
  }
  // A command task (command-relay.mjs) shows its latest output line as its activity, and counts
  // lines of output as its steps.
  const command = attemptAgent(task, task.attempt) === COMMAND_AGENT;
  const progress = command && task.outDir ? commandProgress(path.join(task.outDir, "events.jsonl")) : null;
  const quietMs = running && lastEventMs ? Date.now() - lastEventMs : null;
  // When the session last did anything: its latest event while running, else when it finished.
  const lastActiveMs = running ? lastEventMs || Date.now() : (result?.finishedAt && Date.parse(result.finishedAt)) || lastEventMs || started || 0;
  // A task that stopped because its agent ran out of usage: the one case where limits matter.
  const finishedText = [current.error, result?.error, result?.finalMessage, result?.stderrTail].filter(Boolean).join("\n");
  // Only the error counts: a full window or a limit status still leaves the team plans' extra usage.
  const limitHit = !running && !parked && !["prepared", "completed", "needs-decision"].includes(state) && USAGE_LIMIT_RE.test(finishedText);
  let now;
  const activity = command ? progress?.line || `$ ${shortText(commandText(task.command), 200)}` : current.activity || "starting";
  if (running) now = `${quietMs > QUIET_AFTER_MS ? `quiet ${formatElapsed(quietMs)} · ` : ""}${activity}`;
  else if (decisions) now = firstLine(`asks: ${decisions.join(" · ")}`);
  else if (parked) now = parkedNow(parked);
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
    ...(parked ? { parked } : {}),
    // Set when this attempt began a fresh session from the babysitter's handoff note (park.mjs).
    ...(task.handoffs?.[task.attempt] ? { handoff: task.handoffs[task.attempt] } : {}),
  };
  const reported = { ...row, ...reportFields(run, task, row) };
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
const USAGE_LIMIT_RE = /usage limit|limit reached|hit your (?:usage )?limit|rate_limit_reached|(?:5-hour|five[_ -]hour|weekly|seven[_ -]day) limit/i;

export function listTasks(run) {
  const dir = path.join(run.dir, "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => loadTask(run, id))
    .filter(Boolean)
    .sort((a, b) => String(a.startedAt || a.createdAt).localeCompare(String(b.startedAt || b.createdAt)))
    .map((task) => describe(run, task));
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
