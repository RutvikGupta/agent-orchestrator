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
for (const [plain, wrapped] of variants) test(`normalizes ${wrapped}`, () => assert.equal(normalizeCommand(wrapped), normalizeCommand(plain)));
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
  assert.equal(check('gh pr checks 123', [run('gh pr checks 123 --repo example-org/example-repo | grep -v pending; echo done')]).ran, true);
  assert.equal(check('gh api repos/example-org/example-repo/pulls/1/comments', [run("gh api repos/example-org/example-repo/pulls/1/comments --jq '.[].id'")]).ran, true);
  assert.equal(check('npm test', [run('npm test &')]).exitCode, null);
  assert.equal(check('npm test', [run('/bin/bash -c "npm test"')]).ran, true);
  assert.equal(check('node $TMPDIR/probe.mjs', [run('node "$TMPDIR/probe.mjs"')]).ran, true);
  assert.equal(check('./tests/run.sh', [run('./unrelated/run.sh')]).ran, false);
  assert.equal(check('npm test', [run('timeout -k 5s 60 env -u SESSION npm test')]).ran, true);
  assert.equal(check('node --test tests/a.mjs', [run('node /opt/cli/orch.mjs heavy --label "unit tests" -- env ONE=1 node --test --test-name-pattern units skills/unit/tests/a.mjs')]).ran, true);
  assert.equal(check('node --test -q tests/a.mjs', [run('cd skills/unit && node --test tests/a.mjs | tail -10')]).exitCode, null);
  assert.equal(check('node --test /repo/skills/unit/tests/a.mjs', [run('cd skills/unit && node --test tests/a.mjs')]).ran, true);
  assert.equal(check('node --test tests/a.mjs', [run('node --test tests/b.mjs')]).ran, false);
  assert.equal(check('node --test tests/a.mjs', [run('node --test elsewhere/a.mjs')]).ran, false);
  assert.equal(check('git status --short; git diff --stat', [run('git diff --name-only'), run('git status --porcelain')]).ran, true);
  assert.equal(check('npm test', [run("cat > /tmp/script.sh <<'EOF'\nnpm test\nEOF\necho done")]).ran, false);
  assert.equal(check('npm test', [run("cat > /tmp/script.sh <<'EOF'\necho fake\nEOF\nnpm test")]).exitCode, 0);
  assert.equal(check('npm test', [run('/bin/bash -c "cat <<\'EOF\'\nnpm test\nEOF\necho done"')]).ran, false);
});
