// Failure receipts are per attempt, so a failed relay and its rejected review count only once.
import fs from "node:fs";
import { POLICY_PATH } from "./config.mjs";
import { attemptReasonOf } from "./lifecycle.mjs";
import { CLAUDE_DEFAULT_TIER, peerTier, tierOrder } from "./policy.mjs";
import { readJson } from "./util.mjs";

let policyMemo = null;
// Only old attempts without a recorded tier need this fallback. A missing or half-saved policy
// must not interrupt status, the dashboard or the processes watching for finished attempts.
function tierForModel(agent, model) {
  if (!model) return null;
  let stamp;
  try {
    const st = fs.statSync(POLICY_PATH);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    policyMemo = null;
    return null;
  }
  if (policyMemo?.stamp !== stamp) policyMemo = { stamp, value: readJson(POLICY_PATH) };
  const tiers = policyMemo.value?.[agent]?.tiers || {};
  return Object.keys(tiers).find((t) => tiers[t]?.model === model) || null;
}

// Results and their usage-limit/report flags come from runs.mjs's per-attempt cache. Review and
// gate facts are supplied by the caller, so this path never rereads attempt results or log tails.
export function failureHistory(task, facts, rounds = [], verifications = []) {
  const attempts = facts.map((fact) => {
    const { n, agent } = fact;
    const tier = task.attemptTiers?.[n] || (n === task.attempt ? task.tier : null)
      || tierForModel(agent, fact.model) || (agent === "claude" ? CLAUDE_DEFAULT_TIER : null);
    const stopped = Boolean(task.attemptStops?.[n] || (n === task.attempt && task.stoppedAt));
    const continued = n < task.attempt && attemptReasonOf(task, n + 1) === "retry";
    const failedResult = ["failed", "timeout", "aborted"].includes(fact.state);
    const failedReview = rounds.some((r) => r.attempt === n && ["changes", "reject"].includes(r.verdict));
    const lastGates = new Map();
    for (const v of verifications) if (v.attempt === n) lastGates.set(v.cmd, v);
    const failedGate = [...lastGates.values()].some((v) => v.passed === false);
    // Gate-refused accept receipts are optional: older versions recorded no such refusal.
    const refusedAccept = (task.acceptRefusals || []).some((r) => r.attempt === n && ["missing-gates", "failed-gates"].includes(r.reason));
    return { n, agent, tier, failed: !stopped && !continued && !fact.limitHit && (failedResult || failedReview || failedGate || fact.failedCheck || refusedAccept) };
  });
  return { failureCount: attempts.filter((a) => a.failed).length, attempts };
}

export function escalationFor(task, attempts) {
  const agent = task.agent;
  const tier = task.tier || (agent === "claude" ? CLAUDE_DEFAULT_TIER : null);
  const order = tierOrder(agent);
  const at = order.indexOf(tier);
  if (at < 0) return null; // modelFor reports a removed tier instead of silently choosing another.
  // Switching agents starts a fresh ladder; earlier attempts still count in the task's total.
  const lastSwitch = attempts.findLastIndex((a) => a.agent !== agent);
  const same = attempts.slice(lastSwitch + 1);
  const failures = same.filter((a) => a.tier === tier && a.failed).length;
  if (failures < 2) return null;
  const next = order[at + 1];
  const alreadyUp = same.some((a) => task.automaticEscalations?.[a.n]?.to === tier);
  if (!next || alreadyUp) {
    const peer = peerTier(agent, tier);
    return { refusal: `${failures} counted failures at ${agent} ${tier}${alreadyUp ? " after automatic escalation" : ", the top tier"}; start the other agent with a fresh brief: --agent ${peer.agent} --tier ${peer.tier} and a new --why (${peer.equalRank ? "equal rank in policy.json" : "no equal rank in policy.json; closest lower rank"}).` };
  }
  return { tier: next, note: `automatically escalated ${agent} from ${tier} to ${next}: ${failures} counted failures at the ${tier} tier` };
}

// Preserve the advice after a single failed result, including failed gates and reported checks.
export function failureHint(task, attempts, key, chosenTier) {
  const previous = attempts.find((a) => a.n === task.attempt);
  if (!previous?.failed || previous.agent !== key) return null;
  const order = tierOrder(key);
  const at = order.indexOf(previous.tier);
  if (at < 0 || at === order.length - 1 || order.indexOf(chosenTier) > at) return null;
  return `attempt ${task.attempt} at the ${previous.tier} tier failed its review or gates; redo it one tier up, with --tier ${order[at + 1]} and a new --why`;
}
