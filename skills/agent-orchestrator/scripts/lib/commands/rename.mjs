// `rename`: give a task a name that people and agents see and use in place of its id, and the
// lookup that lets every command that takes a task take that name.
//
// The id stays the stable key of everything the task has (its folder, its relay's --out-dir,
// AGENT_ORCH_TASK in its shell, its inbox, worktree, branch, nested runs and park watcher), so a
// rename restarts nothing and moves nothing: it works on a running, parked, finished or closed task.
// The task records every name it was given, with when and by whom (`names`); renaming to its own id
// removes the name. Only the run's owner, or the task's own agent, renames a task.

import { TASK_ID } from "../config.mjs";
import { actorLabel, actorOf, callerIdentity, guard, recordChange, runNamed } from "../ownership.mjs";
import { readPlan } from "../plan.mjs";
import { earlierNames, loadRun, loadTask, saveTask, taskIdOf, taskNamed, validTask } from "../runs.mjs";
import { die, emit } from "../util.mjs";

// Where each command reads a task: the positions in its arguments (an index, or "rest" for every
// one after the run) and the options that name a task. orch.mjs turns a name in any of them into
// its task's id before the command runs, so commands, their ownership checks and their messages all
// work on ids.
export const TASK_ARGS = {
  worktree: [1], brief: [1], start: [1], result: [1], log: [1], stop: [1], close: ["rest"], wait: ["rest"],
  verify: [1], verdict: [1, "reviewer"], review: [1], rework: [1, "from"], accept: [1], resolve: [1], integrate: [1],
  send: [1], steer: [1], inbox: [1], reply: [1], rename: [1],
};

// Replace each task name in `args` with its task's id, for the run its first argument names. An id
// always wins, and anything that names no task is left for the command to report.
export function resolveTaskNames(command, args) {
  const places = TASK_ARGS[command];
  if (!places || !args._[0]) return args;
  const run = runNamed(args._[0]);
  if (!run) return args;
  const idOf = (ref) => taskIdOf(run, ref);
  for (const place of places) {
    if (place === "rest") args._ = [args._[0], ...args._.slice(1).map(idOf)];
    else if (typeof place === "number") {
      if (args._[place] !== undefined) args._[place] = idOf(args._[place]);
    } else if (typeof args[place] === "string" && args[place] !== "coordinator") args[place] = idOf(args[place]);
  }
  return args;
}

// Whether this command runs in the task's own agent's shell.
function ownTask(run, id) {
  const caller = callerIdentity();
  return caller.kind === "task" && caller.record.parentRun === run.id && caller.record.parentTask === id;
}

// Why `name` cannot be this task's name in `run`, or null when it can.
function nameProblem(run, id, name) {
  if (!TASK_ID.test(name)) return `a name must be a valid task id, matching ${TASK_ID} (lowercase, digits, . _ -), and "${name}" does not`;
  if (name === id) return null;
  if (loadTask(run, name)) return `task ${name} of run ${run.id} has that id; an id always wins over a name, so choose another name`;
  const holder = taskNamed(run, name);
  if (holder && holder.id !== id) return `task ${holder.id} of run ${run.id} is already named ${name}`;
  // A planned task gets its plan id as its task id when it starts, and that id would win over the name.
  if (readPlan(run.dir)?.tasks.some((t) => t.id === name)) return `the plan of run ${run.id} has a task ${name}, which will take that id when it starts`;
  return null;
}

export function cmdRename(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const to = args.to === undefined ? die("--to NAME is required: the task's new name, or its own id to remove its name", 2) : String(args.to).trim();
  if (!to) die("--to needs a name: the task's new name, or its own id to remove its name", 2);
  if (args._.length > 2) die(`rename takes one task: rename RUN TASK --to NAME (got ${args._.slice(1).join(" ")})`, 2);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  // Only the run's owner renames a task (as for `close`), and a task's own agent may rename itself.
  const self = ownTask(run, id);
  const g = self ? { actor: actorOf(callerIdentity()), owned: true } : guard(run, `rename task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  const problem = nameProblem(run, id, to);
  if (problem) die(`cannot rename task ${id}: ${problem}`, 2);
  const current = task.name || null;
  const name = to === id ? null : to;
  const shown = (n) => n || id;
  if (name === current) {
    const text = name ? `task ${id} of run ${run.id} is already named ${name}; nothing changed` : `task ${id} of run ${run.id} has no name; nothing changed`;
    emit(args, { run: run.id, id, name: current, previous: current, changed: false, names: task.names || [] }, text);
    return;
  }
  // The latest record, so that a field saved since this command read the task is kept.
  const latest = loadTask(run, id) || task;
  const names = [...(Array.isArray(latest.names) ? latest.names : []), { name, at: new Date().toISOString(), by: g.actor }];
  const saved = { ...latest, name, names };
  saveTask(run, saved);
  if (!self) recordChange(run, g, { task: id, attempt: task.attempt || null, action: "renamed" });
  const earlier = earlierNames(saved);
  const text = [
    name ? `renamed ${shown(current)} → ${name} (task ${id} of run ${run.id})` : `removed the name ${current} of task ${id} of run ${run.id}; it shows as ${id} again`,
    `  by ${actorLabel(g.actor)}${earlier.length ? `; earlier names: ${earlier.join(", ")}` : ""}`,
    `  its id stays ${id}: its folder, inbox, worktree, branch, nested runs and AGENT_ORCH_TASK keep it, and every command takes either`,
  ].join("\n");
  emit(args, { run: run.id, id, name, previous: current, changed: true, names }, text);
}
