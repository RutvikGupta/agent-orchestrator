// Runs and tasks: where they live, how they are loaded and saved, and what state each task is in.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEPTH, QUIET_AFTER_MS, RUNS_DIR, TASK_ID } from "./config.mjs";
import { decisionsIn } from "./briefs.mjs";
import { inboxFields } from "./inbox.mjs";
import { attemptReasonOf, lifecycleFields } from "./lifecycle.mjs";
import { reportFields } from "./report.mjs";
import { codexRolloutFor } from "./codex.mjs";
import { newSummary, summarizeEvents, summarizeRollout } from "./events.mjs";
import { firstLine, formatElapsed } from "./format.mjs";
import { modelLabel } from "./policy.mjs";
import { die, readJson, writeJson } from "./util.mjs";

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
  const r = spawnSync("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  processTable = { at: Date.now(), rows: parseTable(r.stdout) };
  return processTable.rows;
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

export function relayAlive(pid, startedAt = null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  // Guard against PID reuse: the live process must still be a relay. Right after `start` forks
  // it, the child still shows the parent's command until it execs, so a process that exists
  // within a few seconds of the recorded start counts as the relay.
  const command = processCommand(pid);
  if (command?.includes("relay.mjs")) return true;
  const age = startedAt ? Date.now() - Date.parse(startedAt) : Infinity;
  return command !== null && age >= 0 && age < 10000;
}

// Wait until a stopped relay has exited, so a following `start` of the same task does not race it.
export function waitForExit(pid, ms = 15000) {
  const until = Date.now() + ms;
  while (relayAlive(pid) && Date.now() < until) spawnSync("sleep", ["0.2"]);
  return !relayAlive(pid);
}

// A task may switch agents between attempts, so each attempt is parsed as its own agent's stream.
export function attemptAgent(task, n) {
  return task.attemptAgents?.[n] || task.agent;
}

function attemptDirs(run, task) {
  const dirs = [];
  for (let n = 1; n <= (task.attempt || 0); n++) dirs.push({ dir: path.join(taskDir(run, task.id), `attempt-${n}`), agent: attemptAgent(task, n) });
  return dirs;
}

// The outcome word of a final message's last orch-result block (done, partial or blocked), and
// whether it hands back decisions; report.mjs parses the current attempt's report in full.
function reportOutcome(message) {
  let last;
  for (const block of String(message || "").matchAll(/^[\t ]*```orch-result[\t ]*\r?\n([\s\S]*?)^[\t ]*```[\t ]*(?=\r?$)/gm)) last = block[1];
  try {
    const value = last === undefined ? null : JSON.parse(last.trim());
    return { outcome: ["done", "partial", "blocked"].includes(value?.outcome) ? value.outcome : null, decisions: Array.isArray(value?.decisions) && value.decisions.length > 0 };
  } catch {
    return { outcome: null, decisions: false };
  }
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
    const argv = now && Array.isArray(task.argv) ? task.argv : [];
    const named = argv.includes("--session") ? argv[argv.indexOf("--session") + 1] : null;
    const explicit = (now ? (typeof result?.session === "string" ? result.session : null) : r?.resumedFrom) || named || null;
    const flagged = now ? Boolean(result?.resumed || result?.resumeLast || argv.includes("--resume-last")) : Boolean(r?.resumed);
    const from = explicit || (flagged && session && sessions.includes(session) ? session : null);
    const resumedAttempt = from ? sessions.lastIndexOf(from) + 1 || null : null;
    sessions.push(session);
    let state = now ? row.state : r ? r.status : "aborted";
    if (!now && state === "completed" && r.decisions && task.decisionResolvedAttempt !== n) state = "needs-decision";
    const startedAt = now ? row.startedAt : r?.startedAt || null;
    const finishedAt = now ? result?.finishedAt || null : r?.finishedAt || null;
    const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
    const errorText = now ? (typeof result?.error === "string" ? result.error : result?.error ? JSON.stringify(result.error) : "") : r?.error || "";
    const failed = !["completed", "needs-decision", "running", "prepared"].includes(state);
    return {
      n,
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
  const running = relayAlive(task.pid, task.startedAt);
  // The relay writes result.json and exits; if it did both between the read above and the check,
  // read again before calling the task aborted.
  if (!running && !result && task.pid) result = readResult();
  let state;
  if (!task.pid) state = "prepared";
  else if (running) state = "running";
  else if (result) state = result.status || "unknown";
  else state = "aborted"; // exited without result.json: usage error, kill, or crash; see the log
  // A session that ended by handing back a question is waiting on its orchestrator, not done.
  const decisions = state === "completed" ? decisionsIn(result.finalMessage) : null;
  if (decisions) state = "needs-decision";
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
  const quietMs = running && lastEventMs ? Date.now() - lastEventMs : null;
  // When the session last did anything: its latest event while running, else when it finished.
  const lastActiveMs = running ? lastEventMs || Date.now() : (result?.finishedAt && Date.parse(result.finishedAt)) || lastEventMs || started || 0;
  // A task that stopped because its agent ran out of usage: the one case where limits matter.
  const finishedText = [current.error, result?.error, result?.finalMessage, result?.stderrTail].filter(Boolean).join("\n");
  // Only the error counts: a full window or a limit status still leaves the team plans' extra usage.
  const limitHit = !running && !["prepared", "completed", "needs-decision"].includes(state) && USAGE_LIMIT_RE.test(finishedText);
  let now;
  if (running) now = `${quietMs > QUIET_AFTER_MS ? `quiet ${formatElapsed(quietMs)} · ` : ""}${current.activity || "starting"}`;
  else if (decisions) now = firstLine(`asks: ${decisions.join(" · ")}`);
  else if (result) now = firstLine(result.finalMessage) || current.error || "(empty final message)";
  else now = state === "prepared" ? "worktree ready" : "relay exited without a result; see log";

  const row = {
    id: task.id,
    agent: task.agent || "-",
    mode: !task.pid
      ? "-"
      : `${task.babysit ? "babysit" : task.readOnly ? "read-only" : "write"}${task.network === "off" && !task.readOnly ? "+offline" : task.sandboxed && !task.readOnly ? "+sandbox" : ""}`,
    state,
    attempt: task.attempt || 0,
    elapsed: task.pid ? formatElapsed(elapsedMs) : "-",
    steps: task.pid ? current.steps : "-",
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
    quietMs,
    touched: Array.isArray(result?.touchedFiles) ? result.touchedFiles.length : "-",
    now,
    cd: task.cd || task.worktree?.path || null,
    branch: task.worktree?.branch || null,
    outDir: task.outDir || null,
    // Closed: finished, and either completed or its result collected, or closed with `close`.
    closed: !["running", "prepared"].includes(state) && (state === "completed" || Boolean(task.closedAt)),
    decisions,
    limitHit,
    result,
  };
  const reported = { ...row, ...reportFields(run, task, row) };
  const staged = { ...reported, ...lifecycleFields(run, task, reported) };
  const described = { ...staged, ...inboxFields(run, task, staged) };
  described.attempts = attemptsOf(task, seen, described);
  return described;
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

// The nearest claude or codex ancestor process is the orchestrator. Environment variables alone
// are ambiguous: a Codex session started from Claude Code inherits Claude's variables.
export function detectOrchestrator() {
  const env = process.env;
  if (env.AGENT_ORCH_DEPTH) {
    return { agent: "delegated-agent", sessionId: null, parentRun: env.AGENT_ORCH_RUN || null, parentTask: env.AGENT_ORCH_TASK || null, depth: DEPTH };
  }
  let pid = process.ppid;
  for (let hops = 0; pid > 1 && hops < 20; hops++) {
    const r = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" });
    const m = /^(\d+)\s+(.*)$/.exec((r.stdout || "").trim());
    if (!m) break;
    const argv0 = m[2].split(/\s+/).slice(0, 2).map((a) => path.basename(a));
    if (argv0.includes("codex") || argv0.includes("codex.js")) {
      return { agent: "codex", sessionId: env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null, pid };
    }
    if (argv0.includes("claude")) return { agent: "claude", sessionId: env.CLAUDE_CODE_SESSION_ID || null, pid };
    pid = Number(m[1]);
  }
  return { agent: "terminal", sessionId: null };
}
