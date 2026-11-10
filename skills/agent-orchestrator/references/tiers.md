# Tiers: cost and evidence

Read this before you choose Claude `frontier`, and when cost or a tier's measured results bear on a
choice. The tiers and how to choose one are in `SKILL.md`, "Choose the agent and model".

## Cost per accepted task

- Judge cost per accepted task, not per token: a cheap attempt that fails review costs a rework
  attempt and another review. "Input tokens per accepted task" ("Each tier's measured results")
  counts that cost.
- Measure on this work, not on public benchmarks. When a tier's share accepted on the first try is
  low for a task type, start that type one tier up.

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
  tasks, accepted or not, divided by the number accepted. Failed and reworked attempts raise it.
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
two tables, by agent and model and by task type (the plan's type, or `babysit`, `read-only` or
`write`), with the columns `tasks`, `attempts`, `first accepted`, `accepted`, `integrated`,
`failed`, `limit hits`, `transient`, `first elapsed`, `review wait`, `tokens in`, `tokens out` and
`tokens in per accepted`. It does not show tier names: find a tier by its model.

- It reads the runs created in the window; with a run named, only that run, whatever `--since` says.
- `tasks` counts every Claude and Codex task of those runs that started, running ones and
  babysitters too. Command tasks are not counted.
- `first accepted` is `N/M`: of the M accepted tasks, N were accepted on attempt 1. It differs from
  the share in `agents`, which divides by the reviewed tasks.
- `first elapsed` is the median first attempt, and `review wait` the median time from a result to
  its acceptance.
- `tokens in per accepted` is all the group's input over its accepted tasks, as defined above.

## Why `frontier`

- Fable 5.2 beats Opus 5.5 and Codex astra on agentic coding (FrontierSWE v2: 69.9% against 62.3%
  and 65.5%).
- It keeps going until a long job is done.
- At `high` it matches Opus's best at about half the cost per task.
- It costs about twice Opus per token, which is why bounded or routine work never goes to it.
