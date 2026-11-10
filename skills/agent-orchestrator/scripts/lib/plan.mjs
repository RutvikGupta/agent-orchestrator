// The run's plan (<run-dir>/plan.json): its validation, the parallel conflicts between its tasks,
// and which planned tasks are ready to start. File and git reads only, with no import of runs.mjs:
// lifecycle.mjs uses this module, and runs.mjs imports lifecycle.mjs.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { AGENTS, TASK_ID } from "./config.mjs";
import { CLAUDE_DEFAULT_TIER, loadPolicy } from "./policy.mjs";
import { readJson } from "./util.mjs";

export const TASK_TYPES = ["implement", "review", "research", "debug", "babysit"];
const LIST_FIELDS = ["owns", "uses", "produces", "resources", "dependsOn"];

export function planPath(runDir) {
  return path.join(runDir, "plan.json");
}

// The recorded plan, or null when the run has none.
export function readPlan(runDir) {
  const plan = readJson(planPath(runDir));
  return plan && Array.isArray(plan.tasks) ? plan : null;
}

// A brief path in the plan is relative to the run directory unless it is absolute.
export function briefPath(runDir, brief) {
  return path.isAbsolute(brief) ? brief : path.join(runDir, brief);
}

const filled = (value) => typeof value === "string" && value.trim() !== "";
const stringList = (value) => Array.isArray(value) && value.every(filled);

// The unfilled markers that `brief` leaves in a draft, found the way `start` finds them: how many,
// and the first line that has one.
const MARKER = /<fill in:[^<>\n]*>/g;
export function briefMarkers(text) {
  const count = (text.match(MARKER) || []).length;
  return { count, line: count ? text.split(/\r?\n/).find((l) => l.match(MARKER)).trim() : null };
}

// Why a planned task's brief is not ready to start it yet, or null when it is. A plan may name briefs
// that are not written yet: `brief` drafts them from the recorded plan.
export function briefProblem(runDir, entry) {
  let text;
  try {
    text = fs.readFileSync(briefPath(runDir, entry.brief), "utf8");
  } catch {
    return "not written yet";
  }
  if (!text.trim()) return "empty";
  const { count } = briefMarkers(text);
  return count ? `${count} unfilled <fill in: ...> marker${count === 1 ? "" : "s"}` : null;
}

// "light, standard or complex": a tier list for messages.
const orList = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names.join(""));

// What is wrong with a planned task's tier, or null. Every task names one, since `start` refuses a
// new task without it. A pull-request babysitter is the exception: it always runs `complex`, so its
// tier may be left out. `dispatch` uses this too, for a plan recorded before tiers were required.
export function tierProblem(task, policy = loadPolicy()) {
  if (task?.agent !== "claude" && task?.agent !== "codex") return null; // the agent is reported on its own
  const label = task.agent === "claude" ? "Claude" : "Codex";
  const names = Object.keys(policy[task.agent].tiers);
  if (task.agent === "claude" && task.type === "babysit") {
    return task.tier != null && task.tier !== CLAUDE_DEFAULT_TIER ? `a babysit task runs the ${CLAUDE_DEFAULT_TIER} tier` : null;
  }
  if (names.includes(task.tier)) return null;
  return task.tier == null || task.tier === ""
    ? `a ${label} task needs a tier (${orList(names)}): the lightest that does the task as well as the top one`
    : `tier ${JSON.stringify(task.tier)} is not a ${label} tier (${orList(names)})`;
}

// Check a parsed plan. Returns the problems with its fields and graph (errors), and the pairs of
// tasks that may run at the same time but share an owned path or a resource (conflicts). `held`
// maps each running task to the plan entry it started with: until it finishes, it keeps the paths
// and resources of that entry, whatever the new plan says.
export function validatePlan(plan, held = new Map()) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { errors: ["the plan must be a JSON object"], conflicts: [] };
  if (!filled(plan.goal)) errors.push("goal is empty: one line with the user's original request");
  if (plan.acceptance !== undefined && !(Array.isArray(plan.acceptance) && plan.acceptance.every((a) => typeof a === "string"))) {
    errors.push("acceptance must be a list of strings");
  }
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) {
    errors.push("tasks must be a non-empty list");
    return { errors, conflicts: [] };
  }
  const policy = loadPolicy();
  const ids = new Set();
  let graphReadable = true; // every task is an object whose dependsOn, if any, is a list of ids
  plan.tasks.forEach((task, i) => {
    const name = typeof task?.id === "string" && task.id ? task.id : `#${i + 1}`;
    const bad = (message) => errors.push(`task ${name}: ${message}`);
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      graphReadable = false;
      return bad("must be an object");
    }
    if (task.dependsOn !== undefined && !stringList(task.dependsOn)) graphReadable = false;
    if (!TASK_ID.test(String(task.id ?? ""))) bad(`id must be a lowercase slug matching ${TASK_ID}`);
    else if (ids.has(task.id)) bad("duplicate id");
    ids.add(task.id);
    if (!filled(task.goal)) bad("goal is empty");
    if (task.type !== undefined && !TASK_TYPES.includes(task.type)) bad(`type must be one of ${TASK_TYPES.join(", ")}`);
    if (!AGENTS[task.agent]) bad(`agent must be ${Object.keys(AGENTS).join(" or ")}`);
    else {
      const problem = tierProblem(task, policy);
      if (problem) bad(problem);
    }
    if (!filled(task.why)) bad("why is empty: one line on why your assessment picked this agent");
    for (const key of LIST_FIELDS) if (task[key] !== undefined && !stringList(task[key])) bad(`${key} must be a list of non-empty strings`);
    if (task.readOnly !== undefined && typeof task.readOnly !== "boolean") bad("readOnly must be true or false");
    if (task.readOnly && Array.isArray(task.owns) && task.owns.length) bad("is read-only, so it owns nothing: empty owns, and list what it reads under uses");
    if (task.type === "babysit" && (task.agent !== "claude" || task.readOnly)) bad("a babysit task runs on Claude in write mode");
    if (!filled(task.brief)) bad("brief is empty: the path of its brief file, relative to the run directory");
  });
  if (!graphReadable) return { errors, conflicts: [] };
  const depErrors = [];
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn || []) {
      if (dep === task.id) depErrors.push(`task ${task.id}: depends on itself`);
      else if (!ids.has(dep)) depErrors.push(`task ${task.id}: dependsOn names "${dep}", which is not in the plan`);
    }
  }
  errors.push(...depErrors);
  if (!depErrors.length) for (const cycle of findCycles(plan.tasks)) errors.push(`dependency cycle: ${cycle.join(" → ")}`);
  if (errors.length) return { errors, conflicts: [] };
  return { errors, conflicts: findConflicts(plan.tasks, held) };
}

function findCycles(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn || []]));
  const state = new Map(); // id -> "visiting" | "done"
  const cycles = [];
  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      cycles.push([...trail.slice(trail.indexOf(id)), id]);
      return;
    }
    state.set(id, "visiting");
    for (const dep of deps.get(id)) visit(dep, [...trail, id]);
    state.set(id, "done");
  };
  for (const t of tasks) visit(t.id, []);
  return cycles;
}

// Every task each task depends on, directly or through other tasks.
export function dependencyClosure(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn || []]));
  const closure = new Map();
  const walk = (id) => {
    if (closure.has(id)) return closure.get(id);
    const all = new Set();
    closure.set(id, all); // guards against cycles in an unchecked plan
    for (const dep of deps.get(id) || []) {
      all.add(dep);
      for (const d of walk(dep)) all.add(d);
    }
    return all;
  };
  for (const t of tasks) walk(t.id);
  return closure;
}

// An owned path, compared as a repository-relative directory or file: "./src/x/" and "src/x/**"
// both mean src/x, and "." means the whole repository.
function ownedPath(p) {
  const n = path.posix.normalize(String(p).trim().replace(/\/\*\*?$/, "")).replace(/\/+$/, "");
  return n === "" ? "." : n;
}

export function pathsOverlap(a, b) {
  const x = ownedPath(a);
  const y = ownedPath(b);
  return x === "." || y === "." || x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

// Pairs of tasks that may run at the same time (neither depends on the other, directly or not)
// and share an owned path or a resource. Read-only tasks own nothing, so they meet only on resources.
// A running task in `held` also keeps the paths and resources of the entry it started with.
export function findConflicts(tasks, held = new Map()) {
  const closure = dependencyClosure(tasks);
  const union = (x = [], y = []) => [...new Set([...x, ...y])];
  const effective = tasks.map((t) => {
    const h = held.get(t.id);
    return h ? { ...t, readOnly: Boolean(t.readOnly && h.readOnly), owns: union(t.owns, h.owns), resources: union(t.resources, h.resources) } : t;
  });
  const conflicts = [];
  for (let i = 0; i < effective.length; i++) {
    for (let j = i + 1; j < effective.length; j++) {
      const a = effective[i];
      const b = effective[j];
      if (closure.get(a.id).has(b.id) || closure.get(b.id).has(a.id)) continue;
      const paths = [];
      if (!a.readOnly && !b.readOnly) {
        for (const pa of a.owns || []) for (const pb of b.owns || []) if (pathsOverlap(pa, pb)) paths.push(pa === pb ? pa : `${pa} / ${pb}`);
      }
      const resources = (a.resources || []).filter((r) => (b.resources || []).includes(r));
      if (paths.length || resources.length) conflicts.push({ a: a.id, b: b.id, paths, resources, running: [a.id, b.id].filter((id) => held.has(id)) });
    }
  }
  return conflicts;
}

export function conflictText(c) {
  const shared = [c.paths.length ? `own ${c.paths.join(", ")}` : null, c.resources.length ? `use ${c.resources.join(", ")}` : null].filter(Boolean);
  const one = c.running?.length === 1;
  const running = c.running?.length
    ? ` (${c.running.join(" and ")} ${one ? "is" : "are"} running, and keep${one ? "s" : ""} the paths and resources ${one ? "it" : "they"} started with until ${one ? "it finishes" : "they finish"})`
    : "";
  return `tasks ${c.a} and ${c.b} can run at the same time but both ${shared.join(" and ")}${running}; add "dependsOn": ["${c.a}"] to ${c.b} (or the reverse) so that they run in order`;
}

// Where each planned task stands, given the phase of every task that has a record (`phases`: id ->
// phase). A task is ready when it has not started and every task it depends on is integrated; with
// `runDir`, a ready task whose brief is not ready yet is listed under `unbriefed` instead.
// Babysit tasks need a pull request number, which the plan does not hold, so they are started by hand.
export function planProgress(plan, phases, runDir = null) {
  const out = { started: [], ready: [], unbriefed: [], blocked: [], manual: [] };
  for (const task of plan.tasks) {
    const phase = phases.get(task.id);
    if (phase && phase !== "prepared") {
      out.started.push(task);
      continue;
    }
    const waitsOn = (task.dependsOn || [])
      .filter((dep) => phases.get(dep) !== "integrated")
      .map((dep) => ({ id: dep, phase: phases.get(dep) && phases.get(dep) !== "prepared" ? phases.get(dep) : "not started" }));
    const problem = runDir && !waitsOn.length && task.type !== "babysit" ? briefProblem(runDir, task) : null;
    if (waitsOn.length) out.blocked.push({ task, waitsOn });
    else if (task.type === "babysit") out.manual.push(task);
    else if (problem) out.unbriefed.push({ task, problem });
    else out.ready.push(task);
  }
  return out;
}

export function waitsOnText(waitsOn) {
  return waitsOn.map((w) => `${w.id} (${w.phase})`).join(", ");
}

// Runtime conflicts include dependency-ordered pairs too: a forced start may still be running
// when its dependent is requested. Keep the running task's original reservation after replanning.
export function runningConflicts(entry, running) {
  const reservation = (task) => ({ ...task, dependsOn: [],
    owns: task.babysit || task.type === "babysit" || task.agent === "command" ? [] : task.owns,
    resources: task.agent === "command" ? [] : task.resources,
  });
  return running.flatMap((held) => findConflicts([
    reservation(entry), reservation(held),
  ]).map((conflict) => ({ ...conflict, running: [held.id] })));
}

// A hand merge is evidence to reconcile, not an integration receipt. An unchanged branch at its
// starting commit is not work merged by hand. Git reads only; this also works after worktree removal.
export function manualMerge(run, task) {
  if (!run.isGit || !run.baseBranch || !task || task.readOnly) return null;
  const branch = task.worktree?.branch || `orch/${run.id}/${task.id}`;
  const into = run.baseBranch;
  const query = (...args) => spawnSync("git", ["-C", run.repo, ...args], { encoding: "utf8" });
  const ref = query("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  if (ref.status !== 0) return null;
  const commit = ref.stdout.trim();
  // A later attempt can add commits after an earlier integration receipt. Only that receipt
  // containing the current tip proves this branch has already been recorded.
  if (task.integratedAt && task.integratedCommit && query("merge-base", "--is-ancestor", commit, task.integratedCommit).status === 0) return null;
  const from = task.worktree?.from || run.baseCommit;
  if (!from || query("merge-base", "--is-ancestor", commit, from).status === 0) return null;
  if (query("merge-base", "--is-ancestor", commit, `refs/heads/${into}`).status !== 0) return null;
  return { branch, into, commit };
}
