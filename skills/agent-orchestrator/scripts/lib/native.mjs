// Native sub-agents: agents that a session started with its host's own tool (Claude Code's Agent
// tool, Codex's spawn_agent) instead of `orch.mjs start`. They bypass the model policy and
// `--why`, but the views still list them, under the run that their session launched.
//   Claude Code: <config>/projects/<project>/<session>/subagents/agent-*.jsonl plus .meta.json,
//   and subagents/workflows/<workflow id>/agent-*.jsonl for the agents a Workflow started
//   Codex: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl whose session_meta names the parent
//   thread and has thread_source "subagent" (Codex's automatic approval reviews are skipped).
// The session that launched a run is read from its own transcript the same way (`mainRow`).

import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS, QUIET_AFTER_MS, TURN_SILENT_MS } from "./config.mjs";
import { decisionsIn } from "./briefs.mjs";
import { codexMeta, codexRolloutsSince, codexThreadStart } from "./codex.mjs";
import { newSummary, summarizeEvents, summarizeRollout } from "./events.mjs";
import { firstLine, formatElapsed, slug } from "./format.mjs";
import { listRuns } from "./runs.mjs";
import { readJson } from "./util.mjs";
import { claudeSessions, codexThreads } from "./vendor-status.mjs";

export function nativeRow({ id, agent, parent, startedMs, lastMs, running, summary, sessionId, file, description, why }) {
  const status = sessionId && (agent === "claude" ? claudeSessions() : codexThreads())?.get(sessionId);
  if (status) running = status.state === "running";
  const quietMs = running && lastMs ? Date.now() - lastMs : null;
  const model = status?.model || summary.model || null;
  const decisions = running || (status && !status.waiting) ? null : decisionsIn(summary.lastMessage);
  return {
    id,
    agent,
    native: true,
    parent,
    mode: "native",
    state: status?.state || (running ? "running" : decisions ? "needs-decision" : agent === "codex" ? "idle" : "completed"),
    stateSource: status ? agent === "claude" ? "claude-agents" : "codex-app-server" : "transcript",
    waiting: status?.waiting || false,
    attempt: 1,
    elapsed: formatElapsed((running ? Date.now() : lastMs) - startedMs),
    steps: summary.steps,
    tokensIn: summary.tokens.input,
    tokensCached: summary.tokens.cached,
    tokensOut: summary.tokens.output,
    tokensExact: Boolean(summary.exact),
    costUsd: null,
    model,
    tier: null,
    modelLabel: model ? `${model.replace(/^(claude|gpt|codex)-/, "")} ${summary.effort || ""}`.trim() : "-",
    why: why || `started with ${agent === "codex" ? "Codex's spawn_agent" : "Claude Code's Agent tool"}, not orch.mjs${description ? `: ${description}` : ""}`,
    session: sessionId,
    quietMs,
    touched: "-",
    now: status?.waiting ? status.waitingFor || "waiting for input" : running ? `${quietMs > QUIET_AFTER_MS ? `quiet ${formatElapsed(quietMs)} · ` : ""}${summary.activity || "starting"}` : decisions ? firstLine(`asks: ${decisions.join(" · ")}`) : firstLine(summary.lastMessage) || summary.activity || "",
    decisions,
    cd: null,
    branch: null,
    outDir: file,
    finalMessage: summary.lastMessage || null,
    startedAt: new Date(startedMs).toISOString(),
    lastActiveMs: lastMs || startedMs,
    closed: !running && !status?.waiting,
    result: null,
  };
}

// Codex threads spawned by thread `rootId`, directly or through other sub-agents. `window`
// limits which direct children count (by start time); their descendants always follow them.
// Codex's automatic approval reviews are summed into one row per parent.
export function codexNativeAgents(rootId, parentLabel, window = [0, Infinity]) {
  const since = Math.min(window[0], codexThreadStart(rootId) || window[0]);
  const metas = codexRolloutsSince(since)
    .map((file) => ({ file, meta: codexMeta(file) }))
    .filter((x) => x.meta?.parent_thread_id && ["subagent", "guardian_review"].includes(x.meta.thread_source));
  const rows = [];
  const walk = (parentId, parent, top) => {
    const kids = metas.filter((x) => x.meta.parent_thread_id === parentId);
    const reviews = { summary: { ...newSummary(), busy: false }, count: 0, startedMs: Infinity, latestStartMs: 0, lastMs: 0, file: null };
    for (const { file, meta } of kids) {
      const startedMs = Date.parse(meta.timestamp);
      if (top && !(startedMs >= window[0] && startedMs < window[1])) continue;
      const summary = summarizeRollout(file);
      const lastMs = fs.statSync(file).mtimeMs;
      const busy = summary.busy && Date.now() - lastMs < TURN_SILENT_MS;
      if (meta.thread_source === "guardian_review") {
        reviews.count += 1;
        reviews.summary.tokens.input += summary.tokens.input;
        reviews.summary.tokens.cached += summary.tokens.cached;
        reviews.summary.tokens.output += summary.tokens.output;
        reviews.summary.steps += summary.steps;
        reviews.summary.exact = true;
        reviews.summary.busy ||= busy;
        reviews.summary.model ||= summary.model;
        reviews.startedMs = Math.min(reviews.startedMs, startedMs);
        reviews.latestStartMs = Math.max(reviews.latestStartMs, startedMs);
        if (lastMs > reviews.lastMs) Object.assign(reviews, { lastMs, file });
        continue;
      }
      const name = path.basename(meta.agent_path || meta.id);
      rows.push(nativeRow({ id: name, agent: "codex", parent, startedMs, lastMs, running: busy, summary, sessionId: meta.id, file, description: meta.agent_nickname ? `nickname ${meta.agent_nickname}` : null }));
      walk(meta.id, name, false);
    }
    if (reviews.count) {
      reviews.summary.activity = `${reviews.count} automatic approval review(s) by Codex`;
      const row = nativeRow({ id: "approval-reviews", agent: "codex", parent, startedMs: reviews.startedMs, lastMs: reviews.lastMs, running: reviews.summary.busy, summary: reviews.summary, sessionId: null, file: reviews.file, why: `Codex started ${reviews.count} session(s) on its own to review approval requests; the transcript is the latest one` });
      rows.push({ ...row, state: reviews.summary.busy ? "running" : "completed", now: reviews.summary.activity, invokedAt: new Date(reviews.latestStartMs).toISOString() });
    }
  };
  walk(rootId, parentLabel, true);
  return rows;
}

// Claude Code sub-agents of session `sessionId` that started inside `window`.
// The folders that hold a session's sub-agent transcripts. Every row of a refresh asks, so the
// answer is kept for a second instead of checking every project folder each time.
const SUBAGENT_DIRS_MS = 1000;
let subagentDirs = { at: 0, root: null, bySession: new Map(), projects: null };
function sessionSubagentDirs(sessionId) {
  if (subagentDirs.root !== CLAUDE_PROJECTS || Date.now() - subagentDirs.at >= SUBAGENT_DIRS_MS) {
    let projects = null;
    try {
      projects = fs.readdirSync(CLAUDE_PROJECTS);
    } catch {}
    subagentDirs = { at: Date.now(), root: CLAUDE_PROJECTS, bySession: new Map(), projects };
  }
  if (!subagentDirs.projects) return [];
  if (!subagentDirs.bySession.has(sessionId)) {
    subagentDirs.bySession.set(sessionId, subagentDirs.projects
      .map((project) => path.join(CLAUDE_PROJECTS, project, sessionId, "subagents"))
      .filter((dir) => fs.existsSync(dir)));
  }
  return subagentDirs.bySession.get(sessionId);
}

// The transcripts in one sub-agent folder: the agents the Agent tool started (agent-*.jsonl), and
// those a Workflow started, which Claude Code keeps one folder down (workflows/<workflow id>/).
function agentFiles(dir) {
  const list = (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return []; // removed since it was found, or never there
    }
  };
  const own = (d) => list(d).filter((f) => /^agent-.*\.jsonl$/.test(f)).map((f) => path.join(d, f));
  const flows = path.join(dir, "workflows");
  return [...own(dir), ...list(flows).flatMap((wf) => own(path.join(flows, wf)))];
}

export function claudeNativeAgents(sessionId, parentLabel, window = [0, Infinity]) {
  const rows = [];
  const ids = new Set();
  for (const dir of sessionSubagentDirs(sessionId)) {
    for (const file of agentFiles(dir)) {
      const n = path.basename(file);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue; // removed since it was listed
      }
      const startedMs = stat.birthtimeMs || stat.mtimeMs;
      if (!(startedMs >= window[0] && startedMs < window[1])) continue;
      const meta = readJson(file.replace(/\.jsonl$/, ".meta.json")) || {};
      const summary = summarizeEvents("claude", file, null);
      const agentId = n.replace(/^agent-|\.jsonl$/g, "");
      // Two agents with one description, as a workflow's often have, get distinct ids.
      let id = slug(meta.description || agentId).slice(0, 28);
      if (ids.has(id)) id = `${id.slice(0, 21)}-${agentId.slice(-6)}`;
      ids.add(id);
      // Claude Code only sometimes adds `finished: true` to .meta.json; the transcript's end is reliable.
      const finished = meta.finished === true || Boolean(summary.ended);
      const interrupted = summary.interrupted && !summary.busy;
      const silent = Date.now() - stat.mtimeMs > TURN_SILENT_MS;
      const row = nativeRow({ id, agent: "claude", parent: parentLabel, startedMs, lastMs: stat.mtimeMs, running: !finished && !interrupted && !silent, summary, sessionId: agentId, file, description: meta.workflowPhase ? `workflow agent (${meta.workflowPhase}): ${meta.description || agentId}` : meta.description || meta.agentType });
      if (row.stateSource !== "transcript" || finished || !(interrupted || silent)) rows.push(row);
      else rows.push({ ...row, state: "stopped", now: `${interrupted ? "interrupted by the user" : "stopped without finishing"}; last: ${row.now}` });
    }
  }
  return rows;
}

// Transcript of the session that launched `run` (cached: a session keeps its file).
const transcriptCache = new Map();
export function mainTranscript(run) {
  const o = run.orchestrator;
  if (!o?.sessionId || !["claude", "codex"].includes(o.agent)) return null;
  if (transcriptCache.has(o.sessionId)) return transcriptCache.get(o.sessionId);
  let file = null;
  if (o.agent === "codex") {
    file = codexRolloutsSince(codexThreadStart(o.sessionId) || 0).find((f) => f.endsWith(`-${o.sessionId}.jsonl`)) || null;
  } else {
    try {
      file = fs.readdirSync(CLAUDE_PROJECTS).map((p) => path.join(CLAUDE_PROJECTS, p, `${o.sessionId}.jsonl`)).find((f) => fs.existsSync(f)) || null;
    } catch {
      file = null;
    }
  }
  if (file) transcriptCache.set(o.sessionId, file);
  return file;
}

// The session that launched the run, read from its own transcript: Codex's rollout, or Claude
// Code's <projects>/<project>/<session>.jsonl. Its counts cover the whole session, not only this
// run, so they stay out of the run's totals.
export function mainRow(run) {
  const o = run.orchestrator;
  const file = mainTranscript(run);
  if (!file) return null;
  const stat = fs.statSync(file);
  const summary = o.agent === "codex" ? summarizeRollout(file) : summarizeEvents("claude", file, run.repo);
  // Both hosts mark each turn's start and end; a turn left open but silent for long was cut off
  // (the session was killed mid-turn).
  const running = Boolean(summary.busy) && Date.now() - stat.mtimeMs < TURN_SILENT_MS;
  const startedMs = (o.agent === "codex" && codexThreadStart(o.sessionId)) || stat.birthtimeMs || stat.mtimeMs;
  // Claude Code also writes bookkeeping lines (costs, titles) to an idle session; its last message dates it.
  const lastMs = Math.min(Date.parse(summary.lastAt) || stat.mtimeMs, stat.mtimeMs);
  const row = nativeRow({ id: "main", agent: o.agent, parent: null, startedMs, lastMs, running, summary, sessionId: o.sessionId, file, why: "the session that launched this run; its counts cover the whole session" });
  const state = row.stateSource === "transcript" ? running ? "running" : "idle"
    : row.state === "completed" ? "idle" : row.state;
  return { ...row, native: false, main: true, mode: "main", state, closed: false };
}

// Every native sub-agent of the session that launched this run, shown once: each belongs to the
// session's latest run created before it started, and the session's first run also takes those
// started earlier. Native sub-agents of the run's own tasks follow those tasks.
// `runs` is the list of every run when the caller already has it: the dashboard asks for each
// run on the board, and reading every run record each time cost most of a refresh.
export function listNative(run, tasks, runs = null) {
  const rows = [];
  const o = run.orchestrator;
  if (o?.sessionId && (o.agent === "claude" || o.agent === "codex")) {
    const sessionRuns = (runs || listRuns())
      .filter((r) => r.orchestrator?.sessionId === o.sessionId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const i = sessionRuns.findIndex((r) => r.id === run.id);
    const window = [i <= 0 ? 0 : Date.parse(run.createdAt), i >= 0 && i + 1 < sessionRuns.length ? Date.parse(sessionRuns[i + 1].createdAt) : Infinity];
    rows.push(...(o.agent === "codex" ? codexNativeAgents(o.sessionId, "orchestrator", window) : claudeNativeAgents(o.sessionId, "orchestrator", window)));
  }
  for (const t of tasks) {
    if (t.agent === "codex" && t.session && !t.native) rows.push(...codexNativeAgents(t.session, t.id));
    else if (t.agent === "claude" && t.session && !t.native) rows.push(...claudeNativeAgents(t.session, t.id));
  }
  return rows;
}
