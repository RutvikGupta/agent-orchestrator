import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

async function github(f) {
  const bin = path.join(f.root, 'bin');
  const data = path.join(f.root, 'github.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(f.root, 'github-calls.jsonl'))}, JSON.stringify(args)+'\\n');
if (args[0] === 'pr' && args[1] === 'view') console.log(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));
else process.exit(91);
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const pr = { number: 42, url: 'https://github.com/example/repo/pull/42', title: 'Fixture PR',
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: '', headRefOid: await f.git(['rev-parse', 'HEAD']), headRefName: 'main',
    baseRefName: 'base', statusCheckRollup: [], comments: [], reviews: [] };
  return (changes = {}) => writeJson(data, { ...pr, ...changes });
}

test('pr-watch --once returns 0 without consuming changes; watch reports once, then times out with 3', async (t) => {
  const f = await fixture(t);
  const set = await github(f);
  set({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] });
  const once = await f.json(['pr-watch', '42', '--once']);
  assert.equal(once.attention, true);
  assert.match(once.prs[0].attention.join('\n'), /check failed: unit/);
  const seen = path.join(f.state, 'prs', 'example_repo_42.json');
  assert.equal(fs.existsSync(seen), false, '--once must not acknowledge a change');
  const changed = await f.json(['pr-watch', '42', '--timeout', '1s']);
  assert.equal(changed.attention, true);
  assert.deepEqual(readJson(seen).checks.failed, ['unit']);
  const timeout = await f.json(['pr-watch', '42', '--timeout', '1ms'], { code: 3 });
  assert.equal(timeout.attention, false);
  assert.deepEqual(timeout.prs[0].attention, []);
  const unchanged = await f.json(['pr-watch', '42', '--once']);
  assert.equal(unchanged.attention, false);
  assert.ok(fs.readFileSync(path.join(f.root, 'github-calls.jsonl'), 'utf8').includes('graphql'));
});

test('pr-watch refuses unpushed local commits with exit 4, including --once', async (t) => {
  const f = await fixture(t);
  const set = await github(f);
  set();
  fs.writeFileSync(path.join(f.repo, 'fix.txt'), 'unpublished fix');
  await f.git(['add', 'fix.txt']);
  await f.git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Local fix']);
  for (const flags of [[], ['--once']]) {
    const result = await f.command(['pr-watch', '42', '--timeout', '1ms', ...flags], { code: 4 });
    assert.match(result.stderr, /commits the pull request does not have yet.*Push them first/s);
  }
  assert.equal(fs.existsSync(path.join(f.state, 'prs')), false);
});

test('start --babysit needs no --tier: it runs complex, and a follow-up keeps it', async (t) => {
  const f = await fixture(t);
  const set = await github(f);
  set();
  const run = await f.newRun();
  const started = await f.json(['start', run.id, 'babysit', '--agent', 'claude', '--babysit', '--pr', '42',
    '--why', 'Babysits the fixture PR', '--brief', f.brief('babysit')]);
  assert.deepEqual([started.tier, started.model, started.effort, started.babysit], ['complex', 'claude-opus-5-5', 'xhigh', true]);
  await f.finished(run, 'babysit');
  const again = await f.json(['start', run.id, 'babysit', '--agent', 'claude', '--brief', f.brief('babysit-again'), '--json', '--', '--session', 'fixture-claude']);
  assert.deepEqual([again.attempt, again.tier, again.babysit], [2, 'complex', true]);
  await f.finished(run, 'babysit');
});

for (const [name, changes, message] of [
  ['draft', { isDraft: true }, /still a draft/],
  ['closed', { state: 'CLOSED' }, /is closed; there is nothing to babysit/],
  ['merged', { state: 'MERGED' }, /is merged; there is nothing to babysit/],
]) {
  test(`start --babysit rejects a ${name} PR before launching`, async (t) => {
    const f = await fixture(t);
    const set = await github(f);
    set(changes);
    const run = await f.newRun();
    const result = await f.command(['start', run.id, 'babysit', '--agent', 'claude', '--babysit', '--pr', '42',
      '--why', 'Watch the fixture PR', '--brief', f.brief('babysit')], { code: 2 });
    assert.match(result.stderr, message);
    assert.deepEqual(fs.readdirSync(path.join(run.dir, 'tasks')), []);
  });
}

test('only the latest run of a check counts: a cancelled run that a newer one replaced is not a failure', async () => {
  const { checkSummary } = await import('../scripts/lib/github.mjs');
  const run = (name, conclusion, startedAt, extra = {}) => ({ __typename: 'CheckRun', name, workflowName: 'Rules', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion: conclusion || '', startedAt, ...extra });
  // What GitHub's rollup holds when a workflow is started twice on one commit.
  const replaced = [run('Review rules', 'CANCELLED', '2026-01-01T10:00:32Z'), run('Review rules', 'SUCCESS', '2026-01-01T10:00:41Z'), run('unit', 'SUCCESS', '2026-01-01T10:00:00Z')];
  assert.deepEqual(checkSummary(replaced), { total: 2, passed: 2, pending: 0, failed: [] });
  assert.deepEqual(checkSummary([...replaced].reverse()), { total: 2, passed: 2, pending: 0, failed: [] }, 'the order in the rollup does not matter');

  // The latest run decides in every direction, and a rerun still in progress is pending.
  assert.deepEqual(checkSummary([run('unit', 'SUCCESS', '2026-01-01T10:00:00Z'), run('unit', 'FAILURE', '2026-01-01T10:05:00Z')]).failed, ['unit']);
  assert.deepEqual(checkSummary([run('unit', 'FAILURE', '2026-01-01T10:00:00Z'), run('unit', '', '2026-01-01T10:05:00Z')]), { total: 1, passed: 0, pending: 1, failed: [] });
  // A check that was only cancelled, and one of the same name in another workflow, still count.
  assert.deepEqual(checkSummary([run('unit', 'CANCELLED', '2026-01-01T10:00:00Z')]).failed, ['unit']);
  assert.deepEqual(checkSummary([run('lint', 'SUCCESS', '2026-01-01T10:09:00Z'), run('lint', 'FAILURE', '2026-01-01T10:00:00Z', { workflowName: 'Other' })]), { total: 2, passed: 1, pending: 0, failed: ['lint'] });
  // Commit statuses have a context and a state, and no workflow.
  const status = (context, state, startedAt) => ({ __typename: 'StatusContext', context, state, startedAt });
  assert.deepEqual(checkSummary([status('ci/build', 'FAILURE', '2026-01-01T10:00:00Z'), status('ci/build', 'SUCCESS', '2026-01-01T10:10:00Z'), status('ci/deploy', 'PENDING', '2026-01-01T10:00:00Z')]), { total: 2, passed: 1, pending: 1, failed: [] });
  assert.deepEqual(checkSummary(undefined), { total: 0, passed: 0, pending: 0, failed: [] });
});
