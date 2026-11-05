import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';

for (const [name, config, health, limited] of [
  ['provider error', { finalMessage: 'API Error: 529 overloaded', error: 'claude returned an error result' }, 'transient-error', false],
  ['usage limit', { finalMessage: 'Could not finish.', error: 'Usage limit reached; resets at 20:00 UTC.' }, 'ok', true],
]) {
  test(`status reports the real outcome when ${name} exits between result read and PID check`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const task = await f.start(run, 'race', { config: { ...config, status: 'failed', hold: true } });
    await f.ready(task);
    const json = f.json;
    let raced;
    f.json = async (args, opts) => {
      if (args[0] !== 'status' || raced) return json(args, opts);
      const result = await json(args, { env: {
        NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL('./fixtures/finish-during-read.cjs', import.meta.url)))}`,
        TEST_RACE_RESULT: path.join(task.outDir, 'result.json'),
        TEST_RACE_RELEASE: path.join(task.outDir, 'release'),
        TEST_RACE_PID: String(task.pid),
      } });
      raced = result.tasks[0];
      return result;
    };
    const row = await f.finished(run, 'race');
    // describe() reads result.json again when the relay finished between the read and the PID
    // check, so even the forced interleaving reports the real outcome instead of "aborted".
    assert.equal(raced.state, 'failed', 'the forced interleaving no longer yields a stale aborted row');
    assert.equal(raced.result.exitCode, 1);
    assert.equal(raced.health, health);
    assert.equal(row.state, 'failed');
    assert.equal(row.result.exitCode, 1);
    assert.equal(row.health, health);
    assert.equal(row.limitHit, limited);
  });
}
