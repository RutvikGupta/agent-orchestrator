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
