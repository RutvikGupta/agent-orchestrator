---
name: cursor-delegate
description: >-
  Run Cursor Agent headlessly as a delegated implementer or reviewer, then verify its result.
  Use when a task calls for delegation to the Cursor CLI, including Gemini models run through Cursor.
license: MIT
compatibility: Requires the authenticated Cursor Agent CLI (agent), Node 22+, and git. Examples use bash or zsh.
metadata:
  version: 0.1.0
---

# Cursor Delegate

Write a bounded brief, run the relay in a dedicated worktree, and inspect the result and diff before
accepting it. Use the [brief guide](references/writing-the-brief.md) and the
[dispatch and polling guide](references/dispatch-and-poll.md).

Use `--read-only` for review. It uses Cursor Plan mode, file-write denies, and a tripwire that checks
git status, dirty and ignored files, and index entries. Cursor can still run shell commands in
this mode. A tripwire result of `null` means coverage was incomplete.
On Cursor 2026.11.22, `Write(**/*)` blocked file creation and StrReplace. `Write(**)` by itself
allowed Markdown edits. Use `Write(/abs/file)` to block edits to a specific file.

The relay combines the user's, project's and caller's allow and deny lists in one profile.
Cursor otherwise replaces the global lists with project lists. An invalid project config stops
dispatch and appears in the relay result.
