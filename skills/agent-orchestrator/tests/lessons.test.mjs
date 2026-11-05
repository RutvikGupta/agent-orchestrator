import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJson } from './helpers.mjs';

const lessonsFile = (f, key = 'repo') => path.join(f.env.HOME, '.agents', 'orch-recipes', 'lessons', `${key}.md`);

test('lesson adds with evidence, refuses duplicates, and lists physical line numbers', async (t) => {
  const f = await fixture(t);
  const missing = await f.command(['lesson', '--repo', f.repo, 'Use the fixture'], { code: 2 });
  assert.match(missing.stderr, /--evidence is required/);
  assert.equal(fs.existsSync(lessonsFile(f)), false);
  const args = ['lesson', '--repo', f.repo, 'Use the fixture', '--evidence', 'node --test failed without it'];
  const added = await f.json(args, { env: { AGENT_ORCH_RUN: 'source-run', AGENT_ORCH_TASK: 'source-task' } });
  assert.equal(added.added, true);
  assert.equal(added.file, lessonsFile(f));
  assert.match(fs.readFileSync(added.file, 'utf8'), /^- Use the fixture \(evidence: node --test failed without it; \d{4}-\d{2}-\d{2}, source-run\/source-task\)\n$/);
  assert.equal((await f.json(args)).added, false);
  fs.writeFileSync(added.file, '# Hand edited\n\n' + fs.readFileSync(added.file, 'utf8') + '- A manual lesson\n');
  const listed = await f.command(['lesson', '--repo', f.repo, '--list']);
  assert.match(listed.stdout, /^3: - Use the fixture/m);
  assert.match(listed.stdout, /^4: - A manual lesson/m);
  assert.equal((await f.json(args)).added, false);
  await f.command(['lesson', '--repo', f.repo, 'Multi\nline', '--evidence', 'test'], { code: 2 });
  await f.command(['lesson', '--repo', f.repo, 'Text', '--evidence', 'Multi\nline'], { code: 2 });
});

test('lesson RUN form uses the run repository and custom recipes folder', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const dir = path.join(f.root, 'personal-recipes');
  const env = { AGENT_ORCH_RECIPES_DIR: dir };
  const added = await f.json(['lesson', run.id, 'Run lesson', '--evidence', 'review finding'], { env });
  assert.equal(added.file, path.join(dir, 'lessons', 'repo.md'));
  assert.equal((await f.json(['lesson', run.id, '--list'], { env })).lessons[0].text, 'Run lesson');
});

test('lesson key selects absolute recipe before folder recipe, then folder fallback', async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.root, 'recipes');
  const env = { AGENT_ORCH_RECIPES_DIR: dir };
  writeJson(path.join(dir, 'a-folder.json'), { match: 'repo' });
  writeJson(path.join(dir, 'z-absolute.json'), { match: f.repo });
  const add = () => f.json(['lesson', '--repo', f.repo, 'Trap', '--evidence', 'review'], { env });
  assert.equal((await add()).file, path.join(dir, 'lessons', 'z-absolute.md'));
  fs.unlinkSync(path.join(dir, 'z-absolute.json'));
  assert.equal((await add()).file, path.join(dir, 'lessons', 'a-folder.md'));
  fs.unlinkSync(path.join(dir, 'a-folder.json'));
  assert.equal((await add()).file, path.join(dir, 'lessons', 'repo.md'));
});

test('briefs include all lesson texts without evidence and omit empty lessons', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const dir = path.join(f.root, 'recipes');
  const env = { AGENT_ORCH_RECIPES_DIR: dir };
  writeJson(path.join(dir, 'project.json'), { match: f.repo });
  const brief = async (type, suffix = '') => {
    const result = await f.json(['brief', run.id, `${type}${suffix}`, '--type', type], { env });
    return fs.readFileSync(result.path, 'utf8');
  };
  assert.doesNotMatch(await brief('implement', '-empty'), /Known traps/);
  await f.command(['lesson', run.id, 'Use handshakes', '--evidence', 'test failed'], { env });
  fs.appendFileSync(path.join(dir, 'lessons', 'project.md'), '- Keep manual edits $&\n');
  for (const type of ['implement', 'debug', 'review', 'research', 'babysit']) {
    const text = await brief(type);
    assert.match(text, /## Known traps in this repository\n\n- Use handshakes\n- Keep manual edits \$&/);
    assert.doesNotMatch(text, /evidence: test failed/);
    assert.match(text, /describe it under `unresolved` in your report/);
    if (text.includes('## Gates')) assert.ok(text.indexOf('Known traps') < text.indexOf('## Gates'));
  }
});

test('lesson adds above thirty and warns to prune', async (t) => {
  const f = await fixture(t);
  const file = lessonsFile(f);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Array.from({ length: 29 }, (_, i) => `- Trap ${i} (evidence: review; 2026-01-01)\n`).join(''));
  const add = (text) => f.command(['lesson', '--repo', f.repo, text, '--evidence', 'verified']);
  assert.doesNotMatch((await add('Thirty')).stderr, /prune/);
  assert.match((await add('Thirty one')).stderr, /31 lessons; prune the file/);
  assert.equal((await f.json(['lesson', '--repo', f.repo, '--list'])).lessons.length, 31);
});
