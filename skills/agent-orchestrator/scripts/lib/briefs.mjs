// What `start` appends to every brief, and how a finished agent's handed-back decisions are read.

import { CLI_PATH, MAX_NEST_DEPTH, napBudgetMs, parallelAt } from "./config.mjs";

// The nap budget in words: "10 minutes", "90 seconds".
export function napBudgetText(ms = napBudgetMs()) {
  return ms % 60000 === 0 ? `${ms / 60000} minute${ms === 60000 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`;
}

export function nestingNote(depth) {
  return `

---

## Delegating further

Delegate only where an agent pays for its cost, through the agent-orchestrator skill (\`node ${CLI_PATH}\`; read its SKILL.md first, above all "Delegate well", then \`new\` a run and \`start\` each agent):

- When the task has two or more independent parts, split it and start one agent per part.
- When it has slow side work (test suites, gates, builds, deploys, long runs, reviews, the other model's opinion), start an agent for it and keep working.
- Never start an agent to wait or to run a command: make it one command task (\`start <run> <task> --agent command -- sh -c 'until <check>; do sleep 30; done; <commands>'\`). To judge after a wait, park (\`park-until -- <check>\`).

Size each piece on its own: the lightest tier that does it as well as the top one (its SKILL.md, "Choose the agent and model"). Running tests or gates, reproducing a bug, lookups, and mechanical edits fit \`light\`; small well-specified changes, docs, and reviews of small diffs fit \`standard\`. Name the deciding factor in \`--why\`. Do a few-minute or tightly coupled edit yourself. Do not weigh usage limits.

Never forward your whole task to a single agent, which only adds a middleman: split it, or do it yourself. Never pass its work to a stronger model either (\`start\` refuses one), even through a script that runs \`claude -p\`: if it truly needs one, say so with \`node ${CLI_PATH} ask "<why>"\` and keep doing what you can. Start every agent through \`start\`, never your host's own sub-agent tool.

A test-running agent can work on your uncommitted code in this directory: start it with \`--force\` and a brief that forbids editing files. If an agent's own work has such parts, tell it in its brief to delegate them the same way. You are notified when an agent you started finishes, so do not poll.

Each agent's brief keeps every constraint of this brief (the agents you start never commit, push or publish; you do). Run at most ${parallelAt(depth)} at a time, review and integrate their results yourself, close them before you finish, and cover their work in your final report. When one of them finishes with \`NEEDS DECISION:\`, decide it yourself if this brief covers it and resume that agent's session with the answer; pass it up in your own \`NEEDS DECISION:\` only when it is beyond this brief. You are ${depth} level${depth === 1 ? "" : "s"} below the user's session; agents ${MAX_NEST_DEPTH} levels down cannot delegate.
`;
}

// What a babysitter's handoff note holds. A parked babysitter whose context has grown large is
// resumed in a fresh session from this note (park.mjs), so it must say what the session knows.
export const HANDOFF_RULES = "At most 60 lines: the pull request, branch and worktree; what each review round asked and the commit that answered it; each open thread and its state; each reviewer and where their review was requested; decisions taken and why; what is pending; and what was tried and failed.";

// Appended to a babysitter's brief: where its handoff note lives, and why it keeps it current.
export function handoffNote(file) {
  return `

---

## Handoff note

Keep a handoff note current at \`${file}\`, and update it before every park. Every call you make re-sends your whole context, so once it has grown large your watcher resumes you in a fresh session that knows only your brief, this note, and what changed on the pull request. Without a note updated in the attempt that parks, it has to keep the large session. ${HANDOFF_RULES}
`;
}

// Appended to the brief of a babysitter's attempt at its watch tier, when that is below the tier
// of its fix attempts: what it does itself, and how it hands a fix on (finish-notice.mjs).
export function watchTierNote(tier, fixTier) {
  return `

---

## Watch tier: hand fixes to a fix attempt

This attempt runs at your watch tier (\`${tier}\`). Watch, and do the routine upkeep yourself: re-run a flaky check after reading its log, re-add a label, re-request a review, send the repository's Slack pings, rebase or restack when there is no conflict, post a one-line skip note on a bot's nit, and verify a merge.

Do not change code, and do not write substantive review replies, at this tier. When a wake needs a code change, a reply that explains or defends code, or a rebase with conflicts:

1. Gather the facts: the failing checks' names and the relevant log excerpts (with the repository's CI-log tool), each thread's URL with its comment text, and what you ruled out.
2. Update your handoff note.
3. End your turn with a final message whose first line is \`NEEDS FIX: PR #<n> <what needs fixing, in one line>\`, then those facts, then the \`orch-result\` block with outcome \`partial\`. Do not park in the same message.

This same session then resumes at once at the \`${fixTier}\` tier as the fix attempt, with your message. It fixes, pushes, replies and parks, and your next wake resumes at this tier again. Do everything that needs no fix before you end.
`;
}

// The brief of a babysitter's fix attempt, which finish-notice.mjs starts at `fixTier` when a watch
// attempt ends with NEEDS FIX. The watch attempt's message follows it as data.
export function fixBrief({ reason, watchTier, fixTier, model, handoffFile }) {
  return `## Fix attempt

You are now this babysitter's fix attempt, at the \`${fixTier}\` tier (${model}). Your watch attempt, at the \`${watchTier}\` tier, ended with \`NEEDS FIX: ${reason}\`. Its whole message is quoted at the end of this brief.

Make the fix it asks for. Check each fact it gathered before you act on it. Change the code, run the gates, commit and push, and reply on each thread as your brief's rules say. Then update your handoff note at \`${handoffFile}\`, and park: end your turn with a final message whose first line is \`PARKED: PR #<n> waits for <what>\`, and an \`orch-result\` block with outcome \`parked\`. Your next wake resumes at the \`${watchTier}\` tier.

Do not end this attempt with \`NEEDS FIX:\`: a fix you cannot make goes to your orchestrator as a decision. Stop as your brief's stop rules say when one applies.
`;
}

// Appended when the user asked to review a task's work before it lands (start --no-publish).
export function publishHoldNote() {
  return `

---

## Publishing

The user asked to review this work before it lands: do not commit, push, or open pull requests, and do not write to GitHub. Leave your changes in the working tree and list them in your final message.
`;
}

// Appended to every brief: a question an agent leaves open stalls the work. It decides what its
// brief covers, asks about the rest with `ask` while it keeps working, and hands back what is still
// open at the end in a form `orch.mjs` detects.
export function decisionNote(babysit) {
  return `

---

## Decisions

Questions reach whoever started you while you work, so never stop to wait for an answer, and never leave a point open as "pending a decision" (in a reply on GitHub or anywhere else). When you finish, the agent that started you is told at once.

- When you are blocked (a gate cannot run here, a credential or service is missing, or the same failure has survived two fix attempts), stop and report it right away in your final message, with the exact command and error. Do not keep retrying or work around it silently.
- Decide yourself whatever this brief's goal and scope cover, choosing what the brief, the repository's rules, and the existing code point to. List those choices in your final message.${babysit ? " For a reviewer's request: make it when it is within the pull request's scope; otherwise reply that it is a follow-up and list it in the pull request description." : ""}
- Hand back only a decision beyond this brief: one that changes its scope, the security posture, or the cost, or that needs something only the user has (an approval, a credential, a login). Ask it at once, and keep working: \`node ${CLI_PATH} ask "<question>" --options "a|b" --recommend a\`. The answer arrives as a message. Meanwhile do everything that does not depend on it${babysit ? ", and keep your loop going" : ""}; when only that is left, ${babysit ? "park as your brief says (the answer is a message, which wakes you) rather than waiting with \`nap\`: a parked wait spends no tokens, and a session held open pays for its whole context again when the wait returns" : `wait with \`node ${CLI_PATH} nap 5m\`, which returns as soon as a message arrives (an attempt's naps may add up to ${napBudgetText()}; past that, \`nap\` refuses and you finish as below)`}.
- If nothing else is left and no answer has come (or you cannot run \`ask\`), finish${babysit ? " and push" : ""} what you can, then end your session${babysit ? " (stop watching)" : ""} with a final message whose first line is \`NEEDS DECISION:\`, followed by one line per question with the options and your recommendation. The agent that started you decides and resumes this same session with the answer${babysit ? ", and you go back to your loop" : ""}.

## Keep the final message short

Use at most about 25 lines before the \`orch-result\` block. Give one line per changed file, the gate results, the decisions you took, and what is unresolved. Put long evidence (logs, tables, reproductions) in a file outside the repository, for example under \`$TMPDIR\`, and give its path. The \`orch-result\` block is not counted.

## Structured result

End your final message with this fenced JSON block (including when blocked or handing back a decision), after your human-readable report:

\`\`\`orch-result
{"outcome":"done","changed":[],"checks":[{"cmd":"node --test tests/","result":"not-run","note":"explain why"}],"decisions":[],"unresolved":[]}
\`\`\`

- \`outcome\`: \`done\`, \`partial\`, or \`blocked\`, according to whether the requested work is complete.
- \`changed\`: paths of files you changed, relative to your working directory.
- \`checks\`: one object per check with its \`cmd\`, \`result\` (\`pass\`, \`fail\`, or \`not-run\`), and a short \`note\` with counts or the reason it did not run; use your actual commands.
  - List the testing-skill or synthetic end-to-end check you ran (name the skill in its \`cmd\`), or one marked \`not-run\` with the reason in its \`note\`.
- \`decisions\`: questions beyond this brief, each as {"question":"...","options":["..."],"recommendation":"..."}; use [] when none. A choice you already made is not one: put it in the message. A non-empty list also requires the \`NEEDS DECISION:\` first line above.
- \`unresolved\`: remaining problems or unfinished work as strings; use [] when none.
`;
}

// Whether an entry of a report's `decisions` hands a question back. Agents also list there the
// choices they already made ("Merged 3 and 4 into one comment"), as plain text with no question.
// Such an entry needs no answer, so it must not hold the task open.
export function asksDecision(entry) {
  return typeof entry === "string" ? entry.includes("?") : Boolean(entry);
}

// The questions a finished agent handed back: the lines after a `NEEDS DECISION:` line in its final message.
const DECISION_RE = /^[\s>*_#-]*NEEDS DECISION:?[*_]*\s*(.*)$/im;
export function decisionsIn(text) {
  const m = DECISION_RE.exec(String(text || ""));
  if (!m) return null;
  const rest = String(text).slice(m.index + m[0].length).split("\n");
  const end = rest.findIndex((l, i) => i > 0 && !l.trim());
  const lines = [m[1], ...rest.slice(1, end === -1 ? undefined : end)].map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim()).filter(Boolean);
  return lines.length ? lines : ["(no question given; read the final message)"];
}

// Appended to a new attempt's brief: the tasks this agent started that still wait on it
// (runs.mjs, childrenWaitingOn). Their finish notices may have come while it was not running.
export function waitingChildrenNote(children) {
  if (!children.length) return "";
  const lines = children.map((c) => `- \`${c.name || c.task}\` in run \`${c.run}\` (${c.state}, ${c.kind}): \`node ${CLI_PATH} result ${c.run} ${c.task}\``);
  return `

---

## Tasks you started that wait on you

These finished while you were not running, or before you acted on them. Read each result, then \`accept\` it (with \`--note\`), resume it, or \`close\` it if you no longer need it:

${lines.join("\n")}
`;
}

// Appended to every model task's brief: what its model costs, where its budget comes from, and how
// to keep the work worth its cost (cost.mjs, commands/cost.mjs).
export function costNote({ agent, tier, model, price, defaultBudget }) {
  const rate = price ? ` at $${price.input} input and $${price.output} output per million tokens` : "";
  const fallback = defaultBudget ? `, or $${defaultBudget} (its default) until the tier has 5 finished tasks` : "";
  return `

---

## Cost

You run \`${model}\` (${agent} ${tier})${rate}. Your budget is the ${tier} tier's cost per accepted task on this machine${fallback}. Check it, and what you and the agents you started have spent, with \`node ${CLI_PATH} cost\` at each gate run and before you start agents. Past the budget, stop and judge before you spend more: when the task is harder than your tier, say so (\`node ${CLI_PATH} ask "<why>"\`, or end with \`NEEDS DECISION:\`); when you are going in circles, change the approach. Re-reading your context is most of the cost: keep long output (logs, diffs, query results) out of your session. Start an agent only when it pays for itself, at the cheapest tier that does its part well.
`;
}
