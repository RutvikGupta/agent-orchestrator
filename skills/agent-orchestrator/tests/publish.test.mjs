import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';

const relayArgs = (task) => readJson(path.join(task.outDir, 'invocation.json')).argv;
const brief = (task) => fs.readFileSync(path.join(task.outDir, 'orch-brief.md'), 'utf8');

// The user's choice: a write task lands its own work (commit, push, GitHub writes) unless the user
// asked to review it first. The dangerous commands stay denied either way.
test('a write task may publish by default; --no-publish denies it and says so in the brief', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const lands = await f.start(run, 'lands');
  await f.ready(lands);
  const args = relayArgs(lands);
  assert.ok(args.includes('--allow-publish'));
  assert.ok(args.includes('Bash(git push --force*)'), 'force pushes stay denied');
  assert.ok(args.includes('Bash(gh secret)'), 'secrets stay denied');
  assert.ok(!args.includes('Bash(gh pr create)'), 'opening a pull request is allowed');
  assert.doesNotMatch(brief(lands), /## Publishing/);
  await f.finished(run, 'lands');

  const held = await f.start(run, 'held', { flags: ['--no-publish'] });
  await f.ready(held);
  const heldArgs = relayArgs(held);
  assert.ok(!heldArgs.includes('--allow-publish'));
  assert.ok(heldArgs.includes('Bash(gh pr create)'));
  assert.match(brief(held), /## Publishing\n\nThe user asked to review this work before it lands: do not commit, push, or open pull requests/);
  assert.equal(readJson(f.taskFile(run, 'held')).noPublish, true);
  await f.finished(run, 'held');

  // A read-only task has nothing to publish and gets no such note.
  const review = await f.start(run, 'review', { flags: ['--read-only'] });
  await f.ready(review);
  assert.ok(!relayArgs(review).includes('--allow-publish'));
  await f.finished(run, 'review');
});
