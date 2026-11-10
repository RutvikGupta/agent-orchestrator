import { boundedModel, ModelRefused } from "../policy.mjs";
import { die } from "../util.mjs";

// Policy model names and effort levels are restricted to shell-safe characters.
export function cmdModel(args) {
  try {
    const choice = boundedModel(args.agent, args.tier);
    const effort = choice.effort
      ? args.agent === "codex" ? ` -c model_reasoning_effort="${choice.effort}"` : ` --effort ${choice.effort}`
      : "";
    console.log(`--model ${choice.model}${effort}`);
  } catch (error) {
    if (error instanceof ModelRefused) die(error.message, error.code);
    throw error;
  }
}
