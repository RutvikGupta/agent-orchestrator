// Model policy (policy.json): each agent's tiers, lightest first, and the model and effort each
// tier runs. The orchestrating agent picks a task's tier from its own assessment of the task
// (SKILL.md, "Choose the agent and model"); no rule picks it. Every Codex task names its tier, since
// Codex usage is the scarcer budget. A Claude task without --tier runs `complex`, as every Claude
// task did before Claude had tiers, and so does every pull-request babysitter.

import { POLICY_PATH } from "./config.mjs";
import { die, readJson } from "./util.mjs";

export const CLAUDE_DEFAULT_TIER = "complex";
const POLICY_AGENTS = ["claude", "codex"];
// The model names the relays accept, and an effort level such as "high".
const MODEL_NAME = /^[A-Za-z0-9._:@/[\]-]+$/;
const EFFORT = /^[a-z]+$/;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// What is wrong with a parsed policy.json, one entry per problem; [] when it is valid.
export function policyProblems(policy) {
  if (!isObject(policy)) return ["it must be a JSON object"];
  const problems = [];
  for (const key of POLICY_AGENTS) {
    const tiers = policy[key]?.tiers;
    if (!isObject(tiers) || !Object.keys(tiers).length) {
      problems.push(`${key}.tiers must be an object with at least one tier`);
      continue;
    }
    for (const [name, tier] of Object.entries(tiers)) {
      const at = `${key}.tiers.${name}`;
      if (!/^[a-z][a-z0-9-]*$/.test(name)) problems.push(`${at}: a tier name is one lowercase word`);
      if (!isObject(tier)) {
        problems.push(`${at} must be an object with a model`);
        continue;
      }
      if (typeof tier.model !== "string" || !MODEL_NAME.test(tier.model)) problems.push(`${at}.model must be a model name`);
      if (tier.effort !== undefined && (typeof tier.effort !== "string" || !EFFORT.test(tier.effort))) {
        problems.push(`${at}.effort must be a level such as "high", or left out for the CLI's default`);
      }
      if (tier.use !== undefined && typeof tier.use !== "string") problems.push(`${at}.use must be a string`);
    }
    if (key === "claude" && !tiers[CLAUDE_DEFAULT_TIER]) {
      problems.push(`claude.tiers needs a "${CLAUDE_DEFAULT_TIER}" tier: the default, and every babysitter's`);
    }
  }
  return problems;
}

export function loadPolicy() {
  const policy = readJson(POLICY_PATH);
  if (!policy) die(`missing or invalid ${POLICY_PATH}: it is not readable JSON`);
  const problems = policyProblems(policy);
  if (problems.length) die(`invalid ${POLICY_PATH}: ${problems.join("; ")}`);
  return policy;
}

// An agent's tier names, lightest first.
export function tierOrder(key) {
  return Object.keys(loadPolicy()[key].tiers);
}

function passthroughValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}

// "light = claude-haiku-5-5, standard = ...": an agent's tiers with their models, for messages.
const tierList = (tiers) => Object.entries(tiers).map(([t, v]) => `${t} = ${v.model}`).join(", ");
// A tier by name; never an inherited key such as "constructor".
const tierOf = (tiers, name) => (typeof name === "string" && Object.hasOwn(tiers, name) ? tiers[name] : null);

// The tier, model and effort (null: the CLI's default) a task runs. `previousTier` is the tier of
// the task's earlier attempt by the same agent: a Claude follow-up keeps it unless --tier is given.
export function modelFor(key, args, previousTier = null) {
  const policy = loadPolicy();
  const { tiers } = policy[key];
  const override = args.model ?? passthroughValue(args.passthrough, "--model") ?? passthroughValue(args.passthrough, "--effort");
  if (key === "claude") {
    if (override !== null) {
      die(`choose the Claude model with --tier (${tierList(tiers)}), not --model/--effort (edit ${POLICY_PATH} to change the models)`, 2);
    }
    const name = args.tier || (tierOf(tiers, previousTier) ? previousTier : CLAUDE_DEFAULT_TIER);
    const tier = tierOf(tiers, name) || die(`unknown --tier "${args.tier}" for Claude (choose: ${tierList(tiers)}; without --tier: ${CLAUDE_DEFAULT_TIER})`, 2);
    return { tier: name, model: tier.model, effort: tier.effort || null };
  }
  const names = Object.keys(tiers);
  if (override !== null) die(`choose the Codex model with --tier (${names.join(" | ")}), not --model/--effort`, 2);
  if (!args.tier) die(`--tier is required for Codex: ${tierList(tiers)} (see SKILL.md, "Choose the agent and model")`, 2);
  const tier = tierOf(tiers, args.tier) || die(`unknown --tier "${args.tier}" (choose: ${names.join(", ")})`, 2);
  return { tier: args.tier, model: tier.model, effort: tier.effort || null };
}

export function modelLabel(task) {
  if (!task.model) return "-";
  return `${task.model.replace(/^(claude|gpt)-/, "")} ${task.effort || ""}`.trim();
}
