import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson } from './helpers.mjs';
import { normalizeCommand } from '../scripts/lib/report.mjs';

const report = (checks) => `Done.\n\n\`\`\`orch-result\n${JSON.stringify({ outcome: 'done', changed: [], checks, decisions: [], unresolved: [] })}\n\`\`\``;
const variants = [
  ['node --test tests/check.mjs', 'env FOO="some value" node --test tests/check.mjs'],
  ['node --test tests/check.mjs', 'env -u ONE --unset TWO --unset=THREE node --test tests/check.mjs'],
  ['node --test tests/check.mjs', 'cd "some directory" && env -u ONE node --test tests/check.mjs'],
  ['node --test tests/check.mjs', 'node --test "tests/check.mjs"'],
  ['node --test tests/check.mjs', "node --test tests/check.mjs | grep 'pass'"],
  ['node --test tests/check.mjs', 'node --test tests/check.mjs | tail -10'],
  ['node --test tests/check.mjs', 'node --test tests/check.mjs | head -20'],
  ['node --test tests/check.mjs', 'node --test tests/check.mjs > /tmp/check.log 2>&1; echo "exit $?" >> /tmp/check.log'],
];
for (const [plain, wrapped] of variants) test(`normalizes ${wrapped}`, () => assert.equal(normalizeCommand(wrapped, '/repo'), normalizeCommand(plain, '/repo')));
test('normalizing preserves argument boundaries, quoted spaces and unrelated shell operations', () => {
  for (const [a, b] of [["test 'a  b' = x", "test 'a b' = x"], ['echo "one two"', 'echo one two'], ["echo '$FOO'", 'echo "$FOO"'], ['npm test; false', 'npm test'], ['npm test | custom-filter', 'npm test']]) assert.notEqual(normalizeCommand(a), normalizeCommand(b));
});

for (const agent of ['claude', 'codex']) test(`${agent} evidence matches wrappers, prose and failures, and classifies descriptions`, async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const commands = variants.map(([, cmd], i) => cmd.replaceAll('check.mjs', `check-${i}.mjs`));
  commands.push('npm run lint');
  const checks = commands.map((_, i) => ({ cmd: i === commands.length - 1 ? 'npm run lint' : `Verified with \`node --test tests/check-${i}.mjs\` — passed`, result: 'pass' }));
  checks.push({ cmd: 'synthetic end-to-end inspection of the fixture', result: 'pass' }, { cmd: 'npm run missing', result: 'pass' });
  const extraEvents = commands.flatMap((command, i) => agent === 'claude' ? [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}`, name: 'Bash', input: { command } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: i === commands.length - 1 ? 'Exit code 2' : 'ok', is_error: i === commands.length - 1 }] } },
  ] : [{ type: 'item.completed', item: { type: 'command_execution', id: `c${i}`, command: `/bin/zsh -lc '${command.replaceAll("'", "'\\''")}'`, exit_code: i === commands.length - 1 ? 2 : 0, status: 'completed' } }]);
  await f.start(run, 'forms', { agent, config: { finalMessage: report(checks), extraEvents } });
  await f.finished(run, 'forms');
  const out = await f.command(['result', run.id, 'forms']);
  const row = (await f.json(['status', run.id])).tasks.find((r) => r.id === 'forms');
  assert.ok(row.report.checks.slice(0, commands.length).every((c) => c.evidence.ran));
  assert.equal(row.report.checks[7].evidence.exitCode, null, 'a status echo masks the test exit code');
  assert.equal(row.report.checks[8].evidence.exitCode, 2);
  assert.deepEqual(row.report.checks[9].evidence, { ran: false, notCommand: true });
  assert.deepEqual(row.report.checks[10].evidence, { ran: false });
  assert.match(out.stdout, /last run exited 2/);
  assert.match(out.stdout, /not a command/);
  assert.match(out.stdout, /WARNING: check "synthetic.*not a command/);
  // Evidence saved by the old exact matcher must not survive the matcher upgrade.
  const file = path.join(row.outDir, 'evidence.json');
  const saved = readJson(file); delete saved.version; saved.checks = checks.map(() => ({ ran: false }));
  fs.writeFileSync(file, JSON.stringify(saved));
  await f.command(['result', run.id, 'forms']);
  assert.equal(readJson(file).checks[0].ran, true);
  assert.equal(readJson(file).readAt, saved.readAt);
  assert.equal(readJson(file).commit, saved.commit);
  assert.equal(readJson(file).dirty, saved.dirty);
});

test('prose extracts commands while shell sequences keep exit evidence conservative', async () => {
  const { matchCheckEvidence } = await import('../scripts/lib/report.mjs');
  const match = (cmd, shell, exitCode = 0) => matchCheckEvidence({ cmd }, [{ cmd: shell, exitCode, atMs: null }]);
  assert.equal(match('Lint: npm run lint — passed', 'npm run lint').exitCode, 0);
  assert.equal(match('Ran npm test (all pass)', 'npm test').exitCode, 0);
  assert.equal(match('npm test', 'ls tests; npm test > /tmp/log; echo "exit $?"; git status').exitCode, null);
  assert.equal(match('npm test', 'npm test && git status').exitCode, 0);
  assert.equal(match('npm test', 'false && npm test', 1).ran, false);
  assert.equal(match('npm test', 'exit 0; npm test').ran, false);
  assert.equal(match('npm test', "python3 - <<'EOF'\nnpm test\nEOF").ran, false);
  assert.equal(match('npm test', 'echo "npm test"').ran, false);
  assert.equal(match('npm test', 'npm test | tail -10').exitCode, null);
  assert.equal(match('npm test', 'npm test | tail -10', 2).exitCode, null);
  assert.equal(match('npm test', 'npm test < /tmp/input').ran, false);
});

test('compound steps, wrappers, flag differences and relative paths match', async () => {
  const { matchCheckEvidence: match } = await import('../scripts/lib/report.mjs');
  const run = (cmd, exitCode = 0) => ({ cmd, exitCode, atMs: null });
  const check = (cmd, runs) => match({ cmd }, runs, '/repo');
  assert.equal(check('npm test', [run('npm test && npm run lint')]).exitCode, 0);
  assert.equal(check('npm run lint', [run('npm test && npm run lint; echo done')]).exitCode, null);
  assert.equal(check('npm run lint', [run('npm test && npm run lint', 1)]).exitCode, null);
  assert.equal(check('custom-tool validate', [run('custom-tool validate | rg passed')]).ran, true);
  assert.equal(check('npm run lint', [run('npm test && npm run lint')]).exitCode, 0);
  assert.equal(check('npm test', [run('npm test || true')]).exitCode, null);
  assert.equal(check('git diff before after', [run('git diff before after | rg -n changed; git status')]).exitCode, null);
  assert.equal(check('gh pr checks 123', [run('gh pr checks 123 --repo example-org/example-repo | grep -v pending; echo done')]).ran, false);
  assert.equal(check('gh api repos/example-org/example-repo/pulls/1/comments', [run("gh api repos/example-org/example-repo/pulls/1/comments --jq '.[].id'")]).ran, true);
  assert.equal(check('npm test', [run('npm test &')]).exitCode, null);
  assert.equal(check('npm test', [run('/bin/bash -c "npm test"')]).ran, true);
  assert.equal(check('node $TMPDIR/probe.mjs', [run('node "$TMPDIR/probe.mjs"')]).ran, true);
  assert.equal(check('./tests/run.sh', [run('./unrelated/run.sh')]).ran, false);
  assert.equal(check('npm test', [run('timeout -k 5s 60 env -u SESSION npm test')]).ran, true);
  assert.equal(check('node --test tests/a.mjs', [run('node /opt/cli/orch.mjs heavy --label "unit tests" -- env ONE=1 node --test --test-name-pattern units skills/unit/tests/a.mjs')]).ran, false);
  assert.equal(check('node --test --test-name-pattern units tests/a.mjs', [run('node /opt/cli/orch.mjs heavy --label "unit tests" -- env ONE=1 node --test --test-name-pattern units skills/unit/tests/a.mjs')]).ran, true);
  assert.equal(check('node --test --test-reporter spec tests/a.mjs', [run('cd skills/unit && node --test tests/a.mjs | tail -10')]).exitCode, null);
  assert.equal(check('node --test /repo/skills/unit/tests/a.mjs', [run('cd skills/unit && node --test tests/a.mjs')]).ran, true);
  assert.equal(check('node --test tests/a.mjs', [run('node --test tests/b.mjs')]).ran, false);
  assert.equal(check('node --test tests/a.mjs', [run('node --test elsewhere/a.mjs')]).ran, false);
  assert.equal(check('git status --short; git diff --stat', [run('git diff --name-only'), run('git status --porcelain')]).ran, true);
  assert.equal(check('npm test', [run("cat > /tmp/script.sh <<'EOF'\nnpm test\nEOF\necho done")]).ran, false);
  assert.equal(check('npm test', [run("cat > /tmp/script.sh <<'EOF'\necho fake\nEOF\nnpm test")]).exitCode, 0);
  assert.equal(check('npm test', [run('/bin/bash -c "cat <<\'EOF\'\nnpm test\nEOF\necho done"')]).ran, false);
});

test('command identity preserves validation, mutation and selection flags in both directions', async () => {
  const { matchCheckEvidence } = await import('../scripts/lib/report.mjs');
  const match = (cmd, logged) => matchCheckEvidence({ cmd }, [{ cmd: logged, exitCode: 0, atMs: null }], '/repo');
  for (const [base, changed] of [
    ['git diff', 'git diff --exit-code'], ['black .', 'black --check .'],
    ['git diff', 'git diff --quiet'],
    ['git apply change.patch', 'git apply --stat change.patch'],
    ['node script.js', 'node script.js --test-reporter spec'],
    ['node script.js', 'node -v script.js'],
    ['pytest -k one tests/', 'pytest -k two tests/'],
    ['pytest -k group/a tests/', 'pytest -k prefix/group/a tests/'],
    ['ruff check .', 'ruff check --fix .'], ['formatter .', 'formatter --write .'],
    ['git push origin HEAD', 'git push --dry-run origin HEAD'],
    ['pytest tests/', 'pytest -k one tests/'], ['pytest tests/', 'pytest --keyword=one tests/'],
    ['node --test tests/a.mjs', 'node --test --test-name-pattern=one tests/a.mjs'],
    ['pytest tests/', 'pytest --ignore tests/integration tests/'],
  ]) {
    assert.equal(match(base, changed).ran, false, `${base} versus ${changed}`);
    assert.equal(match(changed, base).ran, false, `${changed} versus ${base}`);
    assert.equal(match(changed, changed).ran, true);
  }
});

test('an exact failing run wins over every later compatible or narrowed success', async () => {
  const { matchCheckEvidence } = await import('../scripts/lib/report.mjs');
  const runs = [
    { cmd: 'pytest tests/', exitCode: 1, atMs: 1 },
    { cmd: 'pytest -q tests/', exitCode: 0, atMs: 2 },
    { cmd: 'pytest -k one tests/', exitCode: 0, atMs: 3 },
  ];
  assert.deepEqual(matchCheckEvidence({ cmd: 'pytest tests/' }, runs, '/repo'), { ran: true, exitCode: 1, atMs: 1 });
});

test('outside directory switches and symlinks cannot provide evidence for the task tree', async (t) => {
  const { matchCheckEvidence } = await import('../scripts/lib/report.mjs');
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.repo, 'inside'));
  fs.symlinkSync(f.root, path.join(f.repo, 'escape'));
  const match = (cmd) => matchCheckEvidence({ cmd: 'npm test' }, [{ cmd, exitCode: 0, atMs: null }], f.repo);
  assert.equal(match(`cd '${f.repo}' && npm test`).ran, true);
  assert.equal(match('cd inside && npm test').ran, true);
  assert.equal(match(`cd '${f.root}' && npm test`).ran, false);
  assert.equal(match(`cd '${f.root}' && echo setup; npm test`).ran, false);
  assert.equal(match('cd escape && npm test').ran, false);
  assert.equal(match('cd escape/missing-child && npm test').ran, false);
  assert.notEqual(normalizeCommand(`cd '${f.root}' && npm test`, f.repo), normalizeCommand('npm test', f.repo));
  assert.equal(matchCheckEvidence({ cmd: 'node tests/a.mjs' }, [{ cmd: `node ${f.root}/tests/a.mjs`, exitCode: 0, atMs: null }], f.repo).ran, false);
});

test('escaped newlines join command words outside single quotes', async () => {
  const { matchCheckEvidence } = await import('../scripts/lib/report.mjs');
  for (const [command, plain] of [
    ['node --test \\\n tests/a.mjs', 'node --test tests/a.mjs'],
    ['no\\\nde --test tests/a.mjs', 'node --test tests/a.mjs'],
    ['node --test "tests/\\\na.mjs"', 'node --test tests/a.mjs'],
  ]) {
    assert.equal(normalizeCommand(command, '/repo'), normalizeCommand(plain, '/repo'));
    assert.equal(matchCheckEvidence({ cmd: plain }, [{ cmd: command, exitCode: 0, atMs: null }], '/repo').ran, true);
  }
  assert.notEqual(normalizeCommand("echo 'a\\\nb'"), normalizeCommand("echo 'ab'"));
});

for (const agent of ['claude', 'codex']) test(`${agent} missing event logs have no evidence and leave saved legacy evidence unchanged`, async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await f.start(run, 'no-log', { agent, config: { finalMessage: report([{ cmd: 'npm test', result: 'pass' }]) } });
  const row = await f.finished(run, 'no-log');
  fs.rmSync(path.join(row.outDir, 'events.jsonl'));
  const file = path.join(row.outDir, 'evidence.json');
  for (const version of [2, 4]) {
    const legacy = JSON.stringify({ version, attempt: 1, checks: [{ ran: true, exitCode: 0, atMs: 1 }] });
    fs.writeFileSync(file, legacy);
    const output = await f.command(['result', run.id, 'no-log']);
    assert.match(output.stdout, /no events log; evidence unavailable/);
    assert.doesNotMatch(output.stdout, /NOT FOUND in the log/);
    const task = (await f.json(['status', run.id])).tasks.find((x) => x.id === 'no-log');
    assert.equal(task.report.checks[0].evidence, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  }
});
