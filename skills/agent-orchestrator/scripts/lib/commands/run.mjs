// `new`, `worktree`, `runs`, and `cleanup`: create a run and its worktrees, list runs, and clean up.

import { reclaimTask } from "../reclaim.mjs";
import fs from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "../config.mjs";
import { compact, firstLine, slug, stamp, table } from "../format.mjs";
import { detectOrchestrator, listRuns, listTasks, loadRun, loadTask, saveTask, validTask } from "../runs.mjs";
import { die, emit, git, writeJson } from "../util.mjs";
import { totals } from "../views.mjs";
import { prepareWorktree, prepSummary, teardownWorktree, worktreeChanges } from "../worktree-prep.mjs";

export function cmdNew(args) {
  const repo = path.resolve(args.repo || process.cwd());
  if (!fs.existsSync(repo)) die(`--repo does not exist: ${repo}`);
  const top = git(repo, ["rev-parse", "--show-toplevel"], { allowFail: true });
  const root = top || repo;
  const id = `${stamp()}-${slug(args.name || path.basename(root))}`;
  const dir = path.join(RUNS_DIR, id);
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  const run = {
    id,
    repo: root,
    isGit: Boolean(top),
    baseBranch: top ? git(top, ["branch", "--show-current"], { allowFail: true }) || null : null,
    baseCommit: top ? git(top, ["rev-parse", "HEAD"], { allowFail: true }) : null,
    goal: args.goal || null,
    orchestrator: detectOrchestrator(),
    createdAt: new Date().toISOString(),
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
  from = from || run.baseCommit;
  branch = branch || `orch/${run.id}/${id}`;
  const wt = path.resolve(worktreePath || path.join(run.dir, "worktrees", id));
  if (fs.existsSync(wt)) die(`worktree path already exists: ${wt}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(run.repo, ["worktree", "add", "-q", "-b", branch, wt, from]);
  const task = { ...(existing || { id, createdAt: new Date().toISOString() }), cd: wt, worktree: { path: wt, branch, from } };
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
  const task = await createWorktree(run, args._[1], { from: args.from, branch: args.branch, path: args.path, prep: !args["no-prep"] });
  const { path: wt, branch, from, prep } = task.worktree;
  emit(args, task.worktree, `worktree ${wt}\nbranch   ${branch} (from ${from.slice(0, 12)})${prep ? prepSummary(prep) : ""}`);
}

export async function cmdCleanup(args) {
  const run = loadRun(args._[0]);
  const report = [];
  for (const t of listTasks(run)) {
    const task = loadTask(run, t.id);
    if (!task?.worktree) continue;
    const { path: wt, branch } = task.worktree;
    if (t.state === "running") {
      report.push(`skip ${t.id}: still running`);
      continue;
    }
    if (fs.existsSync(wt)) {
      const dirty = worktreeChanges(wt, task.worktree.prep, run.repo);
      if (dirty.length && !args.force) {
        report.push(`skip ${t.id}: uncommitted changes in ${wt} (commit them, or pass --force to discard):\n  ${dirty.join("\n  ")}`);
        continue;
      }
      const teardown = await teardownWorktree(run, task);
      for (const result of teardown) {
        if (result.exitCode !== 0) report.push(`teardown ${t.id} failed (${result.exitCode ?? result.signal}): ${result.command}\n${result.output}`);
      }
      reclaimTask(run, task);
      // Teardown can leave artifacts, so force removal after the pre-teardown dirty check.
      // git refuses to remove a worktree with untracked files, caches included.
      git(run.repo, ["worktree", "remove", "--force", wt]);
      report.push(`removed worktree ${wt}`);
    }
    if (args["delete-branches"]) {
      const deleted = git(run.repo, ["branch", args.force ? "-D" : "-d", branch], { allowFail: true });
      report.push(deleted === null ? `kept branch ${branch} (not merged; -D needs --force)` : `deleted branch ${branch}`);
    }
    delete task.worktree;
    saveTask(run, task);
  }
  git(run.repo, ["worktree", "prune"], { allowFail: true });
  process.stdout.write(`${report.length ? report.join("\n") : "nothing to clean"}\n`);
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
