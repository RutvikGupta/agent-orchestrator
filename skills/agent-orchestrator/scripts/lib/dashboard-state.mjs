// The dashboard's state (/api/state): one section per launching session, holding its runs and every
// session they launched as a tree, plus Claude Code sessions that started sub-agents without this
// skill, and the headless agents that a skill's script started outside it (external.mjs). A task's
// row lists the headless agents that its own shell started (`inner`). Each
// section also lists its sessions that need attention, and flags the finished rows that
// the page folds away by default (`older`). Built at most every 250 ms.

import fs from "node:fs";
import path from "node:path";
import { mainSession, sessionGone, sessionLabel } from "./addressee.mjs";
import { CLAUDE_PROJECTS, HOME, RUNS_DIR } from "./config.mjs";
import { externalAgents, externalRow, innerAgent } from "./external.mjs";
import { parentOf, runById } from "./finish-notice.mjs";
import { firstLine, formatElapsed, shortText } from "./format.mjs";
import { claudeNativeAgents, listNative, mainRow, mainTranscript } from "./native.mjs";
import { reviveParked } from "./park.mjs";
import { attemptAgent, isParked, listRuns, listTasks, loadTask, processSnapshot, relayAlive } from "./runs.mjs";
import { parseDuration, tailText } from "./util.mjs";
import { totals, totalsText, treeOrder } from "./views.mjs";

// Durations the environment may override, such as AGENT_ORCH_BOARD_IDLE=90m. They are read when
// used, not when this module loads, because `wait` loads it too; buildDashboardState() reads all
// of them first, so a bad value stops the dashboard at its first build with parseDuration's message.
const envDuration = (name, fallback) => parseDuration(process.env[name] || fallback);
const boardIdleMs = () => envDuration("AGENT_ORCH_BOARD_IDLE", "2h");
const rowIdleMs = () => envDuration("AGENT_ORCH_ROW_IDLE", "1h");
const reviewStaleMs = () => envDuration("AGENT_ORCH_REVIEW_STALE", "24h");

const boardRow = ({ result, activeMs, ...t }) => ({
  ...t,
  finalMessage: result?.finalMessage ?? t.finalMessage ?? null,
  exitCode: result?.exitCode ?? null,
  readOnlyViolation: result?.readOnlyViolation ?? null,
  touchedFiles: result?.touchedFiles ?? null,
});

// The attention lane: sessions that need someone now, most urgent kind first. The lifecycle and
// report fields decide when a row has them (phase, health, awaitingReviewMs); otherwise its state,
// limitHit, and whether it is closed do. A closed session never needs attention: `close` retired
// it, or `result` handed its report over. For an orch.mjs task, `closed` is its own closedAt,
// because describe() marks every completed task closed; a native sub-agent counts as closed once it
// stops, since the session that started it receives its result. A babysitter never awaits review:
// it is done once its pull request lands or is approved. A review left waiting longer than
// AGENT_ORCH_REVIEW_STALE (24h) is stale and leaves the lane; `recover` still lists it. A running
// task is stuck when it keeps re-running one failing command with no change in between (`stuck`,
// from report.mjs); its wait counts from the first of those failures when the events carry a time.
// /api/state exposes each kind's rank, so stuck takes 2.5 and the ranks before it stay as they were.
// A running task that asked the user a question with `ask` (its row's `question`, from inbox.mjs)
// comes first, at 0.5: it waits on an answer while it works, and the item clears once its own
// addressee sends a message after the question (openQuestions in inbox.mjs).
const ATTENTION = { question: 0.5, "needs-decision": 1, failed: 2, stuck: 2.5, "awaiting-review": 3, silent: 4 };
const UNFAILED = new Set(["running", "prepared", "completed", "needs-decision", "idle"]);

export function attentionOf(t, closed, now = Date.now()) {
  if (t.main || closed) return null;
  const item = (kind, label, reason) => ({ kind, rank: ATTENTION[kind], label, reason, sinceMs: t.lastActiveMs || 0 });
  if (t.state === "running" && t.question?.text) {
    const q = t.question;
    const reason = [firstLine(q.text, 140), q.options?.length ? `options: ${q.options.join(" | ")}` : null, q.recommend ? `recommends ${q.recommend}` : null, q.open > 1 ? `+${q.open - 1} more` : null];
    return { ...item("question", "question", reason.filter(Boolean).join(" · ")), sinceMs: Date.parse(q.time) || t.lastActiveMs || 0 };
  }
  // A parked babysitter (park.mjs) waits for its pull request: nothing to review, decide or fix.
  if (t.phase === "parked") return null;
  if (t.state === "needs-decision" || t.phase === "needs-decision") {
    const question = [t.decisions?.[0], t.report?.decisions?.[0]].map((d) => (typeof d === "string" ? d : d?.question)).find(Boolean);
    return item("needs-decision", "needs decision", firstLine(question, 140) || "read its final message");
  }
  if (t.limitHit || t.health === "dead" || t.health === "transient-error" || (t.phase ? t.phase === "failed" : !UNFAILED.has(t.state))) {
    const label = t.limitHit ? "usage limit" : t.health === "dead" ? "dead" : t.health === "transient-error" ? "transient error" : UNFAILED.has(t.state) ? "failed" : t.state;
    return item("failed", label, firstLine(t.result?.error, 140) || firstLine(t.result?.finalMessage ?? t.finalMessage, 140) || t.now || "");
  }
  if (t.state === "running" && t.stuck) {
    const reason = `\`${shortText(t.stuck.command, 80)}\` failed ${t.stuck.failures} times with no change in between`;
    return { ...item("stuck", "stuck", reason), sinceMs: t.stuck.firstMs || t.lastActiveMs || 0 };
  }
  if (t.phase ? t.phase === "awaiting-review" : t.state === "completed") {
    if (String(t.mode || "").startsWith("babysit")) return null;
    const waited = t.awaitingReviewMs ?? (t.lastActiveMs ? now - t.lastActiveMs : null);
    if (waited != null && waited >= reviewStaleMs()) return null;
    return item("awaiting-review", "awaiting review", `waiting ${formatElapsed(waited)}${t.report?.outcome ? ` · reported ${t.report.outcome}` : ""}`);
  }
  if (t.health === "silent") {
    const doing = String(t.now || "").replace(/^quiet \S+ · /, "");
    return item("silent", "silent", `no events for ${formatElapsed(t.quietMs)}${doing ? ` · ${doing}` : ""}`);
  }
  return null;
}

// Most urgent kind first; within a kind, the one that has waited longest.
export const byUrgency = (a, b) => a.rank - b.rank || a.sinceMs - b.sinceMs;

// Who must act on an attention item: the fields the board adds to it. `to` is "agent" or "user";
// `agent` names the agent that must act ("task <run>/<task>" or "orchestrator session 425c2bc2"),
// or is null when the item is the user's own; `agentTask` is that orch task, {run, task}, or null
// for a session; `gone` says why that agent no longer takes it, when the item went to the user for
// that reason. A task in a nested run reports to the orch task that started it, and one in a
// top-level run to the session that launched the run (addressee.mjs), decisions it hands back
// included. The user takes an item only when an agent passed it up (`ask --user`), when a usage
// limit stopped the task, when the run was started from a terminal, or when the agent is gone: an
// orch task that no longer runs, or a session whose process ended or that has had no live `wait`
// on the run for the grace (agentGraceMs). `table` is the process table for that check, PID to
// command line, so one board build runs `ps` once.
export function addresseeOf(run, record, row, item, now = Date.now(), table = undefined) {
  const user = (agent = null, gone = null, agentTask = null) => ({ to: "user", agent, agentTask, gone });
  if (item.label === "usage limit") return user();
  if (item.kind === "question" && row.question?.to === "user") return user();
  const parent = parentOf(run, record);
  if (!parent) {
    const session = mainSession(run);
    if (!session || !run.dir) return user();
    const agent = sessionLabel(session);
    const gone = sessionGone(run, session, now, table);
    return gone ? user(agent, gone) : { to: "agent", agent, agentTask: null, gone: null };
  }
  const agent = `task ${parent.run}/${parent.task}`;
  const agentTask = { run: parent.run, task: parent.task };
  const parentRun = runById(parent.run);
  const task = parentRun && loadTask(parentRun, parent.task);
  const gone = !parentRun ? "its run is gone" : !task ? "its task is gone"
    : relayAlive(task.pid, task.startedAt) || isParked(parentRun, task) ? null : "it is not running";
  return gone ? user(agent, gone, agentTask) : { to: "agent", agent, agentTask, gone: null };
}

const addressed = (run, record, row, item, now, table) => (item ? { ...item, ...addresseeOf(run, record, row, item, now, table) } : null);

// The board's process table for addresseeOf, PID to command line, from the shared snapshot.
function commandTable() {
  const rows = processSnapshot();
  return rows ? new Map([...rows].map(([pid, r]) => [pid, r.command])) : null;
}

// The board hides a run once none of its sessions has run for AGENT_ORCH_BOARD_IDLE (2h). Its files
// stay, so `status` and `result` still read it, and new activity in the run shows it again.
const BOARD_RUNS = 25;
const idleRuns = new Map(); // run id -> { stamp: runStamp() when found idle, checkedMs }
const IDLE_RECHECK_MS = 15_000;

// Latest write to the run's own files, plus the launching session's transcript when the run is
// that session's newest (only then does the session's activity count as the run's).
function runStamp(run, ownsMain) {
  let latest = 0;
  const stamp = (f) => {
    try {
      latest = Math.max(latest, fs.statSync(f).mtimeMs);
    } catch {}
  };
  stamp(path.join(run.dir, "run.json"));
  const dir = path.join(run.dir, "tasks");
  if (fs.existsSync(dir)) for (const id of fs.readdirSync(dir)) stamp(path.join(dir, id, "task.json"));
  if (ownsMain) stamp(mainTranscript(run));
  return latest;
}

// Whether a run past the board's cap still has a task nobody closed that changed within the idle
// window: a result awaiting review or a decision that waits on someone. Reads task records only.
function openWork(run, idleMs, now) {
  let ids = [];
  try { ids = fs.readdirSync(path.join(run.dir, "tasks")); } catch { return false; }
  return ids.some((id) => {
    const dir = path.join(run.dir, "tasks", id);
    try {
      const task = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
      if (!task.attempt || task.closedAt) return false;
      // The record changes when an attempt starts; its result file, when it ends.
      const changed = [path.join(dir, "task.json"), path.join(dir, `attempt-${task.attempt}`, "result.json")]
        .map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } });
      return now - Math.max(...changed) < idleMs;
    } catch { return false; }
  });
}

// Whether any task of the run still has its relay process, or is parked, from the task records alone.
function anyRelayAlive(run) {
  const dir = path.join(run.dir, "tasks");
  let ids = [];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return ids.some((id) => {
    const task = loadTask(run, id);
    return Boolean(task?.pid) && (relayAlive(task.pid, task.startedAt) || isParked(run, task));
  });
}

function boardIdle(run, tasks, ownsMain, idleMs) {
  const counted = tasks.filter((t) => !t.main || ownsMain);
  if (counted.some((t) => t.state === "running")) return false;
  const last = Math.max(Date.parse(run.createdAt) || 0, ...counted.map((t) => t.lastActiveMs || 0));
  return Date.now() - last >= idleMs;
}

// Rows the board folds away by default inside a section that stays: not running, not needing
// attention, not the main session, and quiet for AGENT_ORCH_ROW_IDLE (1h). A row stays while any
// row under it stays, so a folded row takes its whole subtree with it and the tree keeps its shape.
// Every row carries `older`; the page shows a section's older rows again on request.
function markOlder(rows, idleMs, now) {
  const kept = new Set(); // keys of rows with a row under them that stays
  const older = new Map();
  for (const t of [...rows].reverse()) {
    const quiet = !t.main && t.state !== "running" && !t.attention && now - (t.activeMs ?? t.lastActiveMs ?? 0) >= idleMs;
    const fold = quiet && !kept.has(t.key);
    older.set(t, fold);
    if (!fold && t.parentKey) kept.add(t.parentKey);
  }
  return rows.map((t) => ({ ...t, older: older.get(t) }));
}

// Claude Code sessions that started sub-agents, found from Claude Code's own files
// (<projects>/<project>/<session>/subagents/agent-*.jsonl), so the board also shows sessions that
// never used this skill. Rescanned at most every few seconds.
let claudeScan = { at: 0, sessions: [] };
function claudeSessionsWithAgents() {
  if (Date.now() - claudeScan.at < 5000) return claudeScan.sessions;
  const sessions = [];
  let projects = [];
  try {
    projects = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {}
  for (const project of projects) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(CLAUDE_PROJECTS, project), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(CLAUDE_PROJECTS, project, entry.name, "subagents");
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => /^agent-.*\.jsonl$/.test(n));
      } catch {
        continue;
      }
      let firstMs = Infinity;
      let lastMs = 0;
      for (const n of names) {
        const st = fs.statSync(path.join(dir, n));
        firstMs = Math.min(firstMs, st.birthtimeMs || st.mtimeMs);
        lastMs = Math.max(lastMs, st.mtimeMs);
      }
      if (names.length) sessions.push({ sessionId: entry.name, file: path.join(CLAUDE_PROJECTS, project, `${entry.name}.jsonl`), firstMs, lastMs });
    }
  }
  claudeScan = { at: Date.now(), sessions };
  return sessions;
}

// A Claude Code session's newest title (Claude Code writes `ai-title` entries) and working
// directory, from the end of its transcript; cached by file size.
const claudeInfoCache = new Map();
function claudeSessionInfo(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return {};
  }
  const hit = claudeInfoCache.get(file);
  if (hit?.size === size) return hit.info;
  const info = { ...hit?.info };
  const lines = (tailText(file, 512_000) || "").split("\n");
  let title = null;
  let cwd = null;
  for (let i = lines.length - 1; i >= 0 && !(title && cwd); i--) {
    if (!title && lines[i].includes('"ai-title"')) title = /"aiTitle":"((?:[^"\\]|\\.)*)"/.exec(lines[i])?.[1];
    if (!cwd && lines[i].includes('"cwd":')) cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(lines[i])?.[1];
  }
  try {
    if (title) info.title = JSON.parse(`"${title}"`);
    if (cwd) info.cwd = JSON.parse(`"${cwd}"`);
  } catch {}
  claudeInfoCache.set(file, { size, info });
  return info;
}

let shownIds = new Set(); // session, thread, and agent ids shown on the board
let stateCache = { at: 0, value: null };
export function dashboardState() {
  if (Date.now() - stateCache.at < 250 && stateCache.value) return stateCache.value;
  const value = buildDashboardState();
  const ids = new Set();
  for (const sec of value) for (const t of sec.tasks) for (const id of [t.session, t.outDir && path.basename(t.outDir, ".jsonl")]) if (id) ids.add(id);
  shownIds = ids;
  stateCache = { at: Date.now(), value };
  return value;
}

// The session, thread, and agent ids on the board as of its latest build.
export function boardIds() {
  return shownIds;
}

// The headless agents that a task's own shell started, for its row (`inner`, oldest first, the newest
// INNER_MAX; `innerOmitted` counts the rest). Each is matched to the attempt it started in (`attempt`),
// so a resumed task does not take its earlier attempts' agents as its own. Their tokens stay out of the
// task's own. While the task's own latest event is a tool call that has waited INNER_QUIET_MS for its
// result, as when it runs a script that starts an agent, and an agent of its current attempt runs, the
// row's activity is that agent's latest, after "inner: ". Any newer event of the task's own, such as
// a message after it started a command in the background, means it is active itself: its own
// activity shows. The page lists each agent's events in the task's details.
const INNER_QUIET_MS = 30_000;
const INNER_MAX = 8;

// The attempt an agent started in: the latest one that had started by then, so one that starts after
// an attempt ended and before the next began still goes with the earlier. `attempts` is the row's list
// (newest first). An attempt whose start is not recorded starts where the one before it ended.
function attemptAt(attempts, ms, fallback) {
  const list = [...(attempts || [])].sort((x, y) => x.n - y.n);
  let found = list[0]?.n ?? fallback;
  let end = -Infinity; // where the attempt before ended
  for (const a of list) {
    const start = Date.parse(a.startedAt);
    const from = Number.isFinite(start) ? start : end;
    end = from + (Number.isFinite(a.durationMs) ? a.durationMs : 0);
    if (from <= ms) found = a.n;
  }
  return found;
}

// Whether the last event in the task's own log is a tool call with no result yet: a Claude assistant
// message that calls a tool, or a Codex item that has started. Read from the end of the file, once
// per change of the file.
const endMemo = new Map(); // events.jsonl path -> { mtimeMs, size, value }
function endsOnToolCall(agent, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  const hit = endMemo.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const lines = (tailText(file, 65_536) || "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let value = false;
  try {
    const e = JSON.parse(lines.at(-1));
    value = agent === "codex" ? e.type === "item.started" : e.type === "assistant" && (e.message?.content || []).some((b) => b.type === "tool_use");
  } catch {
    // An empty file, or a last line that is still being written: the task is active.
  }
  if (endMemo.size >= 500) endMemo.delete(endMemo.keys().next().value);
  endMemo.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function waitsOnTool(row, record) {
  if (row.state !== "running" || row.phase === "parked" || !row.outDir || !record || !(row.quietMs >= INNER_QUIET_MS)) return false;
  return endsOnToolCall(attemptAgent(record, record.attempt), path.join(row.outDir, "events.jsonl"));
}

function withInner(row, record, agents) {
  if (!agents?.length) return row;
  const inner = agents.slice(-INNER_MAX).map((x) => ({ ...innerAgent(x), attempt: attemptAt(row.attempts, x.startedMs, row.attempt) }));
  const active = inner.filter((a) => a.attempt === row.attempt && a.state === "running").sort((a, b) => b.lastActiveMs - a.lastActiveMs)[0];
  return {
    ...row,
    inner,
    ...(agents.length > inner.length ? { innerOmitted: agents.length - inner.length } : {}),
    now: active && waitsOnTool(row, record) ? `inner: ${active.now}` : row.now,
  };
}

// A script of the user's skills or agent tooling, such as ~/.agents/code-review/codex_review.sh.
const skillScript = (command) => Boolean(command) && (command.includes(`${HOME}/.agents/`) || command.includes(`${HOME}/.claude/`) || /[/\\]\.(claude|agents)[/\\]skills[/\\]/.test(command));

// Headless agents that a command started outside the orchestrator (external.mjs). Only Codex and
// Claude Opus agents that a skill's script started from a session are listed: one started from a
// task's shell is that task's own work (a runner task that runs a review script, say), so the task's
// row stands for it, and its details show the agent (innerOf below). The board row of a listed
// agent, or null.
function listedExternal(x) {
  const p = x.parent || {};
  if ((p.run && p.task) || !skillScript(x.launcher)) return null;
  const row = externalRow(x, x.name, null);
  return x.agent === "claude" && row.model && !/opus/.test(row.model) ? null : row;
}

// Each listed agent goes under whoever ran the command: the task, sub-agent or outside agent on the board whose
// shell it was (by the nearest session's variable); else the task named by AGENT_ORCH_RUN and
// AGENT_ORCH_TASK; else the row of the other session variable; else that session's section,
// created if needed; else one shared section.
function placeExternal(externals, sections, sectionOf, sessionSection) {
  if (!externals.length) return;
  const hosts = new Map(); // session id -> [section, row], for every task and sub-agent on the board
  const tasks = new Map(); // "run/task" -> [section, row]
  for (const sec of sections.values()) {
    for (const t of sec.rows) {
      if (t.session && !hosts.has(t.session)) hosts.set(t.session, [sec, t]);
      if (!t.native) tasks.set(`${t.run}/${t.id}`, [sec, t]);
    }
  }
  let shared = null;
  for (const x of externals) {
    const p = x.parent || {};
    const { row } = x;
    const sessions = (p.nearest === "claude" ? [["claude", p.claude], ["codex", p.codex]] : [["codex", p.codex], ["claude", p.claude]]).filter(([, id]) => id);
    // The variable of the nearest session is set by the shell that ran the command, so it names the
    // launcher more closely than the inherited AGENT_ORCH_* variables.
    const host = (p.nearest && sessions[0]?.[0] === p.nearest && hosts.get(sessions[0][1]))
      || (p.run && p.task && tasks.get(`${p.run}/${p.task}`))
      || sessions.map(([, id]) => hosts.get(id)).find(Boolean);
    let section, run, parent;
    if (host) [section, run, parent] = [host[0], host[1].run, host[1].id];
    else {
      for (const [agent, id] of sessions) {
        section = sections.get(`${agent}-${id}`) || sessionSection(agent, id, x.startedMs);
        if (section) break;
      }
      if (section) {
        // The session's latest run created before the agent started (runs are newest first).
        const own = section.runs.filter((r) => sessions.some(([, id]) => r.orchestrator?.sessionId === id));
        run = (own.find((r) => Date.parse(r.createdAt) <= x.startedMs) || own[own.length - 1] || section.runs[0]).id;
        parent = "orchestrator";
      } else {
        if (!shared) {
          const r = { id: "external", goal: "Agents that a skill's script started, from a session that is not found", createdAt: new Date(x.startedMs).toISOString(), orchestrator: null, sessionOnly: true };
          shared = sectionOf(r);
          shared.runs.push(r);
        }
        [section, run, parent] = [shared, "external", null];
      }
    }
    const ids = new Set(section.rows.filter((t) => t.run === run).map((t) => t.id));
    let id = x.name;
    for (let n = 2; ids.has(id); n++) id = `${x.name.slice(0, 25)}-${n}`;
    const placed = { ...row, id, parent, run, attention: null };
    section.rows.push(placed);
    // An agent that this one's shell starts goes under it (they come oldest first).
    hosts.set(x.sessionId, [section, placed]);
  }
}

export function buildDashboardState() {
  const now = Date.now();
  let commands; // the process table for addresseeOf, read once per build when first needed
  const table = () => (commands === undefined ? (commands = commandTable()) : commands);
  const idleMs = boardIdleMs();
  const rowIdle = rowIdleMs();
  reviewStaleMs(); // attentionOf reads it per row; reading it here checks it on every build
  const runs = listRuns();
  // Headless agents found outside the orchestrator. Those that a task's shell started are kept for
  // as long as the task shows, however long ago they ended; "run/task" -> its agents, oldest first.
  const outside = externalAgents(now - idleMs, (x) => Boolean(x.parent?.run && x.parent?.task));
  const innerOf = new Map();
  for (const x of outside) {
    if (!x.parent?.run || !x.parent?.task) continue;
    const key = `${x.parent.run}/${x.parent.task}`;
    innerOf.set(key, [...(innerOf.get(key) || []), x]);
  }
  const newestOfSession = new Map();
  for (const run of runs) if (run.orchestrator?.sessionId && !newestOfSession.has(run.orchestrator.sessionId)) newestOfSession.set(run.orchestrator.sessionId, run.id);
  // One section per launching session: its runs (newest first, as listRuns returns them) share it.
  const sections = new Map();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const rootOf = (run) => {
    let r = run;
    for (let hops = 0; r.orchestrator?.parentRun && byId.has(r.orchestrator.parentRun) && hops < 10; hops++) r = byId.get(r.orchestrator.parentRun);
    return r;
  };
  const sectionOf = (run) => {
    const o = rootOf(run).orchestrator;
    const id = o?.sessionId ? `${o.agent}-${o.sessionId}` : run.id;
    if (!sections.has(id)) sections.set(id, { id, runs: [], main: null, rows: [] });
    return sections.get(id);
  };
  // Runs with a live process (a relay, a park watcher, a wait) are always shown, however old: the
  // cap of BOARD_RUNS applies only to the rest, so a long run is never pushed off by newer ones.
  const live = new Set();
  const runPath = new RegExp(`${RUNS_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/\\s]+)/`);
  for (const proc of (processSnapshot() || new Map()).values()) {
    const m = runPath.exec(proc?.command || "");
    if (m) live.add(m[1]);
  }
  let counted = 0;
  for (const run of runs) {
    if (counted >= BOARD_RUNS && !live.has(run.id) && !openWork(run, idleMs, now)) continue;
    const ownsMain = newestOfSession.get(run.orchestrator?.sessionId) === run.id;
    // An idle run is checked again at most every IDLE_RECHECK_MS: stamping it stats every task.
    const idle = idleRuns.get(run.id);
    if (idle && now - idle.checkedMs < IDLE_RECHECK_MS) continue;
    const stamp = runStamp(run, ownsMain);
    if (idle?.stamp === stamp) {
      idle.checkedMs = now;
      continue;
    }
    // A run whose files haven't changed for AGENT_ORCH_BOARD_IDLE and that has no live relay is
    // idle: skip it without describing its tasks, which reads every task's event log. A new
    // process (a restarted dashboard) would otherwise read every run ever made.
    if (now - stamp >= idleMs && !anyRelayAlive(run)) {
      idleRuns.set(run.id, { stamp, checkedMs: now });
      continue;
    }
    const described = listTasks(run);
    reviveParked(run, described); // a parked task whose watcher is not running gets a new one
    const main = mainRow(run);
    const natives = listNative(run, described, runs);
    if (boardIdle(run, [...(main ? [main] : []), ...described, ...natives], ownsMain, idleMs)) {
      idleRuns.set(run.id, { stamp, checkedMs: now });
      continue;
    }
    idleRuns.delete(run.id);
    counted += 1;
    const section = sectionOf(run);
    section.runs.push(run);
    section.main ||= main;
    // A nested run's tasks hang under the task that started the run. A task that never ran dates
    // from when it was prepared (`activeMs`, which markOlder reads and the board leaves out).
    const p = run.orchestrator?.parentRun && run.orchestrator.parentTask ? { run: run.orchestrator.parentRun, id: run.orchestrator.parentTask } : null;
    const records = new Map(described.map((t) => [t.id, loadTask(run, t.id)]));
    section.rows.push(
      ...described.map((d) => {
        const record = records.get(d.id);
        const t = withInner(d, record, innerOf.get(`${run.id}/${d.id}`));
        return { ...t, run: run.id, under: p, attention: addressed(run, record, t, attentionOf(t, Boolean(record?.closedAt), now), now, table()), activeMs: t.lastActiveMs || Date.parse(record?.createdAt) || 0 };
      }),
      ...natives.map((t) => ({ ...t, run: run.id, attention: addressed(run, null, t, attentionOf(t, t.closed, now), now, table()) })),
    );
  }
  // Claude Code sessions whose sub-agents ran within AGENT_ORCH_BOARD_IDLE without this skill: each
  // gets a section of its own. Sessions already shown, as a run's main session or task, are skipped.
  const known = new Set(runs.map((r) => r.orchestrator?.sessionId).filter(Boolean));
  for (const sec of sections.values()) for (const t of sec.rows) if (t.session && !t.native) known.add(t.session);
  // Only listed agents count as shown, so a hidden one's session keeps its own section.
  const externals = outside.filter((x) => !known.has(x.sessionId)).map((x) => ({ ...x, row: listedExternal(x) })).filter((x) => x.row);
  for (const x of externals) known.add(x.sessionId); // shown under whoever started it, below
  // A section for a session that launched no run, headed by the session's own row. Without its
  // transcript there is no such row: then null, unless `always`.
  const sessionSection = (agent, sessionId, firstMs, always = false) => {
    const run = { id: `${agent}-${sessionId}`, createdAt: new Date(firstMs).toISOString(), orchestrator: { agent, sessionId }, sessionOnly: true };
    const main = mainRow(run);
    if (!main && !always) return null;
    const info = agent === "claude" && main ? claudeSessionInfo(main.outDir) : {};
    Object.assign(run, { goal: info.title || `${agent === "claude" ? "Claude Code" : "Codex"} session ${sessionId.slice(0, 8)}`, repo: info.cwd || null });
    const section = sectionOf(run);
    section.runs.push(run);
    section.main = main;
    return section;
  };
  for (const c of claudeSessionsWithAgents()) {
    if (sections.size >= BOARD_RUNS) break;
    if (known.has(c.sessionId) || now - c.lastMs >= idleMs) continue;
    const section = sessionSection("claude", c.sessionId, c.firstMs, true);
    section.rows.push(...claudeNativeAgents(c.sessionId, "orchestrator").map((t) => ({ ...t, run: section.runs[0].id, attention: addressed(section.runs[0], null, t, attentionOf(t, t.closed, now), now, table()) })));
  }
  placeExternal(externals, sections, sectionOf, sessionSection);
  const shown = [...sections.values()].map(({ id, runs: secRuns, main, rows }) => {
    const newest = secRuns.find((r) => !r.orchestrator?.parentRun) || secRuns[0];
    const tasks = markOlder(treeOrder([...(main ? [{ ...main, attention: null }] : []), ...rows]), rowIdle, now).map(boardRow);
    const work = tasks.filter((t) => !t.main);
    // `parent` names the task that started a nested run.
    const parentOf = (r) => (r.orchestrator?.parentRun && r.orchestrator.parentTask ? { run: r.orchestrator.parentRun, task: r.orchestrator.parentTask } : null);
    return {
      ...newest,
      id,
      createdAt: secRuns[secRuns.length - 1].createdAt, // when the section's first run started
      runs: secRuns.map((r) => ({ id: r.id, goal: r.goal || null, createdAt: r.createdAt, parent: parentOf(r) })),
      startedMs: Date.parse(main?.startedAt) || Date.parse(secRuns[secRuns.length - 1].createdAt) || 0,
      running: tasks.some((t) => t.state === "running"),
      activeMs: Math.max(Date.parse(secRuns[0].createdAt) || 0, ...tasks.map((t) => t.lastActiveMs || 0)),
      tasks,
      // This section's part of the attention lane; the page merges every section's in the same order.
      // Each item names its own run's goal: a section holds every run of one session, and the
      // section's goal is only its newest run's. Its `to`, `agent` and `gone` say who must act
      // (addresseeOf); the page counts and leads with the user's items only.
      attention: tasks.filter((t) => t.attention).map((t) => ({ key: t.key, id: t.id, runId: t.run || null, runGoal: secRuns.find((r) => r.id === t.run)?.goal || null, ...t.attention })).sort(byUrgency),
      totals: totals(work),
      totalsText: `${totalsText(totals(work))}${main ? " (without the main session)" : ""}`,
    };
  });
  // Sections with something running first, by the newest main session (so they do not swap on
  // every event), then the rest by their latest activity.
  return shown.sort((a, b) => b.running - a.running || (a.running ? b.startedMs - a.startedMs : b.activeMs - a.activeMs) || b.startedMs - a.startedMs);
}

// A parked babysitter holds no agent, so it does not keep a detached dashboard open.
export function anyTaskRunning() {
  return dashboardState().some((run) => run.tasks.some((t) => !t.main && t.state === "running" && t.phase !== "parked"));
}
