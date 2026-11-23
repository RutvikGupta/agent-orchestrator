// What an agent's work costs in US dollars, from the model prices in prices.json. The figures are
// API-equivalent, for comparing models and tasks, not the subscription bill.
//
// A finished Claude attempt reports its own cost (`total_cost_usd`), which is used as is. Otherwise
// the cost is estimated: a Claude attempt call by call, each at its own model's price and long-context
// band; a Codex attempt from its token totals. Codex counts cached input inside its input; Claude
// counts cache reads and writes beside ordinary input, and the estimate from Claude totals prices all
// input that is not a cache read as cache writes, which is what a `claude -p` session's new input is.
// A Gemini attempt (the cursor-delegate relay, whose events have Claude's shape) is estimated from its
// token totals too: Gemini caches implicitly and charges no cache writes, so its new input is ordinary
// input. An agent this file does not know gets no estimate.
//
// `describe` prices every task, so nothing here reads policy.json unless a caller passes the policy.
import fs from "node:fs";
import { PRICES_PATH } from "./config.mjs";

const PER_MILLION = 1_000_000;
const RATES = ["input", "cacheWrite", "cacheRead", "output"];
let cached = { key: null, table: {} };

// What is wrong with a parsed price table, one entry per problem; [] when it is valid.
export function pricesProblems(table) {
  if (!table || typeof table !== "object" || Array.isArray(table)) return ["it must be a JSON object of model prices"];
  const problems = [];
  const rates = (p) => p && typeof p === "object" && RATES.every((k) => typeof p[k] === "number" && p[k] >= 0);
  for (const [model, price] of Object.entries(table)) {
    if (model === "note") continue;
    if (!rates(price)) problems.push(`${model} needs input, cacheWrite, cacheRead and output, each a non-negative number`);
    else if (price.longContext !== undefined && !(rates(price.longContext) && Number.isInteger(price.longContext.over) && price.longContext.over > 0)) {
      problems.push(`${model}.longContext needs a whole number "over" and the four rates`);
    }
  }
  return problems;
}

// prices.json, read again only when the file changes; {} when it is missing or invalid.
export function prices(file = process.env.AGENT_ORCH_PRICES || PRICES_PATH) {
  let key;
  try {
    const stat = fs.statSync(file);
    key = `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return {};
  }
  if (cached.key !== key) {
    let table = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!pricesProblems(parsed).length) table = parsed;
    } catch {
      // An unreadable table prices nothing: costs show as unknown.
    }
    cached = { key, table };
  }
  return cached.table;
}

// The model attempt `n` of `task` ran: with a policy, the model of the tier recorded for that
// attempt; otherwise, or when none was recorded, the task's own model. For an attempt whose events
// do not name their model (a Codex relay's).
export function attemptModel(task, n, agent, policy = null) {
  const tier = task.attemptTiers?.[n];
  return (policy && tier && policy[agent]?.tiers?.[tier]?.model) || task.model || null;
}

// The price of `model`, as { input, cacheWrite, cacheRead, output, longContext? }, or null.
export function priceOf(model, table = prices()) {
  const price = model && table[model];
  return price && typeof price === "object" && Number.isFinite(price.input) ? price : null;
}

// One Claude call's cost from its usage, in dollars, at `price`.
export function claudeCallCost(usage, price) {
  const ordinary = usage.input_tokens || 0, written = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0, output = usage.output_tokens || 0;
  const long = price.longContext;
  const rate = long && ordinary + written + read > long.over ? long : price;
  return (ordinary * rate.input + written * rate.cacheWrite + read * rate.cacheRead + output * rate.output) / PER_MILLION;
}

// The price of input that is not a cache read, per agent: a Claude session writes it to the cache;
// Codex and Gemini charge it as ordinary input.
const FRESH_RATE = { claude: "cacheWrite", codex: "input", gemini: "input" };

// What one attempt cost, from its event summary: { usd, exact }, or null when no price is known
// for its model. `model` is the attempt's model when its events do not name one, or name one the
// table no longer prices.
export function attemptCost(agent, summary, model = null, table = prices()) {
  if (typeof summary?.costUsd === "number") return { usd: summary.costUsd, exact: true };
  if (!Object.hasOwn(FRESH_RATE, agent)) return null;
  if (agent === "claude" && summary?.messages?.size) {
    let usd = 0;
    for (const usage of summary.messages.values()) {
      const price = priceOf(usage.model || summary.model, table) || priceOf(model, table);
      if (!price) return null;
      usd += claudeCallCost(usage, price);
    }
    return { usd, exact: false };
  }
  const price = priceOf(summary?.model, table) || priceOf(model, table);
  const t = summary?.tokens;
  if (!price || !t) return null;
  const fresh = Math.max(0, (t.input || 0) - (t.cached || 0));
  const freshRate = price[FRESH_RATE[agent]];
  return { usd: (fresh * freshRate + (t.cached || 0) * price.cacheRead + (t.output || 0) * price.output) / PER_MILLION, exact: false };
}

// Dollars as people read them: "$0.04", "$3.10", "$127".
export function usdText(usd) {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "-";
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

// What a task at `tier` of `agent` may cost before its agent stops to reassess: the tier's measured
// cost per accepted task on this machine (rework included) once it has enough finished tasks, else
// the tier's `budget` in policy.json. { usd, from } or null.
export function budgetFor(agent, tier, evidence, minTasks, policy) {
  const entry = evidence?.find((e) => e.agent === agent && e.tier === tier);
  if (entry && entry.tasks >= minTasks && entry.costPerAccepted > 0) {
    return { usd: entry.costPerAccepted, from: `the ${tier} tier's cost per accepted task here (last 30d, ${entry.tasks} tasks)` };
  }
  const fallback = policy?.[agent]?.tiers?.[tier]?.budget;
  return typeof fallback === "number" ? { usd: fallback, from: `the ${tier} tier's default in policy.json` } : null;
}
