// `pr-watch`: polls GitHub with the user's gh login and returns when a pull request needs the
// orchestrator: a check failed, every check finished, a review or comment arrived, the review
// decision changed, the branch conflicts with its base, or the pull request left OPEN. It spends
// no model tokens while it waits. The last state reported for each pull request is kept in
// PR_DIR, so the next watch returns only for something new. A pull request seen for the first time
// with nothing to report is recorded too, as the baseline that later comments and reviews count from.
// A parked babysitter's watcher (park.mjs) compares with the same records, without changing them.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PR_DIR, RUNS_DIR } from "../config.mjs";
import { inboxWake } from "../inbox.mjs";
import { prAttention, prSnapshot, prText } from "../github.mjs";
import { die, emit, git, parseDuration, readJson, which, writeJson } from "../util.mjs";

const seenPath = (s) => path.join(PR_DIR, `${s.key}.json`);

// The state last reported for a pull request snapshot, or null.
export const readSeen = (s) => readJson(seenPath(s));

// Record a snapshot as the state last reported.
export function recordSeen(s) {
  fs.mkdirSync(PR_DIR, { recursive: true });
  writeJson(seenPath(s), { ...s, attention: undefined, seenAt: new Date().toISOString() });
}

// Whether the checkout at `cwd`, on the pull request's branch, holds commits the pull request does
// not have yet: a fix that is not published.
export function aheadOfPr(cwd, s) {
  if (s.error) return false;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
  const local = git(cwd, ["rev-parse", "HEAD"], { allowFail: true });
  if (!local || branch !== s.branch || local === s.head) return false;
  return spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", s.head, local]).status === 0;
}

// Whether the agent running this command is a pull-request babysitter, which parks once nothing is new.
function callerBabysits() {
  const run = process.env.AGENT_ORCH_RUN, task = process.env.AGENT_ORCH_TASK;
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!run || !task || !name.test(run) || !name.test(task)) return false;
  const record = readJson(path.join(RUNS_DIR, run, "tasks", task, "task.json"));
  return Boolean(record?.babysit || record?.plan?.type === "babysit");
}

export async function cmdPrWatch(args) {
  const wake = inboxWake();
  const refs = args._;
  if (!refs.length) die("name at least one pull request: a number, URL, or branch", 2);
  if (!which("gh")) die("gh is not installed or not on PATH");
  const cwd = path.resolve(args.repo || process.cwd());
  const timeout = args.timeout === undefined ? 9 * 60000 : parseDuration(args.timeout);
  const deadline = timeout === 0 ? Infinity : Date.now() + timeout;
  const interval = Math.max(15000, parseDuration(args.interval || "60s"));
  for (let poll = 0; ; poll++) {
    const reports = refs.map((ref) => prSnapshot(cwd, ref));
    if (poll === 0 && reports.some((s) => s.error)) die(prText(reports.map((s) => ({ ...s, attention: [] }))));
    // Waiting while this checkout holds commits the pull request does not have would leave a fix
    // unpublished, so refuse to watch until they are pushed.
    if (poll === 0) {
      const local = git(cwd, ["rev-parse", "HEAD"], { allowFail: true });
      for (const s of reports) {
        if (aheadOfPr(cwd, s)) {
          die(`PR #${s.number}: this checkout has commits the pull request does not have yet (local ${local.slice(0, 8)}, pull request ${String(s.head).slice(0, 8)}). Push them first; if the push fails, stop and report the error instead of watching.`, 4);
        }
      }
    }
    for (const s of reports) {
      if (s.error) {
        s.attention = [];
        continue;
      }
      const seen = readSeen(s);
      s.attention = prAttention(s, seen);
      // Without a record, new comments and reviews have nothing to count from.
      if (!seen && !s.attention.length && !args.once) recordSeen(s);
    }
    const due = reports.filter((s) => s.attention.length);
    const message = wake.check();
    const timedOut = Date.now() >= deadline;
    if (due.length || args.once || message || timedOut) {
      if (!args.once) for (const s of due) recordSeen(s);
      const idle = callerBabysits()
        ? "\n(nothing new: the watch timed out. If nothing is unpushed and every item is handled, park: end your turn with a final message whose first line is `PARKED: PR #<n> waits for <what>` and an orch-result outcome `parked`; a watcher resumes you on the next event)"
        : "\n(nothing new: the watch timed out; run it again)";
      const tail = due.length || args.once || message ? "" : idle;
      emit(args, { attention: due.length > 0, prs: reports, ...(message ? { message } : {}) }, `${prText(reports)}${tail}${message ? `\n${message.hint}` : ""}`);
      if (message) {
        if (due.length || args.once) writeJson(wake.pendingPath, { id: message.id });
        else fs.rmSync(wake.pendingPath, { force: true });
      }
      process.exit(due.length || args.once ? 0 : message ? 6 : 3);
    }
    const nextPoll = Math.min(Date.now() + interval, deadline);
    while (Date.now() < nextPoll) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, nextPoll - Date.now())));
      const message = wake.check();
      if (message) {
        emit(args, { attention: false, prs: reports, message }, `${prText(reports)}\n${message.hint}`);
        fs.rmSync(wake.pendingPath, { force: true });
        process.exit(6);
      }
    }
  }
}
