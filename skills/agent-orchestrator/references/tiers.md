# Tiers: cost and evidence

Read this before you choose Claude `frontier`, and when cost or `$ORCH stats` bears on a tier. The
tiers and how to choose one are in `SKILL.md`, "Choose the agent and model".

## Cost per accepted task

- Judge cost per accepted task, not per token: a cheap attempt that fails review costs a rework
  attempt and another review.
- Measure on this work, not on public benchmarks. When `$ORCH stats` shows that a tier's
  first-attempt acceptance is low for a task type, start that type one tier up.

## `$ORCH stats`

```bash
$ORCH stats [<run>] [--since DUR]   # default: the last 30 days
```

It reports first-attempt acceptance, failures, transient errors, and time taken, per agent and model
and per task type. It measures outcomes, never usage limits: limit hits are no reason to avoid an
agent.

## Why `frontier`

- Fable 5.2 beats Opus 5.5 and Codex astra on agentic coding (FrontierSWE v2: 69.9% against 62.3%
  and 65.5%).
- It keeps going until a long job is done.
- At `high` it matches Opus's best at about half the cost per task.
- It costs about twice Opus per token, which is why bounded or routine work never goes to it.
