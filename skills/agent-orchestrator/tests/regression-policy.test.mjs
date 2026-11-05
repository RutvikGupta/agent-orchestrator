import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';

const policy = readJson(new URL('../policy.json', import.meta.url));
test('model policy rejects direct and passthrough overrides before dispatch', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const agent of ['claude', 'codex']) {
    for (const flags of [['--model', 'wrong'], ['--', '--model=wrong'], ['--', '--effort', 'low']]) {
      const result = await f.command(['start', run.id, 'refused', '--agent', agent,
        ...(agent === 'codex' ? ['--tier', 'standard'] : []),
        '--why', 'Policy regression', '--brief', f.brief('refused'), ...flags], { code: 2 });
      assert.match(result.stderr, agent === 'claude' ? /Claude always runs/ : /choose the Codex model with --tier/);
    }
  }
  for (const [agent, tier] of [['claude', 'standard'], ['codex', 'imaginary']]) {
    await f.command(['start', run.id, 'refused', '--agent', agent, '--tier', tier,
      '--why', 'Policy regression', '--brief', f.brief('refused')], { code: 2 });
  }
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});

test('every allowed model tier reaches the relay with the policy effort', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const [agent, tier, choice] of [ ['claude', null, policy.claude],
    ...Object.entries(policy.codex.tiers).map(([tier, choice]) => ['codex', tier, choice]) ]) {
    const id = `${agent}-${tier || 'fixed'}`;
    const started = await f.start(run, id, { agent, flags: tier ? ['--tier', tier] : [] });
    await f.finished(run, id);
    const { argv } = readJson(path.join(started.outDir, 'invocation.json'));
    assert.equal(argv[argv.indexOf('--model') + 1], choice.model);
    assert.equal(argv[argv.indexOf('--effort') + 1], choice.effort);
  }
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
    const refused = await f.command(['start', run.id, 'overflow', '--agent', 'claude', '--read-only',
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
