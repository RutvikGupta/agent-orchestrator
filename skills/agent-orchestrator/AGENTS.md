# Working on the agent-orchestrator skill

This folder is the user's Agent Orchestrator skill, part of the repository at `~/agent-orchestrator`
(GitHub: `RutvikGupta/agent-orchestrator`, private). It is used live every day, from Claude Code and
from Codex: `~/.agents/skills/agent-orchestrator` is a symlink to this folder, so it is what every
session runs. The repository's own `AGENTS.md`, one level up from `skills/`, holds the rules for
committing and pushing.

## Layout

- `SKILL.md` is the instructions agents follow. `references/` holds the agent notes, the babysitter
  brief and the brief templates (`references/briefs/`).
- `scripts/orch.mjs` is the CLI entry point: help text, option specs and the command table.
- `scripts/lib/` holds the modules, with one module per group of commands in `lib/commands/`.
  `lib/runs.mjs` holds run and task state; `describe()` builds each task's row and spreads in
  `lifecycleFields` (`lib/lifecycle.mjs`) and `reportFields` (`lib/report.mjs`).
- `scripts/dashboard/` holds the web page (`index.html`, `app.js`, `app.css`, `logo.svg`), which the
  server reads once at startup.
- `tests/` holds the `node:test` suite. It drives the CLI as a child process against temporary
  folders and fake relays (`tests/helpers.mjs`, `tests/fixtures/`). Import internal modules only
  for pure functions that fixtures cannot reach.

## Rules

- Run the suite with `env -u AGENT_ORCH_DEPTH -u AGENT_ORCH_RUN -u AGENT_ORCH_TASK node --test tests/`.
  Delegated agents have those variables set, and they change parallel limits and nesting.
  `tests/index.mjs` loads every `*.test.mjs` file.
- Tests synchronize with the helpers' handshakes, never with sleeps: `f.finished` waits for a
  finished result, `f.ready` and `f.release` (with the fake relay's `hold`) decide when a relay
  ends, and `f.waitAfterPoll` changes a fixture after `wait`'s first poll. A relay can publish its
  result and exit between two reads, so a guessed delay is flaky. `tests/README.md` has the details.
- Never use the live state root (`~/.local/state/agent-orchestrator`) or the live dashboard port
  (4777) in tests or experiments. Use temporary folders through `AGENT_ORCH_HOME`,
  `AGENT_ORCH_SKILLS_DIR`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and a free port.
- Run the copy of `scripts/orch.mjs` in your own working directory, not the live one.
- Never run `pkill`, `killall` or `kill $(pgrep ...)`; hooks block them. Stop only processes you
  started, by PID.
- Keep CLI output, exit codes, file formats and HTTP endpoints stable unless the task changes them.
  Other sessions and agents parse them.
- `SKILL.md` and the references use plain English, short sentences, and terms defined on first use.
  Update them when behavior changes, and keep `SKILL.md` near 600 lines.
- No dependencies beyond Node's standard library.
