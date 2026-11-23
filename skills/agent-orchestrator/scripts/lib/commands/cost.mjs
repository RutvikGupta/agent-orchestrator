// `cost`: what work costs, in US dollars (API-equivalent; cost.mjs).
//
// With a task (named, or the caller's own from AGENT_ORCH_RUN and AGENT_ORCH_TASK): what the task
// and the tasks it started have cost so far, against its tier's budget, and what to do past it.
// Without one: what each tier costs here per accepted task, beside its price and first-try
// acceptance, for choosing a model.
import { CLI_PATH } from "../config.mjs";
import { budgetFor, priceOf, prices, usdText } from "../cost.mjs";
import { POLICY_AGENTS, loadPolicy } from "../policy.mjs";
import { childrenOf, describe, loadRun, loadTask, taskIdOf } from "../runs.mjs";
import { EVIDENCE_MIN_TASKS, tierEvidence } from "../stats.mjs";
import { die, emit } from "../util.mjs";

// The cost of a task and, below it, of every task it started, each once.
function treeCost(run, task, seen = new Set()) {
  const key = `${run.id}/${task.id}`;
  if (seen.has(key)) return { usd: 0, exact: true, tasks: 0 };
  seen.add(key);
  const row = describe(run, task);
  let usd = row.costUsd || 0, exact = row.costExact !== false, tasks = 1;
  for (const child of childrenOf(run, task.id)) {
    try {
      const childRun = loadRun(child.run);
      const childTask = loadTask(childRun, child.task);
      if (!childTask || childTask.agent === "command") continue;
      const sub = treeCost(childRun, childTask, seen);
      usd += sub.usd;
      exact &&= sub.exact;
      tasks += sub.tasks;
    } catch {
      // A child run that is gone costs nothing more now.
    }
  }
  return { usd, exact, tasks, own: row.costUsd || 0 };
}

function tierTable(args) {
  const policy = loadPolicy();
  const evidence = tierEvidence(policy);
  const table = prices();
  const rows = [];
  for (const agent of POLICY_AGENTS) {
    for (const [tier, spec] of Object.entries(policy[agent].tiers)) {
      const entry = evidence?.find((e) => e.agent === agent && e.tier === tier);
      const enough = entry && entry.tasks >= EVIDENCE_MIN_TASKS;
      const price = priceOf(spec.model, table);
      rows.push({ agent, tier, model: spec.model, inputPerMillion: price?.input ?? null, outputPerMillion: price?.output ?? null,
        tasks: entry?.tasks ?? 0, firstTry: enough ? entry.firstAttemptAcceptance : null,
        costPerAccepted: enough ? entry.costPerAccepted : null, medianCost: enough ? entry.medianCost : null,
        budget: budgetFor(agent, tier, evidence, EVIDENCE_MIN_TASKS, policy)?.usd ?? null });
    }
  }
  const pct = (x) => (x === null || x === undefined ? "-" : `${Math.round(x * 100)}%`);
  const lines = rows.map((r) => `${`${r.agent} ${r.tier}`.padEnd(16)} ${r.model.padEnd(18)} ${`$${r.inputPerMillion ?? "?"}/$${r.outputPerMillion ?? "?"}`.padEnd(10)} ${String(r.tasks).padStart(5)}  ${pct(r.firstTry).padStart(5)}  ${usdText(r.costPerAccepted).padStart(9)}  ${usdText(r.medianCost).padStart(7)}`);
  const text = [
    "What each tier costs here (API-equivalent dollars, last 30d; prices per million input/output tokens):",
    `${"TIER".padEnd(16)} ${"MODEL".padEnd(18)} ${"PRICE".padEnd(10)} ${"TASKS".padStart(5)}  ${"FIRST".padStart(5)}  ${"PER ACCEPT".padStart(9)}  ${"MEDIAN".padStart(7)}`,
    ...lines,
    `Above the tier the task's complexity requires, take the one with the lowest cost per accepted task for this kind of work (stats: "By agent, tier and task type"). Fewer than ${EVIDENCE_MIN_TASKS} tasks shows "-".`,
  ].join("\n");
  emit(args, { tiers: rows }, text);
}

export function cmdCost(args) {
  if (args._.length === 1 || args._.length > 2) die("usage: cost [RUN TASK] [--json]", 2);
  const runRef = args._[0] || process.env.AGENT_ORCH_RUN;
  const taskRef = args._[1] || process.env.AGENT_ORCH_TASK;
  if (!runRef || !taskRef) return tierTable(args);
  const run = loadRun(runRef);
  const task = loadTask(run, taskIdOf(run, taskRef));
  if (!task) die(`no task ${taskRef} in run ${run.id}`, 2);
  if (task.agent === "command") return emit(args, { task: task.id, usd: 0 }, `${task.name || task.id}: a command task runs no model and costs nothing`);
  const tree = treeCost(run, task);
  const tier = task.tier || task.attemptTiers?.[task.attempt] || null;
  const policy = loadPolicy();
  const budget = tier ? budgetFor(task.agent, tier, tierEvidence(policy), EVIDENCE_MIN_TASKS, policy) : null;
  const over = budget && tree.usd > budget.usd;
  const est = tree.exact ? "" : "~";
  const lines = [
    `${task.name || task.id} (${task.agent} ${tier || "no tier"}, attempt ${task.attempt}): ${est}${usdText(tree.own)} itself${tree.tasks > 1 ? `, ${est}${usdText(tree.usd)} with the ${tree.tasks - 1} task${tree.tasks === 2 ? "" : "s"} it started` : ""}`,
    budget ? `budget: ${usdText(budget.usd)}, ${budget.from}; ${Math.round((tree.usd / budget.usd) * 100)}% used` : "budget: none known for this tier",
  ];
  if (over) {
    lines.push(`over budget. Stop and judge before you spend more: if the task is harder than its tier, say so (node ${CLI_PATH} ask "<why>" or end with NEEDS DECISION:); if you are going in circles, change the approach; if it is nearly done for a clear reason, finish it and say why in your report.`);
  } else if (budget) {
    lines.push("Re-reading a large context is most of the cost: keep long output out of your session, and start lighter agents (or command tasks) for side work.");
  }
  emit(args, { run: run.id, task: task.id, tier, usd: tree.usd, ownUsd: tree.own, exact: tree.exact, tasks: tree.tasks, budget: budget?.usd ?? null, budgetFrom: budget?.from ?? null, over: Boolean(over) }, `${lines.join("\n")}\n(API-equivalent dollars${tree.exact ? "" : "; ~ marks an estimate from token counts"}.)`);
}
