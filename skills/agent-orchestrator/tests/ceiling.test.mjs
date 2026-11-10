import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';
import { boundedModel, ceilingEnv, ceilingFor, modelExceedsCeiling } from '../scripts/lib/policy.mjs';

const policy = readJson(new URL('../policy.json', import.meta.url));
const keys = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'AGENT_ORCH_MAX_TIER', 'AGENT_ORCH_MAX_MODEL_CLAUDE', 'AGENT_ORCH_MAX_MODEL_CODEX',
  'AGENT_ORCH_MAX_EFFORT', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SUBAGENT_EFFORT', 'CLAUDE_CODE_EFFORT_LEVEL'];
const snapshot = ['node', '-e', `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] || null]))))`];
async function command(f, run, id, flags = [], env = {}) {
  const task = JSON.parse((await f.command(['start', run.id, id, '--agent', 'command', '--why', 'Check inherited model ceiling',
    '--json', ...flags, '--', ...snapshot], { env })).stdout);
  const row = await f.finished(run, id);
  return { task, vars: JSON.parse(row.result.finalMessage) };
}

test('command ceilings are absent by default and set CLI defaults when selected', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const plain = await command(f, run, 'plain');
  assert.equal(plain.task.maxTier, null);
  assert.deepEqual(plain.vars, Object.fromEntries(keys.map(k => [k, null])));
  const { task, vars } = await command(f, run, 'capped', ['--max-tier', 'light']);
  assert.equal(task.maxTier, 'light');
  assert.deepEqual(vars, {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: policy.claude.tiers.light.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: policy.claude.tiers.light.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: policy.claude.tiers.light.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: policy.claude.tiers.light.model,
    AGENT_ORCH_MAX_TIER: 'light',
    AGENT_ORCH_MAX_MODEL_CLAUDE: policy.claude.tiers.light.model,
    AGENT_ORCH_MAX_MODEL_CODEX: policy.codex.tiers.light.model,
    AGENT_ORCH_MAX_EFFORT: policy.claude.tiers.light.effort,
    ANTHROPIC_MODEL: null,
    ANTHROPIC_DEFAULT_MODEL: null,
    CLAUDE_CODE_SUBAGENT_MODEL: null,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: null,
    CLAUDE_CODE_SUBAGENT_EFFORT: null,
    CLAUDE_CODE_EFFORT_LEVEL: null,
  });
  // A repeated command keeps its ceiling.
  assert.equal((await command(f, run, 'capped')).task.maxTier, 'light');
});

test('a delegated caller supplies the default ceiling and cannot raise it', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun();
  await f.start(parent, 'lead', { flags: ['--tier', 'standard'] });
  await f.finished(parent, 'lead');
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'lead' };
  const child = await f.newRun('child', env);
  assert.equal((await command(f, child, 'default', [], env)).vars.AGENT_ORCH_MAX_TIER, 'standard');
  assert.equal((await command(f, child, 'raised', ['--max-tier', 'complex'], env)).task.maxTier, 'standard');
  assert.equal((await command(f, child, 'lower', ['--max-tier', 'light'], env)).task.maxTier, 'light');
  const inherited = await command(f, child, 'inherited', [], {
    ...env, AGENT_ORCH_MAX_TIER: 'light', AGENT_ORCH_MAX_EFFORT: 'low', CLAUDE_CODE_EFFORT_LEVEL: 'high',
  });
  assert.equal(inherited.task.maxTier, 'light');
  assert.equal(inherited.vars.AGENT_ORCH_MAX_EFFORT, 'low');
  assert.equal(inherited.vars.CLAUDE_CODE_EFFORT_LEVEL, 'low');
});

test('a Codex caller bounds the command effort as well as the model rank', async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun();
  await f.start(parent, 'lead', { agent: 'codex', flags: ['--tier', 'light'] });
  await f.finished(parent, 'lead');
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: parent.id, AGENT_ORCH_TASK: 'lead' };
  const child = await f.newRun('child', env);
  const inherited = await command(f, child, 'default', [], env);
  assert.equal(inherited.task.maxTier, 'light');
  assert.equal(inherited.vars.AGENT_ORCH_MAX_EFFORT, 'medium');
});

test('invalid ceiling names and a ceiling on a modeled task are refused', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const name of ['imaginary', 'constructor', '']) {
    const r = await f.command(['start', run.id, 'bad', '--agent', 'command', '--why', 'Check invalid ceiling',
      '--max-tier', name, '--', 'true'], { code: 2 });
    assert.match(r.stderr, /unknown --max-tier/);
  }
  const r = await f.command(['start', run.id, 'bad', '--agent', 'claude', '--max-tier', 'light'], { code: 2 });
  assert.match(r.stderr, /--max-tier applies to --agent command only/);
  assert.equal(fs.existsSync(path.join(run.dir, 'tasks', 'bad', 'task.json')), false);
});

test('model arguments select a tier and lower both model and effort to the ceiling', async (t) => {
  const f = await fixture(t);
  for (const agent of ['claude', 'codex']) {
    const plain = await f.command(['model', '--agent', agent]);
    const choice = policy[agent].tiers.standard;
    const effortArg = level => agent === 'codex' ? `-c model_reasoning_effort="${level}"` : `--effort ${level}`;
    assert.equal(plain.stdout.trim(), `--model ${choice.model} ${effortArg(choice.effort)}`);
    const capped = await f.command(['model', '--agent', agent, '--tier', 'complex'], {
      env: { AGENT_ORCH_MAX_TIER: 'light', AGENT_ORCH_MAX_EFFORT: 'low' },
    });
    assert.equal(capped.stdout.trim(), `--model ${policy[agent].tiers.light.model} ${effortArg("low")}`);
    const omitted = await f.command(['model', '--agent', agent], { env: { AGENT_ORCH_MAX_TIER: 'light' } });
    assert.match(omitted.stdout, new RegExp(policy[agent].tiers.light.model));
  }
  const invalid = await f.command(['model', '--agent', 'command'], { code: 2 });
  assert.match(invalid.stderr, /--agent must be claude or codex/);
  const badTier = await f.command(['model', '--agent', 'claude', '--tier', 'invalid'], { code: 2 });
  assert.match(badTier.stderr, /unknown --tier/);
});

test('rank comparisons and effort limits are independent', () => {
  assert.equal(ceilingEnv('standard', {}).ANTHROPIC_DEFAULT_HAIKU_MODEL, policy.claude.tiers.light.model);
  assert.throws(() => boundedModel('claude', 'standard', { AGENT_ORCH_MAX_EFFORT: 'invalid' }), /unknown effort ceiling/);
  assert.equal(ceilingFor('complex').codex.model, policy.codex.tiers.complex.model);
  assert.equal(modelExceedsCeiling('codex', policy.codex.tiers.strong.model, 'standard'), true);
  assert.equal(modelExceedsCeiling('claude', policy.claude.tiers.standard.model, 'standard'), false);
  assert.equal(modelExceedsCeiling('claude', 'unrecognized-model', 'standard'), false);
  assert.equal(modelExceedsCeiling('claude', policy.claude.tiers.complex.model, null), false);
  assert.equal(boundedModel('claude', 'light', { AGENT_ORCH_MAX_TIER: 'frontier' }).effort, 'high');
});

test('higher ceilings preserve lighter model, subagent and effort choices without forcing child models', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const { vars } = await command(f, run, 'cheaper', ['--max-tier', 'complex'], {
    ANTHROPIC_MODEL: policy.claude.tiers.light.model,
    ANTHROPIC_DEFAULT_MODEL: policy.claude.tiers.light.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: policy.claude.tiers.light.model,
    CLAUDE_CODE_SUBAGENT_MODEL: policy.claude.tiers.light.model,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_EFFORT_LEVEL: 'low',
    CLAUDE_CODE_SUBAGENT_EFFORT: 'low',
  });
  assert.equal(vars.ANTHROPIC_MODEL, policy.claude.tiers.light.model);
  assert.equal(vars.ANTHROPIC_DEFAULT_MODEL, policy.claude.tiers.light.model);
  assert.equal(vars.ANTHROPIC_DEFAULT_OPUS_MODEL, policy.claude.tiers.light.model);
  assert.equal(vars.CLAUDE_CODE_SUBAGENT_MODEL, policy.claude.tiers.light.model);
  assert.equal(vars.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, null);
  assert.equal(vars.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  assert.equal(vars.CLAUDE_CODE_SUBAGENT_EFFORT, 'low');
});

test('effort and model overrides are emitted only to lower an existing choice', () => {
  const env = ceilingEnv('frontier', {});
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_MODEL'), false);
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_DEFAULT_MODEL'), false);
  assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_EFFORT_LEVEL'), false);
  assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_SUBAGENT_EFFORT'), false);
  const lowered = ceilingEnv('frontier', { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh', CLAUDE_CODE_SUBAGENT_EFFORT: 'max' });
  assert.equal(lowered.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.equal(lowered.CLAUDE_CODE_SUBAGENT_EFFORT, 'high');
  assert.equal(ceilingEnv('light', { ANTHROPIC_MODEL: policy.claude.tiers.complex.model }).ANTHROPIC_MODEL,
    policy.claude.tiers.light.model);
});

test('modeled tasks from a command environment cannot exceed its inherited ceiling', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await command(f, run, 'command', ['--max-tier', 'standard']);
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'command',
    AGENT_ORCH_MAX_TIER: 'standard' };
  const child = await f.newRun('child', env);
  for (const agent of ['claude', 'codex']) {
    const result = await f.command(['start', child.id, 'too-strong', '--agent', agent, '--tier', 'complex',
      '--why', 'Check inherited ceiling', '--brief', f.brief('refused')], { env, code: 2 });
    assert.match(result.stderr, /refusing: this command runs in task .*claude standard.*is stronger/);
    const allowed = await f.start(child, `allowed-${agent}`, { agent, flags: ['--tier', 'light'], env });
    await f.finished(child, allowed.id);
  }
  assert.equal(fs.existsSync(f.taskFile(child, 'too-strong')), false);
});

test('an empty equals ceiling and stale caller tiers fail closed', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const blank = await f.command(['start', run.id, 'blank', '--agent', 'command', '--max-tier=', '--why', 'Check blank',
    '--', 'true'], { code: 2 });
  assert.match(blank.stderr, /unknown --max-tier ""/);
  await f.start(run, 'lead', { flags: ['--tier', 'standard'] });
  await f.finished(run, 'lead');
  writeJson(f.taskFile(run, 'lead'), { ...readJson(f.taskFile(run, 'lead')), tier: 'removed-tier' });
  const env = { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'lead' };
  const child = await f.newRun('child', env);
  const result = await f.command(['start', child.id, 'child', '--agent', 'command', '--why', 'Check stale caller',
    '--', 'true'], { env, code: 2 });
  assert.match(result.stderr, /caller tier claude removed-tier is missing from policy/);
  assert.equal(fs.existsSync(f.taskFile(child, 'child')), false);
});

test('an inherited child model is preserved at the ceiling and lowered only above it', () => {
  const cheaper = ceilingEnv('standard', { CLAUDE_CODE_SUBAGENT_MODEL: policy.claude.tiers.light.model });
  const equal = ceilingEnv('standard', { CLAUDE_CODE_SUBAGENT_MODEL: policy.claude.tiers.standard.model });
  assert.equal(Object.hasOwn(cheaper, 'CLAUDE_CODE_SUBAGENT_MODEL'), false);
  assert.equal(Object.hasOwn(equal, 'CLAUDE_CODE_SUBAGENT_MODEL'), false);
  assert.equal(ceilingEnv('standard', { CLAUDE_CODE_SUBAGENT_MODEL: policy.claude.tiers.complex.model })
    .CLAUDE_CODE_SUBAGENT_MODEL, policy.claude.tiers.standard.model);
});

test('command ceilings include agent-env values without raising its cheaper choices', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const config = path.join(f.root, 'config');
  const file = path.join(config, 'agent-orchestrator', 'agent-env.json');
  const expensive = {
    ANTHROPIC_MODEL: policy.claude.tiers.complex.model,
    CLAUDE_CODE_SUBAGENT_MODEL: policy.claude.tiers.complex.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: policy.claude.tiers.complex.model,
    CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_SUBAGENT_EFFORT: 'high',
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
  };
  writeJson(file, expensive);
  const env = { XDG_CONFIG_HOME: config, AGENT_ORCH_MAX_EFFORT: 'medium' };
  const capped = (await command(f, run, 'capped-env', ['--max-tier', 'standard'], env)).vars;
  assert.equal(capped.ANTHROPIC_MODEL, policy.claude.tiers.standard.model);
  assert.equal(capped.CLAUDE_CODE_SUBAGENT_MODEL, policy.claude.tiers.standard.model);
  assert.equal(capped.ANTHROPIC_DEFAULT_OPUS_MODEL, policy.claude.tiers.standard.model);
  assert.equal(capped.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
  assert.equal(capped.CLAUDE_CODE_SUBAGENT_EFFORT, 'medium');
  assert.equal(capped.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, null);
  writeJson(file, {
    ANTHROPIC_MODEL: policy.claude.tiers.light.model,
    CLAUDE_CODE_SUBAGENT_MODEL: policy.claude.tiers.light.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: policy.claude.tiers.light.model,
    CLAUDE_CODE_EFFORT_LEVEL: 'low', CLAUDE_CODE_SUBAGENT_EFFORT: 'low',
  });
  const cheaper = (await command(f, run, 'cheaper-env', ['--max-tier', 'standard'], env)).vars;
  assert.equal(cheaper.ANTHROPIC_MODEL, policy.claude.tiers.light.model);
  assert.equal(cheaper.CLAUDE_CODE_SUBAGENT_MODEL, policy.claude.tiers.light.model);
  assert.equal(cheaper.ANTHROPIC_DEFAULT_OPUS_MODEL, policy.claude.tiers.light.model);
  assert.equal(cheaper.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  assert.equal(cheaper.CLAUDE_CODE_SUBAGENT_EFFORT, 'low');
  await f.start(run, 'lead', { agent: 'codex', flags: ['--tier', 'light'] });
  await f.finished(run, 'lead');
  writeJson(file, expensive);
  const caller = { ...env, AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: 'lead' };
  const child = await f.newRun('child', caller);
  const delegated = (await command(f, child, 'inherited-env', [], caller)).vars;
  assert.equal(delegated.ANTHROPIC_MODEL, policy.claude.tiers.light.model);
  assert.equal(delegated.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
});

test('modeled starts lower tier and explicit effort to the inherited effort ceiling', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  for (const [agent, flags] of [['claude', ['--tier', 'complex']], ['codex', ['--tier', 'complex']],
    ['claude', ['--tier', 'frontier', '--effort', 'high']]]) {
    const id = `effort-${agent}-${flags[1]}`;
    const task = await f.start(run, id, { agent, flags, env: { AGENT_ORCH_MAX_EFFORT: 'medium' } });
    await f.finished(run, id);
    assert.equal(task.effort, 'medium');
    const { argv } = readJson(path.join(task.outDir, 'invocation.json'));
    assert.equal(argv[argv.indexOf('--effort') + 1], 'medium');
  }
  const lower = await f.start(run, 'already-medium', { agent: 'codex', flags: ['--tier', 'light'],
    env: { AGENT_ORCH_MAX_EFFORT: 'high' } });
  await f.finished(run, 'already-medium');
  assert.equal(lower.effort, 'medium');
});

test('modeled effort ceilings also lower native overrides from the merged environment', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const config = path.join(f.root, 'config');
  writeJson(path.join(config, 'agent-orchestrator', 'agent-env.json'), { CLAUDE_CODE_SUBAGENT_EFFORT: 'max' });
  const seen = path.join(f.root, 'native-effort.json');
  const preload = path.join(f.root, 'native-effort.cjs');
  fs.writeFileSync(preload, `if(process.argv[1]?.endsWith('relay.mjs'))require('fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify({lead:process.env.CLAUDE_CODE_EFFORT_LEVEL,child:process.env.CLAUDE_CODE_SUBAGENT_EFFORT}));`);
  await f.start(run, 'native-overrides', { flags: ['--tier', 'standard'], env: {
    AGENT_ORCH_MAX_EFFORT: 'medium', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh',
    XDG_CONFIG_HOME: config, NODE_OPTIONS: `--require=${preload}`,
  } });
  await f.finished(run, 'native-overrides');
  assert.deepEqual(readJson(seen), { lead: 'medium', child: 'medium' });
});
