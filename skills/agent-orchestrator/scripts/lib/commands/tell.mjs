// `tell`: a delegated agent sends the agent that started it a one-way note, such as a status update
// ("pushed #123; ready for review"), and keeps working. The note goes into the parent task's inbox.
// In a top-level run, whose parent is the launching main session (which has no inbox), it goes into
// the run's notes.jsonl, and that session's next `wait` on the run prints it and exits 6
// (addressee.mjs). A note needs no answer: it never reaches the user's lane and never escalates.
// A question or a decision goes through `ask` instead.

import fs from "node:fs";
import path from "node:path";
import { appendNote, mainSession, sessionLabel } from "../addressee.mjs";
import { callerTask, parentOf, runById } from "../finish-notice.mjs";
import { loadTask } from "../runs.mjs";
import { die, emit } from "../util.mjs";
import { SendError, deliverMessage } from "./inbox.mjs";

export function cmdTell(args) {
  const me = callerTask();
  if (!me) die("tell is for a delegated agent, whose AGENT_ORCH_RUN and AGENT_ORCH_TASK name its task; in your own session, tell the user directly", 2);
  const run = runById(me.run) || die(`unknown run "${me.run}" (from AGENT_ORCH_RUN)`, 2);
  const task = loadTask(run, me.task) || die(`no task ${me.task} in run ${run.id} (from AGENT_ORCH_TASK)`, 2);
  if (args.file && args._.length) die("give the note as text or with --file, not both", 2);
  let text = args._.join(" ");
  if (args.file) {
    try {
      text = fs.readFileSync(path.resolve(args.file), "utf8");
    } catch (error) {
      die(`cannot read --file: ${error.message}`, 2);
    }
  }
  text = text.trim();
  if (!text) die('missing the note: tell "<text>" (or --file FILE)', 2);
  const attempt = task.attempt || 1;
  const from = `agent:${run.id}/${task.id}`;
  const about = { run: run.id, task: task.id, attempt };
  const parent = parentOf(run, task);
  const undelivered = (why) => die(`not delivered: ${why}. Put the note in your final report instead.`, 1);
  try {
    if (parent) {
      const parentRun = runById(parent.run) || undelivered(`your parent's run ${parent.run} is gone`);
      let sent;
      try {
        sent = deliverMessage(parentRun, parent.task, `Note from agent ${run.id}/${task.id} (attempt ${attempt}), which needs no answer:\n${text}`, { from, kind: "note", about });
      } catch (error) {
        if (!(error instanceof SendError)) throw error;
        undelivered(`your parent ${parent.run}/${parent.task} cannot take it (${error.message.replace(/; (resume it|put the message) .*$/, "")})`);
      }
      const to = `agent:${parent.run}/${parent.task}`;
      emit(args, { run: run.id, task: task.id, to, message: sent.message.id, delivery: sent.delivery, reaches: sent.reaches },
        `told your parent, ${parent.run}/${parent.task}, in its inbox (message ${sent.message.id})\ndelivery: ${sent.delivery}`);
      return;
    }
    const note = appendNote(run, { from, about, text });
    const session = mainSession(run);
    emit(args, { run: run.id, task: task.id, to: "orchestrator", note: note.id },
      `told ${session ? `your orchestrator, ${sessionLabel(session)}` : `whoever waits on run ${run.id}`}: its next \`wait\` on run ${run.id} prints it (note ${note.id})`);
  } catch (error) {
    // A sandboxed agent may be unable to write the state folder.
    undelivered(`could not write it (${error.message})`);
  }
}
