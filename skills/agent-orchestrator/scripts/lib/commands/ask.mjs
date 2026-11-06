// `ask`: a delegated agent posts a question to whoever started it and keeps working. The question
// goes into the parent task's inbox when the parent is an orch task that is running and reads its
// messages; otherwise (a top-level run, whose parent is the user's own session, a parent that has
// ended, or one that will not read them, such as a Codex attempt whose brief has no inbox note) it
// shows on the dashboard as a `question` attention item, and wakes the top-level session's `wait`. The
// answer comes back as an ordinary message in the asker's inbox (`send`, or the dashboard's box),
// and the item clears once the asker has read a message sent after the question.

import { CLI_PATH } from "../config.mjs";
import { callerTask, parentOf, runById } from "../finish-notice.mjs";
import { appendQuestion } from "../inbox.mjs";
import { loadTask, taskDir } from "../runs.mjs";
import { die, emit } from "../util.mjs";
import { SendError, deliverMessage, messageReach } from "./inbox.mjs";

// What the parent task receives.
function questionText(run, task, attempt, question, options, recommend) {
  return [
    `Question from agent ${run.id}/${task.id} (attempt ${attempt}), which keeps working meanwhile:`,
    question,
    ...(options.length ? [`Options: ${options.join(" | ")}`] : []),
    ...(recommend ? [`Recommended: ${recommend}`] : []),
    `Answer it now with \`node ${CLI_PATH} send ${run.id} ${task.id} "<answer>"\` if your brief covers it. If it is beyond your brief, ask your own parent at once with \`node ${CLI_PATH} ask "<question>"\`, and pass the answer down when it comes.`,
  ].join("\n");
}

export function cmdAsk(args) {
  const me = callerTask();
  if (!me) die("ask is for a delegated agent, whose AGENT_ORCH_RUN and AGENT_ORCH_TASK name its task; in your own session, ask the user directly", 2);
  const run = runById(me.run) || die(`unknown run "${me.run}" (from AGENT_ORCH_RUN)`, 2);
  const task = loadTask(run, me.task) || die(`no task ${me.task} in run ${run.id} (from AGENT_ORCH_TASK)`, 2);
  const question = args._.join(" ").trim();
  if (!question) die('missing the question: ask "<question>" [--options "a|b|c"] [--recommend a]', 2);
  const options = String(args.options ?? "").split("|").map((o) => o.trim()).filter(Boolean);
  const recommend = String(args.recommend ?? "").trim() || null;
  if (recommend && options.length && !options.includes(recommend)) die(`--recommend must be one of the options: ${options.join(", ")}`, 2);
  const attempt = task.attempt || 1;
  const parent = parentOf(run, task);
  let to = "user";
  let sent = null;
  let fallback = null;
  let entry;
  try {
    if (parent) {
      const parentRun = runById(parent.run);
      // A parent that will not read the question must not swallow it: the user gets it instead.
      const parentTask = parentRun ? loadTask(parentRun, parent.task) : null;
      const reach = parentTask ? messageReach(parentTask) : null;
      const unread = (how) => `it will not read messages (${how.replace(/; stop it and resume it .*$/, "")})`;
      if (!parentRun) fallback = `its run ${parent.run} is gone`;
      else if (reach && !reach.reaches) fallback = unread(reach.delivery);
      else {
        try {
          sent = deliverMessage(parentRun, parent.task, questionText(run, task, attempt, question, options, recommend), {
            from: `agent:${run.id}/${task.id}`, kind: "question", about: { run: run.id, task: task.id, attempt },
          });
          to = `agent:${parent.run}/${parent.task}`;
          if (!sent.reaches) {
            fallback = unread(sent.delivery);
            [to, sent] = ["user", null];
          }
        } catch (error) {
          if (!(error instanceof SendError)) throw error;
          fallback = error.message;
        }
      }
    }
    entry = appendQuestion(taskDir(run, task.id), {
      attempt, question, options, recommend, to, ...(sent ? { message: sent.message.id } : {}), ...(fallback ? { fallback } : {}),
    });
  } catch (error) {
    // A sandboxed agent may be unable to write the state folder.
    die(`could not post the question (${error.message}); finish what does not depend on it, then end with NEEDS DECISION:`, 1);
  }
  const where = sent
    ? `asked your parent, ${parent.run}/${parent.task}, in its inbox`
    : `asked the user on the dashboard${fallback ? ` (your parent ${parent.run}/${parent.task} cannot take it: ${fallback})` : ""}`;
  const text = [
    `${where} (question ${entry.id})`,
    "Keep working on everything that does not depend on the answer. The answer arrives as a message in your inbox: Claude gets it after a tool call; otherwise read it with",
    `\`node ${CLI_PATH} inbox ${run.id} ${task.id} --ack\`. To wait for it, run \`node ${CLI_PATH} nap 5m\`, which exits 6 when a message arrives.`,
    "End with NEEDS DECISION: only when nothing else is left and no answer has come.",
  ].join("\n");
  emit(args, { run: run.id, task: task.id, ...entry, ...(sent ? { delivery: sent.delivery } : {}) }, text);
}
