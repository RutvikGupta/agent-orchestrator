import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

async function setup(t, { detached = false, accepted = true, finalMessage } = {}) {
  const f = await fixture(t);
  const remote = path.join(f.root, 'origin.git');
  await f.git(['init', '--bare', '-q', remote]);
  await f.git(['remote', 'add', 'origin', remote]);
  const base = await f.git(['rev-parse', 'HEAD']);
  const ref = 'refs/remotes/origin/development';
  await f.git(['update-ref', ref, base]);
  await f.git(['symbolic-ref', 'refs/remotes/origin/HEAD', ref]);
  if (detached) {
    await f.git(['checkout', '--detach', '-q', base]);
    await f.git(['branch', '-D', 'main']);
  } else {
    await f.git(['checkout', '-qb', 'writer']);
  }
  const run = await f.newRun();
  await f.start(run, 'writer', { config: finalMessage ? { finalMessage } : {} });
  await f.finished(run, 'writer');
  fs.writeFileSync(path.join(f.repo, 'work.txt'), 'Reviewed work\n');
  await f.git(['add', 'work.txt']);
  await f.git(['commit', '-qm', 'Reviewed change']);
  const tip = await f.git(['rev-parse', 'HEAD']);
  if (accepted) await f.command(['accept', run.id, 'writer']);

  // An isolated PATH makes it impossible to invoke the user's gh, even on a failing test.
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['git', 'ps', 'sh']) {
    const found = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' }).trim();
    fs.symlinkSync(found, path.join(bin, name));
  }
  const log = path.join(f.root, 'gh-call.json');
  return {
    f, run, base, tip,
    updateRemote: (sha) => f.git(['update-ref', ref, sha]),
    async squash() {
      const sha = await f.git(['commit-tree', `${tip}^{tree}`, '-p', base, '-m', 'Squashed change']);
      await f.git(['update-ref', ref, sha]);
      return sha;
    },
    fakeGh(response, error) {
      fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\n` +
        `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n` +
        (error ? `console.error(${JSON.stringify(error)}); process.exitCode = 4;\n` : `console.log(${JSON.stringify(JSON.stringify(response))});\n`),
      { mode: 0o755 });
    },
    ghCall: () => fs.existsSync(log) ? readJson(log) : null,
    integrate: (flags, code = 0) => f.command(['integrate', run.id, 'writer', '--already-merged', ...flags], { code, env: { PATH: bin } }),
    task: () => readJson(f.taskFile(run, 'writer')),
  };
}

const intoRemote = ['--into', 'origin/development'];
const explicitPr = [...intoRemote, '--pr', '42'];
const merged = (headRefOid, commits = []) => ({ state: 'MERGED', mergedAt: '2026-01-01T12:00:00Z', headRefOid, commits });

test('--already-merged records reachability from a remote-tracking ref without calling gh', async (t) => {
  const s = await setup(t);
  await s.updateRemote(s.tip);
  await s.f.git(['tag', '-a', 'landed', '-m', 'Landed', s.tip]);
  const dryRun = await s.integrate(['--into', 'landed', '--dry-run', '--json']);
  assert.equal(JSON.parse(dryRun.stdout).integratedVerification, 'contained in landed');
  assert.equal(s.task().integratedAt, undefined);
  const out = await s.integrate([...explicitPr, '--json']);
  assert.equal(JSON.parse(out.stdout).integratedVerification, 'contained in origin/development');
  assert.equal(s.task().integratedInto, 'origin/development');
  assert.equal(s.task().integratedCommit, s.tip);
  assert.equal(s.ghCall(), null);
});

test('a detached run with no local branches suggests the only matching remote-tracking branch', async (t) => {
  const s = await setup(t, { detached: true });
  const out = await s.integrate([], 2);
  assert.match(out.stderr, /detached HEAD.*try --into origin\/development.*--pr N/);
  await s.updateRemote(s.tip);
  const refs = await s.f.git(['show-ref']);
  await s.integrate(intoRemote);
  assert.equal(s.task().integratedVerification, 'contained in origin/development');
  assert.equal(await s.f.git(['for-each-ref', 'refs/heads']), '');
  assert.equal(await s.f.git(['show-ref']), refs);
  assert.equal(await s.f.git(['rev-parse', 'HEAD']), s.tip);
});

test('a detached run records a squash-merged PR whose head is the accepted commit', async (t) => {
  const s = await setup(t, { detached: true });
  const squash = await s.squash();
  assert.notEqual(squash, s.tip);
  await s.f.git(['checkout', '--detach', '-q', 'origin/development']);
  s.fakeGh(merged(s.tip));
  const out = await s.integrate(explicitPr);
  assert.match(out.stdout, /squash-merged as PR #42/);
  assert.deepEqual(s.ghCall(), { cwd: s.f.repo, args: ['pr', 'view', '42', '--json', 'state,mergedAt,headRefOid,commits'] });
  assert.equal(s.task().integratedInto, 'origin/development');
  assert.equal(s.task().integratedCommit, squash);
  assert.equal(s.task().integratedVerification, 'squash-merged as PR #42');
  assert.equal(await s.f.git(['for-each-ref', 'refs/heads']), '');
  assert.equal(await s.f.git(['rev-parse', 'HEAD']), squash);
  const recovered = await s.f.json(['recover', s.run.id]);
  assert.deepEqual(recovered.runs[0].groups.accepted, []);

  const plan = path.join(s.f.root, 'plan.json');
  const entry = (id, dependsOn = []) => ({
    id, dependsOn, goal: `Build ${id}`, type: 'implement', owns: [`${id}/`],
    agent: 'claude', tier: 'complex', why: 'Fixture plan', brief: s.f.brief(id),
  });
  writeJson(plan, { goal: 'Use the integrated work', tasks: [entry('writer'), entry('followup', ['writer'])] });
  await s.f.command(['plan', s.run.id, plan]);
  const dispatched = await s.f.json(['dispatch', s.run.id]);
  assert.deepEqual(dispatched.started.map(({ id }) => id), ['followup']);
  await s.f.finished(s.run, 'followup');
  assert.equal(readJson(s.f.taskFile(s.run, 'followup')).worktree.from, squash);
});

test('a single PR named in the report can verify a locally available descendant of the accepted commit', async (t) => {
  const s = await setup(t, { finalMessage: 'Merged PR #42 ([link](https://github.com/example-org/example-repo/pull/42)).' });
  await s.squash();
  const descendant = await s.f.git(['commit-tree', `${s.tip}^{tree}`, '-p', s.tip, '-m', 'Post-review commit']);
  s.fakeGh(merged(descendant));
  await s.integrate(intoRemote);
  assert.equal(s.task().integratedVerification, 'squash-merged as PR #42');
});

test('a PR in a task record can verify the accepted commit against the commit list when the head is absent', async (t) => {
  const s = await setup(t);
  await s.squash();
  writeJson(s.f.taskFile(s.run, 'writer'), { ...s.task(), pr: { number: 42 } });
  s.fakeGh(merged('1'.repeat(40), [{ oid: s.tip }]));
  await s.integrate(intoRemote);
  assert.equal(s.task().integratedVerification, 'squash-merged as PR #42');
});

test('ambiguous PR references require an explicit --pr', async (t) => {
  const s = await setup(t, { finalMessage: 'Related work included PR #42 and PR #43.' });
  const { stderr } = await s.integrate(intoRemote, 1);
  assert.match(stderr, /--into ref that contains the accepted commit, or --pr N/);
  assert.equal(s.ghCall(), null);
  assert.equal(s.task().integratedAt, undefined);
});

test('an open PR does not verify integration', async (t) => {
  const s = await setup(t);
  s.fakeGh({ ...merged(s.tip), state: 'OPEN', mergedAt: null });
  const { stderr } = await s.integrate(explicitPr, 1);
  assert.match(stderr, /PR #42 is not merged/);
  assert.equal(s.task().integratedAt, undefined);
});

test('a locally available PR head must contain the accepted commit', async (t) => {
  const s = await setup(t);
  s.fakeGh(merged(s.base, [{ oid: s.tip }]));
  const { stderr } = await s.integrate(explicitPr, 1);
  assert.match(stderr, /PR #42 does not contain the accepted commit/);
  assert.equal(s.task().integratedAt, undefined);
});

test('a missing or logged-out gh produces a refusal with the reason', async (t) => {
  const s = await setup(t);
  const missing = await s.integrate(explicitPr, 1);
  assert.match(missing.stderr, /GitHub CLI \(gh\) is missing/);
  s.fakeGh(null, 'To get started with GitHub CLI, please run: gh auth login');
  const loggedOut = await s.integrate(explicitPr, 1);
  assert.match(loggedOut.stderr, /cannot verify PR #42: gh pr view failed:.*gh auth login/);
  assert.equal(s.task().integratedAt, undefined);
});

test('--already-merged still refuses a task that has not been accepted', async (t) => {
  const s = await setup(t, { accepted: false });
  await s.updateRemote(s.tip);
  const { stderr } = await s.integrate(explicitPr, 1);
  assert.match(stderr, /task writer is awaiting-review, not accepted: review its result/);
  assert.equal(s.task().integratedAt, undefined);
});
