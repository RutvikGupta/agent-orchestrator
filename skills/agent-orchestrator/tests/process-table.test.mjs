import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';

// The dashboard checks every task each refresh. Live relays must cost one `ps` together, not
// one each, and a relay must still be told apart from an unrelated process on a reused PID.
test('status checks every running relay with a single ps call', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const held = [];
  for (const id of ['one', 'two', 'three']) held.push(await f.start(run, id, { config: { hold: true }, flags: ['--read-only'] }));
  for (const task of held) await f.ready(task);
  const bin = path.join(f.root, 'fake-bin'), log = path.join(f.root, 'ps.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho "$*" >> "${log}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const status = await f.json(['status', run.id], { env: { PATH: `${bin}:${f.env.PATH}` } });
  assert.deepEqual(status.tasks.map((task) => task.state), ['running', 'running', 'running']);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  for (const task of held) f.release(task);
  for (const id of ['one', 'two', 'three']) await f.finished(run, id);
});

test('a task whose PID now belongs to another process is not running', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'reused');
  await f.finished(run, 'reused');
  const file = path.join(f.state, 'runs', run.id, 'tasks', 'reused', 'task.json');
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...task, pid: process.pid, startedAt: new Date(Date.now() - 60_000).toISOString() }));
  const row = (await f.json(['status', run.id])).tasks.find((t) => t.id === 'reused');
  assert.notEqual(row.state, 'running');
});

test('escalation checks run at a tenth of the delay, between 1 and 10 seconds', async () => {
  const { escalationCheckMs } = await import('../scripts/lib/escalate.mjs');
  const saved = process.env.AGENT_ORCH_ESCALATE_AFTER;
  try {
    for (const [after, expected] of [[undefined, 10_000], ['10m', 10_000], ['30s', 3000], ['1500ms', 1000], ['100ms', 1000]]) {
      if (after === undefined) delete process.env.AGENT_ORCH_ESCALATE_AFTER;
      else process.env.AGENT_ORCH_ESCALATE_AFTER = after;
      assert.equal(escalationCheckMs(), expected, `delay ${after}`);
    }
  } finally {
    if (saved === undefined) delete process.env.AGENT_ORCH_ESCALATE_AFTER;
    else process.env.AGENT_ORCH_ESCALATE_AFTER = saved;
  }
});
