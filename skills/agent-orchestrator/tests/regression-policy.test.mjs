import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, readJson, writeJson } from './helpers.mjs';
import { failureHistory } from '../scripts/lib/escalation.mjs';

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
    ['codex', 'imaginary', 'unknown --tier "imaginary" (choose: light, standard, strong, complex)'],
    ['codex', 'frontier', 'unknown --tier "frontier"'],
  ]) {
    const result = await f.command(['start', run.id, 'refused', '--agent', agent, '--tier', tier,
      '--why', 'Policy regression', '--brief', f.brief('refused')], { code: 2 });
    assert.ok(result.stderr.includes(message), result.stderr);
  }
  const codex = await f.command(['start', run.id, 'refused', '--agent', 'codex', '--why', 'Policy regression', '--brief', f.brief('refused')], { code: 2 });
  assert.ok(codex.stderr.includes(`--tier is required for Codex: ${tierList('codex')}`), codex.stderr);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});

test('the frontier tier runs Fable at high, or medium with --effort, and never above high', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const frontier = policy.claude.tiers.frontier;
  assert.equal(frontier.model, 'claude-fable-5-2');
  assert.deepEqual([frontier.effort, frontier.efforts], ['high', ['medium', 'high']]);
  const medium = await f.start(run, 'long-medium', { flags: ['--tier', 'frontier', '--effort', 'medium'] });
  assert.deepEqual([medium.model, medium.effort], ['claude-fable-5-2', 'medium']);
  await f.finished(run, 'long-medium');
  const { argv } = readJson(path.join(medium.outDir, 'invocation.json'));
  assert.equal(argv[argv.indexOf('--effort') + 1], 'medium');
  for (const level of ['xhigh', 'max', 'low']) {
    const refused = await f.command(['start', run.id, `too-${level}`, '--agent', 'claude', '--tier', 'frontier', '--effort', level,
      '--why', 'Policy regression', '--brief', f.brief('refused')], { code: 2 });
    assert.match(refused.stderr, new RegExp(`--effort ${level} is not allowed for the claude frontier tier: choose medium or high \\(never higher\\)`));
  }
  // Every other tier runs at its own effort only.
  for (const [agent, tier] of [['claude', 'complex'], ['codex', 'complex']]) {
    const refused = await f.command(['start', run.id, `${agent}-effort`, '--agent', agent, '--tier', tier, '--effort', 'high',
      '--why', 'Policy regression', '--brief', f.brief('refused')], { code: 2 });
    assert.match(refused.stderr, new RegExp(`the ${agent} ${tier} tier runs at \\w+ only`));
  }
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')).sort(), ['long-medium']);
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

test('a same-tier follow-up keeps its choice until two failures, then escalates in the same session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const agent of ['claude', 'codex']) {
    const id = `retry-${agent}`;
    await f.start(run, id, { agent, flags: ['--tier', 'light'], config: { status: 'failed' } });
    await f.finished(run, id);
    const second = await f.json(['start', run.id, id, '--agent', agent, '--brief', f.brief('second', { status: 'timeout' })]);
    assert.equal(second.tier, 'light');
    await f.finished(run, id);
    const third = await f.command(['start', run.id, id, '--agent', agent, '--brief', f.brief('third')]);
    assert.match(third.stdout, /automatically escalated .* from light to standard: 2 counted failures/);
    const task = readJson(f.taskFile(run, id));
    assert.equal(task.tier, 'standard');
    const row = await f.finished(run, id);
    const { argv } = readJson(path.join(task.outDir, 'invocation.json'));
    assert.equal(argv[argv.indexOf('--session') + 1], `fixture-${agent}`);
    assert.equal(row.failureCount, 2);
    assert.deepEqual(row.attempts.map((a) => a.tier), ['standard', 'light', 'light']);
    const result = await f.json(['result', run.id, id]);
    assert.equal(result.failureCount, 2);
    assert.deepEqual(result.attempts.map((a) => a.tier), ['standard', 'light', 'light']);
    const resultText = await f.command(['result', run.id, id]);
    assert.match(resultText.stdout, /2 counted failures; attempts: 1 .* light, 2 .* light, 3 .* standard/);
    const status = await f.command(['status', run.id]);
    assert.match(status.stdout, /2 counted failures; attempts: 1 .* light, 2 .* light, 3 .* standard/);
  }
});

test('review changes and reject count once per attempt, while usage limits and owner stops do not', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'review', { flags: ['--tier', 'light'] });
  await f.finished(run, 'review');
  await f.command(['verdict', run.id, 'review', 'changes', '--note', 'missed a caller']);
  await f.command(['verdict', run.id, 'review', 'reject', '--note', 'same attempt']);
  let row = (await f.json(['status', run.id])).tasks[0];
  assert.equal(row.failureCount, 1);
  await f.command(['start', run.id, 'review', '--agent', 'claude', '--brief', f.brief('failed', { status: 'failed' })]);
  await f.finished(run, 'review');
  const up = await f.json(['start', run.id, 'review', '--agent', 'claude', '--brief', f.brief('up')]);
  assert.equal(up.tier, 'standard');
  await f.finished(run, 'review');
  for (let n = 0; n < 2; n++) {
    await f.start(run, 'limit', { flags: ['--tier', 'light'], config: { status: 'failed', error: 'usage limit reached' } });
    row = await f.finished(run, 'limit');
    assert.equal(row.failureCount, 0);
  }
  const kept = await f.json(['start', run.id, 'limit', '--agent', 'claude', '--brief', f.brief('limit-again')]);
  assert.equal(kept.tier, 'light');
  await f.finished(run, 'limit');
  const held = await f.start(run, 'stopped', { flags: ['--tier', 'light'], config: { hold: true } });
  await f.ready(held);
  await f.command(['stop', run.id, 'stopped']);
  // Historical owner stop remains excluded even if its relay recorded an aborted result.
  writeJson(path.join(held.outDir, 'result.json'), { status: 'aborted', model: held.model });
  await f.command(['start', run.id, 'stopped', '--agent', 'claude', '--brief', f.brief('after-stop')]);
  row = await f.finished(run, 'stopped');
  assert.equal(row.failureCount, 0);
});

test('top-tier failures and two failures after escalation refuse with the other agent tier', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const [agent, tier, peer, peerTier] of [['codex', 'complex', 'claude', 'complex'], ['claude', 'frontier', 'codex', 'complex']]) {
    const id = `top-${agent}`;
    for (let n = 0; n < 2; n++) {
      await f.start(run, id, { agent, flags: ['--tier', tier], config: { status: 'failed' } });
      await f.finished(run, id);
    }
    const refused = await f.command(['start', run.id, id, '--agent', agent, '--brief', f.brief('top-again')], { code: 2 });
    assert.match(refused.stderr, new RegExp(`fresh brief: --agent ${peer} --tier ${peerTier}`));
    assert.equal(readJson(f.taskFile(run, id)).attempt, 2);
    const switched = await f.json(['start', run.id, id, '--agent', peer, '--tier', peerTier, '--why', 'Different approach', '--brief', f.brief('switch')]);
    assert.equal(switched.agent, peer);
    await f.finished(run, id);
  }
  for (let n = 0; n < 2; n++) {
    await f.start(run, 'ladder', { flags: ['--tier', 'light'], config: { status: 'failed' } });
    await f.finished(run, 'ladder');
  }
  for (let n = 0; n < 2; n++) {
    const task = await f.json(['start', run.id, 'ladder', '--agent', 'claude', '--brief', f.brief(`up-${n}`, { status: 'failed' })]);
    assert.equal(task.tier, 'standard');
    await f.finished(run, 'ladder');
  }
  const refused = await f.command(['start', run.id, 'ladder', '--agent', 'claude', '--brief', f.brief('too-many')], { code: 2 });
  assert.match(refused.stderr, /after automatic escalation.*--agent codex --tier standard/);
});

test('explicit tier and no-escalate override automatic escalation, and the delegated guard still applies', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  await f.start(parent, 'owner', { flags: ['--tier', 'light'] });
  await f.finished(parent, 'owner');
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'owner' };
  const run = await f.newRun('child', env);
  for (let n = 0; n < 2; n++) {
    await f.start(run, 'child', { env, flags: ['--tier', 'light'], config: { status: 'failed' } });
    await f.finished(run, 'child');
  }
  const refused = await f.command(['start', run.id, 'child', '--agent', 'claude', '--brief', f.brief('guard')], { code: 2, env });
  assert.match(refused.stderr, /stronger.*delegated agent never starts a stronger.*ask/s);
  assert.equal(readJson(f.taskFile(run, 'child')).attempt, 2);
  for (const flags of [['--tier', 'light'], ['--no-escalate']]) {
    const kept = await f.json(['start', run.id, 'child', '--agent', 'claude', '--brief', f.brief('override'), ...flags], { env });
    assert.equal(kept.tier, 'light');
    await f.finished(run, 'child');
  }
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

test('a delegated task never starts a stronger tier than its own, on either agent; its own tier or lighter starts', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  for (const [id, agent, tier] of [['luna', 'codex', 'light'], ['sol', 'codex', 'strong'], ['opus', 'claude', 'complex']]) {
    await f.start(parent, id, { agent, flags: ['--tier', tier] });
    await f.finished(parent, id);
  }
  const as = (task) => ({ AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: task });
  const cases = [
    ['luna', 'claude', 'standard', 2, 'codex light (gpt-6-luna)'],
    ['luna', 'codex', 'standard', 2, 'codex light (gpt-6-luna)'],
    ['luna', 'claude', 'light', 0],
    ['sol', 'claude', 'complex', 2, 'codex strong (gpt-6.1-sol)'],
    ['sol', 'claude', 'standard', 0],
    ['opus', 'claude', 'frontier', 2, 'claude complex (claude-opus-5-5)'],
    ['opus', 'codex', 'complex', 0],
  ];
  for (const [caller, agent, tier, code, own] of cases) {
    const run = await f.newRun(`from-${caller}`, as(caller));
    const id = `${agent}-${tier}`;
    const result = await f.command(['start', run.id, id, '--agent', agent, '--tier', tier, '--why', 'tier guard', '--brief', f.brief(id)], { code, env: as(caller) });
    if (code) {
      assert.ok(result.stderr.includes(`this command runs in task ${parent.id}/${caller}, on ${own}`), result.stderr);
      assert.match(result.stderr, /never starts a stronger model than its own/);
      assert.match(result.stderr, /orch\.mjs ask "/);
      assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), [], 'nothing starts');
    } else {
      await f.finished(run, id);
    }
  }
});

test('failure receipts count aborted attempts and optional refused accepts without double counting', async (t) => {
  const f = await fixture(t);
  const run = { dir: f.root };
  const task = { id: 'receipts', agent: 'codex', tier: 'standard', attempt: 7,
    attemptStops: { 4: 'owner stopped' },
    acceptRefusals: [{ attempt: 5, reason: 'missing-gates' }, { attempt: 6, reason: 'failed-gates' }] };
  for (const [n, result] of [
    [2, { status: 'aborted', error: 'weekly limit reached' }],
    [3, { status: 'timeout' }], [4, { status: 'aborted' }],
    [5, { status: 'completed' }], [6, { status: 'failed' }],
  ]) writeJson(path.join(f.root, 'tasks', task.id, `attempt-${n}`, 'result.json'), result);
  const history = failureHistory(run, task, 'aborted');
  assert.equal(history.failureCount, 5);
  assert.deepEqual(history.attempts.filter((a) => a.failed).map((a) => a.n), [1, 3, 5, 6, 7]);
  assert.equal(failureHistory(run, task, 'running').failureCount, 4);
});
