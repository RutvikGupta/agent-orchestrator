# Demo board

A self-contained dashboard to take screenshots from. It shows a fictional project,
`example-org/example-shop`, with three launching sessions and their tasks in every state.

```bash
node docs/demo/seed.mjs --port 4790        # any free port except 4777, the live dashboard's
```

It prints the dashboard's address with the send key (`#token=...`), the run ids, and a `status`
command for the CLI views. Open the address to see the board and send messages to running tasks.
Stop it with Ctrl-C, or by creating the stop file it prints (`--stop-file FILE` chooses one). It
then stops only the processes it started, by PID, and deletes its temporary folder.

Everything lives in a new temporary folder, set as `AGENT_ORCH_HOME`, `CLAUDE_CONFIG_DIR` and
`CODEX_HOME`; it never reads or writes the live state, `~/.claude` or `~/.codex`. No model runs:
`relay.mjs` plays back the scripted sessions in `story.mjs` through the real CLI. Edit `story.mjs`
to change what the board shows.

What it shows:

- A Claude Code session running "one-page checkout": tasks on Claude and on Codex at both tiers,
  in write and read-only mode, running, awaiting review, needing a decision, failed, and closed. It
  also holds a pull-request babysitter, a nested run under `promo-codes`, and two native sub-agents.
  Its plan has two dependency chains, and two planned tasks that have not started.
- A Codex session whose run has an accepted task, a closed research task and a running benchmark.
- A Claude Code session with no run, shown through its sub-agents.
- The attention lane, an inbox with a read message, the agent's reply and a queued message (on
  `cart-totals`), and both agents' usage limits.
