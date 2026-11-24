// `pick`: choose the agent for a task type and tier by the rule in SKILL.md ("Choose the agent
// and model"), and print a ready `--why` line.
import { AGENTS } from "../config.mjs";
import { usdText } from "../cost.mjs";
import { loadPolicy, tierText } from "../policy.mjs";
import { listRuns } from "../runs.mjs";
import { EVIDENCE_MIN_TASKS, sinceDuration, taskStats } from "../stats.mjs";
import { die, emit } from "../util.mjs";

const CODING_TYPES = new Set(["implement", "debug", "review"]);
const GEMINI_CODING_TIERS = new Set(["strong", "complex"]);
const WITHIN_POINTS = 10;

// Abilities each --needs value requires, and why an agent that lacks it is excluded.
const NEEDS = {
  web: { allows: (agent) => agent === "codex", reason: "needs web (live web search is codex only)" },
  offline: { allows: (agent) => agent !== "gemini", reason: "needs offline (not supported on gemini)" },
};

// Every tier name present on at least one agent in `policy`, ordered lightest first.
export function availableTiers(policy) {
  const seen = new Map();
  for (const agent of Object.keys(AGENTS)) {
    const tiers = policy[agent]?.tiers || {};
    Object.entries(tiers).forEach(([name, spec], i) => {
      const rank = Number.isInteger(spec?.rank) ? spec.rank : i + 1;
      if (!seen.has(name) || rank < seen.get(name)) seen.set(name, rank);
    });
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

function pctText(pct) {
  return pct === null || pct === undefined ? "-" : `${pct}%`;
}

// Pure decision rule: given { type, tier, needs, policy, byAgentTierType }, returns either
// { ok: true, result } or { ok: false, error }.
export function chooseAgent({ type, tier, needs = [], policy, byAgentTierType = [] }) {
  const allTiers = availableTiers(policy);
  if (!tier) return { ok: false, error: `--tier is required (choose: ${allTiers.join(", ")})` };
  const unknownNeed = needs.find((n) => !Object.hasOwn(NEEDS, n));
  if (unknownNeed) return { ok: false, error: `unknown --needs "${unknownNeed}" (choose: ${Object.keys(NEEDS).join(", ")})` };

  const uniqueNeeds = [...new Set(needs)];
  const withTier = [];
  const excluded = [];
  for (const agent of Object.keys(AGENTS)) {
    const tiers = policy[agent]?.tiers;
    if (tiers && Object.hasOwn(tiers, tier)) withTier.push(agent);
    else excluded.push({ agent, reason: `no ${tier} tier in policy` });
  }
  if (!withTier.length) {
    return { ok: false, error: `unknown --tier "${tier}" (available tiers: ${allTiers.join(", ")})` };
  }

  const remaining = [];
  for (const agent of withTier) {
    const failed = uniqueNeeds.filter((n) => !NEEDS[n].allows(agent));
    if (failed.length) {
      excluded.push({ agent, reason: failed.map((n) => NEEDS[n].reason).join("; ") });
    } else {
      remaining.push(agent);
    }
  }
  if (!remaining.length) {
    const reasons = excluded.map((e) => `${e.agent}: ${e.reason}`).join("; ");
    return { ok: false, error: `no candidate left for tier "${tier}" with --needs ${uniqueNeeds.join(", ")} (${reasons})` };
  }

  const records = remaining.map((agent) => {
    const spec = policy[agent].tiers[tier];
    const row = byAgentTierType.find((g) => g.agent === agent && g.tier === tier && g.type === type);
    const firstTryPct = row && row.firstAttemptAcceptance !== null && row.firstAttemptAcceptance !== undefined
      ? Math.round(row.firstAttemptAcceptance * 100) : null;
    const costPerAccepted = row?.costPerAccepted ?? null;
    return {
      agent,
      tier,
      model: spec.model,
      effort: spec.effort || null,
      budget: typeof spec.budget === "number" ? spec.budget : Infinity,
      finished: row?.tasks ?? 0,
      firstTryPct,
      costPerAccepted,
    };
  });

  const alternate = records.some((c) => c.finished < EVIDENCE_MIN_TASKS);
  const rule = alternate ? "alternate" : "records";
  const preferGemini = CODING_TYPES.has(type) && GEMINI_CODING_TIERS.has(tier);

  let winner;
  let why;
  if (alternate) {
    const sorted = [...records].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished - b.finished;
      if (preferGemini) {
        const ga = a.agent === "gemini" ? 0 : 1;
        const gb = b.agent === "gemini" ? 0 : 1;
        if (ga !== gb) return ga - gb;
      }
      if (a.budget !== b.budget) return a.budget - b.budget;
      return a.agent.localeCompare(b.agent);
    });
    winner = sorted[0];
    if (records.length === 1) {
      const note = uniqueNeeds.length ? `needs ${uniqueNeeds.join(", ")}` : `only agent with ${tier} tier`;
      why = `${winner.agent} ${tier}: only candidate (${note})`;
    } else if (preferGemini && winner.agent === "gemini") {
      why = `${winner.agent} ${tier}: Gemini's first coding tasks of this kind (${winner.finished} of ${EVIDENCE_MIN_TASKS} finished ${type} tasks)`;
    } else {
      why = `${winner.agent} ${tier}: alternating while building records (${winner.finished} of ${EVIDENCE_MIN_TASKS} finished ${type} tasks)`;
    }
  } else {
    const withRate = records.filter((c) => c.firstTryPct !== null);
    let contenders = records;
    if (withRate.length) {
      const bestPct = Math.max(...withRate.map((c) => c.firstTryPct));
      contenders = withRate.filter((c) => bestPct - c.firstTryPct <= WITHIN_POINTS);
    }
    const costOf = (c) => (c.costPerAccepted === null || c.costPerAccepted === undefined ? Infinity : c.costPerAccepted);
    const sorted = [...contenders].sort((a, b) => {
      if (costOf(a) !== costOf(b)) return costOf(a) - costOf(b);
      if ((b.firstTryPct ?? -1) !== (a.firstTryPct ?? -1)) return (b.firstTryPct ?? -1) - (a.firstTryPct ?? -1);
      if (a.budget !== b.budget) return a.budget - b.budget;
      return a.agent.localeCompare(b.agent);
    });
    winner = sorted[0];
    const others = records.filter((c) => c.agent !== winner.agent);
    if (!others.length) {
      const note = uniqueNeeds.length ? `needs ${uniqueNeeds.join(", ")}` : `only agent with ${tier} tier`;
      why = `${winner.agent} ${tier}: only candidate (${note}; ${pctText(winner.firstTryPct)} first try, ${usdText(winner.costPerAccepted)} per accepted)`;
    } else if (contenders.length > 1) {
      const vs = others.map((o) => `${o.agent} ${pctText(o.firstTryPct)} (${usdText(o.costPerAccepted)})`).join(", ");
      why = `${winner.agent} ${tier}: ${pctText(winner.firstTryPct)} first try, ${usdText(winner.costPerAccepted)} per accepted vs ${vs}`;
    } else {
      const vs = others.map((o) => `${o.agent} ${pctText(o.firstTryPct)}`).join(", ");
      why = `${winner.agent} ${tier}: ${pctText(winner.firstTryPct)} first try vs ${vs}, ${usdText(winner.costPerAccepted)} per accepted`;
    }
  }

  const candidates = records.map(({ agent, tier: t, model, finished, firstTryPct, costPerAccepted }) => ({
    agent, tier: t, model, finished, firstTryPct, costPerAccepted,
  }));
  return {
    ok: true,
    result: {
      agent: winner.agent,
      tier: winner.tier,
      model: winner.model,
      effort: winner.effort,
      why,
      rule,
      candidates,
      excluded,
    },
  };
}

export function cmdPick(args) {
  if (args._.length) die("usage: pick --type TYPE --tier TIER [--needs web|offline] [--since DUR] [--json]", 2);
  if (!args.type) die("--type is required (e.g. implement, debug, review, research)", 2);
  const policy = loadPolicy();
  const since = sinceDuration(args.since);
  const cutoff = Date.now() - since;
  const runs = listRuns().filter((run) => Date.parse(run.createdAt) >= cutoff);
  const { byAgentTierType } = taskStats(runs);
  const choice = chooseAgent({
    type: args.type,
    tier: args.tier,
    needs: args.needs || [],
    policy,
    byAgentTierType,
  });
  if (!choice.ok) die(choice.error, 2);
  const res = choice.result;
  const labels = res.candidates.map((c) => tierText(c.agent, c.tier));
  const width = Math.max(...labels.map((s) => s.length));
  const lines = [
    `pick: ${tierText(res.agent, res.tier)}`,
    ...res.candidates.map((c, i) => `  ${labels[i].padEnd(width)}  ${c.finished} finished, ${pctText(c.firstTryPct)} first try, ${usdText(c.costPerAccepted)} per accepted`),
    ...(res.excluded.length ? [`  excluded: ${res.excluded.map((e) => `${e.agent} (${e.reason})`).join("; ")}`] : []),
    `--why "${res.why}"`,
  ];
  emit(args, res, lines.join("\n"));
}
