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
import { fileURLToPath } from 'node:url';
import { ceilingEnv, ceilingFor, peerAgent, peerTier, policyAgents, policyProblems } from '../scripts/lib/policy.mjs';
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
// The same call at any model's prices in prices.json.
const prices = readJson(new URL('../prices.json', import.meta.url));
const callCost = (model) => (100 * prices[model].input + 20 * prices[model].cacheRead + 30 * prices[model].output) / 1e6;

// Cursor's `agent status --format json`, logged out and partly logged in, as its CLI writes them.
const UNAUTHENTICATED = { status: 'unauthenticated', isAuthenticated: false, hasAccessToken: false, hasRefreshToken: false, message: 'Not logged in' };
const PARTIAL = { status: 'partially-authenticated', isAuthenticated: false, hasAccessToken: true, hasRefreshToken: false, message: 'Partially authenticated (missing refresh token)' };
// A fake `agent` CLI: its version, and its login as FAKE_CURSOR_STATUS (that JSON) says, logged in
// by default. As the real one does, `status` exits 0 whatever the login, and prints its message as
// text, or the whole status with --format json.
const FAKE_AGENT = `const args = process.argv.slice(2);
const status = JSON.parse(process.env.FAKE_CURSOR_STATUS || '{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true,"message":"Logged in as someone@example.invalid"}');
if (args[0] === '--version') console.log('2026.11.20-fixture');
else if (args[0] === 'status' && args.length === 1) console.log(status.message);
else if (args[0] === 'status' && args[1] === '--format' && args[2] === 'json' && args.length === 3) console.log(JSON.stringify(status, null, 2));
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

  // Logged out, partly logged in (a missing refresh token, though `agent status` exits 0), and not
  // installed: not ready, with what is missing.
  for (const status of [UNAUTHENTICATED, PARTIAL]) {
    const out = (await f.json(['agents'], { env: { ...env, FAKE_CURSOR_STATUS: JSON.stringify(status) } })).agents.find((r) => r.key === 'gemini');
    assert.deepEqual([out.auth, out.ready], ['logged-out', 'no (log in)'], status.status);
  }
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
  const tasks = {};
  const run1 = async (id, flags) => {
    tasks[id] = await f.start(run, id, { agent: 'gemini', flags });
    assert.equal((await f.finished(run, id)).state, 'completed', `${id}: the relay accepted every flag`);
    return argvOf(tasks[id]);
  };
  const sandboxed = (id) => readJson(f.taskFile(run, id)).sandboxed;

  const held = await run1('held', ['--no-publish']);
  assert.equal(valueOf(held, '--sandbox'), 'disabled');
  for (const rule of [...publishRules, credential]) assert.ok(denies(held).includes(rule), rule);
  // The relay enforces the hold, so the brief carries no note about it, as a Claude task's does.
  const heldBrief = fs.readFileSync(path.join(tasks.held.outDir, 'orch-brief.md'), 'utf8');
  assert.doesNotMatch(heldBrief, /## Publishing|asked to review this work before it lands/);

  const readOnly = await run1('reader', ['--read-only']);
  assert.ok(readOnly.includes('--read-only'));
  assert.equal(readOnly.includes('--sandbox'), false, 'read-only mode needs no sandbox mode');
  for (const rule of [...publishRules, credential]) assert.ok(denies(readOnly).includes(rule), rule);
  assert.equal(sandboxed('reader'), false);

  // A sandboxed task does not publish, as a sandboxed Claude task does not.
  const boxed = await run1('boxed', ['--sandbox']);
  assert.equal(valueOf(boxed, '--sandbox'), 'enabled');
  for (const rule of [...publishRules, credential]) assert.ok(denies(boxed).includes(rule), rule);
  assert.equal(sandboxed('boxed'), true);

  // Read-only and sandboxed: Cursor's plan mode can still run shell commands, so the relay gets both,
  // and the task records the sandbox.
  const both = await run1('both', ['--read-only', '--sandbox']);
  assert.ok(both.includes('--read-only'));
  assert.equal(valueOf(both, '--sandbox'), 'enabled');
  assert.equal(sandboxed('both'), true);
});

test('a held Claude write task still gets the publish-hold note in its brief', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'held', { flags: ['--no-publish'] });
  await f.finished(run, 'held');
  assert.match(fs.readFileSync(path.join(task.outDir, 'orch-brief.md'), 'utf8'), /## Publishing\n\nThe user asked to review this work before it lands/);
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
  // A sandbox mode after -- would run a mode other than the one start records.
  for (const passthrough of [['--sandbox', 'disabled'], ['--sandbox=enabled']]) {
    await refused(['--tier', 'standard', '--sandbox', '--', ...passthrough], /a gemini task's sandbox mode comes from start: pass --sandbox before --/);
  }
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
  // No reading yet, so the count is not exact (~), and its cost is unknown.
  assert.match((await f.command(['result', run.id, 'impl'])).stdout, /tokens ~0 in \(0 cached\) \/ 0 out \(Gemini reports tokens when the attempt ends\)/);
  assert.deepEqual([running.tokensExact, running.costUsd], [false, null]);
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

  // A follow-up resumes the same Cursor session, at the same tier, as the resume command reads. It
  // needs no --tier. The fixture's json helper puts --json before --, so the relay, which refuses a
  // flag it does not take, gets only the session.
  const { resumeCommand } = await import('../scripts/lib/report.mjs');
  assert.match(resumeCommand(run, row), / start \S+ impl --agent gemini --tier standard --brief <delta> -- --session fixture-gemini$/);
  const resumed = await f.json(['start', run.id, 'impl', '--agent', 'gemini', '--brief', f.brief('again'), '--', '--session', row.session]);
  assert.deepEqual([resumed.attempt, resumed.tier, resumed.model], [2, 'standard', tiers.standard.model]);
  const second = await f.finished(run, 'impl');
  const again = argvOf(resumed);
  assert.equal(valueOf(again, '--session'), 'fixture-gemini');
  assert.equal(valueOf(again, '--model'), tiers.standard.model);
  assert.equal(again.includes('--json'), false);
  assert.deepEqual([second.attempt, second.session, second.tokensIn], [2, 'fixture-gemini', 240]);
  close(second.costUsd, 2 * HYDROGEN_CALL, 'both attempts');

  // At another tier, each attempt keeps its own model's price: Cursor's events name the model with
  // its effort, which has no price, and the attempt's result.json names the model it ran.
  assert.notEqual(tiers.strong.model, tiers.standard.model);
  const third = await f.json(['start', run.id, 'impl', '--agent', 'gemini', '--tier', 'strong', '--why', 'A harder part', '--brief', f.brief('harder'), '--', '--session', row.session]);
  assert.equal(third.model, tiers.strong.model);
  const last = await f.finished(run, 'impl');
  close(last.costUsd, 2 * HYDROGEN_CALL + callCost(tiers.strong.model), 'two attempts at hydrogen and one at the strong tier');
  close((await f.json(['cost', run.id, 'impl'])).usd, last.costUsd, 'cost agrees');
});

test('a stopped gemini attempt, whose relay reports no usage, has unknown tokens and cost, not an exact zero', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'halted', { agent: 'gemini', config: { hold: true } });
  await f.ready(task);
  await f.command(['stop', run.id, 'halted']);
  const stopped = await f.finished(run, 'halted');
  assert.equal(readJson(path.join(task.outDir, 'result.json')).usage, null, 'the fake relay, as the real one, reports none');
  assert.deepEqual([stopped.state, stopped.tokensIn, stopped.tokensExact, stopped.costUsd, stopped.costExact], ['stopped', 0, false, null, null]);

  // A later attempt's reading is known, but the total stays incomplete.
  await f.json(['start', run.id, 'halted', '--agent', 'gemini', '--brief', f.brief('again'), '--', '--session', 'fixture-gemini']);
  const resumed = await f.finished(run, 'halted');
  assert.deepEqual([resumed.state, resumed.tokensIn, resumed.tokensExact, resumed.costExact], ['completed', 120, false, false]);
  close(resumed.costUsd, HYDROGEN_CALL, 'only the attempt with a reading');
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
  assert.match(none.stdout, /resume it on another agent once one is ready \(claude, codex: none is installed and logged in\)/);
  // Installed but logged out, as `agents` would report them: not ready either, for result and wait.
  const out = pathWith(f, 'out', { claude: 'process.exit(1)', codex: 'console.log("Not logged in"); process.exit(1)' });
  assert.match((await f.command(['result', run.id, 'limited'], { env: out })).stdout, /once one is ready \(claude, codex: none is installed and logged in\)/);
  assert.match((await f.command(['wait', run.id, '--timeout', '1s'], { env: out })).stdout, /once one is ready \(claude, codex: none is installed and logged in\)/);
  assert.deepEqual((await f.json(['agents'], { env: out })).agents.map((r) => [r.key, r.auth]), [['claude', 'logged-out'], ['codex', 'logged-out'], ['gemini', '-']]);
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

test('a policy without a gemini block still runs Claude, Codex and ceilings, and refuses gemini tasks', async (t) => {
  const { gemini: _gemini, ...twoAgents } = policy;
  assert.deepEqual(policyProblems(twoAgents), []);
  assert.deepEqual(policyAgents(twoAgents), ['claude', 'codex']);
  const cap = ceilingFor('light', twoAgents);
  assert.deepEqual([cap.claude.model, cap.codex.model, cap.gemini], [policy.claude.tiers.light.model, policy.codex.tiers.light.model, undefined]);
  // A block that is there is checked, and the required ones must be there.
  assert.match(policyProblems({ ...policy, gemini: { tiers: {} } }).join('; '), /^gemini\.tiers must be an object with at least one tier$/);
  assert.match(policyProblems({ claude: policy.claude }).join('; '), /^codex\.tiers must be an object with at least one tier$/);

  // A copy of the CLI reads the policy.json next to its own scripts/ folder.
  const f = await fixture(t);
  const run = await f.newRun();
  const copy = path.join(f.root, 'skill-copy');
  fs.cpSync(fileURLToPath(new URL('../scripts', import.meta.url)), path.join(copy, 'scripts'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../prices.json', import.meta.url)), path.join(copy, 'prices.json'));
  fs.writeFileSync(path.join(copy, 'policy.json'), JSON.stringify(twoAgents));
  const cli = (args) => spawnSync(process.execPath, [path.join(copy, 'scripts', 'orch.mjs'), ...args], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  const agents = cli(['agents']);
  assert.equal(agents.status, 0, agents.stderr);
  assert.match(agents.stdout, /^ {2}claude --tier light/m);
  assert.doesNotMatch(agents.stdout, /gemini --tier/);
  const gemini = cli(['start', run.id, 'nope', '--agent', 'gemini', '--tier', 'standard', '--why', 'Two-agent policy', '--brief', f.brief('nope')]);
  assert.equal(gemini.status, 2, gemini.stderr);
  assert.match(gemini.stderr, /policy\.json has no gemini tiers, so gemini tasks cannot start: add a "gemini" block with its tiers/);
  const claude = cli(['start', run.id, 'claude', '--agent', 'claude', '--tier', 'light', '--why', 'Two-agent policy', '--brief', f.brief('claude')]);
  assert.equal(claude.status, 0, claude.stderr);
  // A ceiling names a model for each agent the policy has.
  const capped = cli(['start', run.id, 'capped', '--agent', 'command', '--max-tier', 'light', '--why', 'Two-agent ceiling', '--', 'true']);
  assert.equal(capped.status, 0, capped.stderr);
  assert.equal((await f.finished(run, 'claude')).state, 'completed');
  assert.equal((await f.finished(run, 'capped')).state, 'completed');
});

// Whether one of `rules` (Claude's Bash(...) or Cursor's Shell(...)) matches `command`, with `*`
// matching any text, as both CLIs match them.
function denied(rules, command) {
  return rules.some((rule) => {
    const body = /^(?:Bash|Shell)\((.*)\)$/.exec(rule)?.[1];
    if (body === undefined) return false;
    return new RegExp(`^${body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command);
  });
}

test('the GitHub deny rules match each spelling of a gh api write flag and of the token flag, for gemini and Claude', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const writes = [
    'gh api -X POST repos/o/r/issues', 'gh api -XPOST repos/o/r/issues', 'gh api -X=POST repos/o/r/issues',
    'gh api repos/o/r/issues --method POST', 'gh api repos/o/r/issues --method=POST', 'gh api repos/o/r/issues --method=GET',
    'gh api repos/o/r/issues -f title=x', 'gh api repos/o/r/issues -ftitle=x', 'gh api repos/o/r/issues --field=title=x',
    'gh api repos/o/r/issues --raw-field=body=x', 'gh api graphql -F query=@q.graphql', 'gh api repos/o/r/issues --input=body.json',
  ];
  const tokens = ['gh auth status --show-token', 'gh auth status -t', 'gh auth status --hostname github.com -t', 'gh auth token'];
  const reads = ['gh api repos/o/r/pulls/1', 'gh api repos/o/r/contents/my-file --jq .name', 'gh auth status', 'gh auth status --hostname github.com', 'gh pr view 1'];
  for (const [id, agent, flags, publishing] of [['gemini-held', 'gemini', ['--no-publish'], false], ['gemini-publishing', 'gemini', [], true],
    ['claude-held', 'claude', ['--no-publish'], false], ['claude-publishing', 'claude', [], true]]) {
    const task = await f.start(run, id, { agent, flags });
    await f.finished(run, id);
    const rules = denies(argvOf(task));
    for (const command of tokens) assert.equal(denied(rules, command), true, `${id}: ${command}`);
    for (const command of writes) assert.equal(denied(rules, command), !publishing, `${id}: ${command}`);
    for (const command of reads) assert.equal(denied(rules, command), false, `${id}: ${command}`);
  }
});

test('credential rules cover the folders agent-env.json gives the agent as well as the orchestrator\'s own', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const config = path.join(f.root, 'config');
  const other = { CLAUDE_CONFIG_DIR: path.join(f.root, 'other-claude'), CODEX_HOME: path.join(f.root, 'other-codex') };
  fs.mkdirSync(path.join(config, 'agent-orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(config, 'agent-orchestrator', 'agent-env.json'), JSON.stringify(other));
  const env = { XDG_CONFIG_HOME: config };
  const files = [[f.claude, other.CLAUDE_CONFIG_DIR].map((dir) => `${dir}/.credentials*`), [f.codex, other.CODEX_HOME].map((dir) => `${dir}/auth.json`)].flat();
  const gemini = await f.start(run, 'cursor', { agent: 'gemini', env });
  await f.finished(run, 'cursor');
  const cursorRules = denies(argvOf(gemini));
  for (const file of files) for (const tool of ['Read', 'Write']) assert.ok(cursorRules.includes(`${tool}(${file})`), `gemini ${tool}(${file})`);
  // Claude's absolute form starts with two slashes.
  const claude = await f.start(run, 'anthropic', { env });
  await f.finished(run, 'anthropic');
  const claudeRules = denies(argvOf(claude));
  for (const file of files) for (const tool of ['Read', 'Edit', 'Write']) assert.ok(claudeRules.includes(`${tool}(/${file})`), `claude ${tool}(/${file})`);
});

test('help says a follow-up by the same agent needs no --tier, and that naming one turns escalation off', async (t) => {
  const f = await fixture(t);
  const help = (await f.command(['help'])).stdout;
  assert.match(help, /A follow-up by the same agent needs no --tier/);
  assert.match(help, /--tier \(even the same one\), a changed --agent, or --no-escalate\s+turns that escalation off/);
  assert.doesNotMatch(help, /on every attempt/);
});
