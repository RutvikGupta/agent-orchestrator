// `ask`: a delegated agent posts a question to whoever started it and keeps working. The question
// goes into the parent task's inbox when the parent is an orch task that is running and reads its
// messages. In a top-level run, whose parent is the launching main session (a Claude Code or Codex
// session with no inbox), it becomes a `question` attention item for that session, which wakes its
// `wait` on the run (exit 5); the user gets it only once that session is gone (addressee.mjs). It
// goes to the user directly with --user, from a run started from a terminal, or when the parent task
// cannot take it (its run is gone, or it will not read messages, such as a Codex attempt whose brief
// has no inbox note): then it shows in the dashboard's lane for the user. The answer comes back as
// an ordinary message in the asker's inbox, and the question closes once its addressee's side sends
// one after it: the user from the dashboard's box, the session with `send` (openQuestions, inbox.mjs).
// The question is written before its notice reaches the parent, so the parent's answer always comes
// after it and is recorded on it (recordAnswers).

import { ORCHESTRATOR, mainSession, sessionLabel } from "../addressee.mjs";
import { CLI_PATH } from "../config.mjs";
import { callerTask, parentOf, runById } from "../finish-notice.mjs";
import { appendQuestion, recordAnswers } from "../inbox.mjs";
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
  if (!question) die('missing the question: ask "<question>" [--options "a|b|c"] [--recommend a] [--user]', 2);
  const options = String(args.options ?? "").split("|").map((o) => o.trim()).filter(Boolean);
  const recommend = String(args.recommend ?? "").trim() || null;
  if (recommend && options.length && !options.includes(recommend)) die(`--recommend must be one of the options: ${options.join(", ")}`, 2);
  const attempt = task.attempt || 1;
  const parent = args.user ? null : parentOf(run, task);
  const session = !args.user && !parent ? mainSession(run) : null;
  let to = session ? ORCHESTRATOR : "user";
  let sent = null;
  let fallback = null;
  let entry = null;
  const dir = taskDir(run, task.id);
  // Only its addressee's side answers it: the user from the dashboard, or the session with `send`.
  const record = (addressee, extra) => {
    const answerFrom = addressee === "user" ? "user" : addressee === ORCHESTRATOR ? ORCHESTRATOR : null;
    return appendQuestion(dir, { attempt, question, options, recommend, to: addressee, ...(answerFrom ? { answerFrom } : {}), ...extra });
  };
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
        const target = `agent:${parent.run}/${parent.task}`;
        try {
          // The question is recorded once the parent can take it, before its notice is written.
          sent = deliverMessage(parentRun, parent.task, questionText(run, task, attempt, question, options, recommend), {
            from: `agent:${run.id}/${task.id}`, kind: "question", about: { run: run.id, task: task.id, attempt },
            prepare: ({ id, delivery, reaches }) => {
              if (!reaches) throw new SendError(unread(delivery), 409);
              entry = record(target, { message: id });
            },
          });
          to = target;
        } catch (error) {
          if (!(error instanceof SendError)) throw error;
          fallback = error.message;
        }
      }
    }
    entry ??= record(to, fallback ? { fallback } : {});
  } catch (error) {
    // A sandboxed agent may be unable to write the state folder.
    die(`could not post the question (${error.message}); finish what does not depend on it, then end with NEEDS DECISION:`, 1);
  }
  // An answer sent while the question was being written is recorded now; answerOf finds it anyway.
  try {
    recordAnswers(dir, { question: entry.id });
  } catch {}
  const where = sent
    ? `asked your parent, ${parent.run}/${parent.task}, in its inbox`
    : to === ORCHESTRATOR
      ? `asked your orchestrator, ${sessionLabel(session)}: its \`wait\` on run ${run.id} wakes with it, and the user gets it only if that session is gone`
      : `asked the user on the dashboard${fallback ? ` (your parent ${parent.run}/${parent.task} cannot take it: ${fallback})` : ""}`;
  const text = [
    `${where} (question ${entry.id})`,
    "Keep working on everything that does not depend on the answer. The answer arrives as a message in your inbox: Claude gets it after a tool call; otherwise read it with",
    `\`node ${CLI_PATH} inbox ${run.id} ${task.id} --ack\`. To wait for it, run \`node ${CLI_PATH} nap 5m\`, which exits 6 when a message arrives.`,
    "End with NEEDS DECISION: only when nothing else is left and no answer has come.",
  ].join("\n");
  emit(args, { run: run.id, task: task.id, ...entry, ...(sent ? { delivery: sent.delivery } : {}) }, text);
}
