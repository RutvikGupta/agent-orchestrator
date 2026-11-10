// Historical task outcomes. Read records first; only unfinished/failed tasks need describe().
import fs from "node:fs";
import path from "node:path";
import { decisionsIn } from "./briefs.mjs";
import { RUNS_DIR, STATE_ROOT } from "./config.mjs";
import { summarizeEvents } from "./events.mjs";
import { compact, formatElapsed } from "./format.mjs";
import { phaseOf } from "./lifecycle.mjs";
import { loadPolicy, modelLabel } from "./policy.mjs";
import { reportFields } from "./report.mjs";
import { attemptAgent, describe, relayAlive } from "./runs.mjs";
import { die, readJson, writeJson } from "./util.mjs";

export function sinceDuration(value = "30d") {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  const ms = match && Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (!Number.isFinite(ms) || ms < 0) die(`bad duration "${value}" (use e.g. 7d, 12h, 90m)`, 2);
  return ms;
}

function interval(start, finish) {
  const ms = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function outcome(run, task, dir, results) {
  const result = results[task.attempt];
  // Local paths matter for archived/copied runs, whose task.outDir can point at live state.
  const local = { ...task, outDir: path.join(dir, `attempt-${task.attempt}`) };
  if (result?.status !== "completed") return describe(run, local);
  let tokensIn = 0, tokensOut = 0;
  for (let n = 1; n <= task.attempt; n++) {
    const summary = summarizeEvents(attemptAgent(task, n), path.join(dir, `attempt-${n}`, "events.jsonl"), task.cd);
    tokensIn += summary.tokens.input;
    tokensOut += summary.tokens.output;
  }
  const state = decisionsIn(result.finalMessage) ? "needs-decision" : "completed";
  const row = { state, result, tokensIn, tokensOut, limitHit: false, phase: phaseOf(task, state) };
  return { ...row, ...reportFields(run, local, row) };
}

function group(items, identity) {
  const groups = new Map();
  for (const item of items) {
    const labels = identity(item);
    const key = JSON.stringify(labels);
    if (!groups.has(key)) groups.set(key, { ...labels, tasks: 0, attempts: 0, firstAttemptAccepted: 0,
      accepted: 0, integrated: 0, failed: 0, limitHits: 0, transientErrors: 0,
      tokensIn: 0, tokensOut: 0, elapsed: [], reviewWait: [] });
    const g = groups.get(key);
    g.tasks++;
    g.attempts += item.attempts;
    for (const field of ["firstAttemptAccepted", "accepted", "integrated", "failed", "limitHits", "transientErrors", "tokensIn", "tokensOut"]) g[field] += item[field];
    if (item.elapsedMs !== null) g.elapsed.push(item.elapsedMs);
    if (item.reviewWaitMs !== null) g.reviewWait.push(item.reviewWaitMs);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => {
    const { elapsed, reviewWait, ...numbers } = g;
    // What an accepted task cost: every input token the group's tasks used, accepted or not, over the accepted ones.
    return { ...numbers, firstAttemptAcceptance: g.accepted ? g.firstAttemptAccepted / g.accepted : null,
      tokensInPerAccepted: g.accepted ? Math.round(g.tokensIn / g.accepted) : null,
      medianFirstAttemptMs: median(elapsed), medianReviewWaitMs: median(reviewWait) };
  });
}

// The folder of every task in `runs`, as { run, dir }.
function* taskDirs(runs) {
  for (const run of runs) {
    const tasksDir = path.join(run.dir, "tasks");
    if (!fs.existsSync(tasksDir)) continue;
    for (const entry of fs.readdirSync(tasksDir)) yield { run, dir: path.join(tasksDir, entry) };
  }
}

// The task record in `dir`, or null when it is not a dispatched task: prepared worktrees, main
// sessions, and native sub-agents are not.
function dispatchedTask(dir) {
  const task = readJson(path.join(dir, "task.json"));
  return task && ["claude", "codex"].includes(task.agent) && task.attempt > 0 ? task : null;
}

function attemptResults(dir, task) {
  const results = {};
  for (let n = 1; n <= task.attempt; n++) results[n] = readJson(path.join(dir, `attempt-${n}`, "result.json"));
  return results;
}

// What the stats groups and the tier summary both read from a task: its verdict and how long its
// first attempt took.
function baseItem(task, first) {
  const accepted = Boolean(task.acceptedAt);
  return { agent: task.agent, attempts: task.attempt, accepted: Number(accepted),
    firstAttemptAccepted: Number(accepted && task.acceptedAttempt === 1),
    elapsedMs: interval(first?.startedAt || (task.attempt === 1 ? task.startedAt : null), first?.finishedAt) };
}

// One record per task, with the numbers the stats groups add up.
function taskItems(runs) {
  const items = [];
  for (const { run, dir } of taskDirs(runs)) {
    const task = dispatchedTask(dir);
    if (!task) continue;
    const results = attemptResults(dir, task);
    const row = outcome(run, task, dir, results);
    items.push({ ...baseItem(task, results[1]), modelLabel: modelLabel(task),
      type: task.plan?.type || (task.babysit ? "babysit" : task.readOnly ? "read-only" : "write"),
      integrated: Number(Boolean(task.integratedAt) || row.phase === "integrated"),
      failed: Number(!["completed", "needs-decision", "running", "prepared"].includes(row.state)),
      limitHits: Number(Boolean(row.limitHit)), transientErrors: Number(row.health === "transient-error" || task.retries > 0),
      reviewWaitMs: task.acceptedAt ? interval(results[task.acceptedAttempt]?.finishedAt, task.acceptedAt) : null,
      tokensIn: row.tokensIn, tokensOut: row.tokensOut });
  }
  return items;
}

export function taskStats(runs) {
  const items = taskItems(runs);
  return { byAgent: group(items, ({ agent, modelLabel }) => ({ agent, modelLabel })),
    byType: group(items, ({ type }) => ({ type })) };
}

// How each tier has done on this machine, which is what an orchestrator weighs when it picks one.
// A task counts toward the tier its first attempt ran at (the tier chosen for it), even when it
// was redone one tier up and finished there. The task record keeps only the latest attempt's
// tier, so the first attempt's model names the tier: from its result, or, when it left none, from
// the task record (a one-attempt task) or its event log. A task is in the window by its own finish time.
export const EVIDENCE_DAYS = 30;
// Fewer finished tasks than this say too little about a tier to show a rate.
export const EVIDENCE_MIN_TASKS = 5;

// The tier of `agent` that runs `model`: the one tier with that model, or, when several tiers
// share it, the one with that effort. null when no tier, or more than one, fits.
function tierRunning(policy, agent, model, effort) {
  const named = Object.entries(policy[agent]?.tiers || {}).filter(([, tier]) => tier.model === model);
  if (named.length === 1) return named[0][0];
  const same = named.filter(([, tier]) => (tier.effort ?? null) === (effort ?? null));
  return same.length === 1 ? same[0][0] : null;
}

// One entry per policy tier, in policy order (claude, then codex, lightest first), from the
// per-task records `tierItem` makes. An entry counts the tier's finished tasks (first attempt
// ended), how many of the reviewed ones were accepted on that first attempt, the median
// first-attempt time, and what an accepted task cost: every input token of the tier's finished
// tasks, accepted or not, over the accepted ones.
export function tierSummary(items, policy) {
  const entries = [];
  for (const agent of ["claude", "codex"]) {
    for (const tier of Object.keys(policy[agent].tiers)) {
      const mine = items.filter(({ chosen, first }) => chosen && first && first.agent === agent
        && (first.model ? tierRunning(policy, agent, first.model, first.effort) : first.tier) === tier);
      const accepted = mine.filter((item) => item.accepted);
      const reviewed = mine.filter((item) => item.reviewed);
      const acceptedFirst = reviewed.filter((item) => item.firstAttemptAccepted).length;
      entries.push({ agent, tier, tasks: mine.length, reviewed: reviewed.length, firstAttemptAccepted: acceptedFirst,
        firstAttemptAcceptance: reviewed.length ? acceptedFirst / reviewed.length : null,
        accepted: accepted.length,
        tokensInPerAccepted: accepted.length ? Math.round(mine.reduce((sum, item) => sum + item.tokensIn, 0) / accepted.length) : null,
        medianFirstAttemptMs: median(mine.map((item) => item.elapsedMs).filter((ms) => ms !== null)) });
    }
  }
  return entries;
}

// A tier's numbers on one line, for `agents` and for the error that asks for --tier.
export function evidenceText(entry) {
  const window = `last ${EVIDENCE_DAYS}d`;
  if (!entry || entry.tasks < EVIDENCE_MIN_TASKS) return `${window}: too few tasks (${entry?.tasks ?? 0} finished, ${EVIDENCE_MIN_TASKS} needed)`;
  const first = entry.firstAttemptAcceptance === null ? "no reviewed task yet"
    : `${Math.round(entry.firstAttemptAcceptance * 100)}% accepted first try (${entry.firstAttemptAccepted} of ${entry.reviewed} reviewed)`;
  const tokens = entry.tokensInPerAccepted === null ? "no accepted task yet" : `${compact(entry.tokensInPerAccepted)} input tokens per accepted task`;
  return `${window}: ${entry.tasks} tasks, ${first}, median first attempt ${formatElapsed(entry.medianFirstAttemptMs)}, ${tokens}`;
}

// A tier's numbers as the note that follows the tier on a line: ` [last 30d: ...]`, or nothing
// when the summary could not be read.
export function evidenceNote(summary, agent, tier) {
  return summary ? ` [${evidenceText(summary.find((entry) => entry.agent === agent && entry.tier === tier))}]` : "";
}

// Attempt `n` of a task: its result and whether it has ended. An attempt has ended when it left a
// result, when a later attempt replaced it, or when its relay is gone without one (a crash or a kill).
function attemptState(dir, task, n) {
  const file = path.join(dir, `attempt-${n}`, "result.json");
  const result = readJson(file);
  if (result || n < task.attempt) return { result, ended: true };
  if (!task.pid || relayAlive(task.pid, task.startedAt)) return { result: null, ended: false };
  // The relay may have published its result and exited between the two checks.
  return { result: readJson(file), ended: true };
}

// When an attempt that left no result ended: the newest file time in its folder (its event log, its
// error log), which a crash leaves behind. null when the folder holds no file.
function newestFileTime(dir) {
  let newest = null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ms = fs.statSync(path.join(dir, entry.name)).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    }
  } catch {
    // A folder that is gone has no file time.
  }
  return newest;
}

// How a task's first attempt ran, as { model, effort, tier }, for the tier it counts toward. Its
// result names the model. Without one (a crash), the tier recorded for that attempt when it started
// (`attemptTiers`, which a task from before that record lacks), else a one-attempt task's own
// record, else the attempt's event log, whose model a Claude log names and a Codex log does not.
function firstRan(task, result, summary) {
  if (result?.model) return { model: result.model, effort: result.effort || null, tier: null };
  const tier = task.attemptTiers?.[1];
  if (typeof tier === "string" && tier) return { model: null, effort: null, tier };
  if (task.attempt === 1) return { model: task.model || null, effort: task.effort || null, tier: task.tier || null };
  return { model: summary.model || null, effort: summary.effort || null, tier: null };
}

// The tier summary reads far less of a task than `stats` does: its verdict, how its first attempt
// ran and ended, and the input tokens of its attempts. This is that record as
// { settled, at, item }. A task is finished only when its last attempt has ended: while a retry
// still runs, `item` is null and `settled` false, so that the record is read again next time.
// `item` is also null when the task is not dispatched. `at` is when the task finished (ms), which
// places it in the window: its last result's time, or, for a last attempt that left none, the
// newest file time in that attempt's folder. A task that finished before `cutoff` is placed by its
// time alone: its event logs are not read.
function tierItem(dir, cutoff) {
  const task = dispatchedTask(dir);
  if (!task) return { settled: true, at: null, item: null };
  const attempts = Array.from({ length: task.attempt }, (_, i) => attemptState(dir, task, i + 1));
  const [first] = attempts;
  const last = attempts[attempts.length - 1];
  if (!last.ended) return { settled: false, at: null, item: null };
  let at = Date.parse(last.result?.finishedAt);
  if (!Number.isFinite(at)) at = newestFileTime(path.join(dir, `attempt-${task.attempt}`)) ?? Date.parse(task.startedAt || task.createdAt);
  at = Number.isFinite(at) ? at : null;
  if (at === null || at < cutoff) return { settled: true, at, item: null };
  let tokensIn = 0;
  let firstSummary = null;
  attempts.forEach((attempt, i) => {
    const summary = summarizeEvents(attemptAgent(task, i + 1), path.join(dir, `attempt-${i + 1}`, "events.jsonl"), task.cd);
    tokensIn += summary.tokens.input;
    if (i === 0) firstSummary = summary;
  });
  return { settled: true, at,
    item: { ...baseItem(task, first.result), tokensIn,
      // A babysitter's tier is fixed, not chosen, so the tier summary leaves it out.
      chosen: !task.babysit,
      first: { agent: attemptAgent(task, 1), ...firstRan(task, first.result, firstSummary) },
      // The first attempt's outcome is known once it was accepted or rejected, once the task needed
      // another attempt, or once the attempt itself failed: a result that is not "completed", or none
      // at all. A task closed with no verdict says nothing about its tier.
      reviewed: Boolean(task.acceptedAt) || Boolean(task.rejectedAt) || task.attempt > 1 || first.result?.status !== "completed" } };
}

function statKey(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "-";
  }
}

// Where each task's record for the summary is kept between calls, so that reading the summary
// costs a few file stats and not a read of every task's event log. A record is read again when its
// task's record or first result changes; tasks that other sessions run in the meantime change only
// their own. A task that finished before the window keeps only its time, so that the file holds
// no record of work the summary no longer counts. A task whose last attempt still runs is not kept.
const EVIDENCE_CACHE = path.join(STATE_ROOT, "tier-evidence.json");
const EVIDENCE_VERSION = 3;

// The tier summary over the tasks that finished in the last EVIDENCE_DAYS days, in every run (an old
// run may hold a task that finished today). null when it cannot be read: callers then print no
// numbers, and what they were doing goes on.
export function tierEvidence(policy = loadPolicy()) {
  try {
    const cutoff = Date.now() - EVIDENCE_DAYS * 86400000;
    const runs = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).map((id) => ({ dir: path.join(RUNS_DIR, id) })) : [];
    const cached = readJson(EVIDENCE_CACHE);
    const known = cached?.version === EVIDENCE_VERSION && cached.tasks && typeof cached.tasks === "object" ? cached.tasks : {};
    const kept = {};
    const items = [];
    let changed = false;
    for (const { dir } of taskDirs(runs)) {
      const key = `${statKey(path.join(dir, "task.json"))} ${statKey(path.join(dir, "attempt-1", "result.json"))}`;
      let entry = Object.hasOwn(known, dir) && known[dir]?.key === key ? known[dir] : null;
      if (entry) {
        kept[dir] = entry;
      } else {
        const { settled, at, item } = tierItem(dir, cutoff);
        entry = { key, at, item };
        if (settled) {
          kept[dir] = entry;
          changed = true;
        }
      }
      if (entry.item && entry.at !== null && entry.at >= cutoff) items.push(entry.item);
    }
    if (changed || Object.keys(known).length !== Object.keys(kept).length) {
      try {
        const written = Object.fromEntries(Object.entries(kept).map(([dir, entry]) =>
          [dir, entry.item && entry.at >= cutoff ? entry : { key: entry.key, at: entry.at, item: null }]));
        writeJson(EVIDENCE_CACHE, { version: EVIDENCE_VERSION, tasks: written });
      } catch {
        // A read-only or missing state folder only costs the next call a full read.
      }
    }
    return tierSummary(items, policy);
  } catch {
    return null;
  }
}
