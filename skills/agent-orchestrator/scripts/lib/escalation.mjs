// Failure receipts are per attempt, so a failed relay and its rejected review count only once.
import path from "node:path";
import { reviewRoundsOf } from "./lifecycle.mjs";
import { CLAUDE_DEFAULT_TIER, loadPolicy, peerTier, tierOrder } from "./policy.mjs";
import { readJson, tailText } from "./util.mjs";

const LIMIT = /usage limit|limit reached|hit your (?:usage )?limit|rate_limit_reached|(?:5-hour|five[_ -]hour|weekly|seven[_ -]day) limit/i;

export function failureHistory(run, task, currentState = null) {
  const policy = loadPolicy();
  const rounds = reviewRoundsOf(run, task.id);
  const attempts = [];
  for (let n = 1; n <= (task.attempt || 0); n++) {
    const dir = path.join(run.dir, "tasks", task.id, `attempt-${n}`);
    const result = readJson(path.join(dir, "result.json"));
    const agent = task.attemptAgents?.[n] || task.agent;
    const tiers = policy[agent]?.tiers || {};
    const tier = task.attemptTiers?.[n] || (n === task.attempt ? task.tier : null)
      || Object.keys(tiers).find((t) => tiers[t].model === result?.model)
      || (agent === "claude" ? CLAUDE_DEFAULT_TIER : null);
    const stopped = Boolean(task.attemptStops?.[n] || (n === task.attempt && task.stoppedAt));
    const text = [result?.error, result?.stderrTail, result?.finalMessage,
      !result ? tailText(path.join(dir, "relay.log"), 16384) : null,
      !result ? tailText(path.join(dir, "events.jsonl"), 16384) : null].filter(Boolean).join("\n");
    const limitHit = result?.status !== "completed" && LIMIT.test(text);
    // A missing result is an aborted historical attempt. The latest attempt may still be running.
    const failedResult = ["failed", "timeout", "aborted"].includes(result?.status)
      || (!result && (n < task.attempt || currentState === "aborted"));
    const failedReview = rounds.some((r) => r.attempt === n && ["changes", "reject"].includes(r.verdict));
    // Gate-refused accept receipts are optional: older versions recorded no such refusal.
    const refusedAccept = (task.acceptRefusals || []).some((r) => r.attempt === n && ["missing-gates", "failed-gates"].includes(r.reason));
    attempts.push({ n, agent, tier, failed: !stopped && !limitHit && (failedResult || failedReview || refusedAccept) });
  }
  return { failureCount: attempts.filter((a) => a.failed).length, attempts };
}

export function escalationFor(run, task, currentState = null) {
  const { attempts } = failureHistory(run, task, currentState);
  const agent = task.agent;
  const tier = task.tier || (agent === "claude" ? CLAUDE_DEFAULT_TIER : null);
  // Switching agents starts a fresh ladder; earlier attempts still count in the task's total.
  const lastSwitch = attempts.findLastIndex((a) => a.agent !== agent);
  const same = attempts.slice(lastSwitch + 1);
  const failures = same.filter((a) => a.tier === tier && a.failed).length;
  if (failures < 2) return null;
  const order = tierOrder(agent);
  const next = order[order.indexOf(tier) + 1];
  const alreadyUp = same.some((a) => task.automaticEscalations?.[a.n]?.to === tier);
  if (!next || alreadyUp) {
    const peer = peerTier(agent, tier);
    return { refusal: `${failures} counted failures at ${agent} ${tier}${alreadyUp ? " after automatic escalation" : ", the top tier"}; start the other agent with a fresh brief: --agent ${peer.agent} --tier ${peer.tier} and a new --why (${peer.equalRank ? "equal rank in policy.json" : "no equal rank in policy.json; closest lower rank"}).` };
  }
  return { tier: next, note: `automatically escalated ${agent} from ${tier} to ${next}: ${failures} counted failures at the ${tier} tier; continuing the same session` };
}
