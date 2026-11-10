// Agents that a command started outside the orchestrator: headless `claude -p` and `codex exec`
// processes that neither an orch.mjs relay nor orch.mjs itself started, such as the review scripts
// a session runs from its shell. The dashboard finds them in the process table while they run and
// records each in <state root>/external.jsonl, so a finished one stays on the board; one that
// starts and ends while no dashboard runs is never seen.
//
// Each record names who started the agent, from the variables it inherited: AGENT_ORCH_RUN and
// AGENT_ORCH_TASK (a task's shell), CLAUDE_CODE_SESSION_ID (a Claude Code session's shell) and
// CODEX_THREAD_ID (a Codex session's shell). A shell nested in both kinds of session has both
// session variables, so the nearest Claude Code or Codex process above it decides between them, as
// detectOrchestrator() does.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS, CLAUDE_SESSIONS, CODEX_HOME, EXTERNAL_FILE } from "./config.mjs";
import { codexMeta } from "./codex.mjs";
import { newSummary, summarizeEvents, summarizeRollout } from "./events.mjs";
import { shortText, slug } from "./format.mjs";
import { codexNativeAgents, nativeRow } from "./native.mjs";
import { processSnapshot } from "./runs.mjs";
import { readJson } from "./util.mjs";

const words = (command) => String(command || "").trim().split(/\s+/);
const base = (word) => path.basename(word || "");

// "claude" for a headless Claude Code process, "codex" for `codex exec`, otherwise null. A Node
// launcher (`node .../bin/codex exec ...`) counts as the script it runs. For Codex, `exec` must be
// its first word that is neither an option nor an option's value, so a prompt that merely
// contains "exec" does not count.
export function headlessKind(command) {
  let w = words(command);
  if (["node", "bun"].includes(base(w[0]))) w = w.slice(1);
  const name = base(w[0]);
  if (name === "claude") return w.includes("-p") || w.includes("--print") ? "claude" : null;
  if (!/^codex(\.js|-(aarch64|x86_64|arm64)\S*)?$/.test(name)) return null;
  for (let i = 1; i < Math.min(w.length, 60); i++) {
    if (w[i] === "exec") return "codex";
    if (!w[i].startsWith("-") && !(w[i - 1].startsWith("-") && !w[i - 1].includes("="))) return null;
  }
  return null;
}

// The orchestrator's own headless runs: a relay's agent, and the one-turn limits probe.
const OWN = /[/\\]scripts[/\\](relay|orch)\.mjs(\s|$)/;
const isAgent = (command) => words(command).slice(0, 2).map(base).some((n) => /^(claude|codex)(\.js)?$/.test(n));

function nearestAgent(pid, table) {
  for (let p = table.get(pid)?.ppid, hops = 0; p > 1 && hops < 20; hops++) {
    const row = table.get(p);
    if (!row) return null;
    const names = words(row.command).slice(0, 2).map(base);
    if (names.some((n) => n === "codex" || n === "codex.js")) return "codex";
    if (names.includes("claude")) return "claude";
    p = row.ppid;
  }
  return null;
}

// The script that started the agent, such as `bash codex_review.sh ...`: the nearest process above
// it that runs a file, below the session that ran the command. An orchestrator relay is not such a
// script: an agent a command task runs directly has no launcher, so it is not named after the relay.
const SCRIPT = /\.(sh|bash|zsh|py|mjs|cjs|js|ts|rb|pl)$/;
const RELAY = /skills\/(agent-orchestrator|claude-delegate|codex-delegate)\/scripts\/(command-relay|relay)\.mjs$/;
const INTERPRETER = /^((ba|z|da)?sh|python3?(\.\d+)?|node|bun|deno|ruby|perl)$/;
function launcher(pid, table) {
  for (let p = table.get(pid)?.ppid, hops = 0; p > 1 && hops < 6; hops++) {
    const row = table.get(p);
    if (!row || isAgent(row.command)) return null;
    const w = words(row.command);
    const file = SCRIPT.test(w[0]) ? w[0] : INTERPRETER.test(base(w[0])) && w[1] && !w[1].startsWith("-") ? w[1] : null;
    if (file && RELAY.test(file)) return null;
    if (file) return { name: base(file).replace(/\.[a-z]+$/, ""), command: row.command };
    p = row.ppid;
  }
  return null;
}

const ENV_NAMES = ["AGENT_ORCH_RUN", "AGENT_ORCH_TASK", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];
// The variables above from a process's environment: /proc on Linux, `ps -E` on macOS (which
// prints the environment after the arguments, so the last match is the variable).
function processEnv(pid) {
  let text = "";
  try {
    text = fs.readFileSync(`/proc/${pid}/environ`, "utf8").replace(/\0/g, "\n");
  } catch {
    const r = spawnSync("ps", ["-Eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 8 << 20, timeout: 5000 });
    // A timed-out ps may have printed part of the environment; that text is not trusted.
    text = r.error ? "" : r.stdout || "";
  }
  const env = {};
  for (const name of ENV_NAMES) {
    const all = [...text.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S+)`, "g"))];
    if (all.length) env[name] = all[all.length - 1][1];
  }
  return env;
}

// The Codex rollout file that one of `pids` holds open; Codex keeps it open while it runs. A
// rollout outside this CODEX_HOME belongs to another Codex home (a test's, for one), so its agent
// is not this dashboard's: "elsewhere".
const realOrNull = (f) => {
  try {
    return fs.realpathSync(f);
  } catch {
    return null;
  }
};
function openRollout(pids) {
  const r = spawnSync("lsof", ["-nP", "-Fn", "-p", pids.join(",")], { encoding: "utf8", maxBuffer: 8 << 20, timeout: 5000 });
  // A timed-out lsof may have printed part of its list; a rollout path from that part is not trusted.
  const out = r.error ? "" : r.stdout || "";
  const file = out.split("\n").find((l) => l.startsWith("n") && /[/\\]rollout-[^/\\]*\.jsonl$/.test(l))?.slice(1);
  if (!file) return null;
  const root = realOrNull(path.join(CODEX_HOME, "sessions"));
  return root && (realOrNull(file) || "").startsWith(root + path.sep) ? file : "elsewhere";
}

// What one headless process is: a record, null when it is not an outside agent (an interactive
// session after all), or undefined while its session file or rollout does not exist yet.
function describe(pid, kind, row, table) {
  const w = words(row.command);
  let sessionId, file = null, cwd = null, startedMs = Date.now();
  if (kind === "claude") {
    const s = readJson(path.join(CLAUDE_SESSIONS, `${pid}.json`));
    if (!s?.sessionId) return undefined;
    if (s.entrypoint === "cli") return null;
    ({ sessionId, cwd = null } = s);
    startedMs = Number(s.startedAt) || startedMs;
  } else {
    file = openRollout([pid, ...[...table].filter(([, r]) => r.ppid === pid).map(([p]) => p)]);
    if (file === "elsewhere") return null;
    const meta = file && codexMeta(file);
    if (!meta) return undefined;
    // `codex exec resume` keeps the session's first header, which is interactive if it began as one.
    const resumed = w[w.indexOf("exec") + 1] === "resume";
    if (meta.originator !== "codex_exec" && meta.source !== "exec" && !resumed) return null;
    sessionId = meta.id || /-([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1];
    cwd = meta.cwd || null;
    startedMs = Date.parse(meta.timestamp) || startedMs;
  }
  if (!sessionId) return undefined;
  const env = processEnv(pid);
  const via = launcher(pid, table);
  const sub = kind === "codex" ? w[w.indexOf("exec") + 1] : null;
  const fallback = kind === "codex" ? `codex-exec${["review", "resume"].includes(sub) ? `-${sub}` : ""}` : "claude-headless";
  return {
    key: `${kind}:${sessionId}`,
    agent: kind,
    sessionId,
    file,
    cwd,
    pid,
    command: row.command.slice(0, 300),
    startedMs,
    seenMs: Date.now(),
    name: slug(via?.name || fallback).slice(0, 28),
    launcher: via ? shortText(via.command, 160) : null,
    parent: {
      run: env.AGENT_ORCH_RUN || null,
      task: env.AGENT_ORCH_TASK || null,
      claude: env.CLAUDE_CODE_SESSION_ID || null,
      codex: env.CODEX_THREAD_ID || null,
      nearest: nearestAgent(pid, table),
    },
  };
}

function append(record) {
  fs.mkdirSync(path.dirname(EXTERNAL_FILE), { recursive: true });
  fs.appendFileSync(EXTERNAL_FILE, `${JSON.stringify(record)}\n`);
}

// Records by key, the latest line winning; a resumed session (`codex exec resume`) keeps its first
// start. Reread only when the file grows.
let loaded = { size: -1, records: new Map() };
function records() {
  let size = -1;
  try {
    size = fs.statSync(EXTERNAL_FILE).size;
  } catch {}
  if (size === loaded.size) return loaded.records;
  const map = new Map();
  let text = "";
  try {
    text = fs.readFileSync(EXTERNAL_FILE, "utf8");
  } catch {}
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const prev = map.get(r.key);
      map.set(r.key, prev ? { ...r, startedMs: Math.min(prev.startedMs, r.startedMs) } : r);
    } catch {}
  }
  loaded = { size, records: map };
  return map;
}

// Only the dashboard server scans; other commands just read the records.
let watching = false;
const SCAN_MS = 2000;
const GIVE_UP = 30; // scans to wait for a new agent's session file or rollout before ignoring it
const KEEP_MS = 7 * 24 * 3600 * 1000;
let lastScan = 0;
const seen = new Map(); // pid -> { command, done, tries }

export function watchExternalAgents() {
  watching = true;
  // Keep the record file small: drop agents last seen more than a week ago.
  try {
    if (fs.statSync(EXTERNAL_FILE).size < 256 * 1024) return;
    const kept = [...records().values()].filter((r) => Date.now() - r.seenMs < KEEP_MS);
    const tmp = `${EXTERNAL_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((r) => `${JSON.stringify(r)}\n`).join(""));
    fs.renameSync(tmp, EXTERNAL_FILE);
  } catch {}
}

export function scanExternalAgents(now = Date.now()) {
  if (!watching || now - lastScan < SCAN_MS) return;
  lastScan = now;
  const table = processSnapshot();
  if (!table) return;
  for (const [pid, s] of seen) if (table.get(pid)?.command !== s.command) seen.delete(pid);
  for (const [pid, row] of table) {
    const kind = headlessKind(row.command);
    if (!kind || seen.get(pid)?.done) continue;
    const parent = table.get(row.ppid);
    const entry = seen.get(pid) || { command: row.command, tries: 0, done: false };
    seen.set(pid, entry);
    // A wrapper's own child (`node codex` running the native `codex`) is the same agent.
    if (parent && (OWN.test(parent.command) || headlessKind(parent.command) === kind)) {
      entry.done = true;
      continue;
    }
    const record = describe(pid, kind, row, table);
    if (record === undefined) {
      entry.done = ++entry.tries >= GIVE_UP;
      continue;
    }
    entry.done = true;
    if (record) append(record);
  }
}

// A Claude Code session's transcript, <projects>/<project>/<session>.jsonl (cached once found).
const transcripts = new Map();
function claudeTranscript(sessionId, cwd) {
  if (transcripts.has(sessionId)) return transcripts.get(sessionId);
  const guess = cwd ? path.join(CLAUDE_PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`) : null;
  let file = guess && fs.existsSync(guess) ? guess : null;
  if (!file) {
    try {
      file = fs.readdirSync(CLAUDE_PROJECTS).map((p) => path.join(CLAUDE_PROJECTS, p, `${sessionId}.jsonl`)).find((f) => fs.existsSync(f)) || null;
    } catch {}
  }
  if (file) transcripts.set(sessionId, file);
  return file;
}

// Outside agents still running, or active since `sinceMs`, oldest first. `keep(record)` names more
// to list however long ago they ended: the dashboard keeps the agents of a task that is still shown.
export function externalAgents(sinceMs, keep = null) {
  scanExternalAgents();
  const all = [...records().values()];
  if (!all.length) return [];
  const table = processSnapshot();
  // A PID that a later agent reused belongs to that agent only.
  const newest = new Map();
  for (const r of all) if (!(newest.get(r.pid)?.seenMs >= r.seenMs)) newest.set(r.pid, r);
  const out = [];
  for (const r of all) {
    const file = r.file || claudeTranscript(r.sessionId, r.cwd);
    let lastMs = r.seenMs;
    try {
      lastMs = Math.max(lastMs, fs.statSync(file).mtimeMs);
    } catch {}
    const alive = newest.get(r.pid) === r && table?.get(r.pid)?.command?.slice(0, 300) === r.command
      && (r.agent !== "claude" || readJson(path.join(CLAUDE_SESSIONS, `${r.pid}.json`))?.sessionId === r.sessionId);
    if (!alive && lastMs < sinceMs && !keep?.(r)) continue;
    out.push({ ...r, file, alive, lastMs });
  }
  return out.sort((a, b) => a.startedMs - b.startedMs);
}

// The board row of an outside agent, read from its own transcript like a native sub-agent's. One that a
// task's own shell started says so in `why`; `kind` is the command it ran ("claude -p" or "codex exec").
export function externalRow(x, id, parent) {
  const summary = !x.file ? newSummary() : x.agent === "codex" ? summarizeRollout(x.file) : summarizeEvents("claude", x.file, x.cwd);
  const kind = x.agent === "codex" ? "codex exec" : "claude -p";
  const how = x.agent === "codex" ? "codex exec" : "headless claude -p";
  const why = x.parent?.run && x.parent?.task
    ? `started by the shell of task ${x.parent.task}, not by orch.mjs (${how})${x.launcher ? ` through ${x.launcher}` : ""}`
    : `started outside the orchestrator (${how})${x.launcher ? ` by ${x.launcher}` : ""}`;
  const row = nativeRow({ id, agent: x.agent, parent, startedMs: x.startedMs, lastMs: x.lastMs, running: x.alive, summary, sessionId: null, file: x.file, why });
  const cut = !x.alive && summary.busy; // ended in the middle of a turn
  // `codex exec review` does its work in a sub-thread; count it here, since sub-threads get no rows.
  if (x.agent === "codex") {
    for (const k of codexNativeAgents(x.sessionId, id)) {
      row.tokensIn += k.tokensIn;
      row.tokensCached += k.tokensCached;
      row.tokensOut += k.tokensOut;
      row.steps += k.steps;
      row.tokensExact &&= k.tokensExact;
      if (!row.model && k.model) Object.assign(row, { model: k.model, modelLabel: k.modelLabel });
    }
  }
  return {
    ...row,
    external: true,
    mode: "external",
    kind,
    launcher: x.launcher || null,
    session: x.sessionId,
    state: x.alive ? "running" : cut ? "stopped" : row.decisions ? "needs-decision" : "completed",
    now: cut ? `stopped without finishing; last: ${row.now}` : row.now,
    cd: x.cwd,
  };
}

// The board row of an agent that a task's own shell started (a script that runs `claude -p` or `codex
// exec`); the board nests it under that task (dashboard-state.mjs). The summary behind it is the
// incremental one in events.mjs, so a build reads only what the agent appended; the panel reads the
// agent's events itself, from its `outDir` (api/transcript). A finished agent's row cannot change, so
// it is kept until its transcript or state does.
const INNER_KEEP = 200;
const innerMemo = new Map(); // record key -> { sig, value }
export function innerAgent(x) {
  const sig = [x.alive, x.lastMs, x.file, x.startedMs].join("|");
  const memo = !x.alive && innerMemo.get(x.key);
  if (memo?.sig === sig) return memo.value;
  const value = externalRow(x, x.name, null);
  if (!x.alive) {
    innerMemo.delete(x.key);
    innerMemo.set(x.key, { sig, value });
    if (innerMemo.size > INNER_KEEP) innerMemo.delete(innerMemo.keys().next().value);
  }
  return value;
}
