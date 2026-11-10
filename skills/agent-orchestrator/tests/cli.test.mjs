import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';

test('new records the repository and worktree prepares an isolated branch', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun('basics');
  assert.equal(run.repo, f.repo);
  assert.equal(run.isGit, true);
  assert.equal(run.baseBranch, 'main');
  assert.equal(run.baseCommit, await f.git(['rev-parse', 'HEAD']));
  assert.equal(run.goal, 'Black-box CLI fixture');
  assert.equal(readJson(path.join(run.dir, 'run.json')).id, run.id);
  const wt = await f.json(['worktree', run.id, 'writer']);
  assert.equal(wt.path, path.join(run.dir, 'worktrees', 'writer'));
  assert.equal(wt.branch, `orch/${run.id}/writer`);
  assert.equal(wt.from, run.baseCommit);
  assert.equal(fs.readFileSync(path.join(wt.path, 'README.md'), 'utf8'), 'Temporary fixture repository.\n');
  const prepared = (await f.json(['status', run.id])).tasks[0];
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.cd, wt.path);
  const started = await f.start(run, 'writer');
  assert.equal(started.cd, wt.path);
  await f.finished(run, 'writer');
  await f.command(['result', run.id, 'writer']);
  await f.command(['cleanup', run.id, '--delete-branches']);
  assert.equal(fs.existsSync(wt.path), true, 'reading a result is not explicit closure');
  const cleaned = await f.command(['close', run.id, 'writer']);
  assert.match(cleaned.stdout, /removed worktree/);
  assert.match(cleaned.stdout, /branch kept/);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(readJson(f.taskFile(run, 'writer')).worktree, undefined);
  assert.ok(await f.git(['branch', '--list', wt.branch]));
});

for (const agent of ['claude', 'codex']) {
  test(`${agent}: start, augmented brief, event accounting, wait, result, and close`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun(agent);
    const extraEvents = agent === 'claude'
      ? [{ type: 'assistant', message: { id: 'tool-message', model: 'claude-opus-5-5',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } }] } }]
      : [{ type: 'item.started', item: { id: 'tool-1', type: 'command_execution', command: 'cat README.md' } },
         { type: 'item.completed', item: { id: 'tool-1', type: 'command_execution', command: 'cat README.md', exit_code: 0 } }];
    const started = await f.start(run, 'task', { agent, config: { extraEvents, finalMessage: 'All done ✓' } });
    assert.equal(started.agent, agent);
    assert.match(started.why, /local fake relay/);
    const brief = fs.readFileSync(path.join(started.outDir, 'orch-brief.md'), 'utf8');
    assert.match(brief, /^Fixture task task\./);
    assert.match(brief, /## Decisions/);
    assert.match(brief, /## Delegating further/);
    const row = await f.finished(run, 'task');
    assert.equal(row.state, 'completed');
    assert.equal(row.session, `fixture-${agent}`);
    assert.equal(row.tokensIn, 120);
    assert.equal(row.tokensCached, 20);
    assert.equal(row.tokensOut, 30);
    assert.equal(row.tokensExact, true);
    assert.equal(row.steps, 1);
    assert.equal(row.limitHit, false);
    const invocation = readJson(path.join(started.outDir, 'invocation.json'));
    assert.equal(invocation.depth, '1');
    assert.equal(invocation.run, run.id);
    assert.equal(invocation.task, 'task');
    assert.equal(invocation.cwd, f.repo);
    assert.equal(invocation.argv[invocation.argv.indexOf('--model') + 1], started.model);
    assert.equal(invocation.argv[invocation.argv.indexOf('--effort') + 1], started.effort);
    assert.equal(fs.readFileSync(path.join(started.outDir, 'final.txt'), 'utf8'), 'All done ✓');
    const status = await f.command(['status', run.id]);
    assert.match(status.stdout, /task\s+.*completed/);
    assert.match(status.stdout, /why:/);
    assert.match(status.stdout, /All done ✓/);
    const waited = await f.json(['wait', run.id, '--timeout', '1s']);
    assert.equal(waited.finished, true);
    assert.equal(readJson(f.taskFile(run, 'task')).closedAt, null);
    const result = await f.command(['result', run.id, 'task']);
    assert.match(result.stdout, /All done ✓/);
    assert.ok(readJson(f.taskFile(run, 'task')).closedAt);
    const closed = await f.json(['close', run.id, 'task']);
    assert.deepEqual(closed.closed, ['task']);
    assert.equal((await f.json(['status', run.id])).tasks[0].closed, true);
  });
}

test('a delegated write brief ends with the delegation note: split, lightest tier, pass it on, no commits', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const started = await f.start(run, 'writer');
  const brief = fs.readFileSync(path.join(started.outDir, 'orch-brief.md'), 'utf8');
  const note = brief.slice(brief.indexOf('## Delegating further'), brief.indexOf('## Decisions'));
  assert.ok(note.length > 0 && note.length < 2500, `the note stays short: ${note.length} characters`);
  // Delegate through the skill, rather than doing parts one after another.
  assert.match(note, /orch\.mjs`; read its SKILL\.md first, above all "Delegate well", then `new` a run and `start` each agent\) rather than doing things one after another/);
  assert.match(note, /run it as a command task with no model .*never as an agent that runs it and waits/);
  assert.match(note, /Never forward your whole task to a single agent.*split it, or do it yourself.*say so with `node .*orch\.mjs ask/);
  assert.match(note, /two or more independent parts, split it and start one agent per part/);
  assert.match(note, /slow side work \(test suites, gates, builds, deploys, long runs, reviews/);
  // The lightest tier for each piece, with the deciding factor in --why.
  assert.match(note, /Size each piece on its own: the lightest tier that does it as well as the top one/);
  assert.match(note, /Running tests or gates, reproducing a bug, lookups, and mechanical edits fit `light`; small well-specified changes, docs, and reviews of small diffs fit `standard`/);
  assert.match(note, /Name the deciding factor in `--why`/);
  // Pass it on, one sentence on the automatic notice, and the safety lines that stay.
  assert.match(note, /tell it in its brief to delegate them the same way/);
  assert.match(note, /You are notified when an agent you started finishes, so do not poll\./);
  assert.match(note, /the agents you start never commit, push or publish; you do/);
  assert.match(note, /Run at most 6 at a time/);
  assert.match(note, /close them before you finish/);
  assert.match(note, /`NEEDS DECISION:`/);
  assert.match(note, /1 level below the user's session; agents 4 levels down cannot delegate/);
  // Gone: the old "by default, hand ... anything that would otherwise make you wait" wording.
  assert.doesNotMatch(note, /Split the change itself across agents only/);
});

test('start rejects a missing rationale and a missing tier without launching a relay', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const brief = f.brief('validation');
  const why = await f.command(['start', run.id, 'no-why', '--agent', 'claude', '--tier', 'standard', '--brief', brief], { code: 2 });
  assert.match(why.stderr, /--why is required/);
  const claudeTier = await f.command(['start', run.id, 'no-tier', '--agent', 'claude', '--why', 'test', '--brief', brief], { code: 2 });
  assert.match(claudeTier.stderr, /--tier is required for a new Claude task/);
  const tier = await f.command(['start', run.id, 'no-tier', '--agent', 'codex', '--why', 'test', '--brief', brief], { code: 2 });
  assert.match(tier.stderr, /--tier/);
  assert.deepEqual((await f.json(['status', run.id])).tasks, []);
  assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
});

test('parallel limit, timeout exit 3, stop, and closing a running task', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const env = { AGENT_ORCH_MAX_PARALLEL: '1' };
  const started = await f.start(run, 'slow', { config: { delayMs: 30_000 }, flags: ['--read-only'], env });
  await f.ready(started);
  const brief = fs.readFileSync(path.join(started.outDir, 'orch-brief.md'), 'utf8');
  assert.match(brief, /## Decisions/);
  assert.doesNotMatch(brief, /## Delegating further/);
  const rejected = await f.command(['start', run.id, 'second', '--agent', 'claude', '--tier', 'light', '--why', 'test',
    '--brief', f.brief('second'), '--read-only'], { code: 1, env });
  assert.match(rejected.stderr, /1 tasks already running \(limit 1\)/);
  assert.equal(fs.existsSync(f.taskFile(run, 'second')), false);
  const timedOut = await f.command(['wait', run.id, 'slow', '--timeout', '1ms'], { code: 3 });
  assert.match(timedOut.stdout, /still running: wait timed out/);
  assert.equal((await f.json(['status', run.id])).tasks[0].state, 'running');
  const stopped = await f.command(['stop', run.id, 'slow']);
  assert.match(stopped.stdout, /stopped slow/);
  assert.equal((await f.finished(run, 'slow')).state, 'stopped');
  assert.equal((await f.json(['wait', run.id, '--timeout', '1s'])).finished, true);
  const other = await f.start(run, 'other', { config: { delayMs: 30_000 }, flags: ['--read-only'] });
  await f.ready(other);
  const closed = await f.command(['close', run.id, '--all']);
  assert.match(closed.stdout, /other: stopped .* and closed/);
  assert.ok((await f.json(['status', run.id])).tasks.every((row) => row.closed && row.state !== 'running'));
});

test('decisions stay open and wait names the task; normal messages remain completed', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const questions = ['Choose API A or B? Recommendation: A.', 'Increase scope? Recommendation: no.'];
  await f.start(run, 'question', { config: { finalMessage: `NEEDS DECISION:\n${questions.join('\n')}` } });
  const row = await f.finished(run, 'question');
  assert.equal(row.state, 'needs-decision');
  assert.deepEqual(row.decisions, questions);
  assert.equal(row.closed, false);
  const result = await f.command(['result', run.id, 'question']);
  for (const question of questions) assert.ok(result.stdout.includes(`  - ${question}`));
  assert.equal(readJson(f.taskFile(run, 'question')).closedAt, null);
  const waited = await f.command(['wait', run.id, '--timeout', '1s']);
  assert.match(waited.stdout, /question handed back a decision/);
  await f.command(['close', run.id, 'question']);
  assert.ok(readJson(f.taskFile(run, 'question')).closedAt);
  await f.start(run, 'normal', { config: { finalMessage: 'Implemented the requested behavior.' } });
  assert.equal((await f.finished(run, 'normal')).state, 'completed');
  const normal = await f.command(['wait', run.id, 'normal', '--timeout', '1s']);
  assert.doesNotMatch(normal.stdout, /handed back a decision/);
});

for (const [agent, error, limited] of [
  ['claude', 'Usage limit reached; resets at 20:00 UTC.', true],
  ['codex', 'You have hit your usage limit.', true],
  ['codex', 'Compilation failed: missing semicolon.', false],
]) {
  test(`${agent} failure: ${limited ? 'usage limit is highlighted' : 'ordinary error is not a usage limit'}`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    await f.start(run, 'failed-task', { agent, config: { status: 'failed', finalMessage: 'Could not finish.', error } });
    const row = await f.finished(run, 'failed-task');
    assert.equal(row.state, 'failed');
    assert.equal(row.result.exitCode, 1);
    assert.equal(row.limitHit, limited);
    const result = await f.command(['result', run.id, 'failed-task']);
    const waited = await f.command(['wait', run.id, '--timeout', '1s']);
    if (limited) {
      assert.match(result.stdout, /USAGE LIMIT/);
      assert.match(waited.stdout, /failed-task \((claude|codex)\) stopped on a usage limit/);
    } else {
      assert.doesNotMatch(result.stdout, /USAGE LIMIT/);
      assert.doesNotMatch(waited.stdout, /stopped on a usage limit/);
    }
  });
}

test('nested depth 1 defaults to six slots; depth 4 refuses to start', async (t) => {
  const f = await fixture(t);
  const env = { AGENT_ORCH_DEPTH: '1' };
  const run = await f.newRun('nested', env);
  assert.equal(run.orchestrator.depth, 1);
  assert.equal(run.orchestrator.parentRun, null);
  assert.equal(run.orchestrator.parentTask, null);
  for (let i = 0; i < 6; i++) {
    const task = await f.start(run, `task-${i}`, { config: { delayMs: 30_000 }, flags: ['--read-only'], env });
    await f.ready(task);
    assert.equal(readJson(path.join(task.outDir, 'invocation.json')).depth, '2');
  }
  const args = ['start', run.id, 'overflow', '--agent', 'claude', '--tier', 'light', '--why', 'test', '--brief', f.brief('overflow'), '--read-only'];
  const limit = await f.command(args, { code: 1, env });
  assert.match(limit.stderr, /6 tasks already running \(limit 6\)/);
  const depth = await f.command(args, { code: 1, env: { AGENT_ORCH_DEPTH: '4' } });
  assert.match(depth.stderr, /refusing to dispatch.*4 levels/);
  assert.equal((await f.json(['status', run.id])).tasks.length, 6);
  await f.command(['close', run.id, '--all']);
});

test('cleanup preserves dirty worktrees even when forced', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'dirty']);
  fs.writeFileSync(path.join(wt.path, 'important.txt'), 'Uncommitted fixture work.');
  await f.command(['close', run.id, 'dirty']);
  const skipped = await f.command(['cleanup', run.id]);
  assert.match(skipped.stdout, /skip dirty: uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(wt.path, 'important.txt'), 'utf8'), 'Uncommitted fixture work.');
  assert.ok(readJson(f.taskFile(run, 'dirty')).worktree);
  await f.command(['cleanup', run.id, '--force', '--delete-branches']);
  assert.equal(fs.existsSync(wt.path), true);
  assert.ok(await f.git(['branch', '--list', wt.branch]));
});

test('a finished task whose PID another task\'s relay now holds is not running, and stop and close do not signal that relay', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'ended', { flags: ['--read-only'] });
  await f.finished(run, 'ended');
  const live = await f.start(run, 'live', { config: { hold: true }, flags: ['--read-only'] });
  await f.ready(live);
  // The system gave the ended relay's PID to the other task's relay.
  const file = f.taskFile(run, 'ended');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pid: live.pid }));
  const states = async () => Object.fromEntries((await f.json(['status', run.id])).tasks.map((row) => [row.id, row.state]));
  assert.deepEqual(await states(), { ended: 'completed', live: 'running' });
  const stop = await f.command(['stop', run.id, 'ended'], { code: 1 });
  assert.match(stop.stderr, /task ended is not running/);
  await f.command(['close', run.id, 'ended']);
  assert.doesNotThrow(() => process.kill(live.pid, 0), 'the other task\'s relay still runs');
  assert.deepEqual(await states(), { ended: 'completed', live: 'running' });
  f.release(live);
  await f.finished(run, 'live');
});
