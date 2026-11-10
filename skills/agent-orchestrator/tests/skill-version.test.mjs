import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { diffFiles, headCommit, scan } from '../scripts/lib/skill-version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const NOTICE = 'the skill changed since this session loaded it';

// A private copy of the skill (its CLI and instruction files), so a test can edit SKILL.md without
// touching the real one. The copy's CLI sees the copy as its skill folder.
function skillCopy(f, name = 'skill') {
  const dir = path.join(f.root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(root, 'references'), path.join(dir, 'references'), { recursive: true });
  for (const file of ['SKILL.md', 'policy.json']) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  const cli = path.join(dir, 'scripts', 'orch.mjs');
  const copy = {
    dir, cli,
    // Runs the copy's CLI with the fixture's environment, the notice switched on as a test asks for
    // it, and `env` on top (a session or task identity); a value of undefined removes a variable.
    run(args, env = {}) {
      const merged = { ...f.env, AGENT_ORCH_SKILL_NOTICE: '1', ...env };
      for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
      const r = spawnSync(process.execPath, [cli, ...args], { cwd: f.repo, env: merged, encoding: 'utf8', timeout: 15_000 });
      assert.equal(r.status, 0, `node orch.mjs ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
      return r;
    },
    edit(rel, text = `\nEdited at ${Math.random()}.\n`) { fs.appendFileSync(path.join(dir, rel), text); },
    git(...args) {
      const r = spawnSync('git', ['-C', dir, ...args], { env: f.env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    },
    records() {
      const records = path.join(f.state, 'skill-seen');
      return fs.existsSync(records) ? fs.readdirSync(records).map((name) => path.join(records, name)) : [];
    },
  };
  return copy;
}

const SESSION = { CLAUDE_CODE_SESSION_ID: 'session-one' };
const task = (id) => ({ AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: 'run-a', AGENT_ORCH_TASK: id });

test('the first command records the fingerprint, and an unchanged skill gets no notice', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  assert.equal(skill.records().length, 0);
  const first = skill.run(['runs'], SESSION);
  assert.equal(first.stderr, '');
  assert.equal(skill.records().length, 1);
  const record = JSON.parse(fs.readFileSync(skill.records()[0], 'utf8'));
  assert.equal(record.key, 'claude:session-one');
  assert.match(record.fingerprint, /^[0-9a-f]{64}$/);
  for (const rel of ['SKILL.md', 'policy.json', 'references/agents.md', 'references/briefs/implement.md']) assert.ok(record.files[rel], `${rel} is fingerprinted`);
  assert.equal(skill.run(['runs'], SESSION).stderr, '');
  const shown = JSON.parse(skill.run(['skill', '--json'], SESSION).stdout);
  assert.equal(shown.changed, false);
  assert.equal(shown.recorded.fingerprint, record.fingerprint);
  assert.equal(shown.current.fingerprint, record.fingerprint);
});

test('a changed file gives a notice on stderr at every command until skill --loaded', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  skill.run(['runs'], SESSION);
  const before = JSON.parse(skill.run(['skill', '--json'], SESSION).stdout).recorded.fingerprint;

  skill.edit('SKILL.md');
  fs.writeFileSync(path.join(skill.dir, 'references', 'new-note.md'), 'A new note.\n');
  fs.rmSync(path.join(skill.dir, 'references', 'babysit-brief.md'));
  for (let i = 0; i < 3; i++) {
    const r = skill.run(['runs', '--json'], SESSION);
    assert.deepEqual(JSON.parse(r.stdout), [], 'stdout holds only the command output, as valid JSON');
    assert.ok(r.stderr.startsWith(`orch: ${NOTICE}.`), r.stderr);
    assert.match(r.stderr, /changed SKILL\.md/);
    assert.match(r.stderr, /added references\/new-note\.md/);
    assert.match(r.stderr, /removed references\/babysit-brief\.md/);
    assert.ok(r.stderr.includes(path.join(skill.dir, 'SKILL.md')), 'it names the file to read again');
    assert.ok(r.stderr.includes(`${skill.cli} skill --loaded`), 'it names the command that ends it');
    assert.doesNotMatch(r.stderr, /Commits since/, 'no commits outside a git checkout');
  }

  // `skill` reports the same change itself, once, on stdout.
  const shown = skill.run(['skill', '--json'], SESSION);
  assert.equal(shown.stderr, '');
  const state = JSON.parse(shown.stdout);
  assert.equal(state.changed, true);
  assert.equal(state.recorded.fingerprint, before);
  assert.notEqual(state.current.fingerprint, before);
  assert.deepEqual(state.files, { changed: ['SKILL.md'], added: ['references/new-note.md'], removed: ['references/babysit-brief.md'] });
  assert.match(skill.run(['skill'], SESSION).stdout, /changed: yes/);

  const loaded = JSON.parse(skill.run(['skill', '--loaded', '--json'], SESSION).stdout);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.recorded.fingerprint, state.current.fingerprint);
  assert.equal(loaded.changed, false);
  assert.equal(skill.run(['runs'], SESSION).stderr, '');
  assert.equal(JSON.parse(skill.run(['skill', '--json'], SESSION).stdout).changed, false);

  // A later change is noticed again.
  skill.edit('policy.json', '\n');
  assert.match(skill.run(['runs'], SESSION).stderr, /changed policy\.json/);
});

test('the notice comes before the command\'s own output', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  skill.run(['runs'], SESSION);
  skill.edit('SKILL.md');
  // One stream, so the order of the writes shows.
  const r = spawnSync('/bin/sh', ['-c', 'exec "$0" "$@" 2>&1', process.execPath, skill.cli, 'runs'], {
    cwd: f.repo, env: { ...f.env, AGENT_ORCH_SKILL_NOTICE: '1', ...SESSION }, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith(`orch: ${NOTICE}.`), r.stdout);
  assert.ok(r.stdout.trimEnd().endsWith('no runs in ' + path.join(f.state, 'runs')), r.stdout);
});

test('a touched file with the same content is no change', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  skill.run(['runs'], SESSION);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(skill.dir, 'SKILL.md'), later, later);
  assert.equal(skill.run(['runs'], SESSION).stderr, '');
  assert.equal(JSON.parse(skill.run(['skill', '--json'], SESSION).stdout).changed, false);
});

test('the notice lists the commits since, newest first and at most 5', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  skill.git('init', '-q');
  skill.git('add', '-A');
  skill.git('commit', '-q', '-m', 'Initial skill');
  skill.run(['runs'], SESSION);
  const loadedAt = skill.git('rev-parse', 'HEAD');
  assert.equal(JSON.parse(fs.readFileSync(skill.records()[0], 'utf8')).commit, loadedAt);

  // One commit that touches no instruction file, then six that do.
  fs.writeFileSync(path.join(skill.dir, 'scripts', 'unrelated.txt'), 'x\n');
  skill.git('add', '-A');
  skill.git('commit', '-q', '-m', 'Change a script only');
  for (let i = 1; i <= 6; i++) {
    skill.edit('SKILL.md', `\nRound ${i}.\n`);
    skill.git('commit', '-q', '-am', `Skill round ${i}`);
  }
  const r = skill.run(['runs'], SESSION);
  const subjects = [...r.stderr.matchAll(/^ {4}- (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(subjects, ['Skill round 6', 'Skill round 5', 'Skill round 4', 'Skill round 3', 'Skill round 2', '(and older ones)']);
  assert.doesNotMatch(r.stderr, /Change a script only|Initial skill/);

  // Two commits since the next acknowledgment: no "older" line.
  skill.run(['skill', '--loaded'], SESSION);
  for (let i = 7; i <= 8; i++) {
    skill.edit('SKILL.md', `\nRound ${i}.\n`);
    skill.git('commit', '-q', '-am', `Skill round ${i}`);
  }
  const two = skill.run(['runs'], SESSION);
  assert.deepEqual([...two.stderr.matchAll(/^ {4}- (.*)$/gm)].map((m) => m[1]), ['Skill round 8', 'Skill round 7']);
});

test('a delegated task and a main session are separate callers', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  const callers = { session: SESSION, other: { CLAUDE_CODE_SESSION_ID: 'session-two' }, codex: { CODEX_THREAD_ID: 'thread-one' }, one: task('one'), two: task('two') };
  for (const env of Object.values(callers)) assert.equal(skill.run(['runs'], env).stderr, '');
  assert.equal(skill.records().length, 5, 'each caller has its own record');

  skill.edit('SKILL.md');
  for (const [name, env] of Object.entries(callers)) assert.match(skill.run(['runs'], env).stderr, new RegExp(NOTICE), `${name} is told`);

  // The main session acknowledges; the others still get the notice.
  skill.run(['skill', '--loaded'], SESSION);
  assert.equal(skill.run(['runs'], SESSION).stderr, '');
  for (const name of ['other', 'codex', 'one', 'two']) assert.match(skill.run(['runs'], callers[name]).stderr, new RegExp(NOTICE), `${name} is still told`);

  // Task one acknowledges; task two and the main session's other sessions are unaffected by it.
  skill.run(['skill', '--loaded'], callers.one);
  assert.equal(skill.run(['runs'], callers.one).stderr, '');
  assert.match(skill.run(['runs'], callers.two).stderr, new RegExp(NOTICE));
  assert.match(skill.run(['runs'], callers.other).stderr, new RegExp(NOTICE));

  // A task and a session are named by their own identity, not by the session variable a task inherits.
  const inherited = { ...task('two'), CLAUDE_CODE_SESSION_ID: 'session-one' };
  assert.match(skill.run(['runs'], inherited).stderr, new RegExp(NOTICE), 'the task inside a Claude session is the task, not the session');
  assert.equal(JSON.parse(skill.run(['skill', '--json'], inherited).stdout).caller.key, 'task:run-a/two');
});

test('a caller with no identity gets no notice and records nothing', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  assert.equal(skill.run(['runs']).stderr, '');
  skill.edit('SKILL.md');
  assert.equal(skill.run(['runs']).stderr, '');
  assert.equal(skill.run(['runs', '--json']).stderr, '');
  assert.deepEqual(skill.records(), []);
  // A task variable without its run is no identity either.
  assert.equal(skill.run(['runs'], { AGENT_ORCH_DEPTH: '1', AGENT_ORCH_TASK: 'one' }).stderr, '');
  assert.deepEqual(skill.records(), []);

  const shown = JSON.parse(skill.run(['skill', '--json']).stdout);
  assert.equal(shown.caller, null);
  assert.equal(shown.recorded, null);
  assert.equal(shown.changed, null);
  assert.match(shown.current.fingerprint, /^[0-9a-f]{64}$/);
  const loaded = skill.run(['skill', '--loaded']);
  assert.match(loaded.stdout, /nothing was recorded/);
  assert.deepEqual(skill.records(), []);
});

test('the fixtures stay quiet unless a test asks for the notice', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  const quiet = { ...SESSION, AGENT_ORCH_SKILL_NOTICE: undefined }; // the fixture pins AGENT_ORCH_SKILLS_DIR
  skill.run(['runs'], quiet);
  skill.edit('SKILL.md');
  assert.equal(skill.run(['runs'], quiet).stderr, '');
  assert.deepEqual(skill.records(), [], 'nothing is recorded either');
  // The switch turns it off where it would be on, and on where it would be off.
  assert.equal(skill.run(['runs'], { ...SESSION, AGENT_ORCH_SKILL_NOTICE: '0', AGENT_ORCH_SKILLS_DIR: undefined }).stderr, '');
  assert.deepEqual(skill.records(), []);
  // Without a pinned skills folder, as in the user's own setup, it is on by default.
  const live = { ...SESSION, AGENT_ORCH_SKILL_NOTICE: undefined, AGENT_ORCH_SKILLS_DIR: undefined };
  skill.run(['runs'], live);
  assert.equal(skill.records().length, 1);
  skill.edit('SKILL.md');
  assert.match(skill.run(['runs'], live).stderr, new RegExp(NOTICE));
  // The explicit command works whichever way the switch is set.
  assert.equal(JSON.parse(skill.run(['skill', '--loaded', '--json'], quiet).stdout).loaded, true);
});

test('a caller is told only about the skill folder it runs', async (t) => {
  const f = await fixture(t);
  const live = skillCopy(f, 'live');
  const worktree = skillCopy(f, 'worktree');
  live.run(['runs'], SESSION);
  worktree.run(['runs'], SESSION);
  worktree.edit('SKILL.md');
  // The live copy never changed, so the session that also runs the edited copy is not told about it.
  assert.equal(live.run(['runs'], SESSION).stderr, '');
  assert.match(worktree.run(['runs'], SESSION).stderr, new RegExp(NOTICE));
  assert.equal(live.records().length, 2);
});

test('records older than 30 days are removed, and a caller in use keeps its own', async (t) => {
  const f = await fixture(t);
  const skill = skillCopy(f);
  const age = (file, days) => {
    const when = new Date(Date.now() - days * 24 * 3600 * 1000);
    fs.utimesSync(file, when, when);
  };
  const [oldFile, recentFile, activeFile] = ['old', 'recent', 'active'].map((name) => {
    skill.run(['runs'], { CLAUDE_CODE_SESSION_ID: name });
    return skill.records().find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).key === `claude:${name}`);
  });
  age(oldFile, 31);
  age(recentFile, 29);
  age(activeFile, 40);
  // The active caller runs a command: its record is used, so it is renewed, not pruned.
  skill.run(['runs'], { CLAUDE_CODE_SESSION_ID: 'active' });
  assert.ok(Date.now() - fs.statSync(activeFile).mtimeMs < 60_000, 'a record in use is touched');
  // A new caller's record is written: the stale ones go.
  skill.run(['runs'], { CLAUDE_CODE_SESSION_ID: 'new' });
  assert.ok(!fs.existsSync(oldFile), 'a record unused for 31 days is removed');
  assert.ok(fs.existsSync(recentFile), 'a record unused for 29 days stays');
  assert.ok(fs.existsSync(activeFile));
  assert.equal(skill.records().length, 3);
});

test('the fingerprint reads a file only when its size or modification time changed', async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.root, 'unit');
  fs.mkdirSync(path.join(dir, 'references', 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'));
  const write = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
  write('SKILL.md', 'skill\n');
  write('policy.json', '{}\n');
  write('references/a.md', 'a\n');
  write('references/briefs/b.md', 'b\n');
  write('references/.DS_Store', 'junk');
  write('scripts/x.mjs', 'not an instruction file\n');

  const first = scan(dir);
  assert.deepEqual(Object.keys(first.files), ['SKILL.md', 'policy.json', 'references/a.md', 'references/briefs/b.md']);
  assert.equal(first.hashed, 4);

  const again = scan(dir, first.files);
  assert.equal(again.hashed, 0, 'unchanged files are not read');
  assert.equal(again.fingerprint, first.fingerprint);

  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'references/a.md'), later, later);
  const touched = scan(dir, first.files);
  assert.equal(touched.hashed, 1, 'only the file whose time changed is read');
  assert.equal(touched.fingerprint, first.fingerprint, 'and the same content gives the same fingerprint');

  write('references/briefs/b.md', 'b changed\n');
  const edited = scan(dir, touched.files);
  assert.equal(edited.hashed, 1);
  assert.notEqual(edited.fingerprint, first.fingerprint);
  assert.deepEqual(diffFiles(first.files, edited.files), { changed: ['references/briefs/b.md'], added: [], removed: [] });

  write('references/c.md', 'c\n');
  fs.rmSync(path.join(dir, 'policy.json'));
  const moved = scan(dir, edited.files);
  assert.deepEqual(diffFiles(edited.files, moved.files), { changed: [], added: ['references/c.md'], removed: ['policy.json'] });
  assert.notEqual(moved.fingerprint, edited.fingerprint);
});

test('the commit a checkout is at is read without git, and agrees with git', async (t) => {
  const f = await fixture(t);
  const plain = path.join(f.root, 'plain');
  fs.mkdirSync(plain);
  assert.equal(headCommit(plain), null, 'no checkout, no commit');

  const repo = path.join(f.root, 'checkout');
  fs.mkdirSync(path.join(repo, 'skills', 'one'), { recursive: true });
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'skills', 'one', 'SKILL.md'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'First');
  const sub = path.join(repo, 'skills', 'one');
  assert.equal(headCommit(sub), git(repo, 'rev-parse', 'HEAD'), 'a branch, loose');
  git(repo, 'pack-refs', '--all');
  assert.equal(headCommit(sub), git(repo, 'rev-parse', 'HEAD'), 'a branch, packed');
  const linked = path.join(f.root, 'linked');
  git(repo, 'worktree', 'add', '-q', '-b', 'other', linked);
  fs.writeFileSync(path.join(linked, 'skills', 'one', 'SKILL.md'), 'two\n');
  git(linked, 'commit', '-q', '-am', 'Second');
  assert.equal(headCommit(path.join(linked, 'skills', 'one')), git(linked, 'rev-parse', 'HEAD'), 'a linked worktree');
  assert.notEqual(headCommit(path.join(linked, 'skills', 'one')), headCommit(sub));
  git(repo, 'checkout', '-q', '--detach');
  assert.equal(headCommit(sub), git(repo, 'rev-parse', 'HEAD'), 'a detached HEAD');
});
