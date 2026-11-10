// Model policy (policy.json): each agent's tiers, lightest first, and the model and effort each
// tier runs. The orchestrating agent picks a task's tier from its own assessment of the task
// (SKILL.md, "Choose the agent and model"). Every new task, Claude or Codex,
// names its tier with --tier, so that the choice is explicit and leans to the lightest tier that
// does the task as well as the top one. Two things run `complex` without it: every pull-request
// babysitter, and a Claude task recorded before Claude had tiers when it gets a follow-up attempt.
// start escalates repeated follow-up failures unless --tier or --no-escalate overrides it.

import { POLICY_PATH } from "./config.mjs";
import { die, readJson } from "./util.mjs";

// Not a default for new tasks: the tier of every babysitter, and of a Claude task recorded before
// Claude had tiers (which ran `complex`, then Opus).
export const CLAUDE_DEFAULT_TIER = "complex";
const POLICY_AGENTS = ["claude", "codex"];
// A command task (`start --agent command -- COMMAND...`, scripts/command-relay.mjs) runs a command
// with no model. Its ceiling applies to the agents its command starts.
export const COMMAND_AGENT = "command";
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
      if (tier.efforts !== undefined) {
        // The effort levels `start --effort` may choose for this tier; the tier's own effort is one of them.
        if (!Array.isArray(tier.efforts) || !tier.efforts.length || tier.efforts.some((e) => typeof e !== "string" || !EFFORT.test(e))) {
          problems.push(`${at}.efforts must be a list of levels such as ["medium", "high"]`);
        } else if (tier.effort !== undefined && !tier.efforts.includes(tier.effort)) {
          problems.push(`${at}.effort must be one of ${at}.efforts`);
        }
      }
      if (tier.rank !== undefined && !(Number.isInteger(tier.rank) && tier.rank > 0)) problems.push(`${at}.rank must be a positive whole number`);
      if (tier.use !== undefined && typeof tier.use !== "string") problems.push(`${at}.use must be a string`);
    }
    if (key === "claude" && !tiers[CLAUDE_DEFAULT_TIER]) {
      problems.push(`claude.tiers needs a "${CLAUDE_DEFAULT_TIER}" tier: every babysitter's, and that of tasks recorded before tiers`);
    }
  }
  return problems;
}

// Dashboard readers need errors they can catch rather than an exit of the whole worker.
export function readPolicy(file = POLICY_PATH) {
  const policy = readJson(file);
  if (!policy) throw new ModelRefused(`missing or invalid ${file}: it is not readable JSON`);
  const problems = policyProblems(policy);
  if (problems.length) throw new ModelRefused(`invalid ${file}: ${problems.join("; ")}`);
  return policy;
}

export function loadPolicy() {
  try { return readPolicy(); }
  catch (error) { die(error.message); }
}

// An agent's tier names, lightest first.
export function tierOrder(key) {
  if (key === COMMAND_AGENT) return [];
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
// One line per tier on when to use it, for the error that asks for --tier.
const tierUses = (tiers) => {
  const width = Math.max(...Object.keys(tiers).map((t) => t.length));
  return Object.entries(tiers).map(([t, v]) => `\n  ${t.padEnd(width)}  ${v.use || v.model}`).join("");
};
// A tier by name; never an inherited key such as "constructor".
const tierOf = (tiers, name) => (typeof name === "string" && Object.hasOwn(tiers, name) ? tiers[name] : null);

// A model choice that policy.json or the arguments do not allow: no --tier, an unknown tier, or
// --model/--effort. `code` is the exit status `start` gives.
export class ModelRefused extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function refuse(message, code = 2) {
  throw new ModelRefused(message, code);
}

// The effort a task runs: its tier's, or the one --effort chose from the tier's `efforts`. A tier
// without `efforts` runs only its own, so --effort is refused there, as is a level the tier lists not.
function effortFor(key, name, tier, wanted) {
  if (wanted === undefined || wanted === null) return tier.effort || null;
  const allowed = Array.isArray(tier.efforts) ? tier.efforts : [];
  if (!allowed.includes(wanted)) {
    refuse(allowed.length
      ? `--effort ${wanted} is not allowed for the ${key} ${name} tier: choose ${allowed.join(" or ")} (never higher)`
      : `the ${key} ${name} tier runs at ${tier.effort || "the CLI's default effort"} only; --effort applies to tiers that list efforts in ${POLICY_PATH}`, 2);
  }
  return wanted;
}

// The tier, model and effort (null: the CLI's default) a task runs. `previousTier` is the tier of
// the task's earlier attempt by the same agent: a Claude follow-up keeps it unless --tier is given.
// A new task needs --tier, for both agents. A choice it cannot accept throws ModelRefused, which
// `start` turns into its own refusal: `dispatch` skips that one task and starts the others.
export function modelFor(key, args, previousTier = null) {
  // The words after `--` are the command itself, so a `--model` there is the command's own.
  if (key === COMMAND_AGENT) {
    const given = ["tier", "model", "effort"].filter((name) => args[name] !== undefined && args[name] !== null);
    if (given.length) refuse(`a command task runs no model: drop ${given.map((name) => `--${name}`).join(", ")}`, 2);
    return { tier: null, model: null, effort: null };
  }
  const policy = loadPolicy();
  const { tiers } = policy[key];
  const override = args.model ?? passthroughValue(args.passthrough, "--model") ?? passthroughValue(args.passthrough, "--effort");
  if (key === "claude") {
    if (override !== null) {
      refuse(`choose the Claude model with --tier (${tierList(tiers)}), not --model/--effort (edit ${POLICY_PATH} to change the models)`, 2);
    }
    const name = args.tier || (tierOf(tiers, previousTier) ? previousTier : null);
    if (!name) {
      refuse(`--tier is required for a new Claude task: ${tierList(tiers)}. Choose the lightest tier that does the task as well as the top one (see SKILL.md, "Choose the agent and model")${tierUses(tiers)}`, 2);
    }
    const tier = tierOf(tiers, name) || refuse(`unknown --tier "${args.tier}" for Claude (choose: ${tierList(tiers)})`, 2);
    return { tier: name, model: tier.model, effort: effortFor(key, name, tier, args.effort) };
  }
  const names = Object.keys(tiers);
  if (override !== null) refuse(`choose the Codex model with --tier (${names.join(" | ")}), not --model/--effort`, 2);
  if (!args.tier) refuse(`--tier is required for Codex: ${tierList(tiers)} (see SKILL.md, "Choose the agent and model")${tierUses(tiers)}`, 2);
  const tier = tierOf(tiers, args.tier) || refuse(`unknown --tier "${args.tier}" (choose: ${names.join(", ")})`, 2);
  return { tier: args.tier, model: tier.model, effort: effortFor(key, args.tier, tier, args.effort) };
}

export function modelLabel(task) {
  if (!task.model) return "-";
  return `${task.model.replace(/^(claude|gpt)-/, "")} ${task.effort || ""}`.trim();
}

// How strong a tier's model is, on one scale for both agents: policy.json's `rank`, or, for an agent
// whose tiers have none, the tier's place in its list (lightest first, from 1). null for no tier.
function rankOf(policy, key, name) {
  const tiers = policy[key]?.tiers;
  const tier = tiers && tierOf(tiers, name);
  if (!tier) return null;
  return Number.isInteger(tier.rank) ? tier.rank : Object.keys(tiers).indexOf(name) + 1;
}

// Whether a task that runs `own` ({ agent, tier }) may not start `wanted` ({ agent, tier }): true when
// the wanted tier is stronger. A delegated agent was given its task at a tier chosen for it, so it
// never passes the work to a stronger model. When either tier has no rank, the two compare only
// within one agent, by their order.
export function strongerThan(wanted, own) {
  if (!own?.tier || !wanted?.tier) return false;
  const policy = loadPolicy();
  const ranked = (k, t) => Number.isInteger(tierOf(policy[k]?.tiers || {}, t)?.rank);
  if (wanted.agent !== own.agent && !(ranked(wanted.agent, wanted.tier) && ranked(own.agent, own.tier))) return false;
  const [w, o] = [rankOf(policy, wanted.agent, wanted.tier), rankOf(policy, own.agent, own.tier)];
  return w !== null && o !== null && w > o;
}

// "claude complex (claude-opus-5-5)": a tier with its model, for messages.
export function tierText(key, name) {
  const tier = tierOf(loadPolicy()[key]?.tiers || {}, name);
  return `${key} ${name}${tier ? ` (${tier.model})` : ""}`;
}

// Ceilings use Claude tier names, with policy ranks selecting the strongest model each agent
// may use. They are inherited defaults for CLIs, not a security boundary against explicit flags.
export function ceilingFor(name, policy = loadPolicy()) {
  const ceiling = tierOf(policy.claude.tiers, name);
  if (!ceiling) refuse(`unknown --max-tier "${name}" (choose: ${Object.keys(policy.claude.tiers).join(", ")})`);
  const rank = rankOf(policy, "claude", name);
  const choices = {};
  for (const agent of POLICY_AGENTS) {
    const eligible = Object.keys(policy[agent].tiers)
      .filter((tier) => rankOf(policy, agent, tier) <= rank)
      .sort((a, b) => rankOf(policy, agent, b) - rankOf(policy, agent, a));
    if (!eligible.length) refuse(`no ${agent} model is at or below --max-tier ${name}`);
    const tier = eligible[0];
    choices[agent] = { tier, ...policy[agent].tiers[tier] };
  }
  return { tier: name, rank, effort: ceiling.effort || null, ...choices };
}

// Convert a caller on either CLI into the nearest Claude ceiling that does not exceed its rank.
export function callerCeiling(own) {
  if (!own?.tier) return null;
  const policy = loadPolicy();
  const rank = rankOf(policy, own.agent, own.tier);
  if (rank === null) refuse(`caller tier ${own.agent} ${own.tier} is missing from policy; refusing an unbounded command`);
  const eligible = Object.keys(policy.claude.tiers)
    .filter((tier) => rankOf(policy, "claude", tier) <= rank)
    .sort((a, b) => rankOf(policy, "claude", b) - rankOf(policy, "claude", a));
  if (!eligible.length) refuse(`no Claude ceiling is at or below caller tier ${own.agent} ${own.tier}`);
  return eligible[0];
}

export function lowerCeiling(...names) {
  return names.filter((name) => name !== undefined && name !== null).map((name) => ceilingFor(name)).sort((a, b) => a.rank - b.rank)[0]?.tier || null;
}

const effortLevels = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const lowerEffort = (wanted, cap) => {
  if (!cap) return wanted;
  if (!effortLevels.includes(cap)) refuse(`unknown effort ceiling "${cap}"`);
  if (!wanted) return cap;
  // A level this list does not know, such as one a newer CLI adds, cannot be shown to be at or
  // below the cap, so the cap replaces it.
  if (!effortLevels.includes(wanted)) return cap;
  return effortLevels.indexOf(wanted) > effortLevels.indexOf(cap) ? cap : wanted;
};

export function boundedModel(key, name, env = process.env) {
  if (!POLICY_AGENTS.includes(key)) refuse("--agent must be claude or codex");
  const cap = env.AGENT_ORCH_MAX_TIER ? ceilingFor(env.AGENT_ORCH_MAX_TIER) : null;
  const choice = modelFor(key, { tier: name || cap?.[key].tier || "standard", passthrough: [] });
  const policy = loadPolicy();
  if (cap && rankOf(policy, key, choice.tier) > cap.rank) {
    Object.assign(choice, { tier: cap[key].tier, model: cap[key].model, effort: cap[key].effort || null });
  }
  choice.effort = lowerEffort(choice.effort, env.AGENT_ORCH_MAX_EFFORT || cap?.effort);
  return choice;
}

export function modelExceedsCeiling(agent, model, maxTier, policy = loadPolicy()) {
  if (!maxTier || !model) return false;
  if (!policy[agent]) return false;
  const name = Object.keys(policy[agent].tiers).find((tier) => policy[agent].tiers[tier].model === model);
  return Boolean(name && rankOf(policy, agent, name) > (typeof maxTier === "object" ? maxTier : ceilingFor(maxTier, policy)).rank);
}

export function ceilingEnv(name, env = process.env) {
  if (name === null || name === undefined) return {};
  const policy = loadPolicy();
  const cap = ceilingFor(name, policy);
  const effort = lowerEffort(cap.effort, env.AGENT_ORCH_MAX_EFFORT);
  const rankOfModel = (model) => {
    const tier = Object.keys(policy.claude.tiers).find((tier) => policy.claude.tiers[tier].model === model);
    return tier ? rankOf(policy, "claude", tier) : null;
  };
  const aliases = Object.fromEntries(Object.entries({ HAIKU: "light", SONNET: "standard", OPUS: "complex", FABLE: "frontier" })
    .filter(([, tier]) => tierOf(policy.claude.tiers, tier))
    .map(([family, tier]) => {
      const key = `ANTHROPIC_DEFAULT_${family}_MODEL`;
      const pinned = env[key];
      const rank = rankOfModel(pinned);
      return [key, rank !== null && rank <= cap.rank ? pinned
        : boundedModel("claude", tier, { AGENT_ORCH_MAX_TIER: name }).model];
    }));
  const lowered = {};
  // A ceiling does not select a model or effort for a script. Only lower existing choices;
  // leaving effort unset lets a script's --effort and cheaper model defaults keep working.
  for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
    if (rankOfModel(env[key]) > cap.rank) lowered[key] = cap.claude.model;
  }
  for (const key of ["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_EFFORT"]) {
    if (env[key] && lowerEffort(env[key], effort) !== env[key]) lowered[key] = effort;
  }
  return {
    ...aliases,
    AGENT_ORCH_MAX_TIER: name,
    AGENT_ORCH_MAX_MODEL_CLAUDE: cap.claude.model,
    AGENT_ORCH_MAX_MODEL_CODEX: cap.codex.model,
    AGENT_ORCH_MAX_EFFORT: effort || "",
    ...lowered,
  };
}

// The other agent's tier with the same rank; when ranks differ, the closest lower tier.
export function peerTier(key, name) {
  const policy = loadPolicy();
  const agent = key === "claude" ? "codex" : "claude";
  const rank = rankOf(policy, key, name);
  const tiers = Object.keys(policy[agent].tiers);
  const tier = tiers.find((t) => rankOf(policy, agent, t) === rank)
    || tiers.filter((t) => rankOf(policy, agent, t) <= rank).at(-1) || tiers[0];
  return { agent, tier, equalRank: rankOf(policy, agent, tier) === rank };
}
