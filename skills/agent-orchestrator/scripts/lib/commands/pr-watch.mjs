// `pr-watch`: polls GitHub with the user's gh login and returns when a pull request needs the
// orchestrator: a check failed, every check finished, a review or comment arrived, the review
// decision changed, the branch conflicts with its base, or the pull request left OPEN. It spends
// no model tokens while it waits. The last state reported for each pull request is kept in
// PR_DIR, so the next watch returns only for something new.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PR_DIR } from "../config.mjs";
import { inboxWake } from "../inbox.mjs";
import { prAttention, prSnapshot, prText } from "../github.mjs";
import { die, emit, git, parseDuration, readJson, which, writeJson } from "../util.mjs";

export async function cmdPrWatch(args) {
  const wake = inboxWake();
  const refs = args._;
  if (!refs.length) die("name at least one pull request: a number, URL, or branch", 2);
  if (!which("gh")) die("gh is not installed or not on PATH");
  const cwd = path.resolve(args.repo || process.cwd());
  const timeout = args.timeout === undefined ? 9 * 60000 : parseDuration(args.timeout);
  const deadline = timeout === 0 ? Infinity : Date.now() + timeout;
  const interval = Math.max(15000, parseDuration(args.interval || "60s"));
  const seenPath = (s) => path.join(PR_DIR, `${s.key}.json`);
  for (let poll = 0; ; poll++) {
    const reports = refs.map((ref) => prSnapshot(cwd, ref));
    if (poll === 0 && reports.some((s) => s.error)) die(prText(reports.map((s) => ({ ...s, attention: [] }))));
    // Waiting while this checkout holds commits the pull request does not have would leave a fix
    // unpublished, so refuse to watch until they are pushed.
    if (poll === 0) {
      const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
      const local = git(cwd, ["rev-parse", "HEAD"], { allowFail: true });
      for (const s of reports) {
        if (s.error || !local || branch !== s.branch || local === s.head) continue;
        const ahead = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", s.head, local]).status === 0;
        if (ahead) {
          die(`PR #${s.number}: this checkout has commits the pull request does not have yet (local ${local.slice(0, 8)}, pull request ${String(s.head).slice(0, 8)}). Push them first; if the push fails, stop and report the error instead of watching.`, 4);
        }
      }
    }
    for (const s of reports) s.attention = s.error ? [] : prAttention(s, readJson(seenPath(s)));
    const due = reports.filter((s) => s.attention.length);
    const message = wake.check();
    const timedOut = Date.now() >= deadline;
    if (due.length || args.once || message || timedOut) {
      if (!args.once) {
        fs.mkdirSync(PR_DIR, { recursive: true });
        for (const s of due) writeJson(seenPath(s), { ...s, attention: undefined, seenAt: new Date().toISOString() });
      }
      const tail = due.length || args.once || message ? "" : "\n(nothing new: the watch timed out; run it again)";
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
