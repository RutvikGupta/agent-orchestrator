// Views of a run's sessions shared by `status`, `wait`, `watch`, `runs`, and the dashboard: totals,
// status rows and text, and the session tree.

import path from "node:path";
import { CLI_PATH } from "./config.mjs";
import { compact, shortText, table } from "./format.mjs";
import { listNative, mainRow } from "./native.mjs";
import { noticeText, ownershipOf, readOnlyMark, unseenNotices } from "./ownership.mjs";
import { reviveParked } from "./park.mjs";
import { listRuns, listTasks } from "./runs.mjs";

export function totals(tasks) {
  const t = { running: 0, finished: 0, tokensIn: 0, tokensOut: 0, exact: true };
  for (const task of tasks) {
    if (task.state === "running") t.running += 1;
    else if (task.state !== "prepared") t.finished += 1;
    t.tokensIn += task.tokensIn;
    t.tokensOut += task.tokensOut;
    if (!task.tokensExact) t.exact = false;
  }
  return t;
}

export function totalsText(t) {
  const approx = t.exact ? "" : "~";
  return `${t.running} running · ${t.finished} finished · ${approx}${compact(t.tokensIn)} in / ${approx}${compact(t.tokensOut)} out`;
}

// A closed session shows its outcome; a sub-agent that went idle and was closed has completed. A
// parked babysitter (park.mjs) runs as far as `wait` can tell, and shows as parked.
function stateLabel(t) {
  return t.phase === "parked" ? "parked" : t.closed && t.state === "idle" ? "completed" : t.state;
}

// "(2 attempts, 1 rework round)": the attempts, and the review rounds that asked for changes.
function attemptsLabel(t) {
  const reworks = (t.reviewRounds || []).filter((r) => r.verdict === "changes").length;
  const parts = [t.attempt > 1 ? `${t.attempt} attempts` : null, t.handoff ? `fresh session from a handoff at ${compact(t.handoff.contextTokens)} tokens` : null, reworks ? `${reworks} rework round${reworks === 1 ? "" : "s"}` : null].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function statusRows(tasks) {
  return tasks.map((t) => ({
    id: t.native && t.parent !== "orchestrator" ? `${t.parent}/${t.id}` : t.id,
    agent: t.agent,
    model: t.modelLabel,
    mode: t.mode,
    state: `${stateLabel(t)}${attemptsLabel(t)}`,
    elapsed: t.elapsed,
    steps: t.steps,
    tokens: t.tokensIn || t.tokensOut ? `${t.tokensExact ? "" : "~"}${compact(t.tokensIn)}/${compact(t.tokensOut)}` : "-",
    now: shortText(`${stuckMarker(t)}${t.now ?? ""}`, 70),
  }));
}

// "stuck: `npm test` failed 3× · " before a stuck task's activity; empty otherwise.
function stuckMarker(t) {
  return t.stuck ? `stuck: \`${shortText(t.stuck.command, 30)}\` failed ${t.stuck.failures}× · ` : "";
}

// `notices` are the owner's unseen notices (ownership.mjs) that `wait` already read; by default
// they are read here.
export function statusText(run, tasks, notices = unseenNotices(run)) {
  const native = listNative(run, tasks);
  const main = mainRow(run);
  const changed = notices.map((n) => `${n.task || "run"}: ${noticeText(n)}`);
  const own = ownershipOf(run);
  if (!tasks.length && !native.length) return [`run ${run.id}: no tasks yet${readOnlyMark(own)}`, ...changed].join("\n");
  // A parked task whose watcher is not running (after a reboot, say) gets a new one, and is reported.
  // Only for the owner: anyone else's `status` changes nothing.
  const revived = own.mine ? reviveParked(run, tasks) : [];
  const cols = ["id", "agent", "model", "mode", "state", "elapsed", "steps", "tokens", "now"];
  return [
    `run ${run.id}${orchestratorLabel(run)}${readOnlyMark(own)}`,
    ...(main ? [`main session (whole session, not in the totals): ${main.modelLabel} · ${main.state} · tokens ${main.tokensExact ? "" : "~"}${compact(main.tokensIn)}/${compact(main.tokensOut)} · ${shortText(main.now, 70)}`] : []),
    tasks.length ? table(statusRows(tasks), cols) : "(no orch.mjs tasks)",
    ...(native.length ? ["native sub-agents (started with the host's own tool, not orch.mjs):", table(statusRows(native), cols)] : []),
    `total: ${totalsText(totals([...tasks, ...native]))}`,
    ...revived.map((r) => (r.adopted
      ? `${r.id}: a resume died after starting its relay (pid ${r.pid}), which still runs; recorded it as attempt ${r.adopted}`
      : `${r.id}: parked, and its watcher was not running; started a new one (pid ${r.pid})`)),
    ...nestedLines(run),
    ...whyLines(tasks),
    ...tasks.map((t) => `  ${t.id}: ${t.failureCount || 0} counted failures; attempts: ${(t.attempts || []).slice().reverse().map((a) => `${a.n} ${a.agent} ${a.tier || "no tier"}`).join(", ") || "none"}`),
    ...(changed.length ? ["changed by someone other than you, the owner:", ...changed.map((line) => `  ${line}`)] : []),
  ].join("\n");
}

// Runs that this run's tasks started in turn.
function nestedLines(run) {
  const kids = listRuns().filter((r) => r.orchestrator?.parentRun === run.id);
  if (!kids.length) return [];
  return [
    "nested runs (started by this run's tasks):",
    ...kids.map((r) => `  ${r.orchestrator.parentTask || "?"} → ${r.id}: ${totalsText(totals(listTasks(r)))}  (status: node ${CLI_PATH} status ${r.id})`),
  ];
}

function whyLines(tasks) {
  const chosen = tasks.filter((t) => t.why);
  if (!chosen.length) return [];
  const width = Math.max(...chosen.map((t) => t.id.length));
  return ["why:", ...chosen.map((t) => `  ${t.id.padEnd(width)}  ${t.agent}${t.tier ? ` ${t.tier}` : ""}: ${shortText(t.why, 110)}`)];
}

function orchestratorLabel(run) {
  const o = run.orchestrator;
  if (!o?.agent) return "";
  return ` · launched by ${o.agent}${o.sessionId ? ` session ${o.sessionId.slice(0, 8)}` : ""}`;
}

const COLORS = { running: 33, "needs-decision": 35, completed: 32, failed: 31, timeout: 31, stalled: 31, stopped: 31, aborted: 31, prepared: 90, idle: 90 };

function paint(text, state, tty) {
  const code = COLORS[state] ?? (String(state).endsWith("_unavailable") ? 31 : null);
  return tty && code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

// Orders a run's sessions as a tree: the main session, then everything it launched (its orch.mjs
// tasks and its own sub-agents), each followed by the sub-agents it started in turn. Each session
// gets the tree prefix for its row and for the activity line under it.
export function treeOrder(tasks) {
  const main = tasks.find((t) => t.main) || null;
  const others = tasks.filter((t) => !t.main);
  const parentOf = (t) => {
    if (t.under && !t.native) return others.find((o) => (!o.native || o.taskAgent) && o.run === t.under.run && o.id === t.under.id) || main;
    if (!t.native || t.parent === "orchestrator" || !t.parent) return main;
    const near = others.filter((o) => o !== t && o.id === t.parent && o.run === t.run);
    return near.find((o) => o.native) || near[0] || main;
  };
  const children = new Map();
  for (const t of others) {
    const p = parentOf(t);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(t);
  }
  // Among siblings, a session whose subtree is running comes first, then other open ones (such as
  // a failure not yet handled), then finished ones. Running ones are ordered by the latest started
  // (so rows do not reshuffle on every event); the others by the most recent activity.
  const rank = (n) => {
    const kids = children.get(n) || [];
    const own = n.state === "running" ? 0 : n.closed ? 2 : 1;
    return Math.min(own, ...kids.map(rank));
  };
  const recency = (n) => Math.max(n.lastActiveMs || 0, ...(children.get(n) || []).map(recency));
  const invoked = (n) =>
    Math.max(n.state === "running" ? Date.parse(n.invokedAt || n.startedAt || "") || 0 : 0, ...(children.get(n) || []).map(invoked));
  for (const list of children.values()) {
    const keys = new Map(list.map((n) => [n, [rank(n), rank(n) === 0 ? invoked(n) : recency(n)]]));
    list.sort((a, b) => keys.get(a)[0] - keys.get(b)[0] || keys.get(b)[1] - keys.get(a)[1]);
  }
  const keyOf = (n) => (!n ? null : n.main ? "~main" : `${n.run ? `${n.run}~` : ""}${n.native ? `${n.parent}~` : ""}${n.id}`);
  const descendants = (n) => (children.get(n) || []).reduce((sum, k) => sum + 1 + descendants(k), 0);
  const out = [];
  const walk = (nodes, lead, depth, parent) => {
    nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      const kids = children.get(n) || [];
      out.push({
        ...n,
        key: keyOf(n),
        parentKey: keyOf(parent),
        depth,
        kids: kids.length,
        descendants: descendants(n),
        treePrefix: `${lead}${last ? "└─ " : "├─ "}`,
        nowPrefix: `${lead}${last ? "   " : "│  "}${kids.length ? "│  " : "   "}`,
      });
      walk(kids, `${lead}${last ? "   " : "│  "}`, depth + 1, n);
    });
  };
  if (main) {
    const kids = children.get(main) || [];
    out.push({ ...main, key: keyOf(main), parentKey: null, depth: 0, kids: kids.length, descendants: descendants(main), treePrefix: "", nowPrefix: "" });
    walk(kids, "", 1, main);
  } else {
    walk(children.get(null) || [], "", 0, null);
  }
  return out;
}

export function renderTree(runs, tty) {
  const out = [];
  for (const run of runs) {
    const described = listTasks(run);
    const main = mainRow(run);
    const tasks = treeOrder([...(main ? [main] : []), ...described, ...listNative(run, described)]);
    const counted = tasks.filter((t) => !t.main);
    const repo = path.basename(run.repo || "");
    out.push(`run ${run.id}${orchestratorLabel(run)}${readOnlyMark(ownershipOf(run))} · ${repo}${run.baseBranch ? ` @ ${run.baseBranch}` : ""}`);
    if (run.goal) out.push(`   goal: ${shortText(run.goal, 90)}`);
    const rows = statusRows(tasks).map((row, i) => ({
      ...row,
      id: `${tasks[i].treePrefix}${tasks[i].main ? "main session" : tasks[i].id}`,
      session: tasks[i].session ? tasks[i].session.slice(0, 8) : "-",
    }));
    const cols = ["id", "agent", "model", "mode", "state", "elapsed", "steps", "tokens", "session", "now"];
    const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
    const line = (r) => cols.map((c, i) => (c === "now" ? String(r[c]) : String(r[c]).padEnd(widths[i]))).join("  ");
    out.push(`   ${line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()])))}`);
    rows.forEach((r, i) => {
      out.push(`   ${paint(line(r), tasks[i].closed && tasks[i].state === "idle" ? "completed" : tasks[i].state, tty)}`);
    });
    if (!rows.length) out.push("   (no tasks yet)");
    out.push(`   total: ${totalsText(totals(counted))}${main ? " (without the main session)" : ""}`, "");
  }
  return out.join("\n");
}
