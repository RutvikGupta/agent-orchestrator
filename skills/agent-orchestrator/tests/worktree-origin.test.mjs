import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';

async function commit(f, cd, file, text) {
  fs.writeFileSync(path.join(cd, file), text);
  await f.git(['-C', cd, 'add', file]);
  await f.git(['-C', cd, 'commit', '-qm', `Fixture change ${file}`]);
  return f.git(['-C', cd, 'rev-parse', 'HEAD']);
}

test('worktree --from a branch records the commit it started at, so a later hand merge is still flagged', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const origin = await f.git(['rev-parse', 'main']);
  const wt = await f.json(['worktree', run.id, 'writer', '--from', 'main']);
  // The record holds the commit, never the name `main`, which moves with the branch.
  assert.equal(wt.from, origin);
  assert.equal(readJson(f.taskFile(run, 'writer')).worktree.from, origin);
  assert.equal(await f.git(['-C', wt.path, 'rev-parse', 'HEAD']), origin);

  await f.start(run, 'writer');
  await f.finished(run, 'writer');
  const tip = await commit(f, wt.path, 'change.txt', 'Hand merged work\n');
  await f.command(['verify', run.id, 'writer', '--', process.execPath, '-e', 'process.exit(0)']);
  await f.command(['verdict', run.id, 'writer', 'clean', '--note', 'Reviewed fixture change']);
  await f.command(['accept', run.id, 'writer', '--note', 'Reviewed and verified fixture']);
  assert.deepEqual((await f.json(['recover', run.id])).runs[0].manualMerges, [], 'nothing is merged yet');

  // Merging moves main past the start. A start recorded as `main` would now contain the branch tip,
  // so the merge would look as if it predated the worktree and go unreported.
  await f.git(['merge', '--no-ff', '-qm', 'Manual fixture merge', wt.branch]);
  assert.notEqual(await f.git(['rev-parse', 'main']), origin);
  assert.equal(readJson(f.taskFile(run, 'writer')).worktree.from, origin);
  const expected = [{ id: 'writer', branch: wt.branch, into: 'main', commit: tip }];
  assert.deepEqual((await f.json(['recover', run.id])).runs[0].manualMerges, expected);
  const status = await f.json(['status', run.id]);
  assert.deepEqual(status.manualMerges.map(({ id, branch, into, commit: sha }) => ({ id, branch, into, commit: sha })), expected);
  assert.match((await f.command(['status', run.id])).stdout, /--already-merged/);
});

test('worktree --from names a commit: an unknown ref is refused before anything is created', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const refused = await f.command(['worktree', run.id, 'writer', '--from', 'no-such-ref'], { code: 1 });
  assert.match(refused.stderr, /--from is not a commit.*no-such-ref/);
  assert.equal(fs.existsSync(f.taskFile(run, 'writer')), false);
  assert.equal(fs.existsSync(path.join(run.dir, 'worktrees', 'writer')), false);
});
