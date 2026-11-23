# Dispatch and poll

Authenticate with Cursor Agent before dispatching. Run the relay with an absolute output directory
for each attempt so a supervisor can identify the process and poll its artifacts.

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
Cursor supplies token counts without dollar cost.

Repeat `--allow` and `--deny` with quoted Cursor rules. This version matched
`Shell(gh pr merge *)`, `Shell(git push --force*)`, `Read(/abs/dir/**)` and `Write(/abs/file)`.
The private per-run profile combines those rules with the user's allow and deny lists and the
`.cursor/cli.json` permissions from the git root through the working directory. Cursor's own
project loader replaces arrays, so the relay turns it off after merging the project rules.
`projectConfigPaths` in `result.json` lists the merged files. An unreadable or malformed project
config fails dispatch. The profile shares the chat store with the parent Cursor config.

For `--read-only`, Plan mode can run `git diff --stat`. The relay adds both `Write(**)` and
`Write(**/*)`. The latter blocked both Write and StrReplace in Plan mode. `Write(**)` alone
allowed Markdown edits. Rules named `Edit`, `StrReplace`, and `editToolCall` also allowed the edits
in a combined test. Ask mode hid those tools, but a shell redirect still changed a tracked file.
Shell has a separate permission surface. The relay records
`readOnlyViolation: true` and a failed status when git status changes. A file change that leaves
porcelain status identical can escape this check.
