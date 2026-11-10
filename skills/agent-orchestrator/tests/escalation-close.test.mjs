import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, readJson, writeJson } from './helpers.mjs';

test('closing a live relay excludes its aborted attempt after resume', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const held = await f.start(run, 'closed', { flags: ['--tier', 'light'], config: { hold: true } });
  await f.ready(held);
  await f.command(['close', run.id, 'closed']);
  const stopped = readJson(f.taskFile(run, 'closed'));
  assert.ok(stopped.stoppedAt);
  // Exercise relays that report an abort on SIGTERM, even if the fixture reports stopped.
  writeJson(path.join(held.outDir, 'result.json'), { status: 'aborted', model: held.model });
  await f.command(['start', run.id, 'closed', '--agent', 'claude', '--brief', f.brief('after-close')]);
  const row = await f.finished(run, 'closed');
  const resumed = readJson(f.taskFile(run, 'closed'));
  assert.equal(resumed.attemptStops[1], stopped.stoppedAt);
  assert.equal(row.failureCount, 0);
  assert.equal(row.tier, 'light');
});
