# Tiers: cost and evidence

Read this before you choose Claude `frontier`, and when cost, the models, a tier's measured results or
the choice between the agents bear on a decision. How to choose a tier is in `SKILL.md`, "Choose the agent and model"; `../policy.json`
holds each tier's model, effort and one-line use.

## The models

| Agent | `light` | `standard` | `strong` | `complex` | `frontier` |
| --- | --- | --- | --- | --- | --- |
| Claude | `claude-haiku-5-5`, `xhigh` | `claude-sonnet-5-5`, `xhigh` | | `claude-opus-5-5`, `xhigh` | `claude-fable-5-2`, `high` (never above) |
| Codex | `gpt-6-luna`, `medium` | `gpt-6.1-terra`, `medium` | `gpt-6.2-sol`, `medium` | `gpt-6.2-astra`, `high` | |

## Where the cost goes

Measured on one machine from 2026-11-13 to 2026-11-16, as API-equivalent cost at the rate card
effective 2026-11-09, not as the subscription bill:

- **By role.** Main (orchestrator) sessions were about 45% of the cost, and about 70% of that was
  main sessions on Fable. Opus babysitters were about 25%, and every other Opus task about 21%. Many
  of those tasks were investigation, triage, query drafting and permission requests: `standard` work.
- **By kind of token.** Cache writes were about half of all cost, more than cache reads. Input
  tokens outnumber output tokens about 450 to 1 (a colleague saw about 5B against 11M). So agents
  re-reading their context, not writing code, is what costs. One orchestrator session had a median
  context of 553k tokens per call.

Prices, as ratios of the input price:

- A cache read costs 5% for Opus and Sonnet (Fable 2.5%, Haiku 10%). A 1-hour cache write costs 2
  times, for every model. So rewriting a context costs about 40 times a warm read, on Opus and Sonnet.
- A cache belongs to one model. For `claude -p` on a subscription it lasts about an hour, and each
  read renews it. A session resumed after its cache expired, or switched to another model, rewrites
  its whole context.

What follows:

- **Resume a large session only while its cache is warm.** Otherwise continue from a short handoff
  note in a fresh session (a babysitter's note: `references/babysit.md`).
- **Keep large output out of long sessions.** Every token a session reads is written to the cache
  once and read on each later call. `SKILL.md` ("Delegate well") hands large logs, diffs and query
  output to a lighter task, and the session reads its short result.
- **Waiting costs nothing, until the resume.** A command task has no model and no context. A parked
  task costs nothing while it waits, but its first call after the cache expired pays the rewrite
  (`references/agents.md`, "Cost and limits").
- **The orchestrator caps the Claude agents it starts** at 300k tokens of context by default, through
  `AGENT_ORCH_CLAUDE_COMPACT_WINDOW`.

## Prices

`prices.json`, beside `policy.json`, holds each model's API list price in dollars per million
tokens. The figures are API-equivalent, for comparing models and tasks, not the subscription bill.
It is kept apart from the policy because every task's cost is read from it, and reading a task must
not read the policy.

| Model | Input | Cache write | Cache read | Output |
| --- | ---: | ---: | ---: | ---: |
| `claude-haiku-5-5` (prompt up to 100k; above: 5 times) | $0.10 | $0.20 | $0.01 | $0.50 |
| `claude-sonnet-5-5` | $2 | $4 | $0.10 | $10 |
| `claude-opus-5-5` | $4 | $8 | $0.20 | $20 |
| `claude-fable-5-2` | $8 | $16 | $0.20 | $40 |
| `gpt-6-luna` | $0.10 | | $0.01 | $0.50 |
| `gpt-6.1-terra` | $1 | | $0.05 | $5 |
| `gpt-6.2-sol` | $2 | | $0.10 | $10 |
| `gpt-6.2-astra` | $8 | | $0.40 | $40 |

Claude: Anthropic's rate card effective 2026-11-09 (the 1-hour cache write, which `claude -p`
sessions use). Codex: OpenAI's API prices, with no cache-write charge counted; gpt-6.2 from its
2026-11-17 release as secondary sources report it.

How a task's cost is found. A finished Claude attempt reports its own cost, which is used as is.
Otherwise it is estimated: a Claude attempt call by call at that call's model and long-context band,
a Codex attempt from its token totals. `status --json` and `result` give a task's `costUsd`, and
`costExact` is false when any part is an estimate.

## Return on cost

Delegation and model choice are both judged by what a successful result costs, not by what a call
costs.

- **Cost per accepted task.** Every attempt of a group's tasks, accepted or not, over the accepted
  ones: a cheap attempt that fails review costs a rework attempt and another review. `stats` ("cost
  per accepted") and `cost` show it in dollars.
- **Complexity sets the floor; cost picks above it.** The tier table in `SKILL.md` names the lowest
  tier a task's complexity allows. At or above that floor, take the tier and agent with the lowest
  cost per accepted task for the kind of work, in "By agent, tier and task type". When a tier's
  first-try acceptance is low for a task type, its cost per accepted task already shows it.
- **The break-even.** Starting an agent (or a stronger model) pays when the value of one success is
  more than its extra cost over the gain in success rate: `(cost with − cost without) ÷ (success with
  − success without)`. For example, an orchestrated attempt at $9 against $5 done alone, succeeding
  90% against 80% of the time, pays only when a success is worth more than $4 / 0.10 = $40. Parallel
  independent parts, large reads whose summary is enough, and a second model's review usually pass;
  a split of tightly coupled work, an agent per small step, and orchestration for a quick question do
  not.
- **Splitting coupled work loses outright.** In studies Google Cloud cited in November 2026, two agents changing
  overlapping code succeeded about 30% less often than one agent doing both, and agent teams scored 39%
  to 70% lower than one agent where each step depends on the last (and up to 81% higher where the parts
  were independent). A split of coupled work costs more and fails more: keep it with one owner.
- **A cheaper tier tried more than once can beat a dearer tier tried once,** when a test can pick the
  winner (best of N on a cheap tier, in `references/patterns.md`). Without such a test, more attempts
  stop helping quickly; move up a tier instead.
- **Measure on this work,** not on public benchmarks, and read each tier's figures against the tasks
  you gave it, which you chose by difficulty.

### Budgets

Each model task has a budget: its tier's cost per accepted task on this machine (last 30 days) once
the tier has 5 finished tasks, else the tier's `budget` in `policy.json`. `start` writes it into the
task's brief, with the model's price, and the agent checks its spend with `$ORCH cost` at each gate
run and before it starts agents.

```bash
$ORCH cost [<run> <task>]   # inside a task, its own: spend, its agents' spend, the budget, % used
$ORCH cost                  # outside a task: each tier's price, tasks, first-try rate, cost per accepted task
```

Past the budget, the agent stops and judges before it spends more: a task harder than its tier is
handed back (`ask`, or `NEEDS DECISION:`), work going in circles changes approach, and work nearly
done for a clear reason finishes with the reason in the report. A budget is a point to reassess, not
a limit that stops the task.

## Each tier's measured results

Each tier's results on this machine show in three places:

- `$ORCH agents` prints them after each tier's model, for example `[last 30d: 12 tasks, 83%
  accepted first try (5 of 6 reviewed), median first attempt 4m12s, 1.2M input tokens per accepted
  task]`.
- The error `start` prints when a new task has no `--tier` lists each tier with the same note. A
  `start` that names its tier prints none.
- `$ORCH stats` ("`stats`", below).

The figures in `agents` and in that error:

- **Window.** The last 30 days, over every run. A task falls in the window by when it finished.
- **Tasks.** The finished tasks: Claude and Codex tasks whose last attempt has ended. A task still
  running, a command task and a babysitter are not counted. A task counts toward the tier its first
  attempt ran at, even when it was redone one tier up.
- **Accepted first try.** The share of the tier's reviewed tasks that were accepted on attempt 1.
  A task is reviewed once it was accepted or rejected, needed another attempt, or its first attempt
  failed. A task closed with no verdict is not in this share.
- **Median first attempt.** The median time from the start to the end of attempt 1.
- **Input tokens per accepted task.** Every input token of every attempt of the tier's finished
  tasks, accepted or not, divided by the number accepted. Failed and reworked attempts raise it. The
  same cost in dollars follows in parentheses.
- **Too few tasks.** A tier with fewer than 5 finished tasks shows `too few tasks (N finished, 5
  needed)` and no figures: do not read anything into it. Past that, a tier with no reviewed task
  shows `no reviewed task yet`, and one with no accepted task shows `no accepted task yet`.
- When the results cannot be read, `agents` and the error print none. The first read has to go
  through every finished task, so it is slower; later reads reuse what it saved.

Read each tier's figures against the tasks you gave it, which you chose by difficulty.

### `stats`

```bash
$ORCH stats [<run>] [--since DUR]   # default: the last 30 days
```

`stats` measures outcomes, never usage limits: limit hits are no reason to avoid an agent. It prints
"By agent and model" and "By task type" (the plan's type, or `babysit`, `read-only` or `write`), with
the columns `tasks`, `attempts`, `first accepted`, `accepted`, `integrated`, `failed`, `limit hits`,
`transient`, `first elapsed`, `review wait`, `tokens in`, `tokens out`, `tokens in per accepted`,
`cost` and `cost per accepted` (dollars, "Prices" above).
They do not show tier names: find a tier by its model. "By agent, tier and task type" names each tier,
and is the table for choosing an agent ("Choosing between the agents", below).

- It reads the runs created in the window; with a run named, only that run, whatever `--since` says.
- `tasks` counts every Claude and Codex task of those runs that started, running ones and
  babysitters too. Command tasks are not counted.
- `first accepted` is `N/M`: of the M accepted tasks, N were accepted on attempt 1. It differs from
  the share in `agents`, which divides by the reviewed tasks.
- `first elapsed` is the median first attempt, and `review wait` the median time from a result to
  its acceptance.
- `tokens in per accepted` and `cost per accepted` are all the group's input and cost over its
  accepted tasks, as defined above.

### Choosing between the agents

When the task's abilities and the user's choice leave both agents possible, compare them at the tier
the task needs, for the same kind of task, in "By agent, tier and task type":

1. Take the agent with the better first-try acceptance (`first accepted`).
2. When acceptance is within about 10 points, take the one with the lower cost per accepted task
   (`cost per accepted`).
3. When either agent has fewer than 5 finished tasks of that kind, alternate between them, so both
   build a record: start the next task of that kind on the one with fewer tasks (`tasks`).
4. Write the deciding numbers in the task's `--why`.

Why the rule has no default agent. Since 2026-11-01 on this machine, 36 planned implementation tasks
ran on Claude and 5 on Codex, while Codex did 260 reviews, 127 read-only tasks and 45 debug tasks.
In "By agent and model", Codex's tiers were accepted on the first try 70% to 79% of the time, at 3.6M
to 14.2M input tokens per accepted task, and Claude's 49% to 57%, at 7.4M to 77.1M. That does not
compare like for like, because most of Codex's mix is reviews. Only a record of implementation on
both agents does, so the rule builds one. Implementation is ordinary work for Codex
(`references/agents.md`, "Practical notes").

## Why `frontier`

- Fable 5.2 beats Opus 5.5 and Codex astra on agentic coding (FrontierSWE v2: 69.9% against 62.3%
  and 65.5%).
- It keeps going until a long job is done.
- At `high` it matches Opus's best at about half the cost per task.
- It costs about twice Opus per token, which is why it is for design and difficult work: complicated
  or long development, hard investigation, verification of complicated work. Routine or mechanical
  work, small reviews and waiting never go to it.
