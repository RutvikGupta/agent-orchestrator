// `park-until`: an agent that would otherwise wait in its session (for CI, a DAG run, a deploy, a
// command task) records a wake condition for its current attempt, then ends its turn parked
// (`PARKED:`). The park watcher (park.mjs) runs the condition with no model, every --every, and
// resumes the same session once it exits 0, once it cannot run, once --for has passed, when a
// message arrives, or when a task the agent started finishes. The condition is park-until.json in
// the attempt's folder; a later `park-until` in the same attempt replaces it.

import fs from "node:fs";
import path from "node:path";
import { CLI_PATH } from "../config.mjs";
import { callerTask, ensureFinishWatcher, runById } from "../finish-notice.mjs";
import { COMMAND_AGENT } from "../policy.mjs";
import { PARK_UNTIL_FILE, attemptAgent, commandText, loadTask } from "../runs.mjs";
import { die, emit, parseDuration, which, writeJson } from "../util.mjs";
import { durationText } from "../format.mjs";

const MIN_EVERY = 30 * 1000;
const MAX_FOR = 24 * 3600 * 1000;

// Whether `program` can be started from `cwd`: a path that exists, or a name on PATH.
function runnable(program, cwd) {
  if (program.includes("/")) return fs.existsSync(path.resolve(cwd, program));
  return Boolean(which(program));
}

export function cmdParkUntil(args) {
  const usage = "park-until [--every DUR] [--for DUR] [--why TEXT] -- COMMAND [ARG...]";
  const caller = callerTask();
  if (!caller) die(`park-until runs inside a task, whose agent then parks: AGENT_ORCH_RUN and AGENT_ORCH_TASK are not set here. Outside a task, wait with \`node ${CLI_PATH} wait\` or run the command yourself`, 2);
  const run = runById(caller.run) || die(`run ${caller.run} (from AGENT_ORCH_RUN) does not exist`, 2);
  const task = loadTask(run, caller.task) || die(`task ${caller.task} (from AGENT_ORCH_TASK) does not exist in run ${run.id}`, 2);
  if (!task.attempt || !task.outDir) die(`task ${task.id} has not started`, 2);
  if (attemptAgent(task, task.attempt) === COMMAND_AGENT) die("a command task never parks: it has no session to resume. Run the wait inside the command itself", 2);
  const argv = args.passthrough;
  if (!argv.length || !argv[0]) die(`give the command to check after --: ${usage}`, 2);
  const every = parseDuration(args.every ?? "2m");
  if (!(every >= MIN_EVERY)) die(`--every must be at least 30s (got ${args.every}): the watcher runs the command that often`, 2);
  const longest = parseDuration(args.for ?? "6h");
  if (!(longest > 0) || longest > MAX_FOR) die(`--for must be more than 0 and at most 24h (got ${args.for}): the longest the task waits`, 2);
  const cwd = process.cwd();
  if (!runnable(argv[0], cwd)) die(`cannot run \`${argv[0]}\`: it is not a file here or a program on PATH. Give a command the watcher can run`, 2);
  const why = String(args.why ?? "").replace(/\s+/g, " ").trim() || null;
  const at = new Date();
  const record = {
    attempt: task.attempt, command: argv, cwd, path: process.env.PATH || null, every, for: longest,
    why, at: at.toISOString(), until: new Date(at.getTime() + longest).toISOString(),
  };
  const file = path.join(task.outDir, PARK_UNTIL_FILE);
  const replaced = fs.existsSync(file);
  try {
    writeJson(file, record);
  } catch (error) {
    die(`could not record the wake condition (${error.message}): this task cannot park here; wait another way and say so in your report`);
  }
  // A task that no agent started, and that is not a babysitter, has no finish watcher yet: the
  // watcher that starts the park watcher once this relay ends.
  ensureFinishWatcher(run, task);
  const line = `\`${commandText(argv)}\``;
  emit(args, { run: run.id, task: task.id, ...record, replaced }, [
    `${replaced ? "replaced the" : "recorded a"} wake condition for attempt ${task.attempt} of ${task.id}: ${line} in ${cwd}, every ${durationText(every)}, for at most ${durationText(longest)} (until ${record.until}).`,
    `next: end your turn now, with a final message whose first line is \`PARKED: waits for ${why || "<what>"}\` and an \`orch-result\` block with outcome \`parked\`. Do not run the command yourself, and do not sleep, nap or poll: a watcher with no model runs it every ${durationText(every)} and resumes this session when it exits 0, when it cannot run, after ${durationText(longest)}, when a message arrives, or when a task you started finishes.`,
  ].join("\n"));
}
