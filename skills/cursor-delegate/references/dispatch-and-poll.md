# Dispatch and poll

Authenticate with Cursor Agent before dispatching. Run the relay with an absolute output directory
for each attempt so a supervisor can identify the process and poll its artifacts.
Reusing an output directory sequentially replaces the artifacts and creates a fresh private
permission profile.

```sh
node /path/to/cursor-delegate/scripts/relay.mjs \
  --brief /path/to/brief.md --cd /path/to/worktree --out-dir /path/to/attempt-1 \
  --model gemini-4-hydrogen --effort low --sandbox disabled --timeout 20m
```

Omit `--brief` to read stdin. The relay sends the brief to Cursor over stdin in both cases. Add
`--session ID` with a fresh output directory and a new brief to resume the same chat.

While it runs, follow `events.jsonl` for Claude-shaped progress and `cursor-events.jsonl` for
Cursor's original output. When the relay exits, read `result.json` for status, session ID, changed
paths and token counts, `final.txt` for the report, and `stderr.txt` for diagnostics. Cursor's
`inputTokens` excludes cache reads. In one live session the initial turn reported 15,254 fresh and
17,710 cache-read tokens, and the resumed turn reported 4,417 fresh and 18,322 cache-read tokens.
Cursor supplies token counts without dollar cost, and only in its final event.

**The running estimate.** Until that final event, the relay estimates each model call and puts the
estimate on that call's assistant events in `events.jsonl` (`message.id` is Cursor's
`model_call_id`; `message.usage` uses Claude's field names), so a reader shows a running total marked
as an estimate. A call reads the whole context so far: a fixed base for Cursor's own prompt and the
project's rules, the brief, and every tool call and the part of each result the model sees (not an
edit's full file before and after); most of it from the cache the previous call wrote. It writes its
thinking, tool calls and text. Cursor's final totals then replace the estimate in the reader and in
`result.json` (`usage`), which also keeps what the estimate came to (`usageEstimate`). Each run with
at least three model calls also corrects the estimate for its model: the relay keeps a factor per
base model in `usage-calibration.json` under `$CURSOR_DELEGATE_STATE`, else
`$XDG_STATE_HOME/cursor-delegate`, else `~/.local/state/cursor-delegate`. A run that ends without
Cursor's totals keeps its estimate and corrects nothing.
`result.json` keeps the supplied base ID in `model` and the selected effort in `effort`.
`cursorModel` holds the ID passed to Cursor, including the effort suffix when supplied. If Cursor
selects its default, the relay records the model name from its init event when available.

Repeat `--allow` and `--deny` with quoted Cursor rules. This version matched
`Shell(gh pr merge *)`, `Shell(git push --force*)`, `Read(/abs/dir/**)` and `Write(/abs/file)`.
The relay accepts `Shell`, `Read`, `Write`, `WebFetch` and `Mcp` rules.
[Cursor CLI permission syntax](https://cursor.com/docs/cli/reference/permissions)
The private per-run profile combines those rules with the user's allow and deny lists and the
`.cursor/cli.json` permissions from the git root through the working directory. Cursor's own
project loader replaces arrays, so the relay passes `--disable-project-configs` after merging
the project rules.
`projectConfigPaths` in `result.json` lists the merged files. An unreadable or malformed project
config fails dispatch. The profile shares the chat store with the parent Cursor config.

For `--read-only`, Plan mode can run `git diff --stat`. The relay adds both `Write(**)` and
`Write(**/*)`. The latter blocked both Write and StrReplace in Plan mode. `Write(**)` alone
allowed Markdown edits. Rules named `Edit`, `StrReplace`, and `editToolCall` also allowed the edits
in a combined test. Ask mode hid those tools, but a shell redirect still changed a tracked file.
Shell calls use separate permissions. The tripwire compares git status and fingerprints dirty and
ignored files and their index entries. A proven change sets `readOnlyViolation: true` and fails an
otherwise successful run. Incomplete coverage, such as an unreadable path, nested repository, or
exceeded fingerprint budget, yields `null` unless another check proves a change.
