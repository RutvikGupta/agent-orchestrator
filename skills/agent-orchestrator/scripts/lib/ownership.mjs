// Ownership: who launched a run, who is calling, and whether the caller may change the run.
//
// A run belongs to the session that launched it (run.orchestrator, which `new` records): a Claude
// Code or Codex session, named by its session id; the user, for a run launched from a terminal; or,
// for a nested run, the orch task whose agent ran `new` (its AGENT_ORCH_RUN and AGENT_ORCH_TASK),
// whatever the root. A caller owns a run when it is that launcher, or owns the parent task's run, up
// the chain: a main session manages all its descendants, a delegated agent its own runs and theirs,
// never a sibling's or its parent's. The user, at a terminal (no session variables, and not inside an
// orch task) or through the dashboard, may act on any run. Agent sessions may not act on the user's
// runs; a caller whose identity cannot be read may act on an agent's run, and its owner is told.
//
// Every command is guarded unless it is open (OPEN_COMMANDS): a refusal exits 4 and changes nothing.
// A run is orphaned when every owner up its chain has gone (its process ended, or its PID now runs
// something else) and none has used the run for AGENT_ORCH_ADOPT_AFTER (30m): `--adopt` then makes
// the caller its owner. Each command of an owner records when it last used the run (touchOwner).
// When anyone other than the owner changes a run, the change goes to the run's owner-notices.jsonl:
// each owner's next `status` and `wait` show it, `wait` wakes for it (exit 5) once per owner, and an
// owning orch task also gets an inbox message.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLAUDE_PROJECTS, CLI_PATH, CODEX_HOME, RUNS_DIR } from "./config.mjs";
import { agentOfCommand, detectOrchestrator, exists, isParked, listRuns, loadTask, processInfo, processStarted, relayAlive, relayOf } from "./runs.mjs";
import { die, parseDuration, readJson, writeJson } from "./util.mjs";
import { SendError, deliverMessage } from "./commands/inbox.mjs";

export const REFUSED = 4; // the exit code of a refusal
export const USER_TERMINAL = "user (terminal)";
export const USER_DASHBOARD = "user (dashboard)";
// The dashboard server acts for the user's clicks.
export const DASHBOARD_CALLER = Object.freeze({ kind: "user", via: "dashboard", record: null });

// The orch.mjs commands anyone may run, whoever owns the run: they read, or act only on the
// caller's own things (its new run, its own task's question or note to its parent) or on no run. `result` closes a task
// and `status` and `wait` revive parked watchers and retry tasks only for the owner.
export const OPEN_COMMANDS = new Set([
  "status", "wait", "result", "log", "recover", "agents", "stats", "lesson", "runs", "watch", "nap",
  "new", "ask", "tell", "heavy", "reclaim", "dashboard", "pr-watch", "skill", "model", "questions",
]);
// The guarded commands. `self`: the command checks ownership itself, so its refusal names what it
// would change; orch.mjs checks the others on their RUN argument before they run (gateCommand).
// `open`: the options that make the command read only. `ownTask`: a task's own agent may run it on
// its own task. A command on neither list is guarded too.
export const GUARDED_COMMANDS = {
  start: { self: true }, stop: { self: true }, close: { self: true }, cleanup: { self: true },
  accept: { self: true }, verdict: { self: true }, resolve: { self: true }, steer: { self: true },
  dispatch: { self: true, open: (a) => a["dry-run"] },
  gc: { self: true, open: (a) => a["dry-run"] },
  integrate: { self: true, open: (a) => a["dry-run"] },
  send: { self: true, open: (a) => !a.steer },
  plan: { self: true, open: (a) => a.check },
  worktree: { self: true }, brief: { self: true }, verify: { self: true },
  review: { self: true }, rework: { self: true },
  // `rename` lets a task's own agent rename itself; it checks that itself (commands/rename.mjs).
  rename: { self: true },
  inbox: { open: (a) => !a.ack, ownTask: true },
  reply: { ownTask: true },
};

const NOTICES_FILE = "owner-notices.jsonl";
const SEEN_FILE = "owner-notices-seen.jsonl";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOUCH_MS = 60_000; // an owner's use of a run is recorded at most this often
const adoptAfter = () => parseDuration(process.env.AGENT_ORCH_ADOPT_AFTER ?? "30m");

// Who runs this command: { kind, record }. `record` is what `new` would record as the launcher
// (detectOrchestrator). The kind is `task` inside an orch task, `user` with no session variables
// (the user at a terminal), `session` for a Claude or Codex session with its id, and `unknown` when
// the host's own session variable is missing or the orch task named does not exist.
let callerCache = null;
export function callerIdentity() {
  if (callerCache) return callerCache;
  const env = process.env;
  const record = detectOrchestrator();
  let kind;
  if (record.agent === "delegated-agent") {
    const { parentRun: run, parentTask: task } = record;
    kind = run && task && NAME.test(run) && NAME.test(task) && fs.existsSync(path.join(RUNS_DIR, run, "tasks", task, "task.json")) ? "task" : "unknown";
  } else if (!env.CLAUDE_CODE_SESSION_ID && !env.CODEX_THREAD_ID && !env.CODEX_SESSION_ID) kind = "user";
  else kind = record.sessionId ? "session" : "unknown";
  callerCache = { kind, via: kind === "user" ? "terminal" : null, record };
  return callerCache;
}

// What a change records as its actor (closedBy, stoppedBy, ...): "user (terminal)" or "user
// (dashboard)", or the caller's identity.
export function actorOf(caller) {
  if (caller.kind === "user") return caller.via === "dashboard" ? USER_DASHBOARD : USER_TERMINAL;
  const r = caller.record || {};
  if (r.agent === "delegated-agent") return { agent: r.agent, run: r.parentRun, task: r.parentTask };
  return { agent: r.agent, sessionId: r.sessionId || null, pid: r.pid || null, ...(caller.kind === "unknown" ? { unidentified: true } : {}) };
}

// The actor that automatic worktree collection records (`gc --auto`, and worktree creation on a
// full disk): nobody asked for that change, so a notice names it rather than the caller.
export const AUTO_COLLECTOR = Object.freeze({ agent: "orch", auto: "automatic worktree collection" });

export function actorLabel(actor) {
  if (typeof actor === "string") return actor;
  if (actor?.auto) return actor.auto;
  if (actor?.agent === "delegated-agent") return `task ${actor.task} of run ${actor.run}`;
  return launcherLabel(actor);
}

export function launcherLabel(o) {
  if (!o?.agent) return "the user (no launcher recorded)";
  if (o.agent === "delegated-agent") return `task ${o.parentTask ?? o.task} of run ${o.parentRun ?? o.run}`;
  if (o.agent === "terminal") return "the user at a terminal";
  return `${o.agent} session ${o.sessionId || "(no session id)"}${o.pid ? ` (pid ${o.pid})` : ""}`;
}

// Whether `me` (a caller's record) is the launcher `o`: the same orch task, or the same session (by
// session id, or by PID when neither has one, as for a host that sets no session variable). Session
// ids are the hosts' own unique ids, so they match whichever host was recorded: detection takes the
// id of the nearest host only, never one inherited from a host above it.
export function sameLauncher(o, me) {
  if (!o?.agent || !me?.agent) return false;
  if (o.agent === "delegated-agent" || me.agent === "delegated-agent") {
    return o.agent === me.agent && Boolean(o.parentRun && o.parentTask) && o.parentRun === me.parentRun && o.parentTask === me.parentTask;
  }
  if (o.sessionId || me.sessionId) return o.sessionId === me.sessionId;
  if (o.agent !== me.agent) return false;
  if (o.agent === "terminal") return true;
  return Boolean(o.pid) && o.pid === me.pid;
}

// The key under which a reader's acknowledged notices are kept: the same for every process of one
// session or orch task.
function readerKey(r) {
  if (!r?.agent) return null;
  if (r.agent === "delegated-agent") return `task:${r.parentRun}/${r.parentTask}`;
  if (r.sessionId) return `${r.agent}:${r.sessionId}`;
  return r.pid ? `${r.agent}:pid:${r.pid}` : r.agent;
}

function runById(id) {
  if (!id || !NAME.test(id)) return null;
  const dir = path.join(RUNS_DIR, id);
  const run = readJson(path.join(dir, "run.json"));
  return run ? { ...run, dir } : null;
}

const AGENT_HOSTS = new Set(["claude", "codex"]);

// Whether a session launcher's process is gone: { gone, why }. A launcher with no PID recorded, or
// one that `ps` cannot read, is not known to be gone. A launcher recorded before start times were
// recorded is checked by PID and command alone. A live host process counts as its session even when
// the caller runs in it under another session id (a Claude Code sub-agent).
function sessionGone(o) {
  if (!o?.pid) return { gone: false };
  const info = processInfo(o.pid);
  if (info === null) return { gone: true, why: `its process (pid ${o.pid}) is gone` };
  if (info === undefined) return { gone: false };
  if (!agentOfCommand(info.command)) return { gone: true, why: `pid ${o.pid} now runs another program` };
  if (o.started && info.started !== o.started) return { gone: true, why: `pid ${o.pid} now belongs to a process started at another time` };
  return { gone: false };
}

// Whether the launcher of link `i` is gone: a session's host process, or an orch task's relay.
function launcherGone(links, i, broken) {
  const o = links[i].launcher;
  if (o?.agent !== "delegated-agent") return sessionGone(o);
  const parent = links[i + 1]?.run || null;
  const task = parent ? loadTask(parent, o.parentTask) : null;
  if (!parent) return { gone: true, why: `its parent run ${broken} is gone` };
  return !task || (!relayAlive(task.pid, task.startedAt, task.outDir) && !isParked(parent, task)) ? { gone: true, why: `task ${o.parentTask} of run ${o.parentRun} is not running` } : { gone: false };
}

// Liveness for `gc`, which removes worktrees on its strength, so it must be certain: "alive",
// "ended" or "unknown", with why. Unknown (a process that `ps` cannot read, a host registry that
// cannot be read in full) keeps the run, as alive does. Adoption keeps its own, looser test
// (launcherGone).
const ALIVE = { state: "alive", why: null };
const unknown = (why) => ({ state: "unknown", why });

// What a collection pass reads of the machine, read once and shared by every run it judges: the
// process table, each host root's session registry, and the rollout files Codex processes hold
// open. A pass over many runs therefore costs one `ps` and one `lsof`. resetHostView() starts a
// new pass.
let hostView = null;
const view = () => (hostView ??= { table: undefined, claude: new Map(), codex: new Map(), open: undefined });
export function resetHostView() {
  hostView = null;
}

// Every process: a Map from PID to { ppid, state, started, command }, or null when `ps` fails. The
// start time is written as processStarted() writes it; `state` is ps's (Z for a process that has
// exited and only awaits its parent).
function processTable() {
  const v = view();
  if (v.table !== undefined) return v.table;
  const r = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,state=,lstart=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 10000 });
  if (r.error || r.status !== 0) return (v.table = null);
  const rows = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), state: m[3], started: m[4].replace(/\s+/g, " "), command: m[5].trim() });
  }
  return (v.table = rows);
}

// One process: its row; null when it certainly does not exist; undefined when it exists but the
// table cannot say what it is (`ps` failed, or the process is not in the listing).
function processRow(pid) {
  if (!pid || !exists(pid)) return null;
  return processTable()?.get(pid) ?? undefined;
}

// The folder a host keeps its sessions under: Claude Code's configuration folder, or CODEX_HOME.
// `new` and --adopt record it with the launcher (hostRoot), so that a collector started with another
// configuration still looks where that session's host writes.
export function hostRootOf(agent) {
  return agent === "claude" ? path.dirname(CLAUDE_PROJECTS) : agent === "codex" ? CODEX_HOME : null;
}

// A launcher record with its host's root, for a Claude or Codex session: what `new`, --adopt and a
// resumed owner's first command record.
export function withHostRoot(record) {
  const hostRoot = hostRootOf(record?.agent);
  return hostRoot ? { ...record, hostRoot } : record;
}

// Folder names, or the error's code. `recorded`: the root is the one the launcher recorded, so a
// folder missing there is no evidence (unknown); in the collector's own root it means the host runs
// no session.
function namesOf(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    return error.code || "EIO";
  }
}
const missingState = (names, recorded) => (names === "ENOENT" && !recorded ? "ended" : "unknown");

// Whether Claude Code reports session `id` live under `root`: it writes sessions/<pid>.json, naming
// its session, for each running session. A file that cannot be read or parsed counts as unknown only
// while the PID in its name is alive: a dead PID's file names no live session.
function claudeSessionLive(id, root, recorded) {
  const v = view();
  if (!v.claude.has(root)) {
    const dir = path.join(root, "sessions");
    const names = namesOf(dir);
    const registry = { error: null, sessions: new Map(), unreadable: false };
    if (!Array.isArray(names)) registry.error = names;
    else {
      for (const name of names) {
        const pid = /^(\d+)\.json$/.test(name) ? Number.parseInt(name, 10) : null;
        if (!pid) continue;
        let record = null;
        try {
          record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        } catch {}
        if (typeof record?.sessionId === "string") registry.sessions.set(record.sessionId, [...(registry.sessions.get(record.sessionId) || []), pid]);
        else if (processRow(pid) !== null) registry.unreadable = true;
      }
    }
    v.claude.set(root, registry);
  }
  const registry = v.claude.get(root);
  if (registry.error) return missingState(registry.error, recorded);
  let state = registry.unreadable ? "unknown" : "ended";
  for (const pid of registry.sessions.get(id) || []) {
    const row = processRow(pid);
    if (row === undefined) state = "unknown";
    else if (row && agentOfCommand(row.command) === "claude") return "alive";
  }
  return state;
}

// `lsof` for some processes, into `listing` ({ calls, asked, output }): true when every one of them
// that still lives is covered by a listing that ended without error. `lsof` also ends with an error
// when a process it was asked about has just gone, as a Codex session's short-lived children do, and
// its output then proves nothing: the processes are asked about again in two halves, down to a
// single one, which is settled by whether it still exists (one that is gone holds no file). The
// number of calls is bounded; past it, nothing is proved.
const LSOF_CALLS = 8;
function listOpenFiles(pids, listing) {
  const asked = pids.filter(exists);
  if (!asked.length) return true;
  if (listing.calls >= LSOF_CALLS) return false;
  listing.calls += 1;
  const r = spawnSync("lsof", ["-nP", "-Fn", "-p", asked.join(",")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
  if (r.error || r.signal) return false;
  if (r.status === 0) {
    listing.asked.push(...asked);
    listing.output.push(r.stdout || "");
    return true;
  }
  if (asked.length === 1) return !exists(asked[0]);
  const half = asked.length >> 1;
  return listOpenFiles(asked.slice(0, half), listing) && listOpenFiles(asked.slice(half), listing);
}

// The rollout files that live Codex processes (and their children) hold open, as real paths, read
// once for the whole pass. Null unless the listing is known to be complete: when the process table
// or `lsof` cannot be read, when `lsof` is cut short or keeps ending with an error, when it says
// nothing of a Codex process that still lives, or when a rollout it names cannot be resolved.
function openRollouts() {
  const v = view();
  if (v.open !== undefined) return v.open;
  const table = processTable();
  if (!table) return (v.open = null);
  // A process that has exited and awaits its parent (state Z) holds no file, and lsof lists none.
  const running = [...table].filter(([, row]) => !row.state.startsWith("Z"));
  const hosts = running.filter(([, row]) => agentOfCommand(row.command) === "codex").map(([pid]) => pid);
  const pids = [...new Set([...hosts, ...running.filter(([, row]) => hosts.includes(row.ppid)).map(([pid]) => pid)])];
  const listing = { calls: 0, asked: [], output: [] };
  if (!listOpenFiles(pids, listing)) return (v.open = null);
  const open = new Set(), listed = new Set();
  for (const line of listing.output.join("\n").split("\n")) {
    if (line.startsWith("p")) listed.add(Number(line.slice(1)));
    else if (line.startsWith("n") && /[/\\]rollout-[^/\\]*\.jsonl$/.test(line)) {
      try {
        open.add(fs.realpathSync(line.slice(1)));
      } catch {
        return (v.open = null);
      }
    }
  }
  if (listing.asked.some((pid) => hosts.includes(pid) && !listed.has(pid))) return (v.open = null);
  return (v.open = open);
}

// Whether a Codex process holds session `id`'s rollout file open under `root`, as a running Codex
// session does. A date folder that cannot be listed may hold the session's rollout, so the answer
// is then unknown unless the session is found alive.
function codexSessionLive(id, root, recorded) {
  const v = view();
  if (!v.codex.has(root)) {
    const listing = { error: null, files: [], partial: false };
    const walk = (dir, depth) => {
      const names = namesOf(dir);
      if (!Array.isArray(names)) {
        if (depth === 0) listing.error = names;
        else listing.partial = true;
        return;
      }
      for (const name of names) {
        if (depth < 3) {
          if (/^\d+$/.test(name)) walk(path.join(dir, name), depth + 1);
        } else if (name.endsWith(".jsonl")) listing.files.push(path.join(dir, name));
      }
    };
    walk(path.join(root, "sessions"), 0);
    v.codex.set(root, listing);
  }
  const listing = v.codex.get(root);
  if (listing.error) return missingState(listing.error, recorded);
  const files = listing.files.filter((f) => f.endsWith(`-${id}.jsonl`));
  const absent = listing.partial ? "unknown" : "ended";
  if (!files.length) return absent;
  const open = openRollouts();
  if (!open) return "unknown";
  // A rollout whose path cannot be resolved cannot be matched with the open files: unknown.
  let state = absent;
  for (const f of files) {
    try {
      if (open.has(fs.realpathSync(f))) return "alive";
    } catch {
      state = "unknown";
    }
  }
  return state;
}

// A session launcher: alive while its recorded process runs, or while the host reports its session
// live in another process; ended only when neither is so; unknown when either cannot be read, or
// when no process was recorded for it. The host's report is read under the root the launcher
// recorded (hostRoot), or, for a run recorded before roots were, under the collector's own.
function sessionLiveness(o) {
  if (!o?.pid) return unknown("no process was recorded for its session");
  const row = processRow(o.pid);
  if (row === undefined) return unknown(`its process (pid ${o.pid}) could not be read`);
  const why = row === null ? `its process (pid ${o.pid}) is gone`
    : !agentOfCommand(row.command) ? `pid ${o.pid} now runs another program`
      : o.started && row.started !== o.started ? `pid ${o.pid} now belongs to a process started at another time` : null;
  if (!why) return ALIVE;
  if (!o.sessionId) return { state: "ended", why };
  const recorded = typeof o.hostRoot === "string" && o.hostRoot ? o.hostRoot : null;
  const root = recorded || hostRootOf(o.agent);
  const live = !root ? "unknown" : o.agent === "claude" ? claudeSessionLive(o.sessionId, root, Boolean(recorded)) : codexSessionLive(o.sessionId, root, Boolean(recorded));
  if (live === "alive") return { state: "alive", why: `session ${o.sessionId} runs in another process` };
  if (live === "unknown") return unknown(`${why}, and whether session ${o.sessionId} runs in another process could not be read`);
  return { state: "ended", why };
}

// An orch task launcher: alive while its relay runs or it is parked; ended once its relay's process
// is gone or runs something else. Unknown when its relay cannot be read, or when its run or task
// record is gone, so nothing tells whose it was.
function taskLiveness(parent, o, broken) {
  if (!parent) return unknown(`its parent run ${broken} is gone, so its launchers cannot be checked`);
  const task = loadTask(parent, o.parentTask);
  if (!task) return unknown(`task ${o.parentTask} of run ${o.parentRun} has no record`);
  const stopped = { state: "ended", why: `task ${o.parentTask} of run ${o.parentRun} is not running` };
  if (isParked(parent, task)) return ALIVE;
  if (!task.pid) return stopped;
  const row = processRow(task.pid);
  if (row === undefined) return unknown(`the relay of task ${o.parentTask} of run ${o.parentRun} (pid ${task.pid}) could not be read`);
  if (row === null) return stopped;
  if (row.command.includes("relay.mjs")) return !task.outDir || relayOf(row.command, task.outDir) ? ALIVE : stopped;
  // Right after `start` forks it, a relay still shows its parent's command for a moment.
  const age = task.startedAt ? Date.now() - Date.parse(task.startedAt) : Infinity;
  return age >= 0 && age < 10000 ? ALIVE : stopped;
}

// Whether every launcher up the run's chain has certainly ended: { ended, state, why }. `gc`
// collects such a run's worktrees for anyone, under its own safety rules, since no session is left
// to do it. A run launched from a terminal never has ended. `state` is the chain's: ended, or
// alive or unknown with the first link that is so.
const endedCache = new WeakMap();
export function sessionsEnded(own) {
  if (endedCache.has(own)) return endedCache.get(own);
  let state = { ended: false, state: "alive", why: null };
  if (!own.mine && !own.userOwned) {
    const states = own.links.map((link, i) => link.launcher?.agent === "delegated-agent"
      ? taskLiveness(own.links[i + 1]?.run || null, link.launcher, own.broken)
      : sessionLiveness(link.launcher));
    const live = states.find((s) => s.state !== "ended");
    state = live ? { ended: false, ...live } : { ended: true, state: "ended", why: states.at(-1).why };
  }
  endedCache.set(own, state);
  return state;
}

// How long since any launcher up the run's chain last used it (or the run was created, when no use
// is recorded), in milliseconds: the least of them.
export function sinceLastUse(own, now = Date.now()) {
  return Math.min(...own.links.map((l) => now - (Date.parse(l.launcher?.lastSeenAt || l.run.createdAt) || 0)));
}

// Whether every owner up the chain has gone: each link's launcher (a session's host process, an
// orch task's relay) is gone, and has not used the run for AGENT_ORCH_ADOPT_AFTER. `recent` is set
// when the run's own launcher is gone but used it lately, as a session resumed elsewhere does.
function orphanState(links, broken) {
  const after = adoptAfter();
  const states = links.map((link, i) => {
    const o = link.launcher;
    const gone = launcherGone(links, i, broken);
    const seen = Date.parse(o?.lastSeenAt || link.run.createdAt) || 0;
    return { ...gone, seenAt: seen ? new Date(seen).toISOString() : null, stale: Date.now() - seen > after };
  });
  const orphaned = states.every((s) => s.gone && s.stale);
  const top = states.at(-1);
  const recent = !orphaned && top.gone && !top.stale ? top : null;
  return { orphaned, why: orphaned ? `${top.why}, and no owner has used the run since ${top.seenAt}` : null, recent };
}

// Who owns `run`, as seen by `caller`: `links` are the run and its parent runs up the chain, each
// with its launcher; `matched` the link whose launcher the caller is (so `mine`); `userOwned` when
// the chain's top run was launched from a terminal (or records no launcher). `orphaned`, `why` and
// `recent` (orphanState) are worked out when first read, since they cost a `ps`.
export function ownershipOf(run, caller = callerIdentity()) {
  const links = [];
  const seen = new Set();
  let r = run;
  let broken = null;
  while (r && links.length < 20 && !seen.has(r.id)) {
    seen.add(r.id);
    const o = r.orchestrator || null;
    links.push({ run: r, launcher: o });
    if (o?.agent !== "delegated-agent") break;
    const parent = runById(o.parentRun);
    if (!parent) {
      broken = o.parentRun || "(none recorded)";
      break;
    }
    r = parent;
  }
  const me = caller.record;
  // The user, at a terminal or through the dashboard, owns the runs it launched from a terminal.
  const userRun = (o) => caller.kind === "user" && (o?.agent === "terminal" || !o?.agent) && links.at(-1).launcher === o;
  const matched = links.find((l) => (me && sameLauncher(l.launcher, me)) || userRun(l.launcher)) || null;
  const top = links.at(-1).launcher;
  const userOwned = !broken && top?.agent !== "delegated-agent" && !AGENT_HOSTS.has(top?.agent);
  const own = { run: run.id, caller, links, matched, mine: Boolean(matched), direct: links[0].launcher, top, userOwned, broken };
  let state = null;
  const lazy = () => (state ??= own.mine || userOwned ? { orphaned: false, why: null, recent: null } : orphanState(links, broken));
  for (const key of ["orphaned", "why", "recent"]) Object.defineProperty(own, key, { get: () => lazy()[key], enumerable: true });
  return own;
}

// Whether the caller may change the run: its owner, the user (at a terminal or through the
// dashboard), or, on an agent's run, a caller whose identity cannot be read.
export const mayAct = (own) => own.mine || own.caller.kind === "user" || (!own.userOwned && own.caller.kind === "unknown");

// Record that the run's owner used it: every command of the owner does it. A session resumed in a
// new host process (another PID, or the same PID started at another time) is recorded at once, so
// its run never looks orphaned while it lives; otherwise only lastSeenAt changes, at most once a
// minute. The host's start time is compared when the caller's detection read it (no extra `ps`).
export function touchOwner(run, caller = callerIdentity()) {
  const link = ownershipOf(run, caller).matched;
  if (!link) return;
  const file = path.join(link.run.dir, "run.json");
  const current = readJson(file);
  const o = current?.orchestrator;
  const me = caller.record;
  if (!o || !sameLauncher(o, me)) return;
  const moved = AGENT_HOSTS.has(o.agent) && Boolean(me.pid) && (me.pid !== o.pid || Boolean(me.started && o.started && me.started !== o.started));
  if (!moved && Date.now() - (Date.parse(o.lastSeenAt) || 0) < TOUCH_MS) return;
  const orchestrator = { ...o, ...(moved ? withHostRoot({ agent: o.agent, pid: me.pid, started: me.started || processStarted(me.pid) }) : {}), lastSeenAt: new Date().toISOString() };
  try {
    writeJson(file, { ...current, orchestrator });
    link.run.orchestrator = orchestrator;
  } catch {}
}

// The run a command's first argument names, resolved as loadRun() resolves it, or null when it
// names none; never exits.
export function runNamed(ref) {
  if (!ref || typeof ref !== "string") return null;
  if (ref === "latest") return listRuns()[0] || null;
  if (fs.existsSync(path.join(ref, "run.json"))) {
    const dir = path.resolve(ref);
    const run = readJson(path.join(dir, "run.json"));
    return run ? { ...run, dir } : null;
  }
  return runById(ref);
}

// How to ask the owner to do something.
function askHow(o) {
  if (o?.agent === "delegated-agent") return `message its agent with: node ${CLI_PATH} send ${o.parentRun} ${o.parentTask} "<what you need>"`;
  if (o?.agent === "claude") return `in Claude Code, find that session with ListAgents and send it the request with SendMessage`;
  if (o?.agent === "codex") return "Codex sessions take no messages from other sessions, so ask the user to pass the request on";
  return "ask the user";
}

// Whose run it is, in words: its launcher, and for a nested run the session at the top of its chain.
export function ownerText(own) {
  const d = own.direct;
  if (d?.agent !== "delegated-agent") return launcherLabel(d);
  return `${launcherLabel(d)} (an orch task)${own.links.length > 1 ? `, under ${launcherLabel(own.top)}` : ""}`;
}

// What to do instead: ask the owner, or, for an orphaned run, take it over.
function insteadText(own, what) {
  if (own.orphaned) return `Its owners have gone (${own.why}), so the run is orphaned: pass --adopt to take it over (you become its owner, and the old owner is told).`;
  if (own.userOwned && own.direct?.agent !== "delegated-agent") return `It is the user's run: ask the user to ${what}.`;
  const recent = own.recent ? ` Its owner looks gone (${own.recent.why}), but it used the run at ${own.recent.seenAt}, so it may have resumed in a new process; --adopt works once the run has been unused for ${process.env.AGENT_ORCH_ADOPT_AFTER || "30m"} (AGENT_ORCH_ADOPT_AFTER).` : "";
  return `Ask that session to do it: ${askHow(own.direct)}.${recent}`;
}

// The refusal: whose run it is, what to do instead, and what was refused.
function refusalText(run, own, what, refused) {
  return [
    `refusing to ${what}: run ${run.id} belongs to ${ownerText(own)}, not to you.`,
    insteadText(own, what),
    `Nothing was changed.${refused.length ? ` Refused: ${refused.join(", ")}.` : ""}`,
  ].join("\n  ");
}

// Check that the caller may change `run` before anything changes; `what` names the action ("close
// tasks of run R"), and `refused` (a list, or a function that builds it) names what a refusal
// leaves alone. Returns { actor, owned, own, adopted }: the actor to record, and whether the caller
// owns the run (a change by anyone else leaves the owner a notice: recordChange). A refusal exits 4.
// `ended`: also allow a run whose launching sessions have all ended (sessionsEnded), as `gc` does.
// The command's own caller is checked once per run: a later call returns the same answer.
const decisions = new Map();
export function guard(run, what, { adopt = false, refused = [], caller = null, ended = false } = {}) {
  const ours = !caller;
  if (ours && decisions.has(run.dir)) return decisions.get(run.dir);
  caller ??= callerIdentity();
  const own = ownershipOf(run, caller);
  const actor = actorOf(caller);
  let g;
  if (own.mine) g = { actor, owned: true, own, adopted: false };
  else if (adopt) g = adoptRun(run, own, actor, what);
  else if (mayAct(own) || (ended && sessionsEnded(own).ended)) g = { actor, owned: false, own, adopted: false };
  else die(refusalText(run, own, what, typeof refused === "function" ? refused() : refused), REFUSED);
  if (ours) decisions.set(run.dir, g);
  return g;
}

// orch.mjs runs this before every command: it checks a guarded command that does not check
// ownership itself on its RUN argument, and records an owner's use of the run its first argument
// names when the command exits (after `status` has read the process table, which then serves to
// find the caller). Returns guard()'s answer, or null.
export function gateCommand(command, args) {
  let g = null;
  if (!OPEN_COMMANDS.has(command)) {
    const rule = GUARDED_COMMANDS[command] || {};
    if (!rule.open?.(args) && (!rule.self || rule.ownTask)) {
      const run = runNamed(args._[0]);
      // A command on neither list that names no run has nothing to check ownership against.
      if (!run && !(command in GUARDED_COMMANDS)) die(`\`${command}\` is on neither list of lib/ownership.mjs (OPEN_COMMANDS, GUARDED_COMMANDS), so it runs only on a RUN its caller owns`, REFUSED);
      // An unknown run is the command's own error to report.
      const ownTask = rule.ownTask && run && callerIdentity().kind === "task" && callerIdentity().record.parentRun === run.id && callerIdentity().record.parentTask === args._[1];
      if (run && !ownTask) g = guard(run, `run \`${command}\` on run ${run.id}${rule.ownTask && args._[1] ? ` for task ${args._[1]}` : ""}`, { adopt: args.adopt });
    }
  }
  const run = !["nap", "ask", "tell", "heavy", "pr-watch", "reclaim", "dashboard", "agents", "new", "runs"].includes(command) ? runNamed(args._[0]) : null;
  if (run) {
    process.once("exit", () => {
      try {
        touchOwner(run);
      } catch {}
    });
  }
  return g;
}

// --adopt: refused on the user's runs and while an owner remains; otherwise the caller becomes the
// run's launcher, the old one is kept under previousOrchestrators, and the old owners get a notice.
function adoptRun(run, own, actor, what) {
  const caller = own.caller;
  if (!["session", "task"].includes(caller.kind)) {
    die(`--adopt makes the calling Claude or Codex session, or orch task, the run's owner, and this caller has no such identity (${actorLabel(actor)}); act without --adopt`, 2);
  }
  if (!own.orphaned) {
    const why = own.userOwned
      ? `run ${run.id} belongs to ${ownerText(own)}, and --adopt takes over only a run whose owners have gone`
      : `its owner, ${ownerText(own)}, ${own.recent ? "used it lately" : "has not gone"}`;
    die(`refusing --adopt for run ${run.id}: ${why}.\n  ${insteadText(own, what)}\n  Nothing was changed.`, REFUSED);
  }
  const file = path.join(run.dir, "run.json");
  const current = readJson(file) || {};
  const now = new Date().toISOString();
  const record = withHostRoot({ ...(caller.kind === "task" ? caller.record : detectOrchestrator({ started: true })), lastSeenAt: now });
  const previousOrchestrators = [...(current.previousOrchestrators || []), { ...(current.orchestrator || {}), replacedAt: now, replacedBy: actor }];
  writeJson(file, { ...current, orchestrator: record, previousOrchestrators });
  Object.assign(run, { orchestrator: record, previousOrchestrators });
  process.stderr.write(`orch: adopted run ${run.id}: ${actorLabel(actor)} now owns it (it belonged to ${ownerText(own)}; ${own.why})\n`);
  const g = { actor, owned: false, own, adopted: true };
  recordChange(run, g, { action: "adopted" });
  return g;
}

// What the owner is told about each kind of change: `leave`, what the user left it as; `undo`, a
// change the owner may need to undo; `user`, the whole advice when the user made the change.
const ACTIONS = {
  closed: { leave: "closed", undo: true }, stopped: { leave: "stopped", undo: true }, rejected: { leave: "closed", undo: true },
  "worktree removed": { undo: true }, resumed: { leave: "running" }, accepted: { leave: "accepted" }, integrated: { leave: "integrated" },
  "marked resolved": { leave: "resolved" },
  renamed: { user: "it now shows under its new name, and every command takes that name or its id; nothing to undo" },
  steered: { user: "its command was stopped so the user's message reached it at once; nothing to undo" },
  interrupted: { user: "its session was stopped and resumed with the user's message, so the message reached it at once; nothing to undo" },
  "gate rerun": { user: "a gate was rerun in its working directory and recorded; nothing to undo" },
};
export function noticeText(n) {
  if (n.action === "adopted") return `run ${n.run} was adopted by ${n.byLabel} at ${n.time}, since its owners looked gone: it is no longer yours; ask that session if you still need it`;
  const a = ACTIONS[n.action] || {};
  if (n.user) return `${n.action} by the user: ${a.user || `leave it ${a.leave || "as the user left it"}`}`;
  return `${n.action} by ${n.byLabel} at ${n.time}, not by you: check it${a.undo ? " and resume it if it was still needed" : ""}`;
}

// After a guarded change: when the actor is not the owner, record a notice for the run's owners,
// and message an owning orch task. `g` is guard()'s answer.
export function recordChange(run, g, { task = null, attempt = null, action }) {
  if (!g || g.owned) return null;
  let owners = g.own.links.map((l) => l.launcher).filter((o) => o?.agent);
  // A run that records no launcher is the user's (ownershipOf): the change is recorded in the run for
  // the user at a terminal, whose `status` shows it. No other session is told.
  if (!owners.length && g.own.userOwned) owners = [{ agent: "terminal", sessionId: null }];
  if (!owners.length) return null;
  const notice = {
    id: randomUUID().slice(0, 8), time: new Date().toISOString(), run: run.id, task, attempt, action,
    by: g.actor, byLabel: actorLabel(g.actor), user: typeof g.actor === "string", owners,
  };
  try {
    fs.appendFileSync(path.join(run.dir, NOTICES_FILE), `${JSON.stringify(notice)}\n`);
  } catch (error) {
    process.stderr.write(`orch: could not record the change for the run's owner: ${error.message}\n`);
  }
  const d = g.own.direct;
  if (d?.agent === "delegated-agent") {
    const parent = runById(d.parentRun);
    const text = `${task ? `Task ${task} of your run ${run.id}` : `Your run ${run.id}`}: ${noticeText(notice)}.`;
    // The change is made already: a notice that cannot be delivered never fails it. A task that is
    // not running (SendError) sees it in its next status or wait.
    try {
      if (parent) deliverMessage(parent, d.parentTask, text, { kind: "owner-notice", about: { run: run.id, task, attempt } });
    } catch (error) {
      if (!(error instanceof SendError)) process.stderr.write(`orch: could not message task ${d.parentTask} of run ${d.parentRun} about the change: ${error.message}\n`);
    }
  }
  return notice;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export const noticesFile = (run) => path.join(run.dir, NOTICES_FILE);

// The notices for this caller that it has not been shown in its own `wait`: changes made by someone
// else to a run it owned at the time. Each owner up the chain acknowledges them for itself.
export function unseenNotices(run, caller = null) {
  if (!fs.existsSync(noticesFile(run))) return [];
  caller ??= callerIdentity();
  const reader = readerKey(caller.record);
  if (!reader) return [];
  const seen = new Set(readLines(path.join(run.dir, SEEN_FILE)).filter((s) => s.reader === reader).map((s) => s.id));
  // A notice for the user at a terminal reaches any caller that is the user, whatever host process
  // its terminal runs under.
  const mine = (o) => sameLauncher(o, caller.record) || (caller.kind === "user" && o?.agent === "terminal");
  return readLines(noticesFile(run)).filter((n) => typeof n?.id === "string" && !seen.has(n.id) && (n.owners || []).some(mine));
}

export function markNoticesSeen(run, notices, caller = callerIdentity()) {
  const reader = readerKey(caller.record);
  if (!notices.length || !reader) return;
  const time = new Date().toISOString();
  try {
    fs.appendFileSync(path.join(run.dir, SEEN_FILE), notices.map((n) => `${JSON.stringify({ id: n.id, reader, time })}\n`).join(""));
  } catch {}
}

// The marker views add to a run the caller may only read, or "".
export function readOnlyMark(own) {
  if (mayAct(own)) return "";
  if (own.userOwned && own.links.length === 1) return " · the user's run: read-only for you";
  return ` · another session's: read-only for you${own.orphaned ? ` (orphaned: ${own.why}; --adopt takes it over)` : ""}`;
}
