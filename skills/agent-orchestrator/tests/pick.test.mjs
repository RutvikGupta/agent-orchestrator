import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chooseAgent } from '../scripts/lib/commands/pick.mjs';
import { loadPolicy } from '../scripts/lib/policy.mjs';
import { fixture, jsonl, readJson, writeJson } from './helpers.mjs';

async function finishedTask(f, run, id, { agent, tier, type, accepted = true, attempts = 1, tokensIn = 1000 } = {}) {
  const started = await f.start(run, id, { agent, flags: ['--tier', tier] });
  await f.finished(run, id);
  for (let n = 2; n <= attempts; n++) {
    await f.start(run, id, { agent, flags: ['--tier', tier] });
    await f.finished(run, id);
  }
  const file = f.taskFile(run, id);
  const record = readJson(file);
  // Adjust events.jsonl token counts so costPerAccepted differs predictably across agents.
  const eventsFile = path.join(started.outDir, 'events.jsonl');
  const event = agent === 'codex'
    ? { type: 'turn.completed', usage: { input_tokens: tokensIn, cached_input_tokens: 0, output_tokens: 100 } }
    : { type: 'result', subtype: 'success', usage: { input_tokens: tokensIn, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 } };
  jsonl(eventsFile, [event]);
  writeJson(file, {
    ...record,
    plan: { type },
    ...(accepted ? { acceptedAt: '2026-01-01T00:05:00Z', acceptedAttempt: attempts } : {}),
  });
}

test('pick lists the right candidates per tier and applies empty-record tie-breaks', async (t) => {
  const f = await fixture(t);

  // light: all three; lowest default budget is codex ($0.25 vs claude $1, gemini $1).
  const light = await f.json(['pick', '--type', 'implement', '--tier', 'light']);
  assert.deepEqual(light.candidates.map((c) => c.agent), ['claude', 'codex', 'gemini']);
  assert.deepEqual(light.excluded, []);
  assert.equal(light.agent, 'codex');
  assert.equal(light.rule, 'alternate');

  // standard: all three; lowest default budget is codex ($1 vs gemini $3, claude $10).
  const standard = await f.json(['pick', '--type', 'implement', '--tier', 'standard']);
  assert.deepEqual(standard.candidates.map((c) => c.agent), ['claude', 'codex', 'gemini']);
  assert.equal(standard.agent, 'codex');

  // strong: codex and gemini only; coding type prefers gemini over codex despite higher budget ($6 vs $3).
  for (const type of ['implement', 'debug', 'review']) {
    const strong = await f.json(['pick', '--type', type, '--tier', 'strong']);
    assert.deepEqual(strong.candidates.map((c) => c.agent), ['codex', 'gemini']);
    assert.deepEqual(strong.excluded.map((e) => e.agent), ['claude']);
    assert.equal(strong.agent, 'gemini');
    assert.match(strong.why, new RegExp(`Gemini's first coding tasks of this kind \\(0 of 5 finished ${type} tasks\\)`));
  }

  // strong + non-coding type: budget tie-break picks codex ($3 < $6).
  const researchStrong = await f.json(['pick', '--type', 'research', '--tier', 'strong']);
  assert.equal(researchStrong.agent, 'codex');

  // complex: all three; coding type prefers gemini.
  const complex = await f.json(['pick', '--type', 'implement', '--tier', 'complex']);
  assert.deepEqual(complex.candidates.map((c) => c.agent), ['claude', 'codex', 'gemini']);
  assert.equal(complex.agent, 'gemini');

  // frontier: claude only.
  const frontier = await f.json(['pick', '--type', 'implement', '--tier', 'frontier']);
  assert.deepEqual(frontier.candidates.map((c) => c.agent), ['claude']);
  assert.deepEqual(frontier.excluded.map((e) => e.agent), ['codex', 'gemini']);
  assert.equal(frontier.agent, 'claude');
  assert.equal(frontier.model, 'claude-fable-5-2');
  assert.equal(frontier.effort, 'high');
});

test('pick --needs filters abilities, supports repetition, and exits 2 when none remain', async (t) => {
  const f = await fixture(t);

  const web = await f.json(['pick', '--type', 'research', '--tier', 'strong', '--needs', 'web']);
  assert.equal(web.agent, 'codex');
  assert.deepEqual(web.candidates.map((c) => c.agent), ['codex']);
  assert.ok(web.excluded.some((e) => e.agent === 'gemini' && /web/.test(e.reason)));

  const offline = await f.json(['pick', '--type', 'implement', '--tier', 'complex', '--needs', 'offline']);
  assert.deepEqual(offline.candidates.map((c) => c.agent), ['claude', 'codex']);
  assert.ok(offline.excluded.some((e) => e.agent === 'gemini' && /offline/.test(e.reason)));
  // Without gemini, lowest default budget at complex is codex ($15 vs claude $50).
  assert.equal(offline.agent, 'codex');

  // Repeated --needs that still leave a candidate.
  const webOffline = await f.json(['pick', '--type', 'research', '--tier', 'complex', '--needs', 'web', '--needs', 'offline']);
  assert.equal(webOffline.agent, 'codex');
  assert.deepEqual(webOffline.candidates.map((c) => c.agent), ['codex']);

  // Frontier + --needs web leaves no candidate -> exit 2.
  const frontierWeb = await f.command(['pick', '--type', 'research', '--tier', 'frontier', '--needs', 'web'], { code: 2 });
  assert.match(frontierWeb.stderr, /no candidate left/);

  // Unknown --needs -> exit 2.
  const unknownNeed = await f.command(['pick', '--type', 'implement', '--tier', 'standard', '--needs', 'magic'], { code: 2 });
  assert.match(unknownNeed.stderr, /unknown --needs "magic"/);
});

test('pick validates unknown tier, missing flags, and bad duration with exit 2', async (t) => {
  const f = await fixture(t);

  const badTier = await f.command(['pick', '--type', 'implement', '--tier', 'mythic'], { code: 2 });
  assert.match(badTier.stderr, /unknown --tier "mythic"/);
  for (const tier of ['light', 'standard', 'strong', 'complex', 'frontier']) {
    assert.match(badTier.stderr, new RegExp(`\\b${tier}\\b`));
  }

  const noType = await f.command(['pick', '--tier', 'standard'], { code: 2 });
  assert.match(noType.stderr, /--type is required/);

  const noTier = await f.command(['pick', '--type', 'implement'], { code: 2 });
  assert.match(noTier.stderr, /--tier is required/);

  const badSince = await f.command(['pick', '--type', 'implement', '--tier', 'standard', '--since', 'forever'], { code: 2 });
  assert.match(badSince.stderr, /bad duration/);
});

test('pick alternates from real run history and switches to records once each candidate has 5 tasks', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('history');

  // After 1 gemini strong implement task, codex has 0 -> alternation picks codex.
  await finishedTask(f, run, 'g1', { agent: 'gemini', tier: 'strong', type: 'implement', accepted: true, attempts: 1, tokensIn: 100_000 });
  const alt = await f.json(['pick', '--type', 'implement', '--tier', 'strong']);
  assert.equal(alt.rule, 'alternate');
  assert.equal(alt.agent, 'codex');
  assert.equal(alt.candidates.find((c) => c.agent === 'gemini').finished, 1);
  assert.equal(alt.candidates.find((c) => c.agent === 'codex').finished, 0);

  // Fill both gemini and codex to 5 finished tasks:
  // gemini: 4/5 first-try (80%), higher tokens; codex: 5/5 first-try (100%), lower tokens.
  for (let i = 2; i <= 5; i++) {
    await finishedTask(f, run, `g${i}`, { agent: 'gemini', tier: 'strong', type: 'implement', accepted: true, attempts: i === 2 ? 2 : 1, tokensIn: 100_000 });
  }
  for (let i = 1; i <= 5; i++) {
    await finishedTask(f, run, `c${i}`, { agent: 'codex', tier: 'strong', type: 'implement', accepted: true, attempts: 1, tokensIn: 50_000 });
  }

  const rec = await f.json(['pick', '--type', 'implement', '--tier', 'strong']);
  assert.equal(rec.rule, 'records');
  assert.equal(rec.agent, 'codex');
  assert.equal(rec.tier, 'strong');
  assert.equal(rec.model, 'gpt-6.2-sol');
  assert.equal(rec.effort, 'medium');
  assert.equal(typeof rec.why, 'string');
  assert.match(rec.why, /100% first try/);
  for (const c of rec.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['agent', 'costPerAccepted', 'finished', 'firstTryPct', 'model', 'tier']);
    assert.equal(c.finished, 5);
    assert.equal(typeof c.costPerAccepted, 'number');
  }

  // Human output shows chosen tierText, one line per candidate, and ready --why line.
  const human = (await f.command(['pick', '--type', 'implement', '--tier', 'strong'])).stdout;
  assert.match(human, /pick: codex strong \(gpt-6\.2-sol\)/);
  assert.match(human, /codex strong \(gpt-6\.2-sol\)\s+5 finished, 100% first try/);
  assert.match(human, /gemini strong \(gemini-4-neon\)\s+5 finished, 80% first try/);
  assert.match(human, /^--why "codex strong: .+"$/m);
});

test('chooseAgent applies records rule: best first-try acceptance, and lowest cost within 10 points', () => {
  const policy = loadPolicy();

  // More than 10 percentage points ahead: best first-try wins even when dearer.
  const clearWin = chooseAgent({
    type: 'implement',
    tier: 'complex',
    policy,
    byAgentTierType: [
      { agent: 'codex', tier: 'complex', type: 'implement', tasks: 6, firstAttemptAcceptance: 0.82, costPerAccepted: 4.10 },
      { agent: 'claude', tier: 'complex', type: 'implement', tasks: 6, firstAttemptAcceptance: 0.70, costPerAccepted: 2.50 },
      { agent: 'gemini', tier: 'complex', type: 'implement', tasks: 5, firstAttemptAcceptance: 0.65, costPerAccepted: 1.80 },
    ],
  });
  assert.equal(clearWin.ok, true);
  assert.equal(clearWin.result.rule, 'records');
  assert.equal(clearWin.result.agent, 'codex');
  assert.match(clearWin.result.why, /82% first try vs claude 70%, gemini 65%, \$4\.10 per accepted/);

  // Within 10 percentage points (including exact 10-point boundary 85% vs 75%): lowest cost wins.
  const costWin = chooseAgent({
    type: 'implement',
    tier: 'complex',
    policy,
    byAgentTierType: [
      { agent: 'claude', tier: 'complex', type: 'implement', tasks: 8, firstAttemptAcceptance: 0.85, costPerAccepted: 12.00 },
      { agent: 'codex', tier: 'complex', type: 'implement', tasks: 7, firstAttemptAcceptance: 0.80, costPerAccepted: 5.50 },
      { agent: 'gemini', tier: 'complex', type: 'implement', tasks: 5, firstAttemptAcceptance: 0.75, costPerAccepted: 3.20 },
    ],
  });
  assert.equal(costWin.ok, true);
  assert.equal(costWin.result.rule, 'records');
  assert.equal(costWin.result.agent, 'gemini');
  assert.match(costWin.result.why, /75% first try, \$3\.20 per accepted/);

  // Tie-break on equal finished count and equal budget: alphabetical name (claude vs gemini at light, both $1).
  const nameTie = chooseAgent({
    type: 'implement',
    tier: 'light',
    policy,
    byAgentTierType: [
      { agent: 'codex', tier: 'light', type: 'implement', tasks: 2, firstAttemptAcceptance: 1, costPerAccepted: 0.2 },
    ],
  });
  assert.equal(nameTie.ok, true);
  assert.equal(nameTie.result.rule, 'alternate');
  assert.equal(nameTie.result.agent, 'claude');
});
