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

`$ORCH tell "<text>"` sends the parent a one-way note, such as "pushed #123". It needs no answer and
never reaches the user. Agents report status with `tell`, and use `ask` only for decisions.

- When the parent is a task, the note goes into that task's inbox, marked as needing no answer.
- In a top-level run, the note goes to the launching session's `wait` on the run. It does not end
  that `wait`: `wait` holds it and prints every held note, oldest first, with its next exit of any
  kind, the timeout included. A note sent while no `wait` ran prints with the next one's exit.
  Each note prints once.
- `wait --notes` ends at the first new note instead, with exit 6.

## Steering a running agent

Steer an agent instead of stopping it, for example to pass on a constraint that another agent just
found:

```bash
$ORCH send <run> <task-id> "<message>" [--steer]    # or --file FILE
```

- A Claude agent gets the message as context after its next tool call, through the user's
  `PostToolUse` hook. A Codex agent reads it with `$ORCH inbox <run> <task-id> --ack` at each gate,
  as its brief tells it.
- Every brief tells agents to wait with `$ORCH nap <duration>`, `wait` or `pr-watch`, which return as
  soon as a message arrives.
- Send only what the agent needs. A change of goal or scope still goes through a resume with a delta
  brief (`references/review.md`, "Rework").

### The interrupt

`--steer` (the interrupt) is for a message the agent must act on now. It delivers the message at
once, whatever the agent is doing, and says which of these it did:

- **In a shell command:** it stops that command, so the tool call returns and the message reaches
  the agent. The agent reruns the command if it still needs it. A commit, push, rebase, merge or
  other publishing command is never stopped: the message waits for it.
- **Mid-turn, but not in a shell command** (in a model call, or in another tool such as an edit or a
  sub-agent): it stops the session and resumes it in the same session, with the unread messages as
  its next prompt.
- **Idle:** the same resume (see below).

A resume keeps the task's agent, tier, mode, worktree and brief. It is recorded as a new attempt
with the reason `interrupt`; the stopped attempt shows as `interrupted`, and it is neither a counted
failure nor a rework round. The task stays `running` for `wait`, the parallel limit and the plan,
also in the moment between the two relays. The stopped attempt sends its parent no finish notice;
the resumed one reports to the same parent at the same depth. The resumed prompt says the session
was interrupted to deliver a message, and that its background commands were stopped with it, so the
agent can start again what it still needs. When two senders interrupt at once, one resumes the
session and the other only adds its message, which that resume or the hook delivers.

A resume is refused, with the reason, and nothing changes, for:

- a babysitter, running or parked: its park watcher delivers messages;
- a command task: it has no session and no agent;
- a task whose session id is not known yet, just after it started;
- a sandboxed Codex task with the network on: the Codex relay cannot resume its session.

`$ORCH steer <run> <task-id>` does the same for messages already queued, and so does "Send now" on
the dashboard.

### Idle

An idle agent waits on a background command of its own. A Claude agent can end its turn while a command it started in the background still runs (for
example `bash watch.sh`, started with `run_in_background`). Its process stays alive, but it reads no
message until that command ends and its next turn starts. Such a task is **idle**:

- `status`, `wait` and the dashboard show it as running, with the activity "idle: ended its turn and
  waits on its own background command `<command>`". Its row has `idle`.
- With a message unread, it needs attention at once: `wait` exits 5 with an `unreachable` item, and
  the dashboard's attention lane lists it. It is not left until it shows as silent after 15 minutes.
- A plain `send` stores the message and says the agent will not read it until its own wait ends,
  with the commands that deliver it now: `$ORCH steer <run> <task-id>`, or `send ... --steer`.
- A message from the dashboard's box interrupts an idle task at once, since nothing else would
  deliver it.

A Codex agent is never idle: `codex exec` ends its process when its turn ends. An interrupt of a
Codex agent that is not in a shell command resumes its thread the same way.

### When the agent reads its messages

`$ORCH inbox <run> <task-id>` (without `--ack` or `--all`), run by anyone but the agent itself,
prints one line above the unread
messages that says when the agent will read them: after its next tool call; when its current shell
command ends; not until its own background command ends (idle); when its watcher wakes it (parked);
or at its next `inbox` (Codex). Where an interrupt would deliver them now, a second line gives the
command. The dashboard shows the same line above its message box. In `status --json`, a task row's
`inbox.delivery` holds it as `{ how, text, steer }`.

## Messages from the user

- The user can message a running task from the box under its details panel on the dashboard.
- The agent sees those as from the user and answers each with
  `$ORCH reply <run> <task-id> "<answer>"`. The dashboard shows the answer under the message and in
  the agent's log.
- `inbox <run> <task-id> --all` lists what was sent and read, and the answers; the dashboard marks
  unread messages.
- Only a tab opened by `dashboard --open` gets the key that sending needs. `dashboard --open
  --new-tab` gives it to a browser whose tab was opened another way.
