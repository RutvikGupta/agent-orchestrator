import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attemptCost, budgetFor, claudeCallCost, priceOf, prices, pricesProblems, usdText } from '../scripts/lib/cost.mjs';
import { policyProblems } from '../scripts/lib/policy.mjs';
import { fixture } from './helpers.mjs';

const policy = JSON.parse(fs.readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
const table = JSON.parse(fs.readFileSync(new URL('../prices.json', import.meta.url), 'utf8'));
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`);

test('every tier model has a price, and the price table is valid', () => {
  for (const agent of ['claude', 'codex']) {
    for (const [tier, spec] of Object.entries(policy[agent].tiers)) {
      assert.ok(priceOf(spec.model, table), `${agent} ${tier} (${spec.model}) has no price`);
      assert.ok(spec.budget > 0, `${agent} ${tier} has no default budget`);
    }
  }
  assert.deepEqual(policyProblems(policy), []);
  assert.deepEqual(pricesProblems(table), []);
  assert.deepEqual(prices(), table, 'the table cost.mjs reads is prices.json');
  assert.match(pricesProblems({ 'x-model': { input: 1 } }).join(), /x-model needs input, cacheWrite, cacheRead and output/);
  assert.match(policyProblems({ ...policy, claude: { ...policy.claude, tiers: { ...policy.claude.tiers, light: { ...policy.claude.tiers.light, budget: -1 } } } }).join(), /budget must be a positive number/);
});

test("a Claude call is priced by kind of token, and above Haiku's long-context line at its higher rate", () => {
  const opus = priceOf('claude-opus-5-5', table);
  // 1M of each kind: $4 input, $8 write, $0.20 read, $20 output.
  close(claudeCallCost({ input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6 }, opus), 32.2, 'opus');
  const haiku = priceOf('claude-haiku-5-5', table);
  close(claudeCallCost({ cache_read_input_tokens: 90_000, output_tokens: 1000 }, haiku), (90_000 * 0.01 + 1000 * 0.5) / 1e6, 'short haiku');
  close(claudeCallCost({ cache_read_input_tokens: 150_000, output_tokens: 1000 }, haiku), (150_000 * 0.05 + 1000 * 2.5) / 1e6, 'long haiku');
});

test("an attempt's cost: Claude's own figure first, else each call at its model, else token totals", () => {
  assert.deepEqual(attemptCost('claude', { costUsd: 1.25, tokens: { input: 9e9 } }, 'claude-opus-5-5', table), { usd: 1.25, exact: true });
  // A session that changed model between calls pays each call at its own model.
  const messages = new Map([
    ['a', { model: 'claude-sonnet-5-5', cache_read_input_tokens: 1e6 }],
    ['b', { model: 'claude-opus-5-5', cache_read_input_tokens: 1e6 }],
  ]);
  const mixed = attemptCost('claude', { messages, tokens: {} }, null, table);
  close(mixed.usd, 0.1 + 0.2, 'mixed models');
  assert.equal(mixed.exact, false);
  // From Claude totals, input that is not a cache read is priced as cache writes.
  close(attemptCost('claude', { tokens: { input: 3e6, cached: 2e6, output: 0 } }, 'claude-sonnet-5-5', table).usd, 4 + 0.2, 'claude totals');
  // Codex counts cached input inside its input.
  close(attemptCost('codex', { tokens: { input: 3e6, cached: 2e6, output: 1e6 } }, 'gpt-6.2-sol', table).usd, 2 + 0.2 + 10, 'codex totals');
  // A model the events name but the table no longer prices falls back to the tier's model.
  close(attemptCost('codex', { model: 'gpt-5-retired', tokens: { input: 1e6, cached: 0, output: 0 } }, 'gpt-6.1-terra', table).usd, 1, 'retired model');
  assert.equal(attemptCost('codex', { model: 'gpt-5-retired', tokens: { input: 1 } }, null, table), null);
});

test("a tier's budget is its measured cost per accepted task once it has enough tasks, else its default", () => {
  const evidence = [{ agent: 'claude', tier: 'standard', tasks: 12, costPerAccepted: 7.5 }, { agent: 'codex', tier: 'standard', tasks: 3, costPerAccepted: 0.4 }];
  assert.deepEqual(budgetFor('claude', 'standard', evidence, 5, policy), { usd: 7.5, from: "the standard tier's cost per accepted task here (last 30d, 12 tasks)" });
  assert.deepEqual(budgetFor('codex', 'standard', evidence, 5, policy), { usd: policy.codex.tiers.standard.budget, from: "the standard tier's default in policy.json" });
  assert.equal(usdText(0.042), '$0.04');
  assert.equal(usdText(1368.4), '$1368');
});

test('a task brief carries its model, price and budget, and `cost` reports its spend with its agents', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'lead', { flags: ['--read-only'] });
  const brief = fs.readFileSync(path.join(task.outDir, 'orch-brief.md'), 'utf8');
  const section = brief.slice(brief.indexOf('## Cost'));
  assert.match(section, /^## Cost\n\nYou run `claude-opus-5-5` \(claude complex\) at \$4 input and \$20 output per million tokens\. Your budget is the complex tier's cost per accepted task on this machine, or \$50 \(its default\) until the tier has 5 finished tasks\./);
  assert.match(section, /Check it, and what you and the agents you started have spent, with `node .*orch\.mjs cost`/);
  assert.match(brief, /## Messages[\s\S]*$/, 'the inbox note stays last');
  assert.ok(brief.indexOf('## Cost') < brief.lastIndexOf('---'));
  await f.finished(run, 'lead');
  // A task `lead` started, in a run of its own.
  const as = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'lead' };
  const child = await f.newRun('helpers', as);
  await f.start(child, 'helper', { flags: ['--read-only'], env: as });
  await f.finished(child, 'helper');

  const report = await f.json(['cost', run.id, 'lead']);
  close(report.usd, 0.02, 'lead and its helper, as Claude reported them');
  close(report.ownUsd, 0.01, 'lead alone');
  assert.equal(report.tasks, 2);
  assert.equal(report.budget, 50);
  assert.equal(report.over, false);
  // Inside the task, `cost` reads its own.
  const own = await f.command(['cost'], { env: as });
  assert.match(own.stdout, /^lead \(claude complex, attempt 1\): \$0\.01 itself, \$0\.02 with the 1 task it started\nbudget: \$50\.00, the complex tier's default in policy\.json; 0% used/m);
  // Outside any task, the tier table.
  const tiers = await f.command(['cost']);
  assert.match(tiers.stdout, /^What each tier costs here/);
  assert.match(tiers.stdout, /^claude complex\s+claude-opus-5-5\s+\$4\/\$20/m);
});
