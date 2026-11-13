import { collectWorktrees, collectionText } from "../worktree-gc.mjs";
// `plan`, `dispatch`, `accept`, `integrate`, and `recover`: record the run's plan, start its tasks as
// their prerequisites land, mark reviewed results accepted, merge them, and rebuild the picture
// after the orchestrator restarts.

import { reclaimTask } from "../reclaim.mjs";
import { spawn, spawnSync } from "node:child_process";
import { computeEvidence, evidenceWarning } from "../report.mjs";
import fs from "node:fs";
import path from "node:path";
import { CACHE_PATH, CLI_PATH, DEPTH, MAX_NEST_DEPTH, QUIET_AFTER_MS, parallelAt } from "../config.mjs";
import { agoText, formatElapsed, table } from "../format.mjs";
import { phaseMap, reviewRoundsOf, unlinkedVerifications, verificationsOf } from "../lifecycle.mjs";
import { briefMarkers, briefPath, briefProblem, conflictText, planPath, planProgress, readPlan, runningConflicts, manualMerge, tierProblem, validatePlan, waitsOnText } from "../plan.mjs";
import { guard, launcherLabel, ownershipOf, readOnlyMark, recordChange, touchOwner } from "../ownership.mjs";
import { describe, detectOrchestrator, listRuns, listTaskRecords, listTasks, loadRun, loadTask, saveTask, taskLastActivity, validTask } from "../runs.mjs";
import { die, emit, git, parseDuration, writeJson } from "../util.mjs";
import { retryTask } from "../retry.mjs";
import { reviveParked } from "../park.mjs";
import { taskAttention } from "../escalate.mjs";
import { inboxWake } from "../inbox.mjs";
import { admissionReason, admissionKinds, admissionSettingsError, machineStatus } from "../admission.mjs";
import { StartRefused, startTask } from "./start.mjs";

const CLI = `node ${CLI_PATH}`;
const DAY_MS = 24 * 3600000;
const short = (sha) => String(sha || "").slice(0, 12);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function gitOk(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).status === 0;
}

function isAncestor(repo, commit, of) {
  return gitOk(repo, ["merge-base", "--is-ancestor", commit, of]);
}

// Uncommitted changes in a checkout, without the tool caches that gate runs leave behind.
function uncommitted(dir, { untracked = true } = {}) {
  const r = spawnSync("git", ["-C", dir, "status", "--porcelain", ...(untracked ? [] : ["--untracked-files=no"])], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.trim() && !CACHE_PATH.test(l.slice(3)));
}

export function cmdPlan(args) {
  const run = loadRun(args._[0]);
  // --check only validates, so anyone may run it.
  const g = args.check ? null : guard(run, `replace the plan of run ${run.id}`, { adopt: args.adopt });
  if (!args._[1]) die("missing FILE: the plan as JSON", 2);
  const file = path.resolve(args._[1]);
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    die(`cannot read the plan ${file}: ${error.message}`, 2);
  }
  // A new plan replaces the old one. Started tasks keep their records, but a running task stays
  // planned, and keeps the owned paths and resources it started with until it finishes.
  const ids = new Set(Array.isArray(plan?.tasks) ? plan.tasks.map((t) => t?.id) : []);
  const rows = new Map(listTasks(run).map((r) => [r.id, r]));
  const held = new Map();
  for (const r of rows.values()) {
    const recorded = r.state === "running" && ids.has(r.id) ? loadTask(run, r.id)?.plan : null;
    if (recorded) held.set(r.id, recorded);
  }
  const { errors, conflicts } = validatePlan(plan, held);
  const problems = [...errors, ...conflicts.map(conflictText)];
  const dropped = (readPlan(run.dir)?.tasks || []).map((t) => t.id).filter((id) => !ids.has(id));
  for (const id of dropped) {
    if (rows.get(id)?.state === "running") problems.push(`task ${id} is running, and the new plan drops it: keep it in the plan, or stop it first (${CLI} stop ${run.id} ${id})`);
  }
  if (problems.length) die(`the plan has ${plural(problems.length, "problem")}:\n  - ${problems.join("\n  - ")}`);

  if (!args.check) {
    writeJson(planPath(run.dir), plan);
    recordChange(run, g, { action: "plan replaced" });
  }
  const kept = dropped.filter((id) => rows.has(id)).map((id) => `${id} (${rows.get(id).state})`);
  // Briefs may be written after the plan is recorded (`brief` drafts them from it); `dispatch`
  // starts a task only once its brief is ready.
  const pending = plan.tasks
    .filter((t) => !rows.has(t.id) || rows.get(t.id).state === "prepared")
    .map((t) => ({ id: t.id, brief: briefPath(run.dir, t.brief), problem: briefProblem(run.dir, t) }))
    .filter((p) => p.problem);
  const listed = plan.tasks.map((t) => ({
    id: t.id,
    agent: `${t.agent}${t.tier ? ` ${t.tier}` : ""}`,
    mode: t.readOnly ? "read-only" : t.type === "babysit" ? "babysit" : "write",
    after: (t.dependsOn || []).join(", ") || "-",
  }));
  const readOnly = plan.tasks.filter((t) => t.readOnly).length;
  emit(
    args,
    { run: run.id, recorded: !args.check, path: args.check ? null : planPath(run.dir), tasks: plan.tasks.length, dropped: kept, pendingBriefs: pending },
    [
      `plan for ${run.id}: ${plural(plan.tasks.length, "task")}${readOnly ? ` (${readOnly} read-only)` : ""}, no conflicts`,
      `goal: ${plan.goal}`,
      table(listed, ["id", "agent", "mode", "after"]),
      args.check ? "checked only (--check): nothing recorded" : `recorded ${planPath(run.dir)}`,
      kept.length ? `dropped from the previous plan, records kept: ${kept.join(", ")}` : null,
      pending.length
        ? `briefs not ready (dispatch starts these tasks once they are): ${pending.map((p) => `${p.id} (${p.problem})`).join(", ")}; draft one with: ${CLI} brief ${run.id} <task>`
        : null,
      args.check ? null : `next: ${CLI} dispatch ${run.id} --dry-run`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// Where a write task's worktree starts. A task without prerequisites starts from the run's base
// commit; one with prerequisites from a recorded integration branch containing all their work.
function startPoint(run, entry) {
  if (!(entry.dependsOn || []).length) return { sha: run.baseCommit, label: `the run's base commit ${short(run.baseCommit)}` };
  const dependencies = entry.dependsOn.map((id) => loadTask(run, id));
  const targets = [...new Set(dependencies.map((task) => task?.integratedInto).filter(Boolean))];
  // Several targets are allowed only when one contains all prerequisite commits.
  const branches = [...new Set([...targets, run.baseBranch].filter(Boolean))];
  for (const branch of branches) {
    const head = git(run.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true });
    if (head && dependencies.every((task) => !task?.integratedCommit || isAncestor(run.repo, task.integratedCommit, head))) {
      return { sha: head, label: `${branch} @ ${short(head)}` };
    }
  }
  throw new StartRefused(`${entry.id} needs its prerequisites' integrated commits on one branch; none of ${branches.join(", ") || "the recorded branches"} contains them all; merge their integration branches together, then dispatch again`);
}

// The prerequisites whose integrated commit the checkout at `cd` does not contain.
function lackingWork(run, entry, cd) {
  const head = git(cd, ["rev-parse", "HEAD"], { allowFail: true });
  return (entry.dependsOn || [])
    .map((dep) => ({ dep, commit: loadTask(run, dep)?.integratedCommit }))
    .filter((d) => d.commit && !(head && isAncestor(cd, d.commit, head)));
}

function checkoutLabel(dir) {
  const branch = git(dir, ["branch", "--show-current"], { allowFail: true });
  return `${branch ? `branch ${branch}` : "a detached HEAD"} @ ${short(git(dir, ["rev-parse", "HEAD"], { allowFail: true }))}`;
}

// The working directory a planned task starts in: the run's repository for a read-only task, else
// its worktree, created by the `worktree` command itself so that both paths prepare it the same way.
// Every prerequisite's integrated work must already be in it.
function prepare(run, entry, dryRun) {
  let how;
  if (entry.readOnly) {
    how = { cd: run.repo, where: `read-only, in ${run.repo}` };
  } else {
    if (!run.isGit) throw new StartRefused(`the run's repository is not a git repository, so write task ${entry.id} cannot get a worktree; start it with start`);
    const record = loadTask(run, entry.id);
    const existing = record?.worktree;
    if (existing && fs.existsSync(existing.path)) {
      how = { cd: existing.path, where: `in its worktree ${existing.path} (branch ${existing.branch})`, worktree: existing };
    } else {
      if (existing) {
        // Its worktree was removed: forget it once its branch is gone too, and prepare a new one.
        if (gitOk(run.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${existing.branch}`])) {
          throw new StartRefused(`${entry.id}'s worktree ${existing.path} is gone, but its branch ${existing.branch} remains; delete the branch (git -C ${run.repo} branch -d ${existing.branch}) or restore the worktree (git -C ${run.repo} worktree add ${existing.path} ${existing.branch}), then dispatch again`);
        }
        if (!dryRun) {
          const { worktree, cd, ...rest } = record;
          saveTask(run, rest);
        }
      }
      const from = startPoint(run, entry);
      if (dryRun) return { cd: null, where: `in a new worktree from ${from.label}` };
      const r = spawnSync(process.execPath, [CLI_PATH, "worktree", run.dir, entry.id, "--from", from.sha], { encoding: "utf8" });
      if (r.status !== 0) throw new StartRefused(`worktree: ${(r.stderr || r.stdout).replace(/^orch: /, "").trim()}`);
      const wt = loadTask(run, entry.id).worktree;
      how = { cd: wt.path, where: `in worktree ${wt.path} (branch ${wt.branch}, from ${from.label})`, worktree: wt };
    }
  }
  const lacking = lackingWork(run, entry, how.cd);
  if (lacking.length) {
    const what = lacking.map((d) => `${d.dep} (integrated at ${short(d.commit)})`).join(", ");
    const fix = how.worktree
      ? `merge the base branch into it (git -C ${how.cd} merge ${run.baseBranch || "<base>"}), or remove it (git -C ${run.repo} worktree remove ${how.cd} && git -C ${run.repo} branch -d ${how.worktree.branch})`
      : `check out a branch there that contains ${lacking.length === 1 ? "it" : "them"} (git -C ${how.cd} branch --contains ${short(lacking[0].commit)})`;
    throw new StartRefused(`${entry.id} would start in ${how.cd} (${checkoutLabel(how.cd)}), which lacks the work of ${what}; ${fix}, then dispatch again`);
  }
  return how;
}

// What `start` would refuse about a planned task's brief, in its words, or null. A plan may be
// recorded before its briefs are written; a task starts only once its brief is.
function briefRefusal(run, entry) {
  const file = briefPath(run.dir, entry.brief);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  const markers = briefMarkers(text);
  const why = !text.trim() ? `brief is missing or empty: ${file}` : markers.count ? `brief contains ${plural(markers.count, "unfilled marker")}: ${markers.line}` : null;
  return why && `${why}; write it (${CLI} brief ${run.id} ${entry.id} drafts it from the plan), then dispatch again`;
}

function dispatchWave(args) {
  const run = loadRun(args._[0]);
  const dryRun = Boolean(args["dry-run"]);
  // A dry run changes nothing, so anyone may look.
  if (!dryRun) guard(run, `dispatch run ${run.id}`, { adopt: args.adopt });
  const plan = readPlan(run.dir) || die(`run ${run.id} has no plan; record one with: ${CLI} plan ${run.id} FILE`);
  const rows = listTasks(run);
  const progress = planProgress(plan, phaseMap(run, rows, plan));
  const running = rows.filter((r) => r.state === "running" && r.phase !== "parked").length; // a parked babysitter holds no agent
  const limit = parallelAt(DEPTH);
  const planned = new Set(plan.tasks.map((task) => task.id));
  const plannedRunning = rows.filter((r) => r.state === "running" && r.phase !== "parked" && planned.has(r.id)).length;
  const maxSlots = args.max === undefined ? Infinity : Number(args.max) - (args.follow ? plannedRunning : 0);
  const slots = Math.max(0, Math.min(limit - running, maxSlots));
  if (progress.ready.length && slots && !dryRun && DEPTH >= MAX_NEST_DEPTH) {
    die(`refusing to dispatch: this agent is ${DEPTH} levels below the user's session, the most allowed (AGENT_ORCH_MAX_DEPTH=${MAX_NEST_DEPTH}); do the work yourself`);
  }

  // Ready tasks fill the free slots in plan order. A refused task uses no slot: the next one gets it.
  // A brief that is not ready is refused before anything is prepared, whether or not a slot is free.
  const started = [];
  const failed = [];
  const waiting = [];
  const conflicts = [];
  const machineWaiting = [];
  const machineKinds = [];
  let projectedAgents = 0;
  const reserved = rows.filter((r) => r.state === "running" && r.phase !== "parked").map((r) => {
    const task = loadTask(run, r.id);
    const current = plan.tasks.find((t) => t.id === r.id);
    const original = task?.plan || current || { id: r.id, owns: task?.readOnly ? [] : ["."] };
    return { ...original, agent: task?.agent || original.agent, readOnly: Boolean(task?.readOnly || task?.agent === "command"), babysit: Boolean(task?.babysit),
      owns: [...new Set([...(original.owns || []), ...(current?.owns || [])])],
      resources: [...new Set([...(original.resources || []), ...(current?.resources || [])])] };
  });
  const lines = [];
  for (const entry of progress.ready) {
    try {
      // A plan recorded before tiers were required may lack one: refuse this task, not the batch.
      const noTier = tierProblem(entry);
      if (noTier) throw new StartRefused(`${noTier}; set its tier in the plan and record it again (${CLI} plan ${run.id} FILE)`);
      const unready = briefRefusal(run, entry);
      if (unready) throw new StartRefused(unready);
      if (started.length >= slots) {
        waiting.push(entry.id);
        continue;
      }
      const overlap = runningConflicts(entry, reserved.filter((t) => t.id !== entry.id));
      if (overlap.length) {
        conflicts.push({ id: entry.id, conflicts: overlap });
        lines.push(`waiting ${entry.id}: conflicts with running tasks ${overlap.map((c) => c.b).join(", ")}`);
        continue;
      }
      const machine = entry.agent === "command" ? null : machineStatus();
      if (machine && dryRun) machine.running += projectedAgents;
      const machineReason = machine && admissionReason(machine);
      if (machineReason) {
        const error = new StartRefused(machineReason, 7);
        error.admissionKinds = admissionKinds(machine);
        throw error;
      }
      const how = prepare(run, entry, dryRun);
      if (dryRun) {
        started.push({ id: entry.id, where: how.where });
        if (entry.agent !== "command") projectedAgents++;
        reserved.push(entry);
        lines.push(`would start ${entry.id} → ${entry.agent}${entry.tier ? ` (${entry.tier} tier)` : ""}, ${how.where}`);
        continue;
      }
      const { task, text } = startTask(
        {
          _: [run.dir, entry.id],
          agent: entry.agent,
          ...(entry.tier ? { tier: entry.tier } : {}),
          why: entry.why,
          brief: briefPath(run.dir, entry.brief),
          cd: how.cd,
          "read-only": Boolean(entry.readOnly),
          passthrough: [],
        },
        { plan: entry },
      );
      started.push({ id: entry.id, pid: task.pid, cd: task.cd, branch: task.worktree?.branch || null });
      reserved.push(entry);
      lines.push(text.split("\n").filter((l) => !l.startsWith("next:")).join("\n"));
    } catch (error) {
      if (!(error instanceof StartRefused)) throw error;
      if (error.code === 7) {
        machineWaiting.push({ id: entry.id, reason: error.message });
        machineKinds.push([entry.id, error.admissionKinds || admissionKinds(machineStatus())]);
        lines.push(`ready, waiting ${entry.id}: ${error.message}`);
        continue;
      }
      failed.push({ id: entry.id, error: error.message });
      lines.push(`could not start ${entry.id}: ${error.message}`);
    }
  }
  if (waiting.length) {
    const cap = args.max !== undefined && Number(args.max) < limit - running ? `--max ${args.max}` : `${running} running, limit ${limit}`;
    lines.push(`ready, waiting for a free slot (${cap}): ${waiting.join(", ")}`);
  }
  for (const b of progress.blocked) lines.push(`blocked ${b.task.id}: waits on ${waitsOnText(b.waitsOn)}`);
  for (const t of progress.manual) {
    lines.push(`start by hand: ${t.id} babysits a pull request, which needs its number: ${CLI} start ${run.id} ${t.id} --agent claude --babysit --pr <n> --why "..." --brief ${briefPath(run.dir, t.brief)}`);
  }
  if (!lines.length) lines.push(`nothing to dispatch: all ${plural(plan.tasks.length, "planned task")} have started`);
  if (started.length && !dryRun) lines.push(`next: ${CLI} wait ${run.id}`);
  return {
    machineKinds,
    data: {
      run: run.id, dryRun, limit, running,
      [dryRun ? "wouldStart" : "started"]: started,
      failed, waitingForSlot: waiting, waitingForConflict: conflicts, waitingForMachine: machineWaiting,
      blocked: progress.blocked.map((b) => ({ id: b.task.id, waitsOn: b.waitsOn })),
      manual: progress.manual.map((t) => t.id),
    },
    text: lines.join("\n"),
  };
}

export async function cmdDispatch(args) {
  // Before anything revives a watcher, retries a task or writes state: a bad --max changes nothing.
  if (args.max !== undefined && !/^\d+$/.test(args.max)) die(`--max needs a whole number, not "${args.max}"`, 2);
  const badSetting = admissionSettingsError();
  if (badSetting) die(badSetting, 2);
  const follow = Boolean(args.follow && !args["dry-run"]);
  // With --follow, --timeout bounds the stay, as for `wait`: 0 or none stays until something needs
  // the orchestrator; past it, the command exits 3 and is safe to run again.
  if (args.timeout !== undefined && !args.follow) die("--timeout applies to dispatch --follow only", 2);
  const limit = parseDuration(args.timeout) || 0;
  const until = follow && limit ? Date.now() + limit : null;
  const wake = follow ? inboxWake() : null;
  const started = [];
  const run = loadRun(args._[0]);
  const snapshot = () => {
    let rows = listTasks(run);
    if (reviveParked(run, rows).length) rows = listTasks(run);
    return rows.some((r) => r.state === "aborted" && !r.result && r.health === "ok") ? listTasks(run) : rows;
  };
  const maintain = () => {
    let rows = snapshot();
    let changed = false;
    const planned = new Set((readPlan(run.dir)?.tasks || []).map((task) => task.id));
    let running = rows.filter((row) => planned.has(row.id) && row.state === "running" && row.phase !== "parked").length;
    for (const row of rows) {
      // A resumed planned task occupies the same slot as a newly dispatched one.
      if (planned.has(row.id) && args.max !== undefined && running >= Number(args.max)) continue;
      const retried = retryTask(run, row);
      if (retried) {
        (args.json ? process.stderr : process.stdout).write(`${retried}\n`);
        changed = true;
        if (planned.has(row.id)) running++;
      }
    }
    return changed ? snapshot() : rows;
  };
  const needing = (plan, rows) => {
    const planned = new Set(plan.tasks.map((task) => task.id));
    return rows.flatMap((row) => {
      if (!planned.has(row.id) && loadTask(run, row.id)?.closedAt) return [];
      if (row.phase === "integrated" || row.phase === "prepared") return [];
      const phase = ["awaiting-review", "accepted", "needs-decision", "failed"].includes(row.phase) ? row.phase : null;
      const item = taskAttention(row, false);
      return phase || item ? [{ id: row.id, attempt: row.attempt, phase: phase || item.kind, reason: item?.reason || phase,
        next: `${CLI} ${phase === "accepted" ? "integrate" : "result"} ${run.id} ${row.id}` }] : [];
    });
  };
  const attentionKey = (item) => JSON.stringify([item.id, item.attempt, item.phase]);
  let previous;
  let machineNotice = null;
  if (follow) {
    guard(run, `dispatch run ${run.id}`, { adopt: args.adopt });
    const plan = readPlan(run.dir) || die(`run ${run.id} has no plan; record one with: ${CLI} plan ${run.id} FILE`);
    previous = new Set(needing(plan, snapshot()).map(attentionKey));
  }
  for (;;) {
    if (follow) {
      guard(loadRun(run.dir), `dispatch run ${run.id}`, { adopt: args.adopt });
      maintain();
    }
    const wave = dispatchWave(args);
    if (!follow) {
      emit(args, wave.data, wave.text);
      if (wave.data.failed.length) process.exitCode = 1;
      return;
    }
    const notice = JSON.stringify(wave.machineKinds);
    if (wave.data.waitingForMachine.length && notice !== machineNotice && !args.json && !wave.data.started.length) process.stdout.write(`${wave.text}\n`);
    machineNotice = notice;
    started.push(...wave.data.started);
    if (wave.data.started.length && !args.json) process.stdout.write(`${wave.text}\n`);
    const plan = readPlan(run.dir);
    const rows = maintain();
    const phases = phaseMap(run, rows, plan);
    const complete = plan.tasks.every((t) => phases.get(t.id) === "integrated");
    const attention = needing(plan, rows);
    const newAttention = attention.some((item) => !previous.has(attentionKey(item)));
    previous = new Set(attention.map(attentionKey));
    const message = wake.check((m) => m.kind === "finished" && m.about?.run === run.id);
    const active = rows.some((row) => row.state === "running" && row.phase !== "parked");
    if (complete || newAttention || message || wave.data.failed.length || (!active && !wave.data.waitingForMachine.length)) {
      const reason = complete ? "complete" : message ? "message" : attention.length ? "attention" : wave.data.failed.length ? "failed" : "blocked";
      const text = [wave.data.started.length ? null : wave.text,
        complete ? "plan complete: every task is integrated" : `dispatch stopped: ${reason}`,
        ...attention.map((a) => `${a.id}: ${a.phase}; next: ${a.next}`),
        message ? `new message: ${message.text || message.id}; read your inbox` : null,
      ].filter(Boolean).join("\n");
      emit(args, { ...wave.data, started, follow: true, reason, complete, attention, ...(message ? { message } : {}) }, text);
      if (wave.data.failed.length || attention.some((a) => a.phase === "failed")) process.exitCode = 1;
      return;
    }
    if (until && Date.now() >= until) {
      const text = [wave.data.started.length ? null : wave.text, `dispatch timed out: tasks are still running; run it again to keep following`,
        ...attention.map((a) => `${a.id}: ${a.phase}; next: ${a.next}`)].filter(Boolean).join("\n");
      emit(args, { ...wave.data, started, follow: true, reason: "timeout", complete: false, attention }, text);
      process.exitCode = 3;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export function cmdResolve(args) {
  const note = String(args.note || "").trim();
  if (!note || /[\r\n]/.test(note)) die("--note is required: one line saying how the decision was handled", 2);
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const g = guard(run, `resolve task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  const row = describe(run, task);
  if (row.state !== "needs-decision") die(`task ${id} is ${row.state}, not needs-decision`, 2);
  const resolved = {
    ...task,
    decisionResolvedAt: new Date().toISOString(),
    decisionResolvedAttempt: row.attempt,
    decisionNote: note,
    resolvedBy: g.actor,
  };
  saveTask(run, resolved);
  recordChange(run, g, { task: id, attempt: row.attempt, action: "marked resolved" });
  emit(args, {
    id, decisionResolvedAt: resolved.decisionResolvedAt,
    decisionResolvedAttempt: resolved.decisionResolvedAttempt, decisionNote: note,
  }, `resolved ${id} (attempt ${row.attempt}): ${note}\nnext: review its result, then ${CLI} accept ${run.id} ${id}`);
}

export function cmdAccept(args) {
  computeEvidence();
  const acceptNote = args.note === undefined ? null : String(args.note).trim() || die("--note needs text: why the result is accepted", 2);
  const unverifiedReason = args.unverified === undefined ? null : String(args.unverified).trim() || die("--unverified needs a nonblank reason", 2);
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const g = guard(run, `accept task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  const row = describe(run, task);
  if (row.state !== "completed") {
    const why = {
      prepared: "it has not started",
      closed: "it has not started",
      running: "it is still running",
      "needs-decision": "it handed back a decision: answer it and resume the task",
    }[row.state];
    die(`task ${id} is ${row.state}, not completed${why ? `: ${why}` : ": resume it, or give it to the other agent"}; only a completed task can be accepted`);
  }
  const checks = row.report?.checks || [];
  const passing = checks.filter((check) => check?.result === "pass");
  const warnings = checks.map(evidenceWarning).filter(Boolean);
  if (row.report?.invalid) warnings.unshift(`invalid orch-result report: ${row.report.error}`);
  else if (row.report && !passing.length) warnings.unshift("report has no passing checks");
  const failed = passing.some(({ evidence }) => evidence?.ran && evidence.exitCode != null && evidence.exitCode !== 0);
  if (!task.readOnly && failed && !unverifiedReason) {
    die(`cannot accept ${id}: a passing check matched a failed run.${warnings.length ? `\n  ${warnings.join("\n  ")}` : ""}\nUse --unverified <reason> to accept anyway.`);
  }
  if (warnings.length) process.stderr.write(`${warnings.map((warning) => `WARNING: ${warning}`).join("\n")}\n`);
  const cwd = row.cd || run.repo;
  const inGit = fs.existsSync(cwd) && gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]);
  // The orchestrator commits a write task's work after reviewing it, so nothing may be left over.
  // A read-only task changed nothing: whatever its checkout holds is not its work.
  if (!task.readOnly) {
    if (!fs.existsSync(cwd)) die(`task ${id}'s working directory is gone: ${cwd}`);
    const dirty = inGit ? uncommitted(cwd) : [];
    if (dirty.length) die(`task ${id} has uncommitted changes in ${cwd}; review them and commit them on the task's branch, then accept:\n  ${dirty.join("\n  ")}`);
  }
  let commit = null;
  if (args.commit) {
    if (!inGit) die(`--commit needs a git checkout, and ${cwd} is not one`, 2);
    commit = git(cwd, ["rev-parse", "--verify", "--quiet", `${args.commit}^{commit}`], { allowFail: true }) || die(`no commit ${args.commit} in ${cwd}`, 2);
  } else if (inGit) {
    commit = git(cwd, ["rev-parse", "HEAD"]);
  }
  const attempt = task.attempt || 0;
  // The receipts behind the acceptance: the verifications since the last review round, and
  // whether this attempt's latest round found it clean.
  const rounds = reviewRoundsOf(run, id);
  const acceptVerifications = unlinkedVerifications(verificationsOf(run, id), rounds);
  const cleanVerdict = rounds.filter((r) => r.attempt === attempt).at(-1)?.verdict === "clean";
  const accepted = {
    ...task, acceptedAt: new Date().toISOString(), acceptedAttempt: attempt, acceptedCommit: commit,
    acceptedBy: "coordinator", acceptedActor: g.actor, acceptNote, acceptVerifications, unverifiedReason,
    // Accepting overrides an earlier `reject` of this attempt; reviews.jsonl keeps that round.
    ...(task.rejectedAt ? { rejectedAt: null, rejectedAttempt: null } : {}),
  };
  // A different commit, attempt or restored folder needs integration confirmed again.
  if (task.integratedAt && (task.acceptedCommit !== commit || task.acceptedAttempt !== attempt || Date.parse(task.worktree?.restoredAt) > Date.parse(task.integratedAt))) Object.assign(accepted, { integratedAt: null, integratedCommit: null });
  saveTask(run, accepted);
  recordChange(run, g, { task: id, attempt, action: "accepted" });
  reclaimTask(run, task);
  const empty = !task.readOnly && task.worktree && commit === git(cwd, ["rev-parse", `${task.worktree.from}^{commit}`], { allowFail: true });
  emit(
    args,
    { id, acceptedAt: accepted.acceptedAt, acceptedAttempt: attempt, acceptedCommit: commit, acceptedBy: "coordinator", acceptNote, acceptVerifications, cleanVerdict, unverifiedReason },
    `accepted ${id}${commit ? ` at ${short(commit)}` : ""} (attempt ${attempt})${empty ? `\nnote: ${task.worktree.branch} has no commits beyond where it started, so integrating it changes nothing` : ""}` +
      `${cleanVerdict ? "" : `\nnote: no clean verdict is recorded for attempt ${attempt} (${CLI} verdict ${run.id} ${id} clean records one)`}\nnext: ${CLI} integrate ${run.id} ${id}`,
  );
}

// The branch that holds a task's commits: its worktree's branch, or the branch `worktree` named for
// it once `cleanup` removed the worktree. Null when the task ran in a checkout without its own branch.
function taskBranch(run, task) {
  if (task.worktree?.branch) return task.worktree.branch;
  if (task.removedWorktree?.branch) return task.removedWorktree.branch;
  const own = `orch/${run.id}/${task.id}`;
  return gitOk(run.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${own}`]) ? own : null;
}

function mergeGoal(run, task) {
  const entry = readPlan(run.dir)?.tasks.find((t) => t.id === task.id) || task.plan;
  return String(entry?.goal || task.title || "").replace(/\s+/g, " ").trim();
}

export async function cmdIntegrate(args) {
  const run = loadRun(args._[0]);
  const id = validTask(args._[1]);
  const task = loadTask(run, id) || die(`no task ${id} in run ${run.id}`);
  const dryRun = Boolean(args["dry-run"]);
  // A dry run changes nothing, so anyone may look.
  const g = dryRun ? null : guard(run, `integrate task ${id} of run ${run.id}`, { adopt: args.adopt, refused: [id] });
  const row = describe(run, task);
  if (row.phase === "integrated") {
    if (!dryRun) reclaimTask(run, task);
    const text = task.integratedAt
      ? `task ${id} is already integrated (${short(task.integratedCommit)})`
      : `task ${id} is read-only and its result was collected, so it already counts as integrated`;
    const cleanup = dryRun ? null : await collectWorktrees(run, { tasks: [id], actor: g.actor });
    emit(args, { id, integrated: true, integratedCommit: task.integratedCommit || null, cleanup }, text + (cleanup ? `\n${collectionText(cleanup)}` : ''));
    return;
  }
  if (row.phase !== "accepted") die(`task ${id} is ${row.phase}, not accepted: review its result, commit its work on its branch, then run: ${CLI} accept ${run.id} ${id}`);
  const plan = readPlan(run.dir);
  const entry = plan?.tasks.find((t) => t.id === id) || task.plan;
  const phases = phaseMap(run, listTasks(run), plan);
  const waiting = (entry?.dependsOn || []).filter((dep) => phases.get(dep) !== "integrated");
  if (waiting.length) die(`cannot integrate ${id}: waits on ${waiting.join(", ")} (not integrated)`);
  if (!run.isGit) die("the run's repository is not a git repository");
  const target = args.into || run.baseBranch || die("the run started on a detached HEAD, so it has no base branch; pass --into BRANCH", 2);
  const targetHead = git(run.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}`], { allowFail: true }) || die(`no branch ${target} in ${run.repo}`, 2);
  const record = async (commit, text) => {
    if (!dryRun) {
      saveTask(run, { ...task, integratedAt: new Date().toISOString(), integratedCommit: commit, integratedInto: target, integratedBy: g.actor });
      recordChange(run, g, { task: id, attempt: task.attempt || null, action: "integrated" });
      reclaimTask(run, task);
    }
    const cleanup = dryRun ? null : await collectWorktrees(run, { tasks: [id], actor: g.actor });
    const ready = dryRun ? [] : readyAfter(run, id);
    emit(
      args,
      { id, dryRun, into: target, integratedCommit: commit, ready, cleanup },
      `${text}${cleanup ? `\n${collectionText(cleanup)}` : ""}${ready.length ? `\nready to dispatch now: ${ready.join(", ")}\nnext: ${CLI} dispatch ${run.id}` : ""}`,
    );
  };

  const branch = taskBranch(run, task);
  if (!branch) {
    // It ran in a checkout without its own branch, normally the run's repository: its accepted
    // commit is integrated once the target holds it.
    if (!task.readOnly && task.acceptedCommit && !isAncestor(run.repo, task.acceptedCommit, targetHead)) {
      die(`${id} has no branch of its own, and its accepted commit ${short(task.acceptedCommit)} is not on ${target}; merge it into ${target}, then integrate again`);
    }
    return record(targetHead, `${dryRun ? "would record" : "recorded"} ${id} as integrated at ${target} @ ${short(targetHead)} (it ran without a branch of its own)`);
  }

  const tip = git(run.repo, ["rev-parse", `refs/heads/${branch}`]);
  if (task.acceptedCommit && tip !== task.acceptedCommit) {
    die(`${branch} is at ${short(tip)}, but ${id} was accepted at ${short(task.acceptedCommit)}: review the newer commits, then run: ${CLI} accept ${run.id} ${id}`);
  }
  if (args["already-merged"]) {
    if (!isAncestor(run.repo, tip, targetHead)) die(`${target} does not contain ${branch}; --already-merged records only commits already reachable from the target`);
    return record(targetHead, `${target} already contains ${branch}; ${dryRun ? "would record" : "recorded"} ${id} as integrated at ${short(targetHead)}`);
  }
  // The merge happens in the user's checkout, so it must be on the target and hold no uncommitted
  // work. Never switch, stash, or reset it on the user's behalf.
  const current = git(run.repo, ["branch", "--show-current"], { allowFail: true }) || null;
  const blockers = [];
  // Refusing to start during another operation makes any merge left in progress later this
  // invocation's own: the only kind it may undo.
  const busy = operationInProgress(run.repo);
  if (busy) blockers.push(`${busy} is in progress in ${run.repo}; finish or abort it yourself (git -C ${run.repo} status says how)`);
  if (current !== target) blockers.push(`${run.repo} has ${current ? `branch ${current}` : "a detached HEAD"} checked out, not ${target}; check out ${target} there yourself`);
  const dirty = uncommitted(run.repo, { untracked: false });
  if (dirty.length) blockers.push(`${run.repo} has uncommitted changes; commit them or set them aside yourself:\n  ${dirty.join("\n  ")}`);
  if (blockers.length && !dryRun) die(`cannot integrate ${id} yet:\n- ${blockers.join("\n- ")}`);
  const notes = blockers.map((b) => `\nnote: ${b}`).join("");

  if (isAncestor(run.repo, tip, targetHead)) return record(targetHead, `${target} already contains ${branch}; ${dryRun ? "would record" : "recorded"} ${id} as integrated at ${short(targetHead)}${notes}`);

  const check = spawnSync("git", ["-C", run.repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", target, branch], { encoding: "utf8" });
  if (check.status === 1) {
    const files = check.stdout.split("\n").slice(1).filter(Boolean);
    const where = task.worktree?.path || task.cd;
    emit(
      args,
      { id, dryRun, into: target, conflicts: files },
      [
        `merging ${branch} into ${target} would conflict in ${plural(files.length, "file")}:`,
        ...files.map((f) => `  ${f}`),
        "Nothing was changed. To resolve:",
        `  1. in ${where}: git merge ${target}, resolve the conflicts, and commit (or resume the task's agent to do it)`,
        `  2. ${CLI} accept ${run.id} ${id}`,
        `  3. ${CLI} integrate ${run.id} ${id}`,
      ].join("\n") + notes,
    );
    process.exit(1);
  }
  if (check.status !== 0) die(`git merge-tree failed in ${run.repo} (the conflict check needs git 2.38 or later): ${(check.stderr || "").trim()}`);
  // git's merge silently replaces ignored files, such as a local .env, with the branch's version.
  const clobbered = untrackedInTheWay(run.repo, targetHead, check.stdout.split("\n")[0].trim());
  const overwrite = clobbered.length
    ? `merging ${branch} would overwrite ${plural(clobbered.length, "file")} in ${run.repo} that git does not track (ignored or untracked): ${clobbered.join(", ")}; move ${clobbered.length === 1 ? "it" : "them"} aside yourself, then integrate again`
    : null;
  if (dryRun) {
    emit(args, { id, dryRun, into: target, conflicts: [], overwrites: clobbered }, `${branch} merges cleanly into ${target}; nothing was changed${notes}${overwrite ? `\nnote: ${overwrite}` : ""}`);
    return;
  }
  if (overwrite) die(`cannot integrate ${id}: ${overwrite}`);

  // The options are explicit so that the user's merge settings (branch.<name>.mergeOptions,
  // merge.autoStash, ...) cannot leave the merge uncommitted or squashed, or stash their work.
  // --no-overwrite-ignore guards fast-forwards only, in git 2.47, hence the check above.
  const goal = mergeGoal(run, task);
  const merge = spawnSync(
    "git",
    ["-C", run.repo, "merge", "--no-ff", "--no-squash", "--commit", "--no-autostash", "--no-overwrite-ignore", "-m", `Merge ${id}${goal ? `: ${goal}` : ""}`, branch],
    { encoding: "utf8" },
  );
  const said = (merge.stderr || merge.stdout || "").trim();
  const merging = gitOk(run.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const head = git(run.repo, ["rev-parse", "HEAD"]);
  if (merge.status === 0 && !merging && head !== targetHead && isAncestor(run.repo, tip, head)) {
    return record(head, `integrated ${id}: merged ${branch} into ${target} at ${short(head)}`);
  }
  const how = merge.status === 0 ? "stopped without committing the merge" : "failed";
  if (merging) {
    // integrate refused to start during another operation, so this merge is its own to undo.
    const abort = spawnSync("git", ["-C", run.repo, "merge", "--abort"], { encoding: "utf8" });
    if (abort.status !== 0) {
      die(
        `git merge ${how} in ${run.repo}, and undoing it failed too, so the merge is still in progress there; ${id} is not integrated.\n` +
          `git merge said: ${said}\ngit merge --abort said: ${(abort.stderr || abort.stdout || "").trim()}\n` +
          `To recover: see what is left with git -C ${run.repo} status. Finish the merge with git -C ${run.repo} commit, or set aside the files it lists and run git -C ${run.repo} merge --abort. Then integrate again.`,
      );
    }
    die(`git merge ${how} in ${run.repo}; it was undone, so the checkout is as it was, and ${id} is not integrated:\n${said}`);
  }
  if (head === targetHead && !uncommitted(run.repo, { untracked: false }).length) die(`git refused the merge in ${run.repo}; nothing was changed, and ${id} is not integrated:\n${said}`);
  die(`git merge ${how} in ${run.repo}, leaving ${target} at ${short(head)} without ${branch} merged; ${id} is not integrated. Check git -C ${run.repo} status and log before you integrate again:\n${said}`);
}

// Paths the merged tree adds to the target that already exist in the checkout untracked or ignored,
// or that need a directory where the checkout has an untracked file.
function untrackedInTheWay(repo, targetHead, tree) {
  const r = spawnSync("git", ["-C", repo, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", targetHead, tree], { encoding: "utf8" });
  const exists = (rel) => {
    try {
      return fs.lstatSync(path.join(repo, rel));
    } catch {
      return null;
    }
  };
  return (r.status === 0 ? r.stdout.split("\0").filter(Boolean) : []).filter((rel) => {
    if (exists(rel)) return true;
    for (let dir = path.dirname(rel); dir !== "."; dir = path.dirname(dir)) {
      const stat = exists(dir);
      if (stat && !stat.isDirectory()) return true;
    }
    return false;
  });
}

// An operation in progress in a checkout that a merge must not run into, or null.
const OPERATIONS = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or git am"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["sequencer", "a cherry-pick or revert sequence"],
];
function operationInProgress(repo) {
  for (const [name, what] of OPERATIONS) {
    const file = git(repo, ["rev-parse", "--git-path", name], { allowFail: true });
    if (file && fs.existsSync(path.resolve(repo, file))) return what;
  }
  return null;
}

// Planned tasks that integrating `id` made ready.
function readyAfter(run, id) {
  const plan = readPlan(run.dir);
  if (!plan) return [];
  const { ready, unbriefed } = planProgress(plan, phaseMap(run, listTasks(run), plan), run.dir);
  const after = (t) => (t.dependsOn || []).includes(id);
  return [...ready.filter(after).map((t) => t.id), ...unbriefed.filter((u) => after(u.task)).map((u) => `${u.task.id} (brief ${u.problem})`)];
}

// Who launched a run, matched as `new` records it: a delegated agent by its run and task, a host
// session by its id. Null when this session cannot be identified.
function launchedBy(me) {
  if (me.agent === "delegated-agent") {
    return me.parentRun && me.parentTask ? (o) => o.agent === me.agent && o.parentRun === me.parentRun && o.parentTask === me.parentTask : null;
  }
  return me.sessionId ? (o) => o.agent === me.agent && o.sessionId === me.sessionId : null;
}

function recentlyActive(run) {
  const since = Date.now() - DAY_MS;
  let mtime = 0;
  try {
    mtime = fs.statSync(planPath(run.dir)).mtimeMs;
  } catch {}
  return Math.max(Date.parse(run.createdAt) || 0, mtime) >= since || listTaskRecords(run).some((task) => taskLastActivity(task) >= since);
}

// Independent worktrees can take seconds each to scan. Bound the children and keep the results
// local to this recovery, so later commands always inspect the current checkout contents.
async function recoveryWorktrees(runs, rowsOf) {
  const dirs = new Set();
  for (const run of runs) {
    for (const row of rowsOf(run)) {
      const wt = loadTask(run, row.id)?.worktree?.path;
      if (row.state !== "running" && wt && fs.existsSync(wt)) dirs.add(wt);
    }
  }
  const pending = [...dirs];
  const dirty = new Map();
  const worker = async () => {
    while (pending.length) {
      const dir = pending.shift();
      const changes = await new Promise((resolve) => {
        const child = spawn("git", ["-C", dir, "status", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.on("error", () => resolve([]));
        child.on("close", (code) => resolve(code === 0 ? stdout.split("\n").filter((l) => l.trim() && !CACHE_PATH.test(l.slice(3))) : []));
      });
      dirty.set(dir, changes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  return dirty;
}

export async function cmdRecover(args) {
  const cache = new Map();
  const rowsOf = (run) => cache.get(run.dir) || cache.set(run.dir, listTasks(run)).get(run.dir);
  const recent = () => listRuns().filter(recentlyActive);
  let runs;
  let scope;
  if (args._[0]) {
    runs = [loadRun(args._[0])];
    scope = null;
  } else if (args.all) {
    runs = recent();
    scope = "every run active in the last 24 hours";
  } else {
    const me = detectOrchestrator();
    const mine = launchedBy(me);
    if (mine) {
      runs = listRuns().filter((run) => mine(run.orchestrator || {}));
      scope = me.agent === "delegated-agent" ? `runs launched by task ${me.parentTask} of run ${me.parentRun}` : `runs launched by ${me.agent} session ${me.sessionId}`;
    } else {
      runs = recent();
      scope = "this session cannot be identified (no session id), so this covers every run active in the last 24 hours";
    }
  }
  const dirty = await recoveryWorktrees(runs, rowsOf);
  const reports = runs.map((run) => {
    const own = ownershipOf(run);
    if (own.mine) touchOwner(run); // recovering is using the run
    return recoverRun(run, rowsOf(run), own, dirty);
  });
  const text = reports.length ? reports.map((r) => r.text).join("\n\n") : "no runs";
  emit(args, { scope, runs: reports.map((r) => r.data) }, scope ? `${scope}\n\n${text}` : text);
}

// One run's tasks grouped by what they wait for, with the next command for each group. Reads only.
function recoverRun(run, rows, own, dirty) {
  const plan = readPlan(run.dir);
  const records = new Map(rows.map((r) => [r.id, loadTask(run, r.id)]));
  const progress = plan ? planProgress(plan, phaseMap(run, rows, plan), run.dir) : { ready: [], unbriefed: [], blocked: [], manual: [] };
  const planned = new Set((plan?.tasks || []).map((t) => t.id));
  const phase = (p) => rows.filter((r) => r.phase === p);
  const closed = (r) => Boolean(records.get(r.id)?.closedAt);
  // A task shows its name (`rename`) in place of its id, a planned one too once it has a record;
  // commands take either.
  const nameOf = (id) => records.get(id)?.name || id;
  const label = (r) => nameOf(r.id);
  const id1 = (items) => (items.length === 1 ? nameOf(items[0].id ?? items[0].task.id) : "<task>"); // the task in a group's next command
  const waitsOn = (b) => waitsOnText(b.waitsOn.map((w) => ({ ...w, id: nameOf(w.id) })));
  const groups = [
    {
      key: "running",
      label: "running",
      items: phase("running"),
      show: (r) => `${label(r)} (${r.agent}, ${r.elapsed}${r.quietMs > QUIET_AFTER_MS ? `, quiet ${formatElapsed(r.quietMs)}` : ""})`,
      next: () => `${CLI} wait ${run.id} --timeout 0 (in the background)`,
    },
    {
      key: "parked",
      label: "parked babysitters (a watcher resumes each on its next pull-request event or message)",
      items: phase("parked"),
      show: (r) => `${label(r)} (${r.parked?.waitsFor || "waits for its pull request"}${["alive", "starting"].includes(r.parked?.watcher) ? "" : "; watcher not running"})`,
      next: (items) => (items.some((r) => !["alive", "starting"].includes(r.parked?.watcher)) ? `${CLI} status ${run.id} (starts a watcher that is not running)` : null),
    },
    {
      key: "needs-decision",
      label: "needs decision",
      items: phase("needs-decision"),
      show: label,
      next: (items) =>
        `${CLI} result ${run.id} ${id1(items)}; decide, then resume it: ${CLI} start ${run.id} ${id1(items)} --agent ${items.length === 1 ? items[0].agent : "<same>"} --brief <answer> -- --session ${items.length === 1 && items[0].session ? items[0].session : "<session>"}`,
    },
    {
      key: "failed",
      label: "failed",
      items: phase("failed").filter((r) => !closed(r)),
      show: (r) => `${label(r)} (${r.limitHit ? "usage limit" : r.state})`,
      next: (items) => `${CLI} result ${run.id} ${id1(items)}; then resume it, give it to the other agent, or close it`,
    },
    {
      key: "awaiting-review",
      label: "awaiting review",
      items: phase("awaiting-review").filter((r) => r.mode?.split("+")[0] !== "babysit"),
      show: (r) => `${label(r)} (waited ${agoText(r.awaitingReviewMs || 0)})`,
      next: (items) => `${CLI} result ${run.id} ${id1(items)}; review and commit its work; then ${CLI} accept ${run.id} ${id1(items)}`,
    },
    {
      key: "accepted",
      label: "accepted, not integrated",
      items: phase("accepted"),
      show: label,
      next: (items) => `${CLI} integrate ${run.id} ${id1(items)}`,
    },
    { key: "ready", label: "ready to dispatch", items: progress.ready, show: label, next: () => `${CLI} dispatch ${run.id}` },
    {
      key: "unbriefed",
      label: "ready, waiting for a brief",
      items: progress.unbriefed,
      show: (u) => `${nameOf(u.task.id)} (${u.problem})`,
      next: (items) => `${CLI} brief ${run.id} ${id1(items)}; fill it in; then ${CLI} dispatch ${run.id}`,
    },
    {
      key: "manual",
      label: "babysitters to start by hand",
      items: progress.manual,
      show: label,
      next: (items) => `${CLI} start ${run.id} ${id1(items)} --agent claude --babysit --pr <n> --why "..." --brief <brief>`,
    },
    { key: "blocked", label: "blocked", items: progress.blocked, show: (b) => `${nameOf(b.task.id)} waits on ${waitsOn(b)}`, next: () => null },
    {
      key: "prepared",
      label: "prepared, not started",
      items: phase("prepared").filter((r) => !planned.has(r.id)),
      show: label,
      next: (items) => `${CLI} start ${run.id} ${id1(items)} --agent <agent> --why "..." --brief <brief>`,
    },
  ];
  const integrated = phase("integrated");
  const closedFailed = phase("failed").filter(closed);

  const manualMerges = rows.flatMap((r) => {
    const merged = manualMerge(run, records.get(r.id));
    return merged ? [{ id: r.id, ...merged }] : [];
  });
  const warnings = manualMerges.map((m) => `${nameOf(m.id)}: branch ${m.branch} was merged into ${m.into} without integrate; review and accept it, then record it with: ${CLI} integrate ${run.id} ${m.id} --already-merged`);
  for (const r of rows) {
    const wt = records.get(r.id)?.worktree?.path;
    if (r.state === "running" || !wt || !fs.existsSync(wt)) continue;
    const changes = dirty.get(wt) || [];
    if (changes.length) warnings.push(`${label(r)}: ${plural(changes.length, "uncommitted change")} in its worktree ${wt} (git -C ${wt} status)`);
  }
  for (const r of rows.filter((r) => r.state === "aborted" && !r.result)) {
    warnings.push(`${label(r)}: its process is gone without a result (${CLI} log ${run.id} ${r.id})`);
  }

  const mark = readOnlyMark(own);
  const lines = [
    `run ${run.id}${run.goal ? `: ${run.goal}` : ""}${mark}`,
    `  repo ${run.repo}${run.baseBranch ? ` (base ${run.baseBranch} @ ${short(run.baseCommit)})` : ""} · ${plan ? `plan of ${plural(plan.tasks.length, "task")}` : "no plan"}`,
  ];
  for (const g of groups) {
    if (!g.items.length) continue;
    lines.push(`  ${g.label} (${g.items.length}): ${g.items.map(g.show).join(", ")}`);
    const next = g.next(g.items);
    if (next) lines.push(`    next: ${next}`);
  }
  if (integrated.length) lines.push(`  integrated (${integrated.length}): ${integrated.map(label).join(", ")}`);
  if (closedFailed.length) lines.push(`  closed after failing (${closedFailed.length}): ${closedFailed.map(label).join(", ")}`);
  if (!rows.length && !plan) lines.push("  no tasks yet");
  for (const w of warnings) lines.push(`  ! ${w}`);

  const ids = (items) => items.map((x) => x.id ?? x.task.id);
  return {
    text: lines.join("\n"),
    data: {
      id: run.id,
      dir: run.dir,
      goal: run.goal || null,
      plan: Boolean(plan),
      owner: launcherLabel(own.direct),
      readOnly: Boolean(mark),
      orphaned: own.orphaned,
      groups: {
        ...Object.fromEntries(groups.filter((g) => !["awaiting-review", "blocked"].includes(g.key)).map((g) => [g.key, ids(g.items)])),
        "awaiting-review": groups.find((g) => g.key === "awaiting-review").items.map((r) => ({ id: r.id, awaitingReviewMs: r.awaitingReviewMs })),
        blocked: progress.blocked.map((b) => ({ id: b.task.id, waitsOn: b.waitsOn })),
        integrated: ids(integrated),
        closedFailed: ids(closedFailed),
      },
      warnings,
      manualMerges,
    },
  };
}
