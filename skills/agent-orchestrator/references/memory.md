# Tests, builds and memory

Read this before you run, or brief an agent to run, test suites, builds or containers, and when
`start` refuses an agent because the machine is full ("Agent admission", below).

## The heavy lane

- Wrap Docker-based test suites, builds and container runs in `$ORCH heavy -- <command>`.
- Use `--label "focused tests"` before `--` to name the work.
- Only heavy commands wait in this lane; it never limits agents or sub-agents. The machine limit on
  agents is a separate check ("Agent admission").
- Waiters enter in arrival order. A new message returns exit 6.
- `heavy` runs a program, not a shell function or alias. Run the script the function wraps, or
  `$ORCH heavy -- bash -ic '<function> <args>'`.

How it admits a command:

- An empty lane always starts a command at once.
- While another command runs, admission needs available memory above `AGENT_ORCH_HEAVY_MIN_FREE`
  (default `2.5GB`; set bytes, MB or GiB) and macOS memory pressure below critical (level 4).
  Warning pressure does not block admission.
- macOS uses the kernel's available-memory percentage, falling back to free and speculative pages.
  Linux uses `MemAvailable`, or free memory plus reclaimable slab when that field is absent.
  Inactive memory never counts.
- Admissions wait 20 seconds apart (`AGENT_ORCH_HEAVY_RAMP_MS`, in milliseconds), but only while the
  previously admitted command still runs, so its memory use can settle.
- Nested heavy calls run at once.
- Suspended or dead holders do not block the queue. Process start times keep a reused PID from
  holding a slot.
- An unwritable lane, or an unreadable process start time, prints one note and runs the command
  directly.
- Steering signals the outer heavy wrapper only. It forwards the signal once, waits for the
  command's cleanup, and never force-kills it.
- Commands keep the caller's stdio but cannot open `/dev/tty`.
- The dashboard's lane counts refresh at most every five seconds.

## Agent admission

`start` and `dispatch` check the whole machine before they launch a Claude or Codex agent. The
per-run parallel limit (`references/plan.md`, "Parallel limit") still applies: a start must pass
both.

What it checks:

- **Count.** Live Claude and Codex relays in every run under the state root count, not only your
  run's. Command tasks do not count.
- **The count limit** is `AGENT_ORCH_MAX_TOTAL`. Its default is 75% of the machine's RAM in GiB,
  rounded, and at least 4: 12 on a 16 GiB machine, 24 on 32 GiB. Setting it to `0` turns off the
  admission checks when `AGENT_ORCH_MIN_FREE_AGENT` is unset. Set that memory minimum explicitly
  to keep the memory checks with the count off.
- **Memory.** Available memory must not be below `AGENT_ORCH_MIN_FREE_AGENT` (default `1.5GB`; set
  bytes, MB or GiB, as for `AGENT_ORCH_HEAVY_MIN_FREE`), and macOS memory pressure must be below
  critical (level 4). Available memory is read as the heavy lane reads it (above). If the reading
  fails, one note is printed and that check is skipped. A measured zero still refuses a start.

The count is read from the live relays each time, not from a persistent counter, and the check and
the start share one machine-wide lock, so two starts at the same moment cannot both take the last
place. During an interrupt, a live claim keeps one place between the old relay stopping and its
replacement starting; the claim and relay never count twice. Dead holders release the lock.
A stopped holder is revoked and must check again when it continues. Lock waits last at most three
seconds (or the remaining `--wait` duration). If the lock cannot be used, or the process start time
cannot be read, one note is printed and the start skips the count check. Memory still applies.

When a start does not pass:

- `start` validates the request first. A bad request keeps its usual error and exit code.
  A valid request refused by admission prints the reasons, starts nothing and exits 7.
- `--force` does not bypass it. It skips plan checks only (`references/dispatch.md`).
- A resume or a rework is a new start, so it is checked the same way.
- The agent that takes the place of one that ended does not wait for the count. This covers a
  parked babysitter that its watcher resumes, a task that `wait` retries, and one that an interrupt
  restarts in its own session. Memory still applies: such a replacement never starts while
  available memory is below the minimum or macOS pressure is critical.

What to do:

- `$ORCH wait <run> <task-id>` waits for an existing task to finish, which frees a place. Then start
  again.
- `start ... --wait [DUR]` retries every few seconds, prints the reason once, and starts the task
  when there is room. `DUR` defaults to 10 minutes. It checks once more at the deadline, then
  exits 7 if still refused. A new message returns exit 6 without starting. It blocks like `wait`: in Claude Code, run it in the background
  (`SKILL.md`, "Setup"). A Codex orchestrator, whose shell calls time out, gives a `DUR` below the
  timeout and repeats the call.
- `dispatch` does not fail: it lists each ready task with the reason it waits. A later `dispatch`,
  or `dispatch --follow`, starts it when there is room (`references/dispatch.md`). Follow prints
  a new waiting notice only when the waiting tasks or the kind of limit change.
- `$ORCH agents` shows how many agents run, the count limit, and the available memory.
- Do not start agents through your host's own sub-agent tool to get around a refusal
  (`references/dispatch.md`, "Why never your host's own sub-agent tool").

## Keep test runs small

- Prefer the narrowest test target that proves the change. Leave a full suite to one agent.
- Reuse a running container instead of starting one per command, when the project allows it.
- Bound test workers: never `-n auto` or one worker per core. Use at most 2 parallel workers (for
  example `pytest -n 2`): each worker holds its own copy of the imports and fixtures.

## Clean up daemons

- Stop the containers and daemons you started when you are done.
- `$ORCH reclaim --dry-run` lists forgotten build daemons. `$ORCH reclaim` stops the ones with no
  live workspace owner and no running task.
- Reclaim recognizes `pantsd [/workspace]`. It skips Bazel and shared Gradle daemons: their command
  lines do not reliably identify a workspace.
- A task's cleanup covers only its managed worktree under the run folder. It never reclaims a main
  checkout or an external worktree.
- The dashboard checks for orphans every five minutes. `AGENT_ORCH_RECLAIM=off` disables it.

## Local agent environment

- Put optional environment values for agents in `~/.config/agent-orchestrator/agent-env.json`
  (`$XDG_CONFIG_HOME/agent-orchestrator/agent-env.json` when that is set).
- It is a flat JSON object, for example `{"PANTS_PANTSD_MAX_MEMORY_USAGE": "1GiB"}` to limit a Pants
  daemon. `start` merges it over the inherited environment.
- Keys starting with `AGENT_ORCH_`, plus `XDG_STATE_HOME`, `HOME`, `PATH` and `NODE_OPTIONS`, are
  ignored with a warning.
- Bad JSON warns once and does not block the task.
- Keep this file local, outside the repository.
