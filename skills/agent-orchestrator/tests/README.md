# CLI regression tests

Run from the skill root with Node 22:

```sh
env -u AGENT_ORCH_DEPTH -u AGENT_ORCH_RUN -u AGENT_ORCH_TASK node --test tests/
```

There are no npm dependencies. The tests use Node's standard library and the same
local `git`/process tools the CLI uses. `package.json` and `index.mjs` make the
explicit directory argument work on Node 22. Individual files can also be run with
`node --test tests/cli.test.mjs` or `node --test tests/dashboard.test.mjs`.

Every test creates a temporary repository, state root, home, skills folder, Claude
projects folder, and Codex sessions folder. The initial commit exists only in the
temporary fixture repository. Child environments are allowlisted: inherited
`AGENT_ORCH_DEPTH`, `AGENT_ORCH_RUN`, `AGENT_ORCH_TASK`, session IDs, git settings,
and Node preloads are excluded. Nesting tests explicitly set only their intended
depth. No real agents, network services, credentials, browser, or user state are
used; HTTP requests go only to the local dashboard on an ephemeral port.

The tests invoke the CLI in child processes and inspect its public output,
artifacts, and HTTP endpoints. They never import `orch.mjs` or its internal modules.
The only seeded CLI metadata is the launching-session identity in temporary
`run.json` files: ancestor process detection depends on the test runner's host, so
this connects transcript fixtures deterministically without impersonating a host
process. All other run/task bookkeeping is produced by CLI commands.

`fixtures/relay.mjs` is copied into each fake delegate skill. A brief can contain
`<!-- fake-relay {"status":"failed","error":"Usage limit reached"} -->`.
Supported controls are `status`, `finalMessage`, `delayMs` (capped at 30 seconds),
`error`, `extraEvents`, `touchedFiles`, `readOnlyViolation`, and `hold`. The fake accepts the
real relay arguments, records its invocation, emits agent-specific JSONL events,
and writes `result.json` and `final.txt`. SIGTERM writes a stopped result.

`f.ready(task)` waits for initial events and the SIGTERM handler to be installed.
`f.finished(run, id)` waits for both a terminal state and a parsed result. The CLI
can observe no result, then an exited PID, in a single status snapshot; that
temporary `aborted` row is not completion. Tests for genuinely missing results
wait for completion first and then remove the result, or explicitly poll for death.
`helpers.test.mjs` forces the read-result/exit interleaving for both provider and
usage-limit failures through a child-only preload.

Use `hold: true` and `f.release(task)` when the test must decide when a relay
finishes. An unreleased relay fails after 30 seconds. For changes that must happen
after `wait` has observed its initial state, use `f.waitAfterPoll(args, change,
opts)`. Its child-only preload signals the first polling interval and holds the
next callback until `change` completes, preserving the real three-second interval.
This avoids guessing CLI startup or retry timing with sleeps. Tests asserting
timeout behavior keep explicit deadlines; other handshake waits use timeout zero
and remain bounded by the command helper's watchdog.

Cleanup hooks close all fixture tasks, stop the exact dashboard child, wait for
its exit, verify its port can be rebound, and remove the temporary directory,
including when an assertion fails. Native transcript fixtures represent state;
they do not launch processes. There are currently no TODO tests.

External integrations (`agents --refresh`, live model calls, GitHub `pr-watch`,
publishing/babysitting, browser opening) are deliberately outside this local suite.
