// What `start` appends to every brief, and how a finished agent's handed-back decisions are read.

import { CLI_PATH, MAX_NEST_DEPTH, parallelAt } from "./config.mjs";

export function nestingNote(depth) {
  return `

---

## Delegating further

Delegate through the agent-orchestrator skill (\`node ${CLI_PATH}\`; read its SKILL.md first, then \`new\` a run and \`start\` each agent) rather than doing things one after another:

- When the task has two or more independent parts, split it and start one agent per part.
- When it has slow side work (test suites, gates, builds, deploys, long runs, reviews, the other model's opinion), start an agent for it and keep working.

Pick the lightest tier that does each piece as well as the top one (its SKILL.md, "Choose the agent and model"): running tests or gates, reproducing a bug, lookups, mechanical edits, small well-specified changes, docs and reviews of small diffs usually fit \`light\` or \`standard\`. Name the deciding factor in \`--why\`. Do a few-minute or tightly coupled edit yourself. Do not weigh usage limits.

A test-running agent can work on your uncommitted code in this directory: start it with \`--force\` and a brief that forbids editing files. If an agent's own work has such parts, tell it in its brief to delegate them the same way. You are notified when an agent you started finishes, so do not poll.

Each agent's brief keeps every constraint of this brief (the agents you start never commit, push or publish; you do). Run at most ${parallelAt(depth)} at a time, review and integrate their results yourself, close them before you finish, and cover their work in your final report. When one of them finishes with \`NEEDS DECISION:\`, decide it yourself if this brief covers it and resume that agent's session with the answer; pass it up in your own \`NEEDS DECISION:\` only when it is beyond this brief. You are ${depth} level${depth === 1 ? "" : "s"} below the user's session; agents ${MAX_NEST_DEPTH} levels down cannot delegate.
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

// Appended to every brief: nobody answers a running agent, so a question it leaves open stalls the
// work. It decides what its brief covers and hands anything else back in a form `orch.mjs` detects.
export function decisionNote(babysit) {
  return `

---

## Decisions

Nobody reads your messages until your session ends, so never stop to wait for an answer, and never leave a point open as "pending a decision" (in a reply on GitHub or anywhere else).

- When you are blocked (a gate cannot run here, a credential or service is missing, or the same failure has survived two fix attempts), stop and report it right away in your final message, with the exact command and error. Do not keep retrying or work around it silently.
- Decide yourself whatever this brief's goal and scope cover, choosing what the brief, the repository's rules, and the existing code point to. List those choices in your final message.${babysit ? " For a reviewer's request: make it when it is within the pull request's scope; otherwise reply that it is a follow-up and list it in the pull request description." : ""}
- Hand back only a decision beyond this brief: one that changes its scope, the security posture, or the cost, or that needs something only the user has (an approval, a credential, a login). First finish${babysit ? " and push" : ""} everything that does not depend on it. Then end your session${babysit ? " (stop watching)" : ""} with a final message whose first line is \`NEEDS DECISION:\`, followed by one line per question with the options and your recommendation. The agent that started you decides and resumes this same session with the answer${babysit ? ", and you go back to your loop" : ""}.

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
- \`decisions\`: questions beyond this brief, each as {"question":"...","options":["..."],"recommendation":"..."}; use [] when none. A non-empty list also requires the \`NEEDS DECISION:\` first line above.
- \`unresolved\`: remaining problems or unfinished work as strings; use [] when none.
`;
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
