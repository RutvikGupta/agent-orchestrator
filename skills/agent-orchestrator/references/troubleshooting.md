# Troubleshooting

Read this when a command, task or gate fails in a way the step you are on does not cover, and when
you find a bug in the skill itself ("Report a bug in this skill", below).

| Symptom | Action |
| --- | --- |
| `start` says that no relay was found | Install the delegate skill: `npx skills add amElnagdy/delegate-skills -g -s claude-delegate` (or `codex-delegate`); check that `AGENT_ORCH_SKILLS_DIR` is not set to another folder |
| `<cli>_unavailable` | The CLI is not on `PATH`: install it, or fix `PATH` for non-interactive shells |
| `failed`, with auth errors in the log | Ask the user to log in: `claude auth login` or `codex login` |
| `USAGE LIMIT` in `wait` or `result` | The agent's usage window is used up: ping the user and resume on the other agent (`SKILL.md`, "Usage limits") |
| You lost track of what runs (restart, compaction) | `$ORCH recover`, then act on what it lists (`SKILL.md`, "Setup") |
| Results sat unread while the session was alive (the notice says it "is not reading its results") | The session was stopped in a question dialog or a long turn: nothing reaches a Claude Code session while a dialog is open. Answer the dialog, then have the session run `$ORCH recover` and handle what it lists. Register `scripts/hooks/orch-ask.mjs` (`integrations/claude/settings.example.json`), which refuses the dialog while tasks run (`references/monitor.md`, "Question dialogs") |
| "No agent named ... is reachable" for a session you expect to run, or a `claude --resume` / `start ... -- --session` that is refused because the session is "still running" | The session restarted under a new name, and is not gone. Find its new name by its session id in `ListAgents` or `claude agents --json`, and message that; never resume a running session (`references/messages.md`, "Reaching another session"). `AGENT_ORCH_RESUME_GUARD=off` turns the hook off |
| Claude reports that it is logged out when the orchestrator is Codex | Codex's sandbox blocks the macOS Keychain; re-run the `$ORCH` command with escalated permissions |
| A read-only Codex task cannot run network-dependent commands | Its read-only sandbox has no network; run it as a write task with a brief that forbids edits |
| A `--sandbox` Claude task reports `deny network-outbound <host> (user denied)` | The task ran with `--offline`, or the relay patch is missing (`start` printed a note, and `agents` warns). Re-apply the patch with the command that the note prints, then resume the task |
| A `--sandbox` Claude task's `git fetch`, `git push`, or `gt submit` fails with `policy_refusal` or `ssh_dispatch_run_fatal` | The sandbox refuses SSH. Sandboxed tasks started by this version of `orch.mjs` reach GitHub over HTTPS automatically; resume an older task so that it starts with the rewrite, or run it without `--sandbox` |
| `pr-watch` cannot read the pull request | Run it outside any sandbox; check `gh auth status`; pass `--repo` with a checkout of the pull request's repository, or the pull request URL |
| `start --babysit` says that the relay has no `--allow-publish` option | An update of `claude-delegate` replaced the local relay patch; re-apply it with the `patch` command that the error prints |
| `timeout`, `dead`, `silent`, `quiet` for a long time, or a transient error after `retried <task>` | Check `log`, then resume the session (`wait` prints the command) with a narrower delta brief, split the task, or start it fresh |
| A gate needs Docker, a database or other host services that a sandboxed task (Claude `--sandbox`, or a Codex sandbox) cannot reach | Tell the implementer to skip that gate, and run it yourself during review |
| Worktree gates fail on missing dependencies or ignored files | See `references/worktrees.md`, "Preparation" |
| `start` refuses with `counted failures at <agent> <tier>` | Start the agent and tier that it names, with a fresh brief and a new `--why` (`references/review.md`, "Escalate a tier") |
| `start` refuses a task that is `not in the plan`, `waits on` another, or `conflicts with running task` | See `references/dispatch.md`, "Plan checks" |
| `start` refuses because a task's folder was collected | Run the `worktree` command that it prints (`references/worktrees.md`, "Restoring a collected worktree") |
| `accept` refuses with `a passing check matched a failed run` | Rerun the gate with `verify`, then fix the work or record why with `--unverified` (`references/review.md`, "Accept") |
| `accept` says the working directory is gone | If it was removed on purpose, pass `--unverified "<reason>"` to record acceptance without a commit. |
| The board shows `⚠ ... exceeds the <tier> ceiling` | See `references/dashboard.md`, "Model ceiling warnings" |
| Every command prints `orch: the skill changed since this session loaded it` | See `references/monitor.md`, "Skill changes" |
| `nap` refuses, saying the attempt's naps already add up to its budget | The attempt used `AGENT_ORCH_NAP_BUDGET` (default `10m`). Do not wait in the session: record the wait with `$ORCH park-until -- <command that exits 0 once it is done>`, then end the turn with `PARKED: waits for <what>` (`references/monitor.md`, "Parked tasks") |
| A task said `PARKED:` and ended `completed`; `result` prints `not parked: ...` | Nothing would wake it: it recorded no wake condition with `park-until` in that attempt, and no task it started was still running when it ended. A command task never parks. Resume it by hand, and have it run `park-until` before it ends with `PARKED:` |
| `park-until` refuses (exit 2) | Read its message. It refuses outside a task, in a command task, with `--every` below `30s`, with `--for` above `24h`, and when the command is neither a file nor a program on `PATH`. Run it in the task's own shell, with a command the watcher can run |
| A babysitter shows `needs-decision`, with a `NEEDS FIX:` text | Its watch attempt asked for a fix and none started: the inherited ceiling (`AGENT_ORCH_MAX_TIER`) forbids `complex`, the attempt already ran at `complex`, or no fix attempt started within 15 minutes. `result` says which. Decide what to do, then resume it by hand (`references/babysit.md`, "Watching and fixing") |
| An agent's context grows very large | A Claude agent compacts its context at `AGENT_ORCH_CLAUDE_COMPACT_WINDOW` (default `300k`); its `result` shows the value on the `compact window:` line. `off`, or a `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set in the environment or `agent-env.json`, leaves Claude Code's default, which compacts a 1M-window session only near 967k tokens: remove it, or set a value from `100k` to `1M`. Codex is not capped (`references/monitor.md`, "Context cap of Claude agents") |

## Report a bug in this skill

Report it when you find a bug in the orchestrator or the delegate skills (`orch.mjs`, a relay, a
hook, the dashboard, or these instructions), or a change that would clearly save real work. Do not
report one-off friction, your own mistake, or something the skill already documents, unless you
propose changing it.

- **Who gets it.** The session that maintains the skill: the one that works on the skill's own
  repository, the folder that `<skill-dir>` links to (`$ORCH skill` prints the skill folder). The
  dashboard lists that repository's runs with the session that launched them, and in Claude Code
  `ListAgents` lists the sessions you can message. If you cannot tell which session it is, or it is
  not running, give the report to the user instead.
- **What to send.** One message per issue (`SendMessage` in Claude Code): what you ran, what
  happened, what you expected, and the run ids or paths that show it. Say whether it is a bug or a
  suggestion.
- **A delegated agent** cannot message another session. It sends the report to whoever started it,
  with `$ORCH tell`, or lists it under `unresolved` in its final report. An orchestrator that
  receives one passes it on as above.
- **Do not edit the skill yourself.** It is installed live, so an edit reaches every session at
  once. Work around the bug, keep going, and do not send the same issue twice.

The maintaining session reproduces a report before it changes anything, and replies to the sender
with what it changed, or why it changed nothing.

## Agents died when the terminal was quit

On macOS, quitting the terminal application ends every process started under it, even detached
ones and ones in a tmux session that was started from that terminal. `orch.mjs` starts relays,
watchers and the detached dashboard through a one-off launchd job, so they survive
(`references/agents.md`, "Agents outlive the terminal").

- Run `$ORCH agents`. If its "agents outside the terminal" line says `no: AGENT_ORCH_LAUNCHD=off`,
  remove that setting. If it says `no: launchctl was not found`, put `/bin` back on `PATH`. If it
  names a folder macOS guards, the repository is in Desktop, Documents, Downloads, iCloud Drive or
  on another volume: move it, or allow `node` there and set `AGENT_ORCH_LAUNCHD=on`.
- `$ORCH result <run> <task>` shows `launch: direct, not through launchd (<reason>)` when an
  attempt fell back to a direct start.
- The terminal session that launched the agents always ends with the terminal. Resume it, run
  `$ORCH recover`, and resume any killed task with `start`.
- To keep the dashboard up through a quit, run it under launchd yourself (a job with `KeepAlive`
  that runs `orch.mjs dashboard` in the foreground), not with `dashboard --detach` from a terminal
  that may be quit before the first agent starts.

## A command hangs, or fails with "Operation not permitted", in Desktop, Documents or Downloads

On macOS an agent started through launchd does not have the terminal's access to the folders
macOS guards (`references/agents.md`, "Agents outlive the terminal"). Its first read of one waits
for a prompt, "node would like to access files in your ... folder", and fails with `Operation not
permitted` if the answer was Don't Allow.

- Answer Allow, once for each folder. To change an earlier answer, open System Settings, Privacy &
  Security, Files and Folders, and turn the folder on for `node`.
- To keep every agent under the terminal instead, set `AGENT_ORCH_LAUNCHD=off`. Quitting the
  terminal then ends the agents.
