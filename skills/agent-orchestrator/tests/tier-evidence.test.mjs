// How each tier has done on this machine: the shared summary (lib/stats.mjs), and where it is
// shown: `agents`, the error that asks for --tier, and the cache that keeps reads cheap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

const policy = readJson(new URL('../policy.json', import.meta.url));
const codexTiers = policy.codex.tiers;
const tooFew = (n) => `last 30d: too few tasks (${n} finished, 5 needed)`;

// One task as stats.mjs describes it for the tier summary.
function item(agent, model, extra = {}) {
  return { accepted: 0, firstAttemptAccepted: 0, tokensIn: 0, elapsedMs: null, chosen: true, reviewed: false,
    first: { agent, model, effort: null, tier: null }, ...extra };
}

test('the tier summary counts a task at the tier of its first attempt and rates only reviewed tasks', async () => {
  const { tierSummary, evidenceText } = await import('../scripts/lib/stats.mjs');
  const luna = codexTiers.light.model;
  const terra = codexTiers.standard.model;
  const entry = (items, tier) => tierSummary(items, policy).find((e) => e.agent === 'codex' && e.tier === tier);
  const items = [
    item('codex', luna, { accepted: 1, firstAttemptAccepted: 1, reviewed: true, tokensIn: 100, elapsedMs: 60000 }),
    item('codex', luna, { accepted: 1, firstAttemptAccepted: 1, reviewed: true, tokensIn: 300, elapsedMs: 120000 }),
    // Light failed and a stronger tier finished the task: a miss for light, and the task is not the stronger tier's.
    item('codex', luna, { accepted: 1, reviewed: true, tokensIn: 500, elapsedMs: 180000 }),
    // Rejected, and finished with no verdict: only the rejection says anything about the tier.
    item('codex', luna, { reviewed: true, tokensIn: 50, elapsedMs: 240000 }),
    item('codex', luna, { tokensIn: 50, elapsedMs: 300000 }),
    // Not counted: a babysitter, a task whose first attempt has no result, and a model no tier runs now.
    item('codex', luna, { chosen: false, accepted: 1, firstAttemptAccepted: 1, reviewed: true }),
    { ...item('codex', luna), first: null },
    item('codex', 'gpt-5-retired', { accepted: 1, firstAttemptAccepted: 1, reviewed: true }),
  ];
  const light = entry(items, 'light');
  assert.deepEqual(light, { agent: 'codex', tier: 'light', tasks: 5, reviewed: 4, firstAttemptAccepted: 2,
    firstAttemptAcceptance: 0.5, accepted: 3, tokensInPerAccepted: 300, medianFirstAttemptMs: 180000 });
  assert.equal(entry(items, 'standard').tasks, 0);
  assert.equal(evidenceText(light),
    'last 30d: 5 tasks, 50% accepted first try (2 of 4 reviewed), median first attempt 3m00s, 300 input tokens per accepted task');

  // The threshold: four finished tasks show no rate, and so do none.
  assert.equal(evidenceText(entry(items.slice(0, 4), 'light')), tooFew(4));
  assert.equal(evidenceText(entry([], 'light')), tooFew(0));
  assert.equal(evidenceText(undefined), tooFew(0));
  // Five finished and none reviewed or accepted yet: the counts show, and the rates say why they do not.
  const open = Array.from({ length: 5 }, () => item('codex', terra, { elapsedMs: 90000 }));
  assert.equal(evidenceText(entry(open, 'standard')),
    'last 30d: 5 tasks, no reviewed task yet, median first attempt 1m30s, no accepted task yet');
});

test('the first attempt\'s model picks the tier, by effort when tiers share a model, else the tier the task recorded', async () => {
  const { tierSummary } = await import('../scripts/lib/stats.mjs');
  const shared = { claude: { tiers: { low: { model: 'm-1', effort: 'low' }, high: { model: 'm-1', effort: 'high' }, other: { model: 'm-2' } } },
    codex: { tiers: { one: { model: 'c-1' } } } };
  const tiersOf = (first) => tierSummary([{ ...item('claude', null), first: { agent: 'claude', model: null, effort: null, tier: null, ...first } }], shared)
    .filter((e) => e.tasks).map((e) => e.tier);
  assert.deepEqual(tiersOf({ model: 'm-1', effort: 'high' }), ['high']);
  assert.deepEqual(tiersOf({ model: 'm-1', effort: 'low' }), ['low']);
  assert.deepEqual(tiersOf({ model: 'm-1', effort: 'medium' }), [], 'two tiers fit and neither has that effort');
  assert.deepEqual(tiersOf({ model: 'm-2' }), ['other']);
  assert.deepEqual(tiersOf({ tier: 'low' }), ['low'], 'a result without a model: the tier a one-attempt task recorded');
  assert.deepEqual(tiersOf({ tier: 'renamed-since' }), [], 'a tier that policy.json no longer has');
});

// Runs a real fake-relay task once, then keeps its folder as the template that `seed` copies from, so
// that seeded tasks carry the relay's own records. The task itself leaves the run, so that it is not counted.
async function template(f, run) {
  await f.start(run, 'template', { agent: 'codex', flags: ['--tier', 'light'] });
  await f.finished(run, 'template');
  const kept = path.join(f.root, 'template');
  fs.cpSync(path.join(run.dir, 'tasks', 'template'), kept, { recursive: true });
  fs.rmSync(path.join(run.dir, 'tasks', 'template'), { recursive: true });
  return kept;
}

// A finished Codex task in `run`. `firstTier` is the tier attempt 1 ran at, `tier` the last attempt's;
// `verdict` is accepted on the first or the last attempt, or rejected; `model` replaces the first
// attempt's model in its result.
function seed(source, run, id, { tier = 'light', firstTier = tier, attempts = 1, elapsed = 60000, verdict = null, babysit = false, model } = {}) {
  const dir = path.join(run.dir, 'tasks', id);
  fs.cpSync(source, dir, { recursive: true });
  for (let n = 2; n <= attempts; n++) fs.cpSync(path.join(dir, 'attempt-1'), path.join(dir, `attempt-${n}`), { recursive: true });
  const resultFile = path.join(dir, 'attempt-1', 'result.json');
  writeJson(resultFile, { ...readJson(resultFile), model: model ?? codexTiers[firstTier].model, effort: codexTiers[firstTier].effort,
    startedAt: '2026-01-01T00:00:00Z', finishedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + elapsed).toISOString() });
  const stamp = { first: { acceptedAt: '2026-01-01T09:00:00Z', acceptedAttempt: 1 },
    last: { acceptedAt: '2026-01-01T09:00:00Z', acceptedAttempt: attempts },
    rejected: { rejectedAt: '2026-01-01T09:00:00Z', rejectedAttempt: attempts } }[verdict];
  writeJson(path.join(dir, 'task.json'), { ...readJson(path.join(source, 'task.json')), id, tier, model: codexTiers[tier].model,
    effort: codexTiers[tier].effort, attempt: attempts, outDir: path.join(dir, `attempt-${attempts}`), babysit, ...stamp });
}

// No installed agent CLI: `agents` then lists the relays without starting a CLI, whatever this machine has.
const noAgentClis = (f) => {
  const empty = path.join(f.root, 'empty-bin');
  fs.mkdirSync(empty, { recursive: true });
  return { env: { PATH: empty } };
};

test('agents, the --tier error and stats show each tier\'s results from the last 30 days', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const source = await template(f, run);
  const cache = path.join(f.state, 'tier-evidence.json');
  // Starting a task with its tier reads and writes no summary.
  assert.equal(fs.existsSync(cache), false);

  // light: six finished tasks. Three accepted first try (60, 120, 180 s); one redone at the standard
  // tier and accepted there (240 s, two attempts); one rejected (300 s); one with no verdict (360 s).
  seed(source, run, 'l1', { elapsed: 60000, verdict: 'first' });
  seed(source, run, 'l2', { elapsed: 120000, verdict: 'first' });
  seed(source, run, 'l3', { elapsed: 180000, verdict: 'first' });
  seed(source, run, 'l4', { tier: 'standard', firstTier: 'light', attempts: 2, elapsed: 240000, verdict: 'last' });
  seed(source, run, 'l5', { elapsed: 300000, verdict: 'rejected' });
  seed(source, run, 'l6', { elapsed: 360000 });
  // standard: five finished tasks (the redone one is light's), a babysitter, and a task on a model no tier runs now.
  for (const n of [1, 2, 3, 4]) seed(source, run, `s${n}`, { tier: 'standard', verdict: 'first' });
  seed(source, run, 's5', { tier: 'standard' });
  seed(source, run, 's-babysit', { tier: 'standard', verdict: 'first', babysit: true });
  seed(source, run, 's-retired', { tier: 'standard', verdict: 'first', model: 'gpt-5-retired' });
  // strong: four finished tasks, one short of a rate.
  for (const n of [1, 2, 3, 4]) seed(source, run, `g${n}`, { tier: 'strong', verdict: 'first' });
  // Five light tasks in a run older than 30 days are outside the window.
  const old = await f.newRun('old');
  writeJson(path.join(old.dir, 'run.json'), { ...readJson(path.join(old.dir, 'run.json')), createdAt: new Date(Date.now() - 40 * 86400000).toISOString() });
  for (let n = 1; n <= 5; n++) seed(source, old, `o${n}`, { verdict: 'first' });

  const expected = {
    light: 'last 30d: 6 tasks, 60% accepted first try (3 of 5 reviewed), median first attempt 3m30s, 150 input tokens per accepted task',
    standard: 'last 30d: 5 tasks, 100% accepted first try (4 of 4 reviewed), median first attempt 1m00s, 120 input tokens per accepted task',
    strong: tooFew(4),
    complex: tooFew(0),
  };

  // `agents`: one line per tier, the numbers beside the model.
  const agents = (await f.command(['agents'], noAgentClis(f))).stdout.split('\n');
  assert.deepEqual(agents.filter((line) => line.startsWith('  codex --tier')),
    Object.entries(codexTiers).map(([tier, choice]) =>
      `  codex --tier ${tier.padEnd(8)} → ${choice.model}, effort ${choice.effort} [${expected[tier]}]: ${choice.use}`));
  const { light: claudeLight } = policy.claude.tiers;
  assert.ok(agents.includes(`  claude --tier light    → ${claudeLight.model}, effort ${claudeLight.effort} [${tooFew(0)}]: ${claudeLight.use}`));
  // The same numbers as JSON.
  const json = await f.json(['agents'], noAgentClis(f));
  assert.deepEqual(json.tierEvidence.find((e) => e.agent === 'codex' && e.tier === 'light'),
    { agent: 'codex', tier: 'light', tasks: 6, reviewed: 5, firstAttemptAccepted: 3, firstAttemptAcceptance: 0.6,
      accepted: 4, tokensInPerAccepted: 150, medianFirstAttemptMs: 210000 });

  // The error that asks for --tier carries the numbers on each tier's line, for both agents.
  const refused = await f.command(['start', run.id, 'fresh', '--agent', 'codex', '--why', 'Evidence', '--brief', f.brief('fresh')], { code: 2 });
  const width = Math.max(...Object.keys(codexTiers).map((name) => name.length));
  assert.deepEqual(refused.stderr.split('\n').filter((line) => line.startsWith('  ')),
    Object.entries(codexTiers).map(([tier, choice]) => `  ${tier.padEnd(width)}  ${choice.use} [${expected[tier]}]`));
  const claude = await f.command(['start', run.id, 'fresh', '--agent', 'claude', '--why', 'Evidence', '--brief', f.brief('fresh')], { code: 2 });
  const claudeLines = claude.stderr.split('\n').filter((line) => line.startsWith('  '));
  assert.equal(claudeLines.length, Object.keys(policy.claude.tiers).length);
  for (const line of claudeLines) assert.ok(line.endsWith(` [${tooFew(0)}]`), line);
  assert.equal(fs.existsSync(path.join(run.dir, 'tasks', 'fresh')), false);

  // `stats` adds the input tokens of an accepted task to each group: light's own model has three
  // accepted tasks of 120; the standard model's seven (one of them over two attempts) average 137.
  const label = (tier) => `${codexTiers[tier].model.replace(/^gpt-/, '')} ${codexTiers[tier].effort}`;
  const stats = await f.json(['stats']);
  const group = (tier) => stats.byAgent.find((g) => g.agent === 'codex' && g.modelLabel === label(tier));
  assert.deepEqual([group('light').accepted, group('light').tokensInPerAccepted], [3, 120]);
  assert.deepEqual([group('standard').accepted, group('standard').tokensInPerAccepted], [7, 137]);
  assert.match((await f.command(['stats'])).stdout, /TOKENS IN PER ACCEPTED/);
});

test('the summary keeps one record per task and reads again only the tasks that changed', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const source = await template(f, run);
  for (let n = 1; n <= 5; n++) seed(source, run, `l${n}`, { verdict: 'first' });
  const lightOf = async () => (await f.json(['agents'], noAgentClis(f))).tierEvidence.find((e) => e.agent === 'codex' && e.tier === 'light');
  assert.deepEqual([(await lightOf()).tasks, (await lightOf()).tokensInPerAccepted], [5, 120]);
  const cache = path.join(f.state, 'tier-evidence.json');
  assert.ok(fs.existsSync(cache), 'agents leaves the records in the state folder');

  // Nothing changed: the next call reads the records and not the tasks. A doctored record shows it.
  const kept = readJson(cache);
  const first = path.join(run.dir, 'tasks', 'l1');
  assert.equal(kept.tasks[first].item.tokensIn, 120);
  kept.tasks[first].item.tokensIn = 1120;
  writeJson(cache, kept);
  assert.equal((await lightOf()).tokensInPerAccepted, 320);
  // The error that asks for --tier reads the same records.
  const refused = await f.command(['start', run.id, 'fresh', '--agent', 'codex', '--why', 'Evidence', '--brief', f.brief('fresh')], { code: 2 });
  assert.match(refused.stderr, /\[last 30d: 5 tasks, 100% accepted first try \(5 of 5 reviewed\), median first attempt 1m00s, 320 input tokens per accepted task\]/);

  // A new task, and then a verdict on it, change only its own record: the doctored one stays.
  seed(source, run, 'l6', {});
  assert.deepEqual([(await lightOf()).tasks, (await lightOf()).tokensInPerAccepted], [6, 320]);
  const verdictFile = f.taskFile(run, 'l6');
  writeJson(verdictFile, { ...readJson(verdictFile), acceptedAt: '2026-01-01T09:00:00Z', acceptedAttempt: 1 });
  const light = await lightOf();
  assert.deepEqual([light.accepted, light.tokensInPerAccepted], [6, 287]);
  // A task that is removed leaves the records.
  fs.rmSync(path.join(run.dir, 'tasks', 'l6'), { recursive: true });
  assert.equal((await lightOf()).tasks, 5);
  assert.equal(Object.keys(readJson(cache).tasks).length, 5);
});
