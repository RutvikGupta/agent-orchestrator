// What a main session has in flight in the runs it launched (run.json's orchestrator.sessionId is the
// session's id). The Stop hook (hooks/orch-stop.mjs) blocks the end of a turn for it, and the
// question-dialog hook (hooks/orch-ask.mjs) refuses a dialog for it. Both load this module only once
// they have a session id.
//
// Only tasks the session started itself count (no `startedBy`). For each run it lists the tasks that
// run or are parked, and whether a `wait` on the run is live. It also lists the items that address
// the session: an open question for it from a task that runs, an unread result, and a decision it
// read but has not resolved. A closed task never counts, whether or not it was accepted, nor does one
// whose attempt a stop ended.
//
// It reads files and runs one `ps`: no network and no board build.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ORCHESTRATOR, waitLive } from "./addressee.mjs";
import { decisionsIn } from "./briefs.mjs";
import { CLI_PATH, RUNS_DIR } from "./config.mjs";
import { openQuestions, readInbox, readQuestions } from "./inbox.mjs";
import { acceptedNow } from "./lifecycle.mjs";
import { endedByStop, isParked } from "./runs.mjs";
import { readJson } from "./util.mjs";

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // a run, task or session id, never a path

// The runs that session `sessionId` launched, each with its folder.
export function sessionRuns(sessionId) {
  let ids = [];
  try {
    ids = fs.readdirSync(RUNS_DIR);
  } catch {}
  const runs = [];
  for (const id of ids) {
    if (!NAME.test(id)) continue;
    const dir = path.join(RUNS_DIR, id);
    const run = readJson(path.join(dir, "run.json"));
    if (run?.orchestrator?.sessionId === sessionId) runs.push({ ...run, id: run.id || id, dir });
  }
  return runs;
}

// The session's work: { runs, items }, or null when `ps` fails or the work runs past `deadline` (ms
// since the epoch), so that a hook gives up rather than hold up the session.
//
// - runs: one { run, running, waiting } per run it launched. `running` lists the tasks that run or
//   are parked, each { id, ref, label, parked }; `waiting` says whether a `wait` on the run is live,
//   and is null when nothing runs.
// - items: one { key, kind, label, text } per item, where `kind` is "question", "result" (an unread
//   result, or an unread decision) or "decision" (read and not resolved). `key` names the item for
//   the Stop hook's record; `text` says what to do, with the command.
//
// A named task (`rename`) is shown, and named in each command, by its name; the keys keep its id.
export function sessionWork(sessionId, { deadline = Infinity } = {}) {
  const runs = sessionRuns(sessionId);
  if (!runs.length) return { runs: [], items: [] };

  // One snapshot of the process table, taken before any result is read: a relay that is gone here
  // wrote its result before it exited, so a result read afterwards is never missing.
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 1000 });
  if (ps.status !== 0) return null;
  const table = new Map();
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), m[2]);
  }
  // As relayAlive() in runs.mjs: the process must still be a relay, or a fresh fork of one.
  const relayAlive = (pid, startedAt, outDir) => {
    const command = pid ? table.get(Number(pid)) : undefined;
    if (command === undefined) return false;
    // This task's own relay: one for another attempt folder is a later process with the same PID.
    if (command.includes("relay.mjs")) return !outDir || `${command} `.includes(`--out-dir ${outDir} `);
    const age = startedAt ? Date.now() - Date.parse(startedAt) : Infinity;
    return age >= 0 && age < 10000;
  };

  const cli = (words) => `node ${CLI_PATH} ${words}`;
  const quote = (text, max = 160) => {
    const one = String(text).replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  };
  const items = [];
  const work = [];

  for (const run of runs) {
    if (Date.now() > deadline) return null;
    let taskIds = [];
    try {
      taskIds = fs.readdirSync(path.join(run.dir, "tasks"));
    } catch {}
    const running = [];
    for (const id of taskIds) {
      const dir = path.join(run.dir, "tasks", id);
      const task = readJson(path.join(dir, "task.json"));
      // A task another task started reports to that task, not to this session.
      if (!task || task.startedBy || !NAME.test(id)) continue;
      const attempt = task.attempt || 0;
      if (!attempt || !task.pid) continue;
      const ref = task.name && NAME.test(task.name) ? task.name : id;
      const label = `${run.id}/${ref}`;
      const alive = relayAlive(task.pid, task.startedAt, task.outDir);
      const parked = !alive && isParked(run, task);
      if (alive || parked) {
        running.push({ id, ref, label, parked });
        for (const q of openQuestions(readQuestions(dir), readInbox(dir), attempt)) {
          if (q.to !== ORCHESTRATOR) continue;
          items.push({
            key: [run.id, id, attempt, "question", q.id].join(":"),
            kind: "question",
            label,
            text: `${label} asked a question and keeps working: "${quote(q.question)}". Answer it with \`${cli(`send ${run.id} ${ref} "<answer>"`)}\`.`,
          });
        }
        continue;
      }
      const result = task.outDir ? readJson(path.join(task.outDir, "result.json")) : null;
      // An attempt that a stop ended (`stopped`) has no result to read: whoever stopped it knows.
      if (!result || endedByStop(task, result)) continue;
      const decisions = result.status === "completed" ? decisionsIn(result.finalMessage) : null;
      const resolved = task.decisionResolvedAttempt === attempt;
      if (decisions) {
        if (task.closedAt || resolved) continue;
        if (task.decisionSeenAttempt !== attempt) {
          items.push({
            key: [run.id, id, attempt, "result"].join(":"),
            kind: "result",
            label,
            text: `${label} handed back a decision and nobody has read its result. Read it with \`${cli(`result ${run.id} ${ref}`)}\`.`,
          });
          continue;
        }
        const agent = task.attemptAgents?.[attempt] || task.agent || "claude";
        const session = result.sessionId || result.threadId || "<session id from result>";
        items.push({
          key: [run.id, id, attempt, "decision"].join(":"),
          kind: "decision",
          label,
          text: `${label} handed back a decision that you read and have not resolved: "${quote(decisions[0])}". Decide what the request covers, then resume it with \`${cli(`start ${run.id} ${ref} --agent ${agent} --brief <answer-file> -- --session ${session}`)}\`, or run \`${cli(`resolve ${run.id} ${ref} --note "<how>"`)}\` if you handled it another way, or \`${cli(`close ${run.id} ${ref}`)}\`.`,
        });
        continue;
      }
      // A closed task never counts, accepted or not: `close` retired it, and `result`, which closes
      // a finished task as it hands its report over, cannot be told apart from `close`.
      if (!task.closedAt && !acceptedNow(task) && !resolved) {
        items.push({
          key: [run.id, id, attempt, "result"].join(":"),
          kind: "result",
          label,
          text: `${label} finished (${result.status || "unknown"}) and nobody has read its result. Read it with \`${cli(`result ${run.id} ${ref}`)}\`, then accept it, send it back with \`verdict ... changes\`, or close it; or run \`${cli(`close ${run.id} ${ref}`)}\` if you handled it another way.`,
        });
      }
    }
    // A live wait on the run: the Node process, the shell it parks in, or the Node process that
    // shell resumes; or the process that main-wait.json names, when it still runs a wait.
    work.push({ run, running, waiting: running.length ? waitLive(run, table) : null });
  }
  return { runs: work, items };
}
