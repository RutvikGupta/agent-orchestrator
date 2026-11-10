# Tests, builds and memory

Read this before you run, or brief an agent to run, test suites, builds or containers.

## The heavy lane

- Wrap Docker-based test suites, builds and container runs in `$ORCH heavy -- <command>`.
- Use `--label "focused tests"` before `--` to name the work.
- Only heavy commands wait; this lane never limits agents or sub-agents. No agent count is capped.
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
