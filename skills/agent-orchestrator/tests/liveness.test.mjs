import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';

// A relay whose process exists stays running when `ps` cannot read the process table, as when it
// times out on a heavily loaded machine: reporting it aborted would let `start` launch a second
// agent for the task.
test('a live relay counts as running when ps cannot read the process table', async (t) => {
  const f = await fixture(t), run = await f.newRun();
  const task = await f.start(run, 'held', { agent: 'codex', config: { hold: true }, flags: ['--read-only'] });
  await f.ready(task);
  // Every `ps` that lists the whole table fails; the per-PID reads still work.
  const file = path.join(f.root, 'no-ps-table.cjs');
  fs.writeFileSync(file, `const cp=require('child_process'),original=cp.spawnSync;
cp.spawnSync=function(bin,args,...rest){if(bin==='ps'&&Array.isArray(args)&&args.includes('-axww'))return {status:null,error:new Error('ETIMEDOUT'),stdout:'',stderr:''};return original.call(this,bin,args,...rest)};`);
  const env = { NODE_OPTIONS: `--require=${file}` };

  const status = (await f.command(['status', run.id], { env })).stdout;
  assert.match(status, /^held\s.*\brunning\b/m, status);
  assert.doesNotMatch(status, /aborted|exited without a result/, status);
  const again = await f.command(['start', run.id, 'held', '--agent', 'codex', '--tier', 'standard', '--why', 'Liveness fixture', '--read-only', '--brief', f.brief('held', { hold: true })], { code: 1, env });
  assert.match(again.stderr, /already running/);

  f.release(task);
  await f.finished(run, 'held');
});
