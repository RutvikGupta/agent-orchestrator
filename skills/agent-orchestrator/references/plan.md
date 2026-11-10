# The plan (steps 1 and 2)

Read this before you write a plan or change one. `SKILL.md` step 1 holds the rules on splitting,
the user's choices, and when to ask before dispatching.

## Its shape

```json
{"goal": "one line: the user's original request", "acceptance": ["required behavior 1", "..."],
 "tasks": [{"id": "parser-fix", "goal": "one sentence with a verifiable outcome", "type": "implement",
   "owns": ["src/parser/"], "uses": ["token-api"], "produces": ["parse-error-format"], "resources": ["port:8080"],
   "dependsOn": ["lexer"], "agent": "codex", "tier": "standard", "why": "a well-specified 3-file change",
   "readOnly": false, "brief": "briefs/parser-fix.md"}]}
```

| Field | Meaning |
| --- | --- |
| `goal` | The plan's: the user's original request. A task's: one sentence with a verifiable outcome |
| `acceptance` | The request restated as checkable behaviors; step 7 checks every one before you report |
| `id`, `type` | A short lowercase slug; `implement`, `review`, `research`, `debug`, or `babysit`, which picks the brief template |
| `owns`, `readOnly` | Files or directories the task may change; `readOnly: true` (reviews, investigations, research, second opinions) owns nothing |
| `uses`, `produces` | The interfaces or contracts the task relies on, and those it creates or changes |
| `resources` | Shared runtime state it needs: `port:8080`, `db:local-postgres`, `file:generated/schema.json` |
| `dependsOn` | Task ids that must be integrated before this task starts |
| `agent`, `tier`, `why` | The agent, its tier (Claude `light`, `standard`, `complex` or `frontier`; Codex `light`, `standard`, `strong` or `complex`; required, except that a babysit task may leave it out), and your one-line assessment |
| `brief` | The brief file, relative to the run directory |

## Disjoint files are not enough

Two tasks that own different files can still break each other:

- one changes an interface that the other calls;
- both assume different shapes of a contract;
- both bind the same port, migrate the same database, or regenerate the same file.

`uses`, `produces` and `resources` make these explicit. When a task uses what another produces,
make it depend on the producer, or settle the interface's exact shape in both briefs before either
starts.

## Parallel limit

- At most 8 tasks run at once by default. `AGENT_ORCH_MAX_PARALLEL` overrides it.
- Runs that delegated agents start allow fewer: 6 at the second level, 4 at the third, and 2 at the
  fourth.
- Agents below the fourth level (`AGENT_ORCH_MAX_DEPTH`, default 4) cannot delegate.

## Recording it

- `new` records the repository root, the current branch, the `HEAD` commit, and which session
  launched the run (the orchestrator's Claude session id when available).
- Write the plan file outside the repository, for example as `<run-dir>/plan-draft.json`.
- `plan` validates it, including conflicts between tasks that can run at once: overlapping owned
  paths or a shared resource. Fix what it reports: add a dependency, split the path or resource,
  or merge the tasks.
- Record every later change the same way. `--check` only validates.
- The briefs need not exist yet: `plan` lists the ones still to write, and `brief` drafts them.
