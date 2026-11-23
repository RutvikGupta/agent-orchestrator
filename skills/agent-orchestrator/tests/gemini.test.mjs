// Gemini, the third agent: Gemini 4 models run through Cursor's `agent` CLI by the cursor-delegate
// relay. The fixture's fake for that relay (fixtures/relay.mjs) writes Claude's event shape with no
// cost, reports its usage once in its result event and in result.json, and exits 2 on a flag outside
// the relay's contract, so a task that completes passed only flags the relay takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson } from './helpers.mjs';
import { CREDENTIAL_PATHS } from '../scripts/lib/permissions.mjs';
import { ceilingEnv, ceilingFor, peerAgent, peerTier } from '../scripts/lib/policy.mjs';
import { eventShape } from '../scripts/lib/events.mjs';
import { tierProblem } from '../scripts/lib/plan.mjs';

const policy = readJson(new URL('../policy.json', import.meta.url));
const tiers = policy.gemini.tiers;
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-12, `${what}: ${actual} != ${expected}`);
const argvOf = (task) => readJson(path.join(task.outDir, 'invocation.json')).argv;
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];
const denies = (argv) => argv.filter((_, i) => argv[i - 1] === '--deny');
// What the fake relay's single model call costs at gemini-4-hydrogen's prices (prices.json): 100 fresh
// input tokens at the input rate, 20 cache reads and 30 output tokens.
const HYDROGEN_CALL = (100 * 1.5 + 20 * 0.075 + 30 * 7.5) / 1e6;

// A fake `agent` CLI: its version, and its login as FAKE_CURSOR_STATUS says (logged in by default).
const FAKE_AGENT = `const [command] = process.argv.slice(2);
if (command === '--version') console.log('2026.11.20-fixture');
else if (command === 'status') console.log(process.env.FAKE_CURSOR_STATUS || 'Logged in as someone@example.invalid');
else process.exit(2);`;

// A PATH of its own: the shell, ps and git, which the CLI runs, and the fake CLIs named in `programs`,
// so that what this machine has installed changes nothing.
function pathWith(f, name, programs = {}) {
  const dir = path.join(f.root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of ['sh', 'ps', 'git']) {
    const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', tool], { encoding: 'utf8' }).stdout.trim();
    assert.ok(found, `${tool} is installed`);
    fs.symlinkSync(found, path.join(dir, tool));
  }
  for (const [program, source] of Object.entries(programs)) {
    fs.writeFileSync(path.join(dir, program), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  }
  return { PATH: dir };
}

test('agents lists gemini: its CLI version and login, the cursor-delegate relay, its four tiers, and usage unknown', async (t) => {
  const f = await fixture(t);
  const env = pathWith(f, 'bin', { agent: FAKE_AGENT });
  const report = await f.json(['agents'], { env });
  const row = report.agents.find((r) => r.key === 'gemini');
  assert.deepEqual([row.vendor, row.bin, row.version, row.auth, row.ready],
    ['Google via Cursor', path.join(env.PATH, 'agent'), '2026.11.20-fixture', 'ok', 'yes']);
  assert.equal(row.relay, fs.realpathSync(path.join(f.skills, 'cursor-delegate', 'scripts', 'relay.mjs')));
  assert.equal(report.usage.gemini, null);
  assert.deepEqual(report.policy.gemini, policy.gemini);
  assert.deepEqual(report.tierEvidence.filter((e) => e.agent === 'gemini').map((e) => e.tier), Object.keys(tiers));

  const text = (await f.command(['agents'], { env })).stdout;
  assert.match(text, /^gemini\s+Google via Cursor\s+2026\.11\.20-fixture\s+ok\s+yes$/m);
  const lines = text.split('\n').filter((line) => line.startsWith('  gemini --tier'));
  assert.equal(lines.length, 4);
  for (const [i, [tier, choice]] of Object.entries(tiers).entries()) {
    assert.ok(lines[i].startsWith(`  gemini --tier ${tier.padEnd(8)} → ${choice.model}, effort ${choice.effort} [last 30d: too few tasks`), lines[i]);
    assert.ok(lines[i].endsWith(`: ${choice.use}`), lines[i]);
  }
  assert.match(text, /^ {2}gemini unknown \(Cursor reports no usage limits\)$/m);

  // Logged out, and not installed: not ready, with what is missing.
  const out = (await f.json(['agents'], { env: { ...env, FAKE_CURSOR_STATUS: 'Not logged in' } })).agents.find((r) => r.key === 'gemini');
  assert.deepEqual([out.auth, out.ready], ['logged-out', 'no (log in)']);
  const bare = (await f.json(['agents'], { env: pathWith(f, 'bare') })).agents.find((r) => r.key === 'gemini');
  assert.deepEqual([bare.bin, bare.version, bare.auth, bare.ready], ['-', '-', '-', 'no (install agent)']);
  fs.rmSync(path.join(f.skills, 'cursor-delegate'), { recursive: true });
  const noRelay = (await f.json(['agents'], { env })).agents.find((r) => r.key === 'gemini');
  assert.equal(noRelay.ready, 'no (install cursor-delegate)');
});

test('a gemini write task runs the cursor-delegate relay at its tier, outside the sandbox, with Cursor deny rules', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const started = await f.start(run, 'impl', { agent: 'gemini', config: { hold: true } });
  assert.deepEqual([started.agent, started.tier, started.model, started.effort, started.readOnly], ['gemini', 'standard', tiers.standard.model, tiers.standard.effort, false]);
  await f.ready(started);
  // A running gemini relay counts against the machine's limit, as Claude's and Codex's do.
  assert.equal((await f.json(['agents'], { env: pathWith(f, 'bin') })).machine.running, 1);
  f.release(started);
  assert.equal((await f.finished(run, 'impl')).state, 'completed', 'the relay accepted every flag');

  const argv = argvOf(started);
  assert.deepEqual([valueOf(argv, '--model'), valueOf(argv, '--effort'), valueOf(argv, '--sandbox')], ['gemini-4-hydrogen', 'high', 'disabled']);
  assert.equal(argv.includes('--read-only'), false);
  for (const flag of ['--no-sandbox', '--allow-publish', '--confine', '--allow-domain', '--allow-write', '--subagent-model']) {
    assert.equal(argv.includes(flag), false, `${flag} is Claude's`);
  }
  const rules = denies(argv);
  assert.ok(rules.length && rules.every((rule) => /^(Read|Write|Shell)\(.+\)$/.test(rule)), 'Cursor rules only');
  const home = path.join(f.root, 'home');
  for (const rule of [
    // Credential files, for Read and Write: folders as /**, files as themselves, and the configured ones.
    `Read(${home}/.ssh/**)`, `Write(${home}/.ssh/**)`, `Read(${home}/.netrc)`, `Write(${home}/.docker/config.json)`,
    `Read(${f.claude}/.credentials*)`, `Write(${f.codex}/auth.json)`, `Read(${f.state}/dashboard-token)`,
    // What no task runs: force pushes, admin merges, secrets, token reads.
    'Shell(git push --force*)', 'Shell(git * push -f*)', 'Shell(gh pr merge --admin*)', 'Shell(gh secret)', 'Shell(gh secret *)',
    'Shell(gh auth token)', 'Shell(gh auth status *--show-token*)',
  ]) assert.ok(rules.includes(rule), rule);
  // A write task publishes unless told not to.
  for (const rule of ['Shell(git push*)', 'Shell(git commit*)', 'Shell(gh pr create)', 'Shell(gh api *-X *)']) assert.equal(rules.includes(rule), false, rule);
});

test('--no-publish, --read-only and --sandbox reach the gemini relay as rules and modes', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const publishRules = ['Shell(git commit*)', 'Shell(git * commit*)', 'Shell(git push*)', 'Shell(git * push*)', 'Shell(gh pr create)', 'Shell(gh pr create *)', 'Shell(gh api *-X *)', 'Shell(gh api *--input *)'];
  const credential = `Read(${path.join(f.root, 'home')}/.aws/**)`;
  const run1 = async (id, flags) => {
    const task = await f.start(run, id, { agent: 'gemini', flags });
    assert.equal((await f.finished(run, id)).state, 'completed', `${id}: the relay accepted every flag`);
    return argvOf(task);
  };

  const held = await run1('held', ['--no-publish']);
  assert.equal(valueOf(held, '--sandbox'), 'disabled');
  for (const rule of [...publishRules, credential]) assert.ok(denies(held).includes(rule), rule);

  const readOnly = await run1('reader', ['--read-only']);
  assert.ok(readOnly.includes('--read-only'));
  assert.equal(readOnly.includes('--sandbox'), false, 'read-only mode needs no sandbox mode');
  for (const rule of [...publishRules, credential]) assert.ok(denies(readOnly).includes(rule), rule);

  // A sandboxed task does not publish, as a sandboxed Claude task does not.
  const sandboxed = await run1('boxed', ['--sandbox']);
  assert.equal(valueOf(sandboxed, '--sandbox'), 'enabled');
  for (const rule of [...publishRules, credential]) assert.ok(denies(sandboxed).includes(rule), rule);
});

test('start refuses a gemini task what it cannot honor, and starts nothing', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const tierList = Object.entries(tiers).map(([tier, choice]) => `${tier} = ${choice.model}`).join(', ');
  const refused = async (flags, pattern) => {
    const result = await f.command(['start', run.id, 'nope', '--agent', 'gemini', '--why', 'Refusals', '--brief', f.brief('nope'), ...flags], { code: 2 });
    assert.match(result.stderr, pattern);
  };
  await refused([], new RegExp(`--tier is required for Gemini: ${tierList.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await refused(['--tier', 'frontier'], /unknown --tier "frontier" \(choose: light, standard, strong, complex\)/);
  await refused(['--tier', 'standard', '--model', 'gemini-4-neon'], /choose the Gemini model with --tier/);
  await refused(['--tier', 'standard', '--', '--model=gemini-4-neon'], /choose the Gemini model with --tier/);
  await refused(['--tier', 'standard', '--effort', 'low'], /the gemini standard tier runs at high only/);
  await refused(['--tier', 'standard', '--offline'], /--offline is not supported for gemini: Cursor's sandbox has not been shown to block the network/);
  await refused(['--tier', 'standard', '--confine'], /--confine applies to Claude tasks only; a gemini task takes --sandbox or --read-only/);
  await refused(['--tier', 'standard', '--babysit', '--pr', '42'], /A Codex or Gemini implementer hands its pull request to a Claude babysitter/);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});

test('a gemini task shows steps, activity, tokens and cost, and a resume continues its Cursor session', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const extraEvents = [{ type: 'assistant', message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: path.join(f.repo, 'README.md') } }] } }];
  const started = await f.start(run, 'impl', { agent: 'gemini', config: { hold: true, extraEvents, finalMessage: 'Gemini finished ✓' } });
  await f.ready(started);
  // While it runs: its step and activity, and no tokens yet, which status and result explain.
  const running = (await f.json(['status', run.id])).tasks[0];
  assert.deepEqual([running.state, running.agent, running.steps, running.now, running.tokensIn, running.session], ['running', 'gemini', 1, 'Read README.md', 0, 'fixture-gemini']);
  assert.match((await f.command(['status', run.id])).stdout, /impl\s+gemini\s+.*\s1\s+at end\s+Read README\.md/);
  assert.match((await f.command(['result', run.id, 'impl'])).stdout, /tokens 0 in \(0 cached\) \/ 0 out \(Gemini reports tokens when the attempt ends\)/);
  f.release(started);

  const row = await f.finished(run, 'impl');
  assert.deepEqual([row.state, row.session, row.tokensIn, row.tokensCached, row.tokensOut, row.tokensExact, row.steps, row.limitHit],
    ['completed', 'fixture-gemini', 120, 20, 30, true, 1, false]);
  close(row.costUsd, HYDROGEN_CALL, 'cost from the result event at the input rate');
  assert.equal(row.costExact, false, 'estimated from tokens: the relay reports no cost');
  const status = (await f.command(['status', run.id])).stdout;
  assert.match(status, /impl\s+gemini\s+4-hydrogen high\s+write\s+completed\s+.*\s1\s+120\/30\s/);
  assert.doesNotMatch(status, /at end/);
  const waited = await f.json(['wait', run.id, '--timeout', '1s']);
  assert.deepEqual([waited.finished, waited.tasks[0].tokensIn, waited.tasks[0].agent], [true, 120, 'gemini']);
  const result = (await f.command(['result', run.id, 'impl'])).stdout;
  assert.match(result, /Gemini finished ✓/);
  assert.match(result, /1 steps · tokens 120 in \(20 cached\) \/ 30 out · model gemini-4-hydrogen/);
  assert.doesNotMatch(result, /reports tokens when/);

  // cost: the task's estimate against its tier's default budget, and the tier table with Gemini's rows.
  const cost = await f.json(['cost', run.id, 'impl']);
  close(cost.usd, HYDROGEN_CALL, 'cost');
  assert.deepEqual([cost.tasks, cost.budget, cost.over], [1, tiers.standard.budget, false]);
  const table = (await f.command(['cost'])).stdout;
  for (const [tier, choice] of Object.entries(tiers)) assert.match(table, new RegExp(`^gemini ${tier}\\s+${choice.model}\\s+\\$`, 'm'));
  // stats: a group of its own, with its tokens.
  const stats = await f.json(['stats', run.id]);
  const group = stats.byAgent.find((g) => g.agent === 'gemini');
  assert.deepEqual([group.tasks, group.tokensIn, group.tokensOut], [1, 120, 30]);
  assert.ok(stats.byAgentTierType.some((g) => g.agent === 'gemini' && g.tier === 'standard'));

  // A follow-up resumes the same Cursor session, at the same tier, as the resume command reads.
  const { resumeCommand } = await import('../scripts/lib/report.mjs');
  assert.match(resumeCommand(run, row), / start \S+ impl --agent gemini --tier standard --brief <delta> -- --session fixture-gemini$/);
  // --json goes before --: what follows -- is the relay's, and the gemini relay refuses a flag it does not take.
  const resumed = JSON.parse((await f.command(['start', run.id, 'impl', '--agent', 'gemini', '--brief', f.brief('again'), '--json', '--', '--session', row.session])).stdout);
  assert.deepEqual([resumed.attempt, resumed.tier, resumed.model], [2, 'standard', tiers.standard.model]);
  const second = await f.finished(run, 'impl');
  const again = argvOf(resumed);
  assert.equal(valueOf(again, '--session'), 'fixture-gemini');
  assert.equal(valueOf(again, '--model'), tiers.standard.model);
  assert.deepEqual([second.attempt, second.session, second.tokensIn], [2, 'fixture-gemini', 240]);
  close(second.costUsd, 2 * HYDROGEN_CALL, 'both attempts');
});

test('a gemini task that the relay ends with an error is a failed attempt, and its stderr tail is kept', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  // An unknown flag after -- reaches the relay, which exits 2 as the real one does.
  await f.command(['start', run.id, 'bad', '--agent', 'gemini', '--tier', 'light', '--why', 'Relay contract', '--brief', f.brief('bad'), '--', '--no-such-flag']);
  // The relay writes no result, so the task ends without one.
  const row = await eventually(async () => {
    const task = (await f.json(['status', run.id])).tasks.find((x) => x.id === 'bad');
    return task && !['running', 'prepared'].includes(task.state) ? task : null;
  }, 'the relay did not exit');
  assert.notEqual(row.state, 'completed');
  assert.match((await f.command(['log', run.id, 'bad'])).stdout, /cursor-delegate: unknown argument --no-such-flag/);
});

test('review gives gemini work to Codex; --agent gemini reviews with a brief written for it', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const wt = (await f.json(['worktree', run.id, 'work', '--no-prep'])).path;
  await f.start(run, 'work', { agent: 'gemini', config: { finalMessage: 'Added greet().' } });
  await f.finished(run, 'work');
  fs.writeFileSync(path.join(wt, 'greet.mjs'), 'export const greet = (name) => `hi ${name}`;\n');
  await f.git(['-C', wt, 'add', '-A']);
  await f.git(['-C', wt, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Add greet']);

  const first = await f.json(['review', run.id, 'work']);
  assert.deepEqual([first.agent, first.tier], ['codex', 'standard']);
  assert.match(readJson(f.taskFile(run, 'review-work')).why, /^codex reviews work's gemini work, the other model; /);
  await f.finished(run, 'review-work');

  const second = await f.json(['review', run.id, 'work', '--agent', 'gemini']);
  assert.deepEqual([second.review, second.agent, second.tier], ['review-work-2', 'gemini', 'standard']);
  const saved = readJson(f.taskFile(run, 'review-work-2'));
  assert.equal(saved.readOnly, true);
  assert.match(saved.why, /^gemini reviews work's gemini work, chosen with --agent; /);
  const brief = fs.readFileSync(path.join(second.started.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /You run read-only, so the diff follows\. Read the changed files in full in .*, with your file tools/);
  assert.match(brief, /^\+export const greet/m, 'the diff is in the brief');
  assert.match(brief, /## How to confirm a finding\n\nYou run read-only\. Show each defect from the code/);
  assert.doesNotMatch(brief, /no shell|Read, Glob and Grep|read-only sandbox/, "neither Claude's nor Codex's wording");
  await f.finished(run, 'review-work-2');
  assert.ok(argvOf(second.started).includes('--read-only'));

  const refused = await f.command(['review', run.id, 'work', '--agent', 'robot'], { code: 2 });
  assert.match(refused.stderr, /--agent must name the reviewing agent: claude, codex, gemini/);
});

test('a running gemini task reads its messages with inbox, as a Codex task does', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'worker', { agent: 'gemini', config: { hold: true } });
  await f.ready(task);
  const brief = fs.readFileSync(path.join(task.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /inbox \S+ worker --ack/);
  assert.match(brief, /start it with `&`/);
  assert.doesNotMatch(brief, /run_in_background/);
  const sent = await f.command(['send', run.id, 'worker', 'Use the v2 API.']);
  assert.match(sent.stdout, /^delivery: Gemini reads it the next time it runs `inbox`: after each gate run, and at least every 10 commands$/m);
  const row = (await f.json(['status', run.id])).tasks[0];
  assert.match(row.inbox.delivery.text, /^It reads them the next time it runs `inbox`/);
  f.release(task);
  await f.finished(run, 'worker');
});

test('a gemini task stopped by a usage limit names the other ready agents to resume it on', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'limited', { agent: 'gemini', config: { status: 'failed', error: 'You have hit your usage limit.' } });
  assert.equal((await f.finished(run, 'limited')).limitHit, true);
  const both = pathWith(f, 'both', { claude: 'process.exit(0)', codex: 'process.exit(0)' });
  const result = await f.command(['result', run.id, 'limited'], { env: both });
  assert.match(result.stdout, /USAGE LIMIT: gemini reached a usage limit\. Ping the user once, and resume it on another agent that is ready: claude or codex \(SKILL\.md, "Usage limits"\)/);
  const waited = await f.command(['wait', run.id, '--timeout', '1s'], { env: both });
  assert.match(waited.stdout, /limited \(gemini\) stopped on a usage limit: ping the user, and resume it on another agent that is ready: claude or codex/);
  const none = await f.command(['result', run.id, 'limited'], { env: pathWith(f, 'none') });
  assert.match(none.stdout, /resume it on another agent once one is ready \(claude, codex: none is installed\)/);
});

test('the dashboard lists Gemini usage as unknown', async (t) => {
  const f = await fixture(t);
  const board = await f.dashboard();
  const usage = await board.json('/api/usage');
  assert.deepEqual(Object.keys(usage), ['claude', 'codex', 'gemini']);
  assert.equal(usage.gemini, null);
});

test('gemini in the policy helpers: event shape, review peer, ceilings and plan tiers', () => {
  assert.equal(eventShape('gemini'), 'claude');
  assert.equal(eventShape('codex'), 'codex');
  assert.deepEqual(['claude', 'codex', 'gemini'].map(peerAgent), ['codex', 'claude', 'codex']);
  assert.deepEqual(peerTier('gemini', 'strong'), { agent: 'codex', tier: 'strong', equalRank: true });
  // A ceiling names each agent's strongest model under it, Gemini's too.
  for (const ceiling of Object.keys(policy.claude.tiers)) {
    const rank = policy.claude.tiers[ceiling].rank;
    const strongest = Object.values(tiers).filter((tier) => tier.rank <= rank).sort((a, b) => b.rank - a.rank)[0];
    assert.equal(ceilingFor(ceiling, policy).gemini.model, strongest.model, ceiling);
    assert.equal(ceilingEnv(ceiling, {}).AGENT_ORCH_MAX_MODEL_GEMINI, strongest.model, ceiling);
  }
  assert.equal(tierProblem({ agent: 'gemini', tier: 'strong' }, policy), null);
  assert.match(tierProblem({ agent: 'gemini' }, policy), /^a Gemini task needs a tier \(light, standard, strong or complex\)/);
  assert.match(tierProblem({ agent: 'gemini', tier: 'frontier' }, policy), /Gemini/);
});

test('the gemini relay is denied the same credential files as the claude-delegate relay', () => {
  const source = fs.readFileSync(new URL('../../claude-delegate/scripts/relay.mjs', import.meta.url), 'utf8');
  const list = /const CREDENTIAL_PATHS = \[([\s\S]*?)\];/.exec(source)?.[1];
  assert.ok(list, "claude-delegate's CREDENTIAL_PATHS was found");
  assert.deepEqual(CREDENTIAL_PATHS, [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
});
