import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, readJson, writeJson } from './helpers.mjs';

const policy = readJson(new URL('../policy.json', import.meta.url));
const tiersOf = (agent) => Object.entries(policy[agent].tiers);
// "light = claude-haiku-5-5, standard = ...", as the error messages list an agent's tiers.
const tierList = (agent) => tiersOf(agent).map(([tier, choice]) => `${tier} = ${choice.model}`).join(', ');

test('model policy rejects direct and passthrough overrides and unknown tiers before dispatch', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const agent of ['claude', 'codex']) {
    for (const flags of [['--model', 'wrong'], ['--', '--model=wrong'], ['--', '--effort', 'low']]) {
      const result = await f.command(['start', run.id, 'refused', '--agent', agent,
        ...(agent === 'codex' ? ['--tier', 'standard'] : []),
        '--why', 'Policy regression', '--brief', f.brief('refused'), ...flags], { code: 2 });
      if (agent === 'claude') assert.ok(result.stderr.includes(`choose the Claude model with --tier (${tierList('claude')}), not --model/--effort`), result.stderr);
      else assert.match(result.stderr, /choose the Codex model with --tier/);
    }
  }
  for (const [agent, tier, message] of [
    ['claude', 'imaginary', `unknown --tier "imaginary" for Claude (choose: ${tierList('claude')})`],
    ['claude', 'constructor', 'unknown --tier "constructor" for Claude'],
    ['codex', 'imaginary', 'unknown --tier "imaginary" (choose: standard, complex)'],
    ['codex', 'light', 'unknown --tier "light"'],
  ]) {
    const result = await f.command(['start', run.id, 'refused', '--agent', agent, '--tier', tier,
      '--why', 'Policy regression', '--brief', f.brief('refused')], { code: 2 });
    assert.ok(result.stderr.includes(message), result.stderr);
  }
  const codex = await f.command(['start', run.id, 'refused', '--agent', 'codex', '--why', 'Policy regression', '--brief', f.brief('refused')], { code: 2 });
  assert.ok(codex.stderr.includes(`--tier is required for Codex: ${tierList('codex')}`), codex.stderr);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});

test('every tier reaches the relay with its policy model and effort, and status shows the tier', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const all = ['claude', 'codex'].flatMap((agent) => tiersOf(agent).map(([tier, choice]) => [agent, tier, choice]));
  for (const [agent, tier, choice] of all) {
    const id = `${agent}-${tier}`;
    const started = await f.start(run, id, { agent, flags: ['--tier', tier] });
    assert.deepEqual([started.tier, started.model, started.effort], [tier, choice.model, choice.effort ?? null]);
    await f.finished(run, id);
    const { argv } = readJson(path.join(started.outDir, 'invocation.json'));
    assert.equal(argv[argv.indexOf('--model') + 1], choice.model);
    // A tier without an effort leaves the flag out, so the CLI uses its default for the model.
    if (choice.effort) assert.equal(argv[argv.indexOf('--effort') + 1], choice.effort);
    else assert.equal(argv.includes('--effort'), false);
  }
  const rows = new Map((await f.json(['status', run.id])).tasks.map((row) => [row.id, row]));
  const text = (await f.command(['status', run.id])).stdout;
  for (const [agent, tier, choice] of all) {
    const row = rows.get(`${agent}-${tier}`);
    assert.equal(row.tier, tier);
    assert.equal(row.modelLabel, `${choice.model.replace(/^(claude|gpt)-/, '')} ${choice.effort || ''}`.trim());
    assert.match(text, new RegExp(`${agent}-${tier}\\s+${agent} ${tier}: `));
  }
});

// What the error that asks for --tier lists for an agent: its tiers, then one line per tier on when to use it.
const tierUseLines = (agent) => tiersOf(agent).map(([tier, choice]) => `  ${tier.padEnd(Math.max(...Object.keys(policy[agent].tiers).map((t) => t.length)))}  ${choice.use}`);

test('a new Claude task needs --tier: the error lists each tier with when to use it, and nothing starts', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  // Write mode, read-only mode, and a new attempt by another agent all count as a new Claude task.
  await f.start(run, 'by-codex', { agent: 'codex' });
  await f.finished(run, 'by-codex');
  for (const [id, flags] of [['fresh', []], ['fresh-read-only', ['--read-only']], ['by-codex', []]]) {
    const result = await f.command(['start', run.id, id, '--agent', 'claude', '--why', 'Policy regression',
      '--brief', f.brief(id), ...flags], { code: 2 });
    const lines = result.stderr.split('\n');
    assert.ok(lines[0].includes(`--tier is required for a new Claude task: ${tierList('claude')}`), result.stderr);
    assert.match(lines[0], /lightest tier/);
    assert.deepEqual(lines.filter((line) => line.startsWith('  ')), tierUseLines('claude'), result.stderr);
    assert.doesNotMatch(result.stderr, /complex tier|defaults? to complex|without --tier: complex/);
  }
  const codex = await f.command(['start', run.id, 'fresh-codex', '--agent', 'codex', '--why', 'Policy regression',
    '--brief', f.brief('fresh-codex')], { code: 2 });
  assert.deepEqual(codex.stderr.split('\n').filter((line) => line.startsWith('  ')), tierUseLines('codex'), codex.stderr);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), ['by-codex']);
  assert.equal(readJson(f.taskFile(run, 'by-codex')).agent, 'codex');
});

test('the start line names the tier, for each Claude tier', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const [tier, choice] of tiersOf('claude')) {
    const out = await f.command(['start', run.id, tier, '--agent', 'claude', '--tier', tier, '--why', `A ${tier} fixture`,
      '--brief', f.brief(tier)]);
    assert.ok(out.stdout.includes(`started ${tier} → claude ${choice.model} (effort ${choice.effort}, ${tier} tier, write`), out.stdout);
    const task = readJson(f.taskFile(run, tier));
    assert.deepEqual([task.tier, task.model, task.effort], [tier, choice.model, choice.effort]);
    await f.finished(run, tier);
  }
});

test('a babysitter refuses a lighter Claude tier before reading the pull request', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const tier of ['light', 'standard']) {
    const result = await f.command(['start', run.id, 'babysit-1', '--agent', 'claude', '--babysit', '--pr', '1', '--tier', tier,
      '--why', 'Babysits PR #1', '--brief', f.brief('babysit')], { code: 2 });
    assert.match(result.stderr, new RegExp(`a babysitter always runs the complex tier, .*; drop --tier ${tier}$`, 'm'));
  }
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});

test('a Claude follow-up keeps its tier, and a failed lighter attempt names the next tier', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'lookup', { flags: ['--tier', 'light'] });
  await f.finished(run, 'lookup');
  // A follow-up without --tier or --why keeps the tier and the earlier reason; nothing failed yet.
  const kept = await f.command(['start', run.id, 'lookup', '--agent', 'claude', '--brief', f.brief('resume'), '--', '--session', 'fixture-claude']);
  assert.doesNotMatch(kept.stdout, /one tier up/);
  let task = readJson(f.taskFile(run, 'lookup'));
  assert.deepEqual([task.attempt, task.tier, task.model, task.why], [2, 'light', policy.claude.tiers.light.model, first.why]);
  await f.finished(run, 'lookup');

  // A `changes` verdict on a light attempt: starting it at the same tier again prints the next tier.
  await f.command(['verdict', run.id, 'lookup', 'changes', '--note', 'missed a caller']);
  const failingCheck = '```orch-result\n{"outcome":"done","changed":[],"checks":[{"cmd":"npm test","result":"fail","note":"1 failure"}],"decisions":[],"unresolved":[]}\n```';
  const same = await f.command(['start', run.id, 'lookup', '--agent', 'claude', '--brief', f.brief('rework', { finalMessage: failingCheck })]);
  assert.match(same.stdout, /^note: attempt 2 at the light tier failed its review or gates; redo it one tier up, with --tier standard and a new --why$/m);
  await f.finished(run, 'lookup');

  // Attempt 3 reported a failing check. Moving up a tier needs a new --why, and then gives no hint.
  const refused = await f.command(['start', run.id, 'lookup', '--agent', 'claude', '--tier', 'standard', '--brief', f.brief('up')], { code: 2 });
  assert.match(refused.stderr, /--why is required: .* picked claude at the standard tier/);
  const up = await f.command(['start', run.id, 'lookup', '--agent', 'claude', '--tier', 'standard',
    '--why', 'standard: the light attempt missed a caller', '--brief', f.brief('up')]);
  assert.doesNotMatch(up.stdout, /one tier up/);
  task = readJson(f.taskFile(run, 'lookup'));
  assert.deepEqual([task.attempt, task.tier, task.model], [4, 'standard', policy.claude.tiers.standard.model]);
  await f.finished(run, 'lookup');

  // A check the agent itself reported as failing counts too, and Codex `standard` names `complex`.
  const failing = { finalMessage: failingCheck };
  await f.start(run, 'scan', { agent: 'codex', config: failing });
  await f.finished(run, 'scan');
  const codex = await f.command(['start', run.id, 'scan', '--agent', 'codex', '--tier', 'standard', '--brief', f.brief('scan-again')]);
  assert.match(codex.stdout, /^note: attempt 1 at the standard tier failed its review or gates; redo it one tier up, with --tier complex and a new --why$/m);
  await f.finished(run, 'scan');
});

test('a Claude task recorded before tiers resumes at complex with its earlier reason', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'legacy');
  await f.finished(run, 'legacy');
  const file = f.taskFile(run, 'legacy');
  writeJson(file, { ...readJson(file), tier: null });
  const resumed = await f.json(['start', run.id, 'legacy', '--agent', 'claude', '--brief', f.brief('again')]);
  assert.deepEqual([resumed.attempt, resumed.tier, resumed.why], [2, 'complex', first.why]);
  await f.finished(run, 'legacy');
});

test('a bad policy.json stops start with a message that names the problem', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  // A copy of the CLI reads the policy.json next to its own scripts/ folder.
  const copy = path.join(f.root, 'skill-copy');
  fs.cpSync(fileURLToPath(new URL('../scripts', import.meta.url)), path.join(copy, 'scripts'), { recursive: true });
  const cli = path.join(copy, 'scripts', 'orch.mjs');
  const { light, standard } = policy.claude.tiers;
  for (const [content, message] of [
    ['{not json', /orch: missing or invalid \S+policy\.json: it is not readable JSON/],
    [JSON.stringify({ claude: { model: 'claude-opus-5-5', effort: 'xhigh' }, codex: policy.codex }),
      /orch: invalid \S+policy\.json: claude\.tiers must be an object with at least one tier$/m],
    [JSON.stringify({ claude: { tiers: { light, standard } }, codex: policy.codex }), /claude\.tiers needs a "complex" tier/],
    [JSON.stringify({ claude: { tiers: { ...policy.claude.tiers, standard: { effort: 'high' } } }, codex: { tiers: { standard: { model: 'gpt-x', effort: 7 } } } }),
      /claude\.tiers\.standard\.model must be a model name; codex\.tiers\.standard\.effort must be a level/],
    [JSON.stringify({ claude: policy.claude, codex: { tiers: {} } }), /codex\.tiers must be an object with at least one tier/],
  ]) {
    fs.writeFileSync(path.join(copy, 'policy.json'), content);
    const result = spawnSync(process.execPath, [cli, 'start', run.id, 'bad', '--agent', 'claude', '--why', 'Policy regression',
      '--brief', f.brief('bad')], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  }
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});

for (const [depth, slots] of [[2, 4], [3, 2]]) {
  test(`nested depth ${depth} permits ${slots} concurrent task(s) and propagates ancestry`, async (t) => {
    const f = await fixture(t);
    const env = { AGENT_ORCH_DEPTH: String(depth), AGENT_ORCH_RUN: 'parent-run', AGENT_ORCH_TASK: 'parent-task' };
    const run = await f.newRun('nested', env);
    assert.equal(run.orchestrator.parentRun, 'parent-run');
    assert.equal(run.orchestrator.parentTask, 'parent-task');
    for (let i = 0; i < slots; i++) {
      const task = await f.start(run, `child-${i}`, { config: { hold: true }, flags: ['--read-only'], env });
      await f.ready(task);
      assert.equal(readJson(path.join(task.outDir, 'invocation.json')).depth, String(depth + 1));
    }
    const refused = await f.command(['start', run.id, 'overflow', '--agent', 'claude', '--tier', 'light', '--read-only',
      '--why', 'Nested fixture', '--brief', f.brief('overflow')], { code: 1, env });
    assert.match(refused.stderr, new RegExp(`${slots} tasks already running \\(limit ${slots}\\)`));
  });
}

test('a same-choice follow-up reuses why and session, while changing the agent requires a new why', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const first = await f.start(run, 'followup');
  await f.finished(run, 'followup');
  await f.command(['result', run.id, 'followup']);
  const resumed = await f.json(['start', run.id, 'followup', '--agent', 'claude',
    '--brief', f.brief('resume', { hold: true }), '--json', '--', '--session', 'fixture-claude']);
  await f.ready(resumed);
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.why, first.why);
  assert.equal(resumed.closedAt, null);
  const { argv } = readJson(path.join(resumed.outDir, 'invocation.json'));
  assert.equal(argv[argv.indexOf('--session') + 1], 'fixture-claude');
  f.release(resumed);
  await f.finished(run, 'followup');
  const refused = await f.command(['start', run.id, 'followup', '--agent', 'codex', '--tier', 'standard',
    '--brief', f.brief('changed-choice')], { code: 2 });
  assert.match(refused.stderr, /--why is required/);
  assert.equal(readJson(f.taskFile(run, 'followup')).attempt, 2);
});
