import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, readJson } from './helpers.mjs';

const report = (checks) => `Done.\n\n\`\`\`orch-result\n${JSON.stringify({ outcome: 'done', changed: [], checks, decisions: [], unresolved: [] })}\n\`\`\`\n`;
const pass = (cmd) => ({ cmd, result: 'pass' });
const runEvent = (id, command, result = 'ok', isError = false) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } },
];
async function start(f, run, id, checks, { flags = [], events = [] } = {}) {
  await f.start(run, id, { flags, config: { ...(checks && { finalMessage: report(checks) }), extraEvents: events } });
  await f.finished(run, id);
}

test('a failed matching check refuses even alongside success; override is saved and must be nonblank', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await start(f, run, 'writer', [pass('npm test'), pass('npm run lint')], { events: [...runEvent('test', 'npm test'), ...runEvent('lint', 'npm run lint', 'Exit code 2', true)] });
  const denied = await f.command(['accept', run.id, 'writer'], { code: 1 });
  assert.match(denied.stderr, /npm run lint.*exited 2/);
  assert.equal(readJson(f.taskFile(run, 'writer')).acceptedAt, undefined);
  await f.command(['accept', run.id, 'writer', '--unverified', '   '], { code: 2 });
  const override = await f.command(['accept', run.id, 'writer', '--unverified', ' reviewed elsewhere ', '--json']);
  assert.match(override.stderr, /npm run lint.*exited 2/);
  assert.equal(JSON.parse(override.stdout).unverifiedReason, 'reviewed elsewhere');
  assert.equal(readJson(f.taskFile(run, 'writer')).unverifiedReason, 'reviewed elsewhere');
});

test('a report with no matched passing checks is refused', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await start(f, run, 'missing', [pass('npm test'), pass('manual inspection')]);
  const denied = await f.command(['accept', run.id, 'missing'], { code: 1 });
  assert.match(denied.stderr, /no passing check matched a run/);
});

test('unknown exit counts as matched and warns', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await start(f, run, 'unknown', [pass('npm test')], { events: runEvent('test', 'npm test; echo done') });
  const accepted = await f.command(['accept', run.id, 'unknown']);
  assert.match(accepted.stderr, /WARNING:.*npm test.*no exit code/);
});

for (const [id, extra, warning] of [
  ['prose', 'manual inspection', /WARNING:.*manual inspection/],
  ['missing', 'npm run missing', /WARNING:.*npm run missing.*no matching run/],
]) test(`${id} alongside a matched success accepts with a warning`, async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await start(f, run, id, [pass('npm test'), pass(extra)], { events: runEvent('test', 'npm test') });
  const accepted = await f.command(['accept', run.id, id]);
  assert.match(accepted.stderr, warning);
});

test('read-only reports warn without refusal and no-report tasks accept', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  await start(f, run, 'reader', [pass('npm test')], { flags: ['--read-only'], events: runEvent('test', 'npm test', 'Exit code 2', true) });
  const reader = await f.command(['accept', run.id, 'reader']);
  assert.match(reader.stderr, /WARNING:.*npm test.*exited 2/);
  await start(f, run, 'no-report', null);
  await f.command(['accept', run.id, 'no-report']);
});
