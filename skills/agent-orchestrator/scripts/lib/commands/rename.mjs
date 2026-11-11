// `rename`: give a task a name that people and agents see and use in place of its id, and the
// lookup that lets every command that takes a task take that name.
//
// The id stays the stable key of everything the task has (its folder, its relay's --out-dir,
// AGENT_ORCH_TASK in its shell, its inbox, worktree, branch, nested runs and park watcher), so a
// rename restarts nothing and moves nothing: it works on a running, parked, finished or closed task.
// The task records every name it was given, with when and by whom (`names`); renaming to its own id
// removes the name. Only the run's owner, or the task's own agent, renames a task; a rename by
// anyone else, the task's own agent included, leaves the run's owner a notice (ownership.mjs).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TASK_ID } from "../config.mjs";
import { actorLabel, actorOf, callerIdentity, guard, ownershipOf, recordChange, runNamed } from "../ownership.mjs";
import { readPlan } from "../plan.mjs";
import { earlierNames, exists, loadRun, loadTask, processStarted, saveTask, taskIdOf, taskNamed, validTask } from "../runs.mjs";
import { die, emit, readJson } from "../util.mjs";

// Where each command reads a task: the positions in its arguments (an index, or "rest" for every
// one after the run), and the options that name a task ({ option }, with `except` for a word the
// option takes that is no task: `verdict --reviewer coordinator`). orch.mjs turns a name in any of
// them into its task's id before the command runs, so commands, their ownership checks and their
// messages all work on ids.
export const TASK_ARGS = {
  worktree: [1], brief: [1], start: [1], result: [1], log: [1], stop: [1], close: ["rest"], wait: ["rest"],
  verify: [1], verdict: [1, { option: "reviewer", except: "coordinator" }], review: [1], rework: [1, { option: "from" }],
  accept: [1], resolve: [1], integrate: [1], send: [1], steer: [1], inbox: [1], reply: [1], rename: [1],
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
    } else if (typeof args[place.option] === "string" && args[place.option] !== place.except) args[place.option] = idOf(args[place.option]);
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

// The run's rename lock: one rename at a time checks that a name is free and saves it, so two
// renames of different tasks to one name cannot both pass the check. The lock file is created
// whole and exclusively (a temporary file linked to its name), and names its holder by PID and
// start time. A live holder is never evicted, however old its lock: a waiter waits LOCK_WAIT_MS
// and then refuses. A lock whose holder has exited is removed only by the waiter that holds the
// reclaim lock (created exclusively, for the moment the removal takes), and only if the lock is
// still the dead holder's when that waiter reads it again: two waiters can then never both remove
// a lock, and none removes a live one. After a removal every waiter competes for the lock afresh.
// A reclaim lock left by a process that died while holding it is not taken over: renames of the
// run refuse and name the file to remove, which fails closed.
const LOCK_FILE = "rename.lock";
const RECLAIM_FILE = "rename.lock.reclaim";
const LOCK_WAIT_MS = 10_000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Whether the process a lock names still runs: the same PID with the same start time. A lock
// written before start times were recorded is judged by its PID alone.
const holderAlive = (holder) => Boolean(holder?.pid) && exists(holder.pid) && (!holder.started || processStarted(holder.pid) === holder.started);

function lockRenames(run) {
  const file = path.join(run.dir, LOCK_FILE);
  const reclaim = path.join(run.dir, RECLAIM_FILE);
  const me = { pid: process.pid, started: processStarted(process.pid), at: new Date().toISOString(), id: randomUUID() };
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const tmp = `${file}.${process.pid}.${me.id.slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(me)}\n`);
    try {
      fs.linkSync(tmp, file);
      return () => {
        if (readJson(file)?.id === me.id) fs.rmSync(file, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const holder = readJson(file);
    if (holder && !holderAlive(holder)) {
      let mine = false;
      try {
        fs.writeFileSync(reclaim, `${JSON.stringify(me)}\n`, { flag: "wx" });
        mine = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const other = readJson(reclaim);
        if (other && !holderAlive(other)) die(`a rename in run ${run.id} died while clearing a stale lock; nothing changed. Remove ${reclaim} and try again`, 1);
      }
      if (mine) {
        try {
          // Still the dead holder's lock, read again now that no other waiter can remove it.
          if (readJson(file)?.id === holder.id) fs.rmSync(file, { force: true });
        } finally {
          fs.rmSync(reclaim, { force: true });
        }
        continue;
      }
    }
    if (Date.now() >= until) die(`another rename in run ${run.id} holds ${file}${holder?.pid ? ` (pid ${holder.pid})` : ""}; nothing changed, so try again`, 1);
    pause(20);
  }
}

export function cmdRename(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const to = args.to === undefined ? die("--to NAME is required: the task's new name, or its own id to remove its name", 2) : String(args.to).trim();
  if (!to) die("--to needs a name: the task's new name, or its own id to remove its name", 2);
  if (args._.length > 2) die(`rename takes one task: rename RUN TASK --to NAME (got ${args._.slice(1).join(" ")})`, 2);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  // Only the run's owner renames a task (as for `close`), and a task's own agent may rename itself.
  // That agent is not the run's owner, so its rename leaves the owner a notice, as one by the user does.
  const self = ownTask(run, id);
  const own = self ? ownershipOf(run) : null;
  const g = self ? { actor: actorOf(callerIdentity()), owned: own.mine, own, adopted: false } : guard(run, `rename task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  const release = lockRenames(run);
  let current, name, saved;
  try {
    const problem = nameProblem(run, id, to);
    if (problem) {
      release(); // die() exits at once, without running `finally`
      die(`cannot rename task ${id}: ${problem}`, 2);
    }
    // The latest record, so that a field saved since this command read the task is kept.
    const latest = loadTask(run, id) || task;
    current = latest.name || null;
    name = to === id ? null : to;
    if (name === current) {
      const text = name ? `task ${id} of run ${run.id} is already named ${name}; nothing changed` : `task ${id} of run ${run.id} has no name; nothing changed`;
      emit(args, { run: run.id, id, name: current, previous: current, changed: false, names: latest.names || [] }, text);
      return;
    }
    saved = { ...latest, name, names: [...(Array.isArray(latest.names) ? latest.names : []), { name, at: new Date().toISOString(), by: g.actor }] };
    saveTask(run, saved);
  } finally {
    release();
  }
  recordChange(run, g, { task: id, attempt: task.attempt || null, action: "renamed" });
  const earlier = earlierNames(saved);
  const text = [
    name ? `renamed ${current || id} → ${name} (task ${id} of run ${run.id})` : `removed the name ${current} of task ${id} of run ${run.id}; it shows as ${id} again`,
    `  by ${actorLabel(g.actor)}${earlier.length ? `; earlier names: ${earlier.join(", ")}` : ""}`,
    `  its id stays ${id}: its folder, inbox, worktree, branch, nested runs and AGENT_ORCH_TASK keep it, and every command takes either`,
  ].join("\n");
  emit(args, { run: run.id, id, name, previous: current, changed: true, names: saved.names }, text);
}
