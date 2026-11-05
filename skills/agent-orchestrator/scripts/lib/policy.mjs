// Model policy (policy.json): Claude always runs one fixed model and effort; Codex usage is the
// scarcer budget, so every Codex task names a tier and the tier picks the model and effort.

import { POLICY_PATH } from "./config.mjs";
import { die, readJson } from "./util.mjs";

export function loadPolicy() {
  const policy = readJson(POLICY_PATH);
  if (!policy?.claude?.model || !policy?.claude?.effort || !policy?.codex?.tiers) die(`missing or invalid ${POLICY_PATH}`);
  return policy;
}

function passthroughValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1] ?? "";
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}

export function modelFor(key, args) {
  const policy = loadPolicy();
  const override = args.model ?? passthroughValue(args.passthrough, "--model") ?? passthroughValue(args.passthrough, "--effort");
  if (key === "claude") {
    if (override !== null || args.tier) {
      die(`Claude always runs ${policy.claude.model} at effort ${policy.claude.effort}; drop --model/--effort/--tier (edit ${POLICY_PATH} to change)`, 2);
    }
    return { tier: null, model: policy.claude.model, effort: policy.claude.effort };
  }
  const tiers = Object.keys(policy.codex.tiers);
  if (override !== null) die(`choose the Codex model with --tier (${tiers.join(" | ")}), not --model/--effort`, 2);
  if (!args.tier) die(`--tier is required for Codex: ${tiers.map((t) => `${t} = ${policy.codex.tiers[t].model}`).join(", ")} (see SKILL.md, "Choose the agent and model")`, 2);
  const tier = policy.codex.tiers[args.tier] || die(`unknown --tier "${args.tier}" (choose: ${tiers.join(", ")})`, 2);
  return { tier: args.tier, model: tier.model, effort: tier.effort };
}

export function modelLabel(task) {
  if (!task.model) return "-";
  return `${task.model.replace(/^(claude|gpt)-/, "")} ${task.effort || ""}`.trim();
}
