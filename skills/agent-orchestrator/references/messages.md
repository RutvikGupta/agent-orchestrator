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
  answers: the session with `send`, or the user from the dashboard's box. The other's message never
  clears it.
- A session's question shown to the user, because that session is gone, clears on the user's reply.

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
