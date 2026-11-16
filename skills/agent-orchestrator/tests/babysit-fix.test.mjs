import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';
// Pure: what a final message says about a fix, and about parking.
import { needsFixSignal, parkedSignal } from '../scripts/lib/runs.mjs';
import { coldResume } from '../scripts/lib/park.mjs';

const SLOW = 20_000; // a watcher's check is a fresh Node process, slow on a loaded machine
const report = (outcome) => `\`\`\`orch-result\n{"outcome":"${outcome}","changed":[],"checks":[],"decisions":[],"unresolved":[]}\n\`\`\``;
const PARKED = `PARKED: PR #42 waits for a human review\n${report('parked')}`;
const NEEDS_FIX = `NEEDS FIX: PR #42 the unit check fails on a renamed import\nFailing check: unit (log: ImportError in src/app.py line 3).\nRuled out: a flaky runner.\n${report('partial')}`;

// A fake gh serving pull request #42, as in park.test.mjs; watchers check every second.
async function github(f) {
  const bin = path.join(f.root, 'bin');
  const data = path.join(f.root, 'github.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'graphql') {
  const pr = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
  const list = (items) => ({ totalCount: items.length, nodes: items });
  const bodies = args.join(' ').includes('totalCount') ? { comments: list(pr.comments.map((c) => ({ body: c.body }))), reviews: list([]) } : {};
  console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}, ...bodies}}}}));
} else process.exit(91);
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.AGENT_ORCH_PARK_INTERVAL = '1s';
  const pr = { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] };
  const set = (changes = {}) => writeJson(data, { ...pr, ...changes });
  set();
  return set;
}

const babysit = (f, run, id, config, { flags = [], env = {} } = {}) => f.json(['start', run.id, id, '--agent', 'claude', '--babysit', '--pr', '42',
  '--why', 'Babysits the fixture PR', '--brief', f.brief(id, config), ...flags], { env });
const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const attempt = (f, run, id, n) => eventually(() => {
  const task = readJson(f.taskFile(run, id));
  return task.attempt === n ? task : null;
}, `${id}'s attempt ${n} did not start`, SLOW);
const parkedRow = (f, run, id, n) => eventually(async () => {
  const row = await rowOf(f, run, id);
  return row?.phase === 'parked' && row.attempt === n && row.parked.watcher === 'alive' ? row : null;
}, `${id} did not park in attempt ${n}`, SLOW);
const sessionOf = (task) => {
  const { argv } = readJson(path.join(task.outDir, 'invocation.json'));
  return argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : null;
};
const modelOf = (task) => {
  const { argv } = readJson(path.join(task.outDir, 'invocation.json'));
  return argv[argv.indexOf('--model') + 1];
};
const briefOf = (task) => fs.readFileSync(path.join(task.outDir, 'orch-brief.md'), 'utf8');
const failed = [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }];

test('only an unquoted, unindented NEEDS FIX: first or last line asks for a fix, and such a message never parks', () => {
  assert.equal(needsFixSignal(NEEDS_FIX), 'PR #42 the unit check fails on a renamed import');
  assert.equal(needsFixSignal('Facts first.\n\nNEEDS FIX: PR #42 rename the flag\n'), 'PR #42 rename the flag');
  assert.equal(needsFixSignal(`Facts.\nNEEDS FIX: PR #42 rename the flag\n${report('partial')}`), 'PR #42 rename the flag');
  for (const message of [
    `> NEEDS FIX: quoted\n${report('partial')}`,
    `  NEEDS FIX: indented\n${report('partial')}`,
    `Done.\nNEEDS FIX: in the middle\nMore text.\n${report('partial')}`,
    `NEEDS FIX: PR #42 a fix\n${report('parked')}`,
    'NEEDS FIX: PR #42 a fix\nNEEDS DECISION:\n- Merge or wait?',
    'Nothing to fix.',
  ]) assert.equal(needsFixSignal(message), null, message);
  assert.equal(parkedSignal(`PARKED: PR #42 waits\nNEEDS FIX: PR #42 a fix`), null, 'a message that asks for a fix does not park');
});

test('a resume reads no prompt cache after another model or a wait past the cache\'s life', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.deepEqual(coldResume('2026-11-16T11:59:00Z', 'claude-sonnet-5-5', 'claude-sonnet-5-5', now), { cold: false, why: null });
  assert.deepEqual(coldResume('2026-11-16T11:59:00Z', 'claude-sonnet-5-5', 'claude-opus-5-5', now), { cold: true, why: 'model' });
  assert.deepEqual(coldResume('2026-11-16T11:04:00Z', 'claude-sonnet-5-5', 'claude-sonnet-5-5', now), { cold: true, why: 'idle' }, '56 minutes: past 1h less 5 minutes');
  assert.deepEqual(coldResume('2026-11-16T11:06:00Z', 'claude-sonnet-5-5', 'claude-sonnet-5-5', now), { cold: false, why: null }, '54 minutes: still warm');
});

test('a babysitter watches at standard; a NEEDS FIX starts its fix attempt at complex in the same session, and the next wake watches again', async (t) => {
  const f = await fixture(t);
  const set = await github(f);
  // The fix attempt's brief has no fake-relay comment: it holds, then parks.
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: PARKED });
  const run = await f.newRun();
  const out = await f.command(['start', run.id, 'sit', '--agent', 'claude', '--babysit', '--pr', '42', '--why', 'Babysits the fixture PR', '--brief', f.brief('sit', { finalMessage: NEEDS_FIX })]);
  assert.match(out.stdout, /started sit → claude claude-sonnet-5-5 \(effort xhigh, standard tier, write, babysitter: may commit and push/);
  assert.match(out.stdout, /note: the babysitter watches at the standard tier; a wake that needs a code fix ends with NEEDS FIX:, and its fix attempt runs at once at the complex tier in the same session/);
  const first = readJson(f.taskFile(run, 'sit'));
  assert.deepEqual([first.tier, first.watchTier], ['standard', 'standard']);
  assert.match(briefOf({ outDir: path.join(run.dir, 'tasks', 'sit', 'attempt-1') }), /## Watch tier: hand fixes to a fix attempt\n\nThis attempt runs at your watch tier \(`standard`\)/);

  // The watch attempt ends with NEEDS FIX: its fix attempt starts at once, at complex, in its session.
  const fix = await attempt(f, run, 'sit', 2);
  await f.ready(fix);
  assert.deepEqual([fix.tier, fix.watchTier, fix.attemptReason, fix.babysit], ['complex', 'standard', 'fix', true]);
  assert.deepEqual([fix.fixes[2].fromAttempt, fix.fixes[2].reason], [1, 'PR #42 the unit check fails on a renamed import']);
  assert.deepEqual([sessionOf(fix), modelOf(fix)], ['fixture-claude', 'claude-opus-5-5']);
  // A switch of model is cold, but this session is small and has no note: it is kept.
  assert.deepEqual(fix.handoffChecks[2], { contextTokens: 120, limit: 60000, limitKind: 'cold', coldWhy: 'model', note: 'missing', fresh: false });
  const brief = briefOf(fix);
  assert.match(brief, /^## Fix attempt\n\nYou are now this babysitter's fix attempt, at the `complex` tier \(claude-opus-5-5\)\. Your watch attempt, at the `standard` tier, ended with `NEEDS FIX: PR #42 the unit check fails on a renamed import`/);
  assert.match(brief, /## The watch attempt's message\n\n> NEEDS FIX: PR #42 the unit check fails on a renamed import\n> Failing check: unit \(log: ImportError in src\/app\.py line 3\)\.\n> Ruled out: a flaky runner\./);
  assert.doesNotMatch(brief, /## Watch tier/, 'the fix attempt is told to fix, not to hand off');
  const notice = readJson(path.join(run.dir, 'tasks', 'sit', 'attempt-1', 'parent-notice.json'));
  assert.deepEqual(notice.fix, { attempt: 2, reason: 'PR #42 the unit check fails on a renamed import' });
  const row = await rowOf(f, run, 'sit');
  assert.deepEqual(row.attempts.map((a) => [a.n, a.tier, a.reason, a.state]), [[2, 'complex', 'fix', 'running'], [1, 'standard', 'first', 'needs-fix']]);
  assert.match((await f.command(['status', run.id])).stdout, /sit: 0 counted failures; attempts: 1 claude standard, 2 claude complex \(fix\)/);
  assert.match((await f.command(['result', run.id, 'sit'])).stdout, /^fix attempt: attempt 2 fixes what attempt 1 asked for: NEEDS FIX: PR #42 the unit check fails on a renamed import$/m);

  // The fix attempt parks; the next wake resumes at the watch tier, in the same session (no note).
  f.release(fix);
  await parkedRow(f, run, 'sit', 2);
  set({ statusCheckRollup: failed });
  const third = await attempt(f, run, 'sit', 3);
  await f.ready(third);
  assert.deepEqual([third.tier, third.attemptReason, sessionOf(third), modelOf(third)], ['standard', 'resume', 'fixture-claude', 'claude-sonnet-5-5']);
  assert.match(briefOf(third), /## Watch tier: hand fixes to a fix attempt/);
  f.release(third);
  await parkedRow(f, run, 'sit', 3);
  await f.command(['close', run.id, 'sit']);
});

test('a NEEDS FIX goes to the orchestrator as a decision when the ceiling forbids complex, or the watch tier is complex', async (t) => {
  const f = await fixture(t);
  await github(f);
  const run = await f.newRun();
  await babysit(f, run, 'capped', { finalMessage: NEEDS_FIX }, { env: { AGENT_ORCH_MAX_TIER: 'standard' } });
  const capped = await eventually(async () => {
    const row = await rowOf(f, run, 'capped');
    return row?.state === 'needs-decision' ? row : null;
  }, 'the capped babysitter was not handed back', SLOW);
  assert.deepEqual(capped.decisions, ['NEEDS FIX: PR #42 the unit check fails on a renamed import',
    'No fix attempt was started: the inherited ceiling AGENT_ORCH_MAX_TIER=standard forbids claude complex (claude-opus-5-5), which a fix attempt runs']);
  assert.equal(readJson(f.taskFile(run, 'capped')).attempt, 1, 'nothing was started');
  assert.match((await f.command(['result', run.id, 'capped'])).stdout, /NEEDS DECISION:.*\n {2}- NEEDS FIX: PR #42/);

  await babysit(f, run, 'opus', { finalMessage: NEEDS_FIX }, { flags: ['--tier', 'complex'] });
  const opus = await eventually(async () => {
    const row = await rowOf(f, run, 'opus');
    return row?.state === 'needs-decision' ? row : null;
  }, 'the complex babysitter was not handed back', SLOW);
  assert.match(opus.decisions[1], /attempt 1 already ran at the complex tier, which a fix attempt \(complex\) does not exceed/);
  const record = readJson(f.taskFile(run, 'opus'));
  assert.deepEqual([record.attempt, record.tier, record.watchTier], [1, 'complex', 'complex']);
  assert.doesNotMatch(briefOf(record), /## Watch tier/, 'a complex watch tier fixes for itself');
});

test('a parked babysitter hands off at the cold limit once its cache is cold, and keeps its session at the warm limit', async (t) => {
  const f = await fixture(t);
  await github(f);
  // The fake relay's last call sends 120 tokens: above the cold limit, below the warm one.
  f.env.AGENT_ORCH_BABYSIT_HANDOFF_TOKENS = '1000';
  f.env.AGENT_ORCH_COLD_HANDOFF_TOKENS = '100';
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: PARKED });
  // One run each, so that neither holds the other's checkout; a message wakes each.
  const parkWithNote = async (run, id) => {
    await babysit(f, run, id, { hold: true, finalMessage: PARKED });
    const first = readJson(f.taskFile(run, id));
    await f.ready(first);
    fs.writeFileSync(path.join(run.dir, 'tasks', id, 'handoff.md'), `HANDOFF_MARK ${id}: round 1 answered.\n`);
    f.release(first);
    await parkedRow(f, run, id, 1);
  };
  // Warm: the same model, resumed at once: the session is kept, whatever the note.
  const warmRun = await f.newRun('warm');
  await parkWithNote(warmRun, 'warm');
  await f.command(['send', warmRun.id, 'warm', 'Please also rename the flag.']);
  const warm2 = await attempt(f, warmRun, 'warm', 2);
  await f.ready(warm2);
  assert.equal(sessionOf(warm2), 'fixture-claude');
  assert.equal(warm2.handoffs, undefined);
  assert.deepEqual(warm2.handoffChecks[2], { contextTokens: 120, limit: 1000, limitKind: 'warm', note: 'current', fresh: false });
  assert.match((await f.command(['result', warmRun.id, 'warm'])).stdout, /^session kept: its latest call sent 120 tokens, within 1000 \(the warm limit\)$/m);
  f.release(warm2);
  await parkedRow(f, warmRun, 'warm', 2);
  await f.command(['close', warmRun.id, 'warm']);

  // Cold: a cache that lives 5 minutes, less the 5-minute margin, is cold at once. Whoever starts
  // the park watcher (the finish watcher, or a `status`) passes the setting on.
  f.env.AGENT_ORCH_CACHE_TTL = '5m';
  const coldRun = await f.newRun('cold');
  await parkWithNote(coldRun, 'cold');
  await f.command(['send', coldRun.id, 'cold', 'Please also rename the flag.']);
  const cold2 = await attempt(f, coldRun, 'cold', 2);
  await f.ready(cold2);
  assert.equal(sessionOf(cold2), null, 'the cold session was resumed');
  assert.deepEqual(cold2.handoffs[2], { ...cold2.handoffs[2], fromAttempt: 1, contextTokens: 120, limit: 100, limitKind: 'cold', coldWhy: 'idle' });
  assert.match(briefOf(cold2), /It parked; its context had grown to 120 tokens, and it had waited longer than its prompt cache lives, so its first call would have written all of it to the cache again, so you start fresh/);
  assert.match(briefOf(cold2), /HANDOFF_MARK cold: round 1 answered\./);
  assert.match((await f.command(['result', coldRun.id, 'cold'])).stdout, /fresh session: attempt 2 started from the handoff note, since attempt 1's context had grown to 120 tokens \(limit 100, the cold limit: the prompt cache had expired\)/);
  f.release(cold2);
  await parkedRow(f, coldRun, 'cold', 2);
  await f.command(['close', coldRun.id, 'cold']);
});

test('a fix attempt switches model, so with a current note and a session above the cold limit it starts fresh', async (t) => {
  const f = await fixture(t);
  await github(f);
  f.env.AGENT_ORCH_COLD_HANDOFF_TOKENS = '100';
  f.env.FAKE_RELAY_CONFIG = JSON.stringify({ hold: true, finalMessage: PARKED });
  const run = await f.newRun();
  await babysit(f, run, 'sit', { hold: true, finalMessage: NEEDS_FIX });
  const watch = readJson(f.taskFile(run, 'sit'));
  await f.ready(watch);
  fs.writeFileSync(path.join(run.dir, 'tasks', 'sit', 'handoff.md'), 'HANDOFF_MARK the unit check broke after a rename.\n');
  f.release(watch);
  const fix = await attempt(f, run, 'sit', 2);
  await f.ready(fix);
  assert.equal(sessionOf(fix), null, 'the watch session was resumed');
  assert.deepEqual([fix.tier, fix.attemptReason, fix.handoffs[2].limitKind, fix.handoffs[2].coldWhy, fix.handoffs[2].limit], ['complex', 'fix', 'cold', 'model', 100]);
  const brief = briefOf(fix);
  const parts = ['Fixture task sit.', '## Handoff note from your previous session', 'You are the fix attempt of this babysitter, and take over from its watch session: its context had grown to 120 tokens, and it would have resumed on another model',
    'HANDOFF_MARK the unit check broke', '## Fix attempt', '## The watch attempt\'s message'].map((part) => brief.indexOf(part));
  assert.ok(parts.every((at, i) => at >= 0 && (i === 0 || at > parts[i - 1])), `the brief's parts are out of order: ${parts}`);
  // The brief the babysitter was first given is kept as it was.
  assert.equal(fs.readFileSync(path.join(run.dir, 'tasks', 'sit', 'babysit-brief.md'), 'utf8'), fs.readFileSync(f.brief('sit', { hold: true, finalMessage: NEEDS_FIX }), 'utf8'));
  // The fresh session's brief starts with the first brief, whose fake relay ends with NEEDS FIX
  // again: a fix attempt that asks for a fix goes to the orchestrator, and nothing loops.
  f.release(fix);
  const handed = await eventually(async () => {
    const row = await rowOf(f, run, 'sit');
    return row?.state === 'needs-decision' ? row : null;
  }, 'the fix attempt\'s NEEDS FIX was not handed back', SLOW);
  assert.match(handed.decisions[1], /attempt 2 already ran at the complex tier, which a fix attempt \(complex\) does not exceed/);
  assert.equal(readJson(f.taskFile(run, 'sit')).attempt, 2);
});

test('an implementer kept as babysitter starts fresh from the babysit brief and a current note when its session is large, and otherwise continues it', async (t) => {
  const f = await fixture(t);
  await github(f);
  // The switch from the implementer's complex tier to the standard watch tier is cold.
  f.env.AGENT_ORCH_COLD_HANDOFF_TOKENS = '100';
  const run = await f.newRun();
  const implement = async (id, withNote) => {
    const task = await f.start(run, id, { config: { hold: true }, flags: ['--force'] });
    await f.ready(task);
    if (withNote) fs.writeFileSync(path.join(run.dir, 'tasks', id, 'handoff.md'), `HANDOFF_MARK ${id} implemented the change.\n`);
    f.release(task);
    await f.finished(run, id);
  };

  await implement('noted', true);
  const brief = f.brief('noted-babysit', { hold: true, finalMessage: PARKED });
  const out = await f.command(['start', run.id, 'noted', '--agent', 'claude', '--babysit', '--pr', '42', '--brief', brief, '--', '--session', 'fixture-claude']);
  assert.match(out.stdout, /note: started a fresh session from the babysit brief and the handoff note instead of continuing session fixture-claude: its context had grown to 120 tokens, and it would have resumed on another model.* \(limit 100, cold\)/);
  const noted = readJson(f.taskFile(run, 'noted'));
  await f.ready(noted);
  assert.equal(sessionOf(noted), null);
  assert.deepEqual([noted.tier, noted.watchTier, noted.babysit, noted.handoffs[2].from, noted.handoffs[2].limitKind], ['standard', 'standard', true, 'implementer', 'cold']);
  const text = briefOf(noted);
  assert.ok(text.startsWith(fs.readFileSync(brief, 'utf8').trimEnd()), 'the fresh brief starts with the babysit brief');
  assert.match(text, /You take over this pull request, as its babysitter, from the session that implemented it: its context had grown to 120 tokens/);
  assert.match(text, /HANDOFF_MARK noted implemented the change\./);
  assert.equal(fs.readFileSync(path.join(run.dir, 'tasks', 'noted', 'babysit-brief.md'), 'utf8'), fs.readFileSync(brief, 'utf8'));
  f.release(noted);

  // Without a note the session continues, at the watch tier, told to write the note.
  await implement('bare', false);
  const bare = JSON.parse((await f.command(['start', run.id, 'bare', '--agent', 'claude', '--babysit', '--pr', '42', '--force', '--brief', f.brief('bare-babysit', { hold: true, finalMessage: PARKED }), '--json', '--', '--session', 'fixture-claude'])).stdout);
  await f.ready(bare);
  assert.deepEqual([sessionOf(bare), bare.tier, bare.handoffs], ['fixture-claude', 'standard', undefined]);
  assert.match(briefOf(bare), /Your session's latest call sent 120 tokens, and every call re-sends all of it\. Write your handoff note at `[^`]*handoff\.md` now, before you park/);
  f.release(bare);
  await parkedRow(f, run, 'noted', 2);
  await parkedRow(f, run, 'bare', 2);
  await f.command(['close', run.id, 'noted', 'bare']);
});

test('a Codex babysitter is refused with the real reason, before the pull request is read', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const refused = await f.command(['start', run.id, 'sit', '--agent', 'codex', '--tier', 'standard', '--babysit', '--pr', '42',
    '--why', 'Babysits the fixture PR', '--brief', f.brief('sit')], { code: 2 });
  assert.match(refused.stderr, /pull-request babysitting runs on Claude: a babysitter \(--babysit\) parks and resumes the same Claude session/);
  assert.match(refused.stderr, /A Codex implementer hands its pull request to a Claude babysitter through its handoff note \(references\/babysit\.md\)/);
  assert.doesNotMatch(refused.stderr, /costs less/);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});
