// How each tier has done on this machine: the shared summary (lib/stats.mjs), and where it is
// shown: `agents`, the error that asks for --tier, and the cache that keeps reads cheap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

const policy = readJson(new URL('../policy.json', import.meta.url));
const codexTiers = policy.codex.tiers;
const DAY = 86400000;
const tooFew = (n) => `last 30d: too few tasks (${n} finished, 5 needed)`;
// The PID of a process that has exited: the relay of a task that is no longer running.
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;

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
    // Not counted: a babysitter, and a model no tier runs now.
    item('codex', luna, { chosen: false, accepted: 1, firstAttemptAccepted: 1, reviewed: true, tokensIn: 7000 }),
    item('codex', 'gpt-5-retired', { accepted: 1, firstAttemptAccepted: 1, reviewed: true, tokensIn: 7000 }),
  ];
  const light = entry(items, 'light');
  // The cost of an accepted task is all five tasks' 1000 input tokens over the three that were accepted.
  assert.deepEqual(light, { agent: 'codex', tier: 'light', tasks: 5, reviewed: 4, firstAttemptAccepted: 2,
    firstAttemptAcceptance: 0.5, accepted: 3, tokensInPerAccepted: 333, medianFirstAttemptMs: 180000 });
  assert.equal(entry(items, 'standard').tasks, 0);
  assert.equal(evidenceText(light),
    'last 30d: 5 tasks, 50% accepted first try (2 of 4 reviewed), median first attempt 3m00s, 333 input tokens per accepted task');

  // The threshold: four finished tasks show no rate, and so do none.
  assert.equal(evidenceText(entry(items.slice(0, 4), 'light')), tooFew(4));
  assert.equal(evidenceText(entry([], 'light')), tooFew(0));
  assert.equal(evidenceText(undefined), tooFew(0));
  // Five finished and none reviewed or accepted yet: the counts show, and the rates say why they do not.
  const open = Array.from({ length: 5 }, () => item('codex', terra, { elapsedMs: 90000 }));
  assert.equal(evidenceText(entry(open, 'standard')),
    'last 30d: 5 tasks, no reviewed task yet, median first attempt 1m30s, no accepted task yet');
});

test('tokens per accepted task is what it cost to get one: every finished task\'s input tokens, accepted or not', async () => {
  const { tierSummary } = await import('../scripts/lib/stats.mjs');
  const luna = codexTiers.light.model;
  // One accepted task of 100 tokens and nine failed ones of 100 each: obtaining the accepted one used 1000.
  const items = [item('codex', luna, { accepted: 1, firstAttemptAccepted: 1, reviewed: true, tokensIn: 100 }),
    ...Array.from({ length: 9 }, () => item('codex', luna, { reviewed: true, tokensIn: 100 }))];
  const light = tierSummary(items, policy).find((e) => e.agent === 'codex' && e.tier === 'light');
  assert.deepEqual([light.tasks, light.accepted, light.tokensInPerAccepted], [10, 1, 1000]);
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
  assert.deepEqual(tiersOf({ tier: 'low' }), ['low'], 'a first attempt without a model: the tier a one-attempt task recorded');
  assert.deepEqual(tiersOf({ tier: 'renamed-since' }), [], 'a tier that policy.json no longer has');
});

// Runs a real fake-relay task once, then keeps its folder as the template that `seed` copies from, so
// that seeded tasks carry the relay's own records. The task itself leaves the run, so that it is not counted.
async function template(f, run, agent = 'codex') {
  const id = `template-${agent}`;
  await f.start(run, id, { agent, flags: ['--tier', 'light'] });
  await f.finished(run, id);
  const kept = path.join(f.root, id);
  fs.cpSync(path.join(run.dir, 'tasks', id), kept, { recursive: true });
  fs.rmSync(path.join(run.dir, 'tasks', id), { recursive: true });
  return kept;
}

// A task in `run` whose relay is gone. `firstTier` is the tier attempt 1 ran at, `tier` the last
// attempt's; it finished `age` ms ago after running `elapsed` ms. `verdict`: accepted on the first or
// the last attempt, or rejected. `model` replaces the first attempt's model in its result; `status`
// its status; `crashed` removes its result, as when a relay exits without one.
function seed(source, run, id, { agent = 'codex', tier = 'light', firstTier = tier, attempts = 1, elapsed = 60000, age = 3600000,
  verdict = null, babysit = false, model, status, crashed = false } = {}) {
  const tiers = policy[agent].tiers;
  const dir = path.join(run.dir, 'tasks', id);
  fs.cpSync(source, dir, { recursive: true });
  for (let n = 2; n <= attempts; n++) fs.cpSync(path.join(dir, 'attempt-1'), path.join(dir, `attempt-${n}`), { recursive: true });
  const started = Date.now() - age - elapsed;
  for (let n = 1; n <= attempts; n++) {
    const file = path.join(dir, `attempt-${n}`, 'result.json');
    const ran = tiers[n === 1 ? firstTier : tier];
    writeJson(file, { ...readJson(file), model: n === 1 && model ? model : ran.model, effort: ran.effort, ...(n === 1 && status ? { status } : {}),
      startedAt: new Date(started).toISOString(), finishedAt: new Date(started + elapsed).toISOString() });
  }
  if (crashed) fs.rmSync(path.join(dir, 'attempt-1', 'result.json'));
  const stamp = { first: { acceptedAt: new Date(started + elapsed + 1000).toISOString(), acceptedAttempt: 1 },
    last: { acceptedAt: new Date(started + elapsed + 1000).toISOString(), acceptedAttempt: attempts },
    rejected: { rejectedAt: new Date(started + elapsed + 1000).toISOString(), rejectedAttempt: attempts } }[verdict];
  writeJson(path.join(dir, 'task.json'), { ...readJson(path.join(source, 'task.json')), id, tier, model: tiers[tier].model,
    effort: tiers[tier].effort, attempt: attempts, outDir: path.join(dir, `attempt-${attempts}`), babysit, pid: deadPid,
    startedAt: new Date(started).toISOString(), ...stamp });
}

// No installed agent CLI: `agents` then lists the relays without starting a CLI, whatever this machine has.
// Only `ps` is on the path, which the check for a running relay needs.
const noAgentClis = (f) => {
  const bin = path.join(f.root, 'only-ps');
  fs.mkdirSync(bin, { recursive: true });
  const ps = ['/bin/ps', '/usr/bin/ps'].find((file) => fs.existsSync(file));
  if (!fs.existsSync(path.join(bin, 'ps'))) fs.symlinkSync(ps, path.join(bin, 'ps'));
  return { env: { PATH: bin } };
};
const evidence = async (f) => (await f.json(['agents'], noAgentClis(f))).tierEvidence;
const entryOf = (list, agent, tier) => list.find((e) => e.agent === agent && e.tier === tier);

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

  const expected = {
    // 840 input tokens (the redone task used 240) over the four accepted tasks.
    light: 'last 30d: 6 tasks, 60% accepted first try (3 of 5 reviewed), median first attempt 3m30s, 210 input tokens per accepted task',
    standard: 'last 30d: 5 tasks, 100% accepted first try (4 of 4 reviewed), median first attempt 1m00s, 150 input tokens per accepted task',
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
  assert.deepEqual(entryOf(await evidence(f), 'codex', 'light'),
    { agent: 'codex', tier: 'light', tasks: 6, reviewed: 5, firstAttemptAccepted: 3, firstAttemptAcceptance: 0.6,
      accepted: 4, tokensInPerAccepted: 210, medianFirstAttemptMs: 210000 });

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

  // `stats` adds what an accepted task cost to each group: every input token of the group's tasks over
  // its accepted ones. Light's own model: five tasks of 120 over three accepted. The standard model:
  // 840 from seven tasks and 240 from the redone one, over seven accepted.
  const label = (tier) => `${codexTiers[tier].model.replace(/^gpt-/, '')} ${codexTiers[tier].effort}`;
  const stats = await f.json(['stats']);
  const group = (tier) => stats.byAgent.find((g) => g.agent === 'codex' && g.modelLabel === label(tier));
  assert.deepEqual([group('light').accepted, group('light').tokensIn, group('light').tokensInPerAccepted], [3, 600, 200]);
  assert.deepEqual([group('standard').accepted, group('standard').tokensIn, group('standard').tokensInPerAccepted], [7, 1080, 154]);
  assert.match((await f.command(['stats'])).stdout, /TOKENS IN PER ACCEPTED/);
});

test('a task is in the window by its own finish time, whatever the creation date of its run', async (t) => {
  const f = await fixture(t);
  const recent = await f.newRun('recent');
  const old = await f.newRun('old');
  const source = await template(f, recent);
  const oldFile = path.join(old.dir, 'run.json');
  writeJson(oldFile, { ...readJson(oldFile), createdAt: new Date(Date.now() - 40 * DAY).toISOString() });
  // Finished today in a run made 40 days ago: counted.
  for (let n = 1; n <= 5; n++) seed(source, old, `new${n}`, { verdict: 'first' });
  // Finished 40 days ago in the same run, and 31 days ago in a recent run: not counted.
  for (let n = 1; n <= 3; n++) seed(source, old, `gone${n}`, { age: 40 * DAY, verdict: 'first' });
  for (let n = 1; n <= 4; n++) seed(source, recent, `ancient${n}`, { age: 31 * DAY, verdict: 'first' });
  const light = entryOf(await evidence(f), 'codex', 'light');
  assert.deepEqual([light.tasks, light.accepted], [5, 5]);
  // A task that finished before the window is kept as its time only.
  const gone = readJson(path.join(f.state, 'tier-evidence.json')).tasks[path.join(old.dir, 'tasks', 'gone1')];
  assert.deepEqual([gone.item, typeof gone.at], [null, 'number']);
});

test('a first attempt that failed, or ended with no result, is a finished task that missed; a running one is not counted yet', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const codex = await template(f, run, 'codex');
  const claude = await template(f, run, 'claude');

  // Codex light: two accepted first try; a relay that exited with no result; a first attempt that
  // failed; one finished with no verdict. Five finished tasks, four of them judged, two accepted.
  seed(codex, run, 'a1', { verdict: 'first' });
  seed(codex, run, 'a2', { verdict: 'first' });
  seed(codex, run, 'crashed', { crashed: true });
  seed(codex, run, 'failed', { status: 'failed' });
  seed(codex, run, 'open', {});
  let light = entryOf(await evidence(f), 'codex', 'light');
  assert.deepEqual([light.tasks, light.reviewed, light.firstAttemptAccepted, light.firstAttemptAcceptance, light.accepted], [5, 4, 2, 0.5, 2]);
  assert.equal(light.medianFirstAttemptMs, 60000, 'a crash has no end time, so it is left out of the median');

  // A task whose relay still runs is not counted until it ends.
  const live = await f.start(run, 'live', { agent: 'codex', config: { hold: true }, flags: ['--tier', 'light'] });
  await f.ready(live);
  assert.equal(entryOf(await evidence(f), 'codex', 'light').tasks, 5);
  f.release(live);
  await f.finished(run, 'live');
  light = entryOf(await evidence(f), 'codex', 'light');
  assert.deepEqual([light.tasks, light.reviewed], [6, 4]);

  // Claude light: a first attempt that left no result and was redone at the standard tier. The tier
  // is read from the attempt's event log, and the task is light's miss, not standard's.
  for (const n of [1, 2, 3]) seed(claude, run, `c${n}`, { agent: 'claude', verdict: 'first' });
  seed(claude, run, 'moved', { agent: 'claude', tier: 'standard', firstTier: 'light', attempts: 2, crashed: true, verdict: 'last' });
  seed(claude, run, 'c5', { agent: 'claude' });
  const list = await evidence(f);
  const claudeLight = entryOf(list, 'claude', 'light');
  assert.deepEqual([claudeLight.tasks, claudeLight.reviewed, claudeLight.firstAttemptAccepted, claudeLight.firstAttemptAcceptance], [5, 4, 3, 0.75]);
  assert.equal(entryOf(list, 'claude', 'standard').tasks, 0);
});

test('the summary keeps one record per task and reads again only the tasks that changed', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const source = await template(f, run);
  for (let n = 1; n <= 5; n++) seed(source, run, `l${n}`, { verdict: 'first' });
  const lightOf = async () => entryOf(await evidence(f), 'codex', 'light');
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

  // A new task, and then a verdict on it, change only its own record: the doctored one stays. The new
  // task's 120 tokens count at once, though it is not accepted.
  seed(source, run, 'l6', {});
  assert.deepEqual([(await lightOf()).tasks, (await lightOf()).tokensInPerAccepted], [6, 344]);
  const verdictFile = f.taskFile(run, 'l6');
  writeJson(verdictFile, { ...readJson(verdictFile), acceptedAt: new Date().toISOString(), acceptedAttempt: 1 });
  const light = await lightOf();
  assert.deepEqual([light.accepted, light.tokensInPerAccepted], [6, 287]);
  // A task that is removed leaves the records.
  fs.rmSync(path.join(run.dir, 'tasks', 'l6'), { recursive: true });
  assert.equal((await lightOf()).tasks, 5);
  assert.equal(Object.keys(readJson(cache).tasks).length, 5);
});
