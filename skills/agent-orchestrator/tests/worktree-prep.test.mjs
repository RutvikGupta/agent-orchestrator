import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixture, readJson, writeJson, eventually } from './helpers.mjs';
import { worktreePort, runPrepCommand } from '../scripts/lib/worktree-prep.mjs';

function put(root, name, value = name) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
async function configuration(f, includes = '', ignores = '.env*\ncache/\nnode_modules/\n*.local\n') {
  put(f.repo, '.gitignore', ignores);
  put(f.repo, '.worktreeinclude', includes);
  await f.git(['add', '.gitignore', '.worktreeinclude']);
  await f.git(['commit', '-qm', 'Prep configuration']);
}
function closed(f, run, id) {
  const file = f.taskFile(run, id);
  writeJson(file, { ...readJson(file), closedAt: new Date().toISOString(), closedExplicitlyAttempt: 0 });
}
function recipes(f, value, name = 'recipe.json') {
  const dir = path.join(f.root, 'recipes');
  writeJson(path.join(dir, name), value);
  return { AGENT_ORCH_RECIPES_DIR: dir };
}

test('include patterns copy only ignored files, with gitignore glob, negation and directory semantics', async (t) => {
  const f = await fixture(t);
  await configuration(f, '# comment\n\n.env*\n*.local\ncache/**\n!cache/exclude.local\n!skip.local\nREADME.md\nuntracked.txt\n');
  for (const name of ['.env', '.env.dev', 'cache/deep/file', 'cache/exclude.local', 'a/nested.local', 'skip.local', 'untracked.txt']) put(f.repo, name);
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'include']);
  closed(f, run, 'include');
  for (const name of ['.env', '.env.dev', 'cache/deep/file', 'a/nested.local']) assert.equal(fs.readFileSync(path.join(wt.path, name), 'utf8'), name);
  for (const name of ['cache/exclude.local', 'skip.local', 'untracked.txt']) assert.equal(fs.existsSync(path.join(wt.path, name)), false);
  assert.equal(fs.readFileSync(path.join(wt.path, 'README.md'), 'utf8'), 'Temporary fixture repository.\n');
  assert.equal(wt.prep.copied.length, 4);
  assert.deepEqual(wt.prep.errors, []);
  assert.deepEqual(readJson(f.taskFile(run, 'include')).worktree.prep, wt.prep);
  await f.command(['cleanup', run.id]);
  assert.equal(fs.existsSync(wt.path), false);
});

test('absolute recipe beats basename; symlinks, commands, environment and teardown are recorded', async (t) => {
  const f = await fixture(t);
  await configuration(f, 'node_modules/\n');
  put(f.repo, 'node_modules/pkg/index.js'); put(f.repo, '.env');
  recipes(f, { match: 'repo', notes: 'wrong recipe' }, 'a-fallback.json');
  const env = recipes(f, {
    match: f.repo, copy: ['.env', 'README.md'], symlink: ['node_modules/'], port: true, notes: 'Run local gates here',
    setup: ['printf "%s|%s|%s|%s|%s" "$ORCH_WORKTREE" "$ORCH_REPO" "$ORCH_RUN" "$ORCH_TASK" "$ORCH_PORT" > .env.setup', 'printf failure; exit 7', 'printf continued > .env.after'],
    teardown: ['printf "%s|%s|%s|%s|%s" "$ORCH_WORKTREE" "$ORCH_REPO" "$ORCH_RUN" "$ORCH_TASK" "$ORCH_PORT" > "$ORCH_REPO/teardown.local"', 'echo teardown-failed; exit 9'],
  }, 'z-exact.json');
  const run = await f.newRun();
  const result = await f.command(['worktree', run.id, 'recipe'], { env });
  assert.match(result.stdout, /1 copied, 1 symlinked/); assert.match(result.stdout, /setup failed \(7\)/);
  const wt = readJson(f.taskFile(run, 'recipe')).worktree;
  closed(f, run, 'recipe');
  assert.deepEqual(wt.prep.symlinked, ['node_modules']);
  assert.equal(fs.readlinkSync(path.join(wt.path, 'node_modules')), path.join(f.repo, 'node_modules'));
  assert.equal(wt.prep.notes, 'Run local gates here');
  assert.ok(wt.prep.port >= 41000 && wt.prep.port <= 48999);
  const expected = [wt.path, f.repo, run.id, 'recipe', wt.prep.port].join('|');
  assert.equal(fs.readFileSync(path.join(wt.path, '.env.setup'), 'utf8'), expected);
  assert.equal(fs.readFileSync(path.join(wt.path, '.env.after'), 'utf8'), 'continued');
  assert.deepEqual(wt.prep.setup.map((r) => r.exitCode), [0, 7, 0]);
  assert.equal(wt.prep.setup[1].output, 'failure');
  assert.ok(wt.prep.setup.every((r) => r.durationMs >= 0));
  fs.unlinkSync(path.join(wt.path, '.env.setup'));
  fs.unlinkSync(path.join(wt.path, '.env.after'));
  fs.rmSync(env.AGENT_ORCH_RECIPES_DIR, { recursive: true });
  const cleaned = await f.command(['cleanup', run.id]);
  assert.match(cleaned.stdout, /teardown recipe failed \(9\)/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'teardown.local'), 'utf8'), expected);
  assert.equal(fs.existsSync(wt.path), false);
  assert.ok(fs.existsSync(path.join(f.repo, 'node_modules/pkg/index.js')));
});

test('basename fallback and no-prep escape hatch', async (t) => {
  const f = await fixture(t);
  await configuration(f, '.env\n'); put(f.repo, '.env');
  const env = recipes(f, { match: 'repo', copy: ['.env'], setup: ['exit 8'], notes: 'fallback' });
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'fallback'], { env });
  assert.equal(wt.prep.notes, 'fallback'); assert.equal(wt.prep.setup[0].exitCode, 8);
  const skipped = await f.json(['worktree', run.id, 'skip', '--no-prep'], { env });
  assert.equal(skipped.prep, undefined); assert.equal(fs.existsSync(path.join(skipped.path, '.env')), false);
});

test('default personal recipe directory is outside the repository', async (t) => {
  const f = await fixture(t);
  await configuration(f); put(f.repo, '.env');
  writeJson(path.join(f.env.HOME, '.agents/orch-recipes/default.json'), { match: f.repo, copy: ['.env'] });
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'default']);
  assert.deepEqual(wt.prep.copied, ['.env']);
});

test('cleanup keeps modified files and unrelated untracked files; teardown waits until removal', async (t) => {
  const f = await fixture(t);
  await configuration(f);
  const env = recipes(f, { match: f.repo, teardown: ['touch "$ORCH_REPO/teardown.local"'] });
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'dirty'], { env });
  closed(f, run, 'dirty');
  put(wt.path, 'untracked.txt', 'keep');
  assert.match((await f.command(['cleanup', run.id])).stdout, /skip dirty: uncommitted/);
  assert.equal(fs.existsSync(path.join(f.repo, 'teardown.local')), false);
  fs.unlinkSync(path.join(wt.path, 'untracked.txt'));
  put(wt.path, 'README.md', 'changed');
  assert.match((await f.command(['cleanup', run.id])).stdout, /skip dirty: uncommitted/);
  await f.command(['cleanup', run.id, '--force']);
  assert.equal(fs.existsSync(wt.path), true);
  assert.equal(fs.existsSync(path.join(f.repo, 'teardown.local')), false);
  await f.git(['-C', wt.path, 'restore', 'README.md']);
  await f.command(['cleanup', run.id]);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(fs.existsSync(path.join(f.repo, 'teardown.local')), true);
});

test('cleanup keeps an untracked replacement when prep exclusions have been removed', async (t) => {
  const f = await fixture(t);
  await configuration(f, '', 'vendor/\n'); put(f.repo, 'vendor/pkg/file');
  const exclude = path.join(f.repo, '.git/info/exclude');
  const originalExcludes = fs.readFileSync(exclude, 'utf8');
  const env = recipes(f, { match: f.repo, symlink: ['vendor/'] });
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'links'], { env });
  closed(f, run, 'links');
  // Prep makes the symlink ignored even though the directory-only pattern does not.
  await f.command(['cleanup', run.id]); assert.equal(fs.existsSync(wt.path), false);
  const replaced = await f.json(['worktree', run.id, 'replaced'], { env });
  closed(f, run, 'replaced');
  fs.unlinkSync(path.join(replaced.path, 'vendor'));
  put(replaced.path, 'vendor', 'user file');
  // Exercise the untracked fallback used by worktrees without prep's exclusion.
  fs.writeFileSync(exclude, originalExcludes);
  assert.match((await f.command(['cleanup', run.id])).stdout, /skip replaced/);
});

test('port is deterministic and probes past occupied ports', async (t) => {
  const port = await worktreePort('port-test', 'task');
  assert.equal(await worktreePort('port-test', 'task'), port);
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const next = await worktreePort('port-test', 'task');
  assert.ok(next >= 41000 && next <= 48999); assert.notEqual(next, port);
});

test('command timeouts and output tails are recorded without aborting', async (t) => {
  const f = await fixture(t);
  const failed = await runPrepCommand('printf abc; sleep 10', f.repo, f.env, 60);
  assert.equal(failed.timedOut, true); assert.equal(failed.exitCode, null); assert.equal(failed.signal, 'SIGKILL');
  const tail = await runPrepCommand('printf "%10000s" x; printf tail', f.repo, f.env);
  assert.equal(tail.output.length, 8192); assert.ok(tail.output.endsWith('tail'));
});

test('malformed recipe is recorded and does not abort worktree creation; existing worktrees are refused', async (t) => {
  const f = await fixture(t);
  const env = recipes(f, { match: f.repo, setup: 'not-an-array' });
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'bad'], { env });
  assert.match(wt.prep.errors.join(' '), /invalid setup/);
  const duplicate = await f.command(['worktree', run.id, 'bad'], { code: 1 });
  assert.match(duplicate.stderr, /already has a worktree/);
  const existing = await f.command(['worktree', run.id, 'other', '--path', wt.path], { code: 1 });
  assert.match(existing.stderr, /already exists/);
});

test('tracked files in source and target branches are never overwritten or linked', async (t) => {
  const f = await fixture(t);
  await configuration(f, '.env*\ncache/\nREADME.md\n');
  put(f.repo, '.env.tracked', 'tracked source'); await f.git(['add', '-f', '.env.tracked']); await f.git(['commit', '-qm', 'Tracked ignored file']);
  const run = await f.newRun();
  await f.git(['checkout', '-qb', 'target']); put(f.repo, '.env.target', 'tracked target'); await f.git(['add', '-f', '.env.target']); await f.git(['commit', '-qm', 'Target tracked ignored file']);
  await f.git(['checkout', 'main']); put(f.repo, '.env.target', 'ignored source');
  const env = recipes(f, { match: f.repo, symlink: ['README.md', '.env.tracked'] });
  const wt = await f.json(['worktree', run.id, 'protected', '--from', 'target'], { env });
  assert.equal(fs.readFileSync(path.join(wt.path, '.env.target'), 'utf8'), 'tracked target');
  assert.ok(!wt.prep.copied.includes('.env.tracked')); assert.deepEqual(wt.prep.symlinked, []);
  assert.match(wt.prep.errors.join(' '), /kept existing path: .env.target/);
});

test('bad JSON is reported while a valid recipe and include patterns still prepare the tree', async (t) => {
  const f = await fixture(t);
  await configuration(f, '.env\n'); put(f.repo, '.env');
  const env = recipes(f, { match: f.repo, notes: 'valid' }, 'valid.json');
  put(env.AGENT_ORCH_RECIPES_DIR, 'bad.json', '{broken');
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'json'], { env });
  assert.equal(wt.prep.notes, 'valid'); assert.deepEqual(wt.prep.copied, ['.env']);
  assert.match(wt.prep.errors.join(' '), /bad.json/);
});

test('copy preserves source symlinks and refuses to traverse target branch symlinks', async (t) => {
  const f = await fixture(t);
  await configuration(f, 'cache/\n.env.link\n');
  put(f.root, 'external/keep', 'external');
  fs.symlinkSync(path.join(f.root, 'external/keep'), path.join(f.repo, '.env.link'));
  const run = await f.newRun();
  await f.git(['checkout', '-qb', 'symlink-target']);
  fs.symlinkSync(path.join(f.root, 'external'), path.join(f.repo, 'cache'));
  await f.git(['add', '-f', 'cache']); await f.git(['commit', '-qm', 'Tracked symlink']);
  await f.git(['checkout', 'main']); put(f.repo, 'cache/keep', 'ignored');
  const wt = await f.json(['worktree', run.id, 'safe', '--from', 'symlink-target']);
  assert.equal(fs.readlinkSync(path.join(wt.path, '.env.link')), path.join(f.root, 'external/keep'));
  assert.equal(fs.readFileSync(path.join(f.root, 'external/keep'), 'utf8'), 'external');
  assert.match(wt.prep.errors.join(' '), /kept existing path: cache\/keep/);
});

test('macOS clone-copy failure falls back to a normal copy', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t);
  await configuration(f, '.env\n'); put(f.repo, '.env', 'fallback content');
  const bin = path.join(f.root, 'bin');
  put(bin, 'cp', '#!/bin/bash\nprintf "%s" "$1" > "$HOME/clone-attempt"\nexit 1\n');
  fs.chmodSync(path.join(bin, 'cp'), 0o755);
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'clone'], { env: { PATH: bin + path.delimiter + f.env.PATH } });
  assert.equal(fs.readFileSync(path.join(f.env.HOME, 'clone-attempt'), 'utf8'), '-c');
  assert.equal(fs.readFileSync(path.join(wt.path, '.env'), 'utf8'), 'fallback content');
});

test('cleanup removes gate caches and ignored build output without force', async (t) => {
  const f = await fixture(t);
  await configuration(f, '', 'build/\n.venv/\n');
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'gates']);
  closed(f, run, 'gates');
  for (const name of ['__pycache__/x.pyc', '.pytest_cache/results', 'node_modules/pkg/file', 'build/output.js', '.venv/bin/python']) put(wt.path, name);
  const result = await f.command(['cleanup', run.id]);
  assert.match(result.stdout, /removed worktree/);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(readJson(f.taskFile(run, 'gates')).worktree, undefined);
});

test('exported createWorktree saves and returns the task with the same preparation and options', async (t) => {
  const f = await fixture(t);
  await configuration(f, '.env\n'); put(f.repo, '.env', 'prepared');
  const run = await f.newRun();
  const moduleUrl = new URL('../scripts/lib/commands/run.mjs', import.meta.url).href;
  const create = async (id, options) => {
    const script = `import { createWorktree } from ${JSON.stringify(moduleUrl)};
      const task = await createWorktree(JSON.parse(process.argv[1]), process.argv[2], JSON.parse(process.argv[3]));
      process.stdout.write(JSON.stringify(task));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(run), id, JSON.stringify(options)], { cwd: f.repo, env: f.env });
    return JSON.parse(stdout);
  };
  const task = await create('api', { from: run.baseCommit, branch: 'custom-prep', path: path.join(f.root, 'custom-worktree') });
  assert.equal(task.worktree.branch, 'custom-prep');
  assert.equal(task.worktree.from, run.baseCommit);
  assert.equal(task.cd, path.join(f.root, 'custom-worktree'));
  assert.deepEqual(task.worktree.prep.copied, ['.env']);
  assert.equal(fs.readFileSync(path.join(task.cd, '.env'), 'utf8'), 'prepared');
  assert.deepEqual(task, readJson(f.taskFile(run, 'api')));
  const skipped = await create('raw', { prep: false });
  assert.equal(skipped.worktree.prep, undefined);
  assert.equal(skipped.worktree.branch, `orch/${run.id}/raw`);
  assert.equal(fs.existsSync(path.join(skipped.cd, '.env')), false);
});

test('prep never walks unmatched ignored folders and skips git entirely without patterns', async (t) => {
  const f = await fixture(t);
  await configuration(f, '.env\n', '.env\nlarge-cache/\n');
  put(f.repo, '.env', 'selected');
  for (let index = 0; index < 500; index++) put(f.repo, `large-cache/dir-${index}/file`, 'unselected');
  const moduleUrl = new URL('../scripts/lib/worktree-prep.mjs', import.meta.url).href;
  const destination = path.join(f.root, 'prep-target');
  fs.mkdirSync(destination);
  const run = { repo: f.repo, id: 'performance' };
  const task = { id: 'filtered', worktree: { path: destination } };
  const script = `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const run = JSON.parse(process.argv[1]);
    const task = JSON.parse(process.argv[2]);
    const unmatched = run.repo + '/large-cache';
    for (const key of ['readdirSync', 'lstatSync', 'statSync']) {
      const original = fs[key];
      fs[key] = function(file, ...args) {
        if (String(file).startsWith(unmatched)) throw new Error('walked unmatched ignored folder');
        return original.call(this, file, ...args);
      };
    }
    if (process.argv[3] === 'no-patterns') {
      const original = childProcess.spawnSync;
      childProcess.spawnSync = function(bin, ...args) {
        if (bin === 'git') throw new Error('git called without patterns');
        return original.call(this, bin, ...args);
      };
      syncBuiltinESMExports();
    }
    const { prepareWorktree } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(JSON.stringify(await prepareWorktree(run, task)));
  `;
  const call = async (mode) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(run), JSON.stringify(task), mode], {
      cwd: f.repo, env: { ...f.env, AGENT_ORCH_RECIPES_DIR: path.join(f.root, 'absent-recipes') },
    });
    return JSON.parse(stdout);
  };
  const filtered = await call('filtered');
  assert.deepEqual(filtered.errors, []);
  assert.deepEqual(filtered.copied, ['.env']);
  assert.equal(fs.readFileSync(path.join(destination, '.env'), 'utf8'), 'selected');
  fs.unlinkSync(path.join(f.repo, '.worktreeinclude'));
  const empty = await call('no-patterns');
  assert.deepEqual(empty.errors, []);
  assert.deepEqual(empty.copied, []);
  assert.deepEqual(empty.symlinked, []);
});

// Review regressions exercise real git worktrees and the CLI's setup lifetime.
test('regression: prep symlinks stay ignored through staging, commit and merge', async (t) => {
  const f = await fixture(t);
  await configuration(f, '', '.venv/\nnode_modules/\n');
  for (const name of ['.venv', 'node_modules']) put(f.repo, `${name}/keep`, 'must survive');
  const env = recipes(f, { match: f.repo, symlink: ['.venv/', 'node_modules/'] });
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'merge-safe'], { env });
  assert.deepEqual(wt.prep.errors, []);
  assert.equal(await f.git(['-C', wt.path, 'status', '--porcelain']), '');
  await f.git(['-C', wt.path, 'add', '-A']);
  assert.equal(await f.git(['-C', wt.path, 'diff', '--cached', '--name-only']), '');
  put(wt.path, 'feature.txt', 'feature');
  await f.git(['-C', wt.path, 'add', '-A']);
  assert.equal(await f.git(['-C', wt.path, 'diff', '--cached', '--name-only']), 'feature.txt');
  await f.git(['-C', wt.path, 'commit', '-qm', 'Feature without prep artifacts']);
  await f.git(['merge', '--ff-only', wt.branch]);
  for (const name of ['.venv', 'node_modules']) {
    assert.equal(fs.lstatSync(path.join(f.repo, name)).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(f.repo, name, 'keep'), 'utf8'), 'must survive');
  }
  const common = await f.git(['-C', wt.path, 'rev-parse', '--git-common-dir']);
  assert.match(fs.readFileSync(path.resolve(wt.path, common, 'info/exclude'), 'utf8'), /# orch prep/);
});

test('regression: a prep link is removed if worktree ignore rules override the local exclusion', async (t) => {
  const f = await fixture(t);
  await configuration(f, '', 'vendor/\n');
  put(f.repo, 'vendor/keep');
  const run = await f.newRun();
  await f.git(['checkout', '-qb', 'unignored-target']);
  put(f.repo, '.gitignore', '!vendor\n');
  await f.git(['add', '.gitignore']); await f.git(['commit', '-qm', 'Unignore on target']);
  await f.git(['checkout', 'main']);
  const env = recipes(f, { match: f.repo, symlink: ['vendor/'] });
  const wt = await f.json(['worktree', run.id, 'refused-link', '--from', 'unignored-target'], { env });
  assert.deepEqual(wt.prep.symlinked, []);
  assert.equal(fs.existsSync(path.join(wt.path, 'vendor')), false);
  assert.match(wt.prep.errors.join(' '), /ignor/i);
  assert.equal(fs.readFileSync(path.join(f.repo, 'vendor/keep'), 'utf8'), 'vendor/keep');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`regression: ${signal} during setup saves prep and stops its process group`, async (t) => {
    const f = await fixture(t);
    await configuration(f, '.env\n', '.env\nvendor/\n'); put(f.repo, '.env'); put(f.repo, 'vendor/keep');
    const setupScript = path.join(f.root, 'setup-running.mjs');
    put(f.root, 'setup-running.mjs', `import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const ready = process.env.ORCH_WORKTREE + '/setup-ready.json';
      fs.writeFileSync(ready + '.tmp', JSON.stringify({ pid: process.pid, child: child.pid }));
      fs.renameSync(ready + '.tmp', ready);
      setInterval(() => {}, 1000);`);
    const env = recipes(f, { match: f.repo, symlink: ['vendor/'], port: true,
      setup: ['printf first-complete', 'exec "$TEST_NODE" "$TEST_SETUP"', 'touch should-not-run'], teardown: ['echo teardown'] });
    const run = await f.newRun();
    const wt = path.join(run.dir, 'worktrees', 'interrupted');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url)), 'worktree', run.id, 'interrupted'], {
      cwd: f.repo, env: { ...f.env, ...env, TEST_NODE: process.execPath, TEST_SETUP: setupScript }, stdio: 'ignore',
    });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    let pids;
    try {
      await eventually(() => fs.existsSync(path.join(wt, 'setup-ready.json')), 'setup did not start');
      pids = readJson(path.join(wt, 'setup-ready.json'));
      const during = readJson(f.taskFile(run, 'interrupted')).worktree.prep;
      child.kill(signal);
      await eventually(() => child.exitCode !== null || child.signalCode !== null, 'CLI did not exit after interruption', 3000);
      await exited;
      assert.ok(during, 'prep must be saved before setup finishes');
      assert.deepEqual(during.copied, ['.env']);
      assert.deepEqual(during.symlinked, ['vendor']);
      assert.deepEqual(during.teardown, ['echo teardown']);
      assert.ok(during.port >= 41000 && during.port <= 48999);
      assert.equal(during.setup[0].exitCode, 0);
      const prep = readJson(f.taskFile(run, 'interrupted')).worktree.prep;
      assert.equal(prep.interrupted, signal);
      assert.equal(prep.setup.length, 2);
      assert.equal(prep.setup[1].interrupted, signal);
      assert.equal(child.exitCode, signal === 'SIGINT' ? 130 : 143);
      assert.equal(fs.existsSync(path.join(wt, 'should-not-run')), false);
      await eventually(() => Object.values(pids).every((pid) => {
        try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
      }), 'setup or its child survived the CLI interruption');
    } finally {
      // Exact processes created by this fixture; confirm identity before fallback cleanup.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (const pid of Object.values(pids || {})) {
        try {
          const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']);
          if (stdout.includes(setupScript) || stdout.includes('setInterval(() => {}, 1000)')) process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await exited;
    }
  });
}

test('regression: timeout does not wait for an escaped child holding stdout open', async (t) => {
  const f = await fixture(t);
  const escaped = path.join(f.root, 'escaped-child.mjs');
  put(f.root, 'escaped-child.mjs', 'setTimeout(() => {}, 3000);');
  put(f.root, 'spawn-escaped.mjs', `import { spawn } from 'node:child_process'; import fs from 'node:fs';
    const child = spawn(process.execPath, [process.env.ESCAPED], { detached: true, stdio: 'inherit' });
    fs.writeFileSync(process.env.PID_FILE, String(child.pid)); child.unref();`);
  const pidFile = path.join(f.root, 'escaped.pid');
  // Exercise the real CLI without waiting ten minutes for its production timeout.
  put(f.root, 'short-timeout.cjs', `const original = global.setTimeout;
    global.setTimeout = (callback, ms, ...args) => original(callback, ms === 600000 ? 300 : ms, ...args);`);
  const env = recipes(f, { match: f.repo, setup: ['"$TEST_NODE" "$TEST_SPAWNER"'] });
  const run = await f.newRun();
  let result;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--require', path.join(f.root, 'short-timeout.cjs'),
      fileURLToPath(new URL('../scripts/orch.mjs', import.meta.url)), 'worktree', run.id, 'escaped-pipe', '--json'], {
      cwd: f.repo, env: { ...f.env, ...env, TEST_NODE: process.execPath,
        TEST_SPAWNER: path.join(f.root, 'spawn-escaped.mjs'), ESCAPED: escaped, PID_FILE: pidFile }, timeout: 8000,
    });
    result = JSON.parse(stdout).prep.setup[0];
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try {
        const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']);
        if (stdout.includes(escaped)) process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 1500, `timeout took ${result.durationMs}ms despite a 300ms limit`);
});

test('regression: port selection skips an IPv4 loopback listener', async (t) => {
  const f = await fixture(t);
  const env = recipes(f, { match: f.repo, port: true });
  const run = await f.newRun();
  const first = await f.json(['worktree', run.id, 'loopback'], { env });
  closed(f, run, 'loopback');
  const port = first.prep.port;
  await f.command(['cleanup', run.id]);
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const next = await f.json(['worktree', run.id, 'loopback', '--branch', 'next-port'], { env });
  assert.notEqual(next.prep.port, port);
});

test('regression: copied relative symlinks resolve inside and outside the repository', async (t) => {
  const f = await fixture(t);
  await configuration(f, '.env*\n');
  put(f.root, 'shared/dev.env', 'shared config'); put(f.repo, '.env.data', 'local config');
  fs.symlinkSync('../shared/dev.env', path.join(f.repo, '.env.external'));
  fs.symlinkSync('.env.data', path.join(f.repo, '.env.internal'));
  const run = await f.newRun();
  const wt = await f.json(['worktree', run.id, 'relative-links']);
  assert.equal(fs.readlinkSync(path.join(wt.path, '.env.external')), path.join(f.root, 'shared/dev.env'));
  assert.equal(fs.readFileSync(path.join(wt.path, '.env.external'), 'utf8'), 'shared config');
  assert.equal(fs.readlinkSync(path.join(wt.path, '.env.internal')), '.env.data');
  assert.equal(fs.readFileSync(path.join(wt.path, '.env.internal'), 'utf8'), 'local config');
});
