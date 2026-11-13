// `new`, `worktree`, `runs`, and `cleanup`: create a run and its worktrees, list runs, and clean up.

import { collectWorktrees, collectionText, ensureDisk } from "../worktree-gc.mjs";
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "../config.mjs";
import { compact, firstLine, slug, stamp, table } from "../format.mjs";
import { guard, recordChange } from "../ownership.mjs";
import { detectOrchestrator, listRuns, listTasks, loadRun, loadTask, saveTask, validTask } from "../runs.mjs";
import { die, emit, git, writeJson } from "../util.mjs";
import { totals } from "../views.mjs";
import { prepareWorktree, prepSummary } from "../worktree-prep.mjs";

export function cmdNew(args) {
  const repo = path.resolve(args.repo || process.cwd());
  if (!fs.existsSync(repo)) die(`--repo does not exist: ${repo}`);
  const top = git(repo, ["rev-parse", "--show-toplevel"], { allowFail: true });
  const root = top || repo;
  // Two runs started in the same second with the same name would share an id: the folder is created
  // exclusively, and a taken id gets a suffix, so `new` never writes into an existing run.
  const base = `${stamp()}-${slug(args.name || path.basename(root))}`;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  let id = base;
  for (let n = 2; ; n++) {
    try {
      fs.mkdirSync(path.join(RUNS_DIR, id));
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || n > 1000) throw error;
      id = `${base}-${n}`;
    }
  }
  const dir = path.join(RUNS_DIR, id);
  fs.mkdirSync(path.join(dir, "tasks"));
  const createdAt = new Date().toISOString();
  const run = {
    id,
    repo: root,
    isGit: Boolean(top),
    baseBranch: top ? git(top, ["branch", "--show-current"], { allowFail: true }) || null : null,
    baseCommit: top ? git(top, ["rev-parse", "HEAD"], { allowFail: true }) : null,
    goal: args.goal || null,
    // lastSeenAt: when its owner last used the run (ownership.mjs, touchOwner).
    orchestrator: { ...detectOrchestrator({ started: true }), lastSeenAt: createdAt },
    createdAt,
  };
  writeJson(path.join(dir, "run.json"), run);
  emit(
    args,
    { ...run, dir },
    `run ${id}\n  dir:  ${dir}\n  repo: ${root}${run.isGit ? `\n  base: ${run.baseBranch || "(detached)"} @ ${run.baseCommit.slice(0, 12)}` : "\n  (not a git repository: worktrees unavailable)"}`,
  );
}

export async function createWorktree(run, id, { from, branch, path: worktreePath, prep = true } = {}) {
  id = validTask(id);
  if (!run.isGit) die("the run's repo is not a git repository");
  const existing = loadTask(run, id);
  if (existing?.worktree) die(`task ${id} already has a worktree at ${existing.worktree.path}`);
  const previous = existing?.removedWorktree;
  branch = branch || previous?.branch || `orch/${run.id}/${id}`;
  // A collected folder leaves its branch intact. Reuse it without resetting its commits.
  const retainedHead = previous?.branch === branch ? git(run.repo, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFail: true }) : null;
  if (retainedHead && from) die(`cannot use --from while restoring retained branch ${branch}; omit --from, or choose a new --branch`);
  // Record the commit the branch starts at, never a branch name: `--from main` moves when main does,
  // and a moving start would make later work merged by hand look as if it predated the worktree.
  const start = retainedHead ? previous.from || run.baseCommit : from || run.baseCommit;
  from = git(run.repo, ["rev-parse", "--verify", `${start}^{commit}`], { allowFail: true });
  if (!from) die(`--from is not a commit in ${run.repo}: ${start}`);
  const wt = path.resolve(worktreePath || (retainedHead && previous.path) || path.join(run.dir, "worktrees", id));
  if (fs.existsSync(wt)) die(`worktree path already exists: ${wt}`);
  // Every worktree (`worktree`, `dispatch`, a restore) is created here, after the disk check: on a
  // disk below AGENT_ORCH_MIN_FREE_DISK it collects unused worktrees, then refuses if that was not
  // enough, before anything is created.
  await ensureDisk(path.dirname(wt));
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(run.repo, retainedHead ? ["worktree", "add", "-q", wt, branch] : ["worktree", "add", "-q", "-b", branch, wt, from]);
  const createdAt = new Date().toISOString();
  const task = {
    ...(existing || { id, createdAt }), cd: wt,
    worktree: {
      path: wt, branch, from,
      // A fresh branch also reopens a closed preparation; it has no restoredAt.
      ...(!existing?.pid && existing?.closedAt ? { createdAt } : {}),
      ...(retainedHead ? { restored: true, restoredAt: createdAt, restoredCommit: retainedHead } : {}),
    },
  };
  saveTask(run, task);
  if (prep) {
    const controller = new AbortController();
    const onInt = () => controller.abort('SIGINT');
    const onTerm = () => controller.abort('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    try {
      await prepareWorktree(run, task, { signal: controller.signal, onProgress: () => saveTask(run, task) });
    } finally {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
    }
    if (controller.signal.aborted) process.exit(controller.signal.reason === 'SIGINT' ? 130 : 143);
  }
  return task;
}

export async function cmdWorktree(args) {
  const run = loadRun(args._[0]);
  const g = guard(run, `create a worktree in run ${run.id}`, { adopt: args.adopt, refused: args._[1] ? [args._[1]] : [] });
  let task = await createWorktree(run, args._[1], { from: args.from, branch: args.branch, path: args.path, prep: !args["no-prep"] });
  task = { ...(loadTask(run, task.id) || task), worktreeBy: g.actor };
  saveTask(run, task);
  recordChange(run, g, { task: task.id, attempt: task.attempt || null, action: "worktree created" });
  const { path: wt, branch, from, prep } = task.worktree;
  emit(args, task.worktree, `worktree ${wt}\nbranch   ${branch} (from ${from.slice(0, 12)})${prep ? prepSummary(prep) : ""}`);
}

export async function cmdCleanup(args) {
  const run = loadRun(args._[0]);
  const rows = listTasks(run);
  const g = guard(run, `clean up run ${run.id}`, {
    adopt: args.adopt,
    refused: () => rows.filter((t) => loadTask(run, t.id)?.worktree).map((t) => `${t.id}'s worktree`),
  });
  const report = await collectWorktrees(run, { actor: g.actor, reclaimKept: true });
  emit(args, report, `${args.force || args["delete-branches"] ? "Safety checks cannot be overridden; branches are always kept.\n" : ""}${collectionText(report)}`);
}

export function cmdRuns(args) {
  const runs = listRuns().map((r) => {
    const tasks = listTasks(r);
    const t = totals(tasks);
    return {
      id: r.id,
      by: r.orchestrator?.agent || "-",
      tasks: tasks.length,
      running: t.running,
      tokens: `${t.exact ? "" : "~"}${compact(t.tokensIn)}/${compact(t.tokensOut)}`,
      goal: firstLine(r.goal, 50),
    };
  });
  emit(args, runs, runs.length ? table(runs, ["id", "by", "tasks", "running", "tokens", "goal"]) : `no runs in ${RUNS_DIR}`);
}
