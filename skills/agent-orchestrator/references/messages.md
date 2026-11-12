# Messages, questions and steering

Read this before you steer or message a running agent, or answer one. How to decide what an agent
hands back is in `SKILL.md`, "Decisions agents hand back".

## Finish notices

When an orch task started a task, it gets one inbox message from `agent:<run>/<task>` when each
attempt ends: ready for review, needs a decision (with the questions), or failed (with the error's
first line), plus the `result` command. `nap`, `wait` and `pr-watch` wake on it (exit 6). The user's
session gets none; its `wait` wakes on the result.

## Questions

- A running agent asks with `$ORCH ask "<question>" [--options "a|b|c"] [--recommend a]` and keeps
  working.
- The question reaches the parent task's inbox. In a top-level run it reaches the launching session
  as a `question` that wakes its `wait` (exit 5).
- It goes to the user only with `--user`, when the parent will not read it, or once that agent is
  gone.
- Answer with `$ORCH send <run> <task-id> "<answer>"`. A question clears once its own addressee
  answers: the session or the parent task with `send`, or the user from the dashboard's box. The
  other's message never clears it.
- A session's question shown to the user, because that session is gone, clears on the user's reply.
- `wait`, the dashboard and the Stop hook show only a line of each question. Read them whole with
  `$ORCH questions` (below).

### Reading questions in full

```bash
$ORCH questions <run> [<task-id>] [--all] [--json]
```

- It prints every open question of the run, or of one task: its id, the task and attempt that
  asked, when, to whom, the whole text, every option, the recommendation, and the command that
  answers it. Nothing is cut short.
- A question is **open** while nobody has answered it and the attempt that asked it still runs.
- `--all` also lists the answered questions, each with when it was answered and the id of the
  answering message. It also lists the questions whose attempt ended before an answer came.
- With no open question it says so. It exits 0 either way.
- `--json` gives `{run, task, counts, questions}`. Each question has `state`: `open`, `answered`
  or `unanswered` (its attempt ended first).

### The answer record

A task's questions and their answers live in two files in its folder, `tasks/<task-id>/` in the
run's folder. Both are only ever appended to; no line is ever rewritten.

- `questions.jsonl` holds one line per question, as `ask` wrote it.
- `answers.jsonl` holds one line per answer: `question` (the question's id), `answeredAt` (when the
  answering message was sent, ISO 8601) and `answerMessage` (that message's id in the task's
  `inbox.jsonl`).

A question with no line in `answers.jsonl` has not been answered, unless it was answered before
answers were recorded (see the end of this section). If two lines name the same question, the
first counts. `questions`, `wait`, the dashboard, `send` and the Stop hook all
join the two files by question id, through `readQuestions` in `scripts/lib/inbox.mjs`.

The answer is the first message sent to the asking task after the question, in the same attempt,
by the question's own side:

- for a question to the user, a message from the dashboard's box;
- for one to the launching session, a `send`, or the user's reply when the question was shown to
  the user because the session was gone;
- for one to the parent task, a `send` (the parent answers that way).

A notice the orchestrator writes itself (a finish notice, a child's question or note, an attention
or owner notice) never answers. `send` and the dashboard's box append the answer line as they
deliver the message.

- `ask` writes the question before its notice reaches the parent, so the parent's answer always
  comes after it. It also records any answer sent while it was writing the question.
- A question asked before answers were recorded gets its line when it is answered from now on.
- A question answered before answers were recorded has no line. Its answer is still found from the
  task's messages by the rule above, and `questions --all` shows it.

## Notes

`$ORCH tell "<text>"` sends the parent a one-way note, such as "pushed #123": into its inbox, or
printed by the session's next `wait` (exit 6). It needs no answer and never reaches the user. Agents
report status with `tell`, and use `ask` only for decisions.

## Steering a running agent

Steer an agent instead of stopping it, for example to pass on a constraint that another agent just
found:

```bash
$ORCH send <run> <task-id> "<message>" [--steer]    # or --file FILE
```

- `--steer` is for a message the agent must act on now. It stops the agent's current shell command
  (never a commit, push, rebase, merge or other publishing command) so the message reaches it at
  once. The agent reruns the command if it still needs it.
- Every brief tells agents to wait with `$ORCH nap <duration>`, `wait` or `pr-watch`, which return as
  soon as a message arrives.
- A Claude agent gets the message as context after its next tool call, through the user's
  `PostToolUse` hook. A Codex agent reads it with `$ORCH inbox <run> <task-id> --ack` at each gate,
  as its brief tells it.
- Send only what the agent needs. A change of goal or scope still goes through a resume with a delta
  brief (`references/review.md`, "Rework").

## Messages from the user

- The user can message a running task from the box under its details panel on the dashboard.
- The agent sees those as from the user and answers each with
  `$ORCH reply <run> <task-id> "<answer>"`. The dashboard shows the answer under the message and in
  the agent's log.
- `inbox <run> <task-id> --all` lists what was sent and read, and the answers; the dashboard marks
  unread messages.
- Only a tab opened by `dashboard --open` gets the key that sending needs. `dashboard --open
  --new-tab` gives it to a browser whose tab was opened another way.
