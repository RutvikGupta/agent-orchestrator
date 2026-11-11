# CLI regression tests

Run from the repository root with Node 22:

```sh
bash tools/test.sh                 # full suite
bash tools/test.sh --quick         # quick lane
bash tools/test.sh <file>...       # selected files
```

From the skill root, use `../../tools/test.sh` with the same arguments. The script
clears `AGENT_ORCH_DEPTH`, `AGENT_ORCH_RUN`, `AGENT_ORCH_TASK`,
`CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID`. It defaults to four workers normally
or two when delegated; set `AGENT_ORCH_TEST_CONCURRENCY` to override the count.
There are no npm dependencies; tests use Node's standard library and the same local
`git`/process tools the CLI uses.

Every test creates a temporary repository, state root, home, skills folder, Claude
projects folder, and Codex sessions folder. A shared immutable per-worker seed is
copied into independent temporary repositories. Child environments are allowlisted: inherited
`AGENT_ORCH_DEPTH`, `AGENT_ORCH_RUN`, `AGENT_ORCH_TASK`, session IDs, git settings,
and Node preloads are excluded. Nesting tests explicitly set only their intended
depth. No real agents, network services, credentials, browser, or user state are
used; HTTP requests go only to the local dashboard on an ephemeral port.

The tests invoke the CLI in child processes and inspect its public output,
artifacts, and HTTP endpoints. They never import `orch.mjs` or its internal modules.
The only seeded CLI metadata is the launching-session identity in temporary
`run.json` files: ancestor process detection depends on the test runner's host, so
this connects transcript fixtures deterministically. The helper sets `process.title = 'codex'`
to act as a fake nearest host, while process scans remain real. All other run/task
bookkeeping is produced by CLI commands.

`fixtures/relay.mjs` is copied into each fake delegate skill. A brief can contain
`<!-- fake-relay {"status":"failed","error":"Usage limit reached"} -->`.
Supported controls are `status`, `finalMessage`, `delayMs` (capped at 30 seconds),
`error`, `extraEvents`, `touchedFiles`, `readOnlyViolation`, and `hold`. A brief without that
comment, such as the one a parked babysitter's watcher writes, takes its controls from the
`FAKE_RELAY_CONFIG` environment variable (the same JSON). The fake accepts the
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
next callback until `change` completes. Fixtures poll every 100 ms; production
polling remains at 3000 ms.
This avoids guessing CLI startup or retry timing with sleeps. Tests asserting
timeout behavior keep explicit deadlines; other handshake waits use timeout zero
and remain bounded by the command helper's watchdog.

Cleanup hooks close all fixture tasks, stop the exact dashboard child, wait for
its exit, verify its port can be rebound, and remove the temporary directory,
including when an assertion fails. Native transcript fixtures represent state;
they do not launch processes. There are currently no TODO tests.

External integrations (`agents --refresh`, live model calls, GitHub `pr-watch`,
publishing/babysitting, browser opening) are deliberately outside this local suite.
