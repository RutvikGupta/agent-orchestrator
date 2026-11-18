import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';

const as = (run, id) => ({ AGENT_ORCH_DEPTH: '1', AGENT_ORCH_RUN: run.id, AGENT_ORCH_TASK: id });

// A finish notice reaches only a running agent. A task that finished while the agent that started it
// was between attempts would wait on it unseen, so the agent's next attempt's brief lists every task
// it started that still waits on it, and none that it already accepted or closed.
test("a new attempt's brief lists the tasks it started that still wait on its review", async (t) => {
  const f = await fixture(t);
  const parent = await f.newRun('parent');
  await f.start(parent, 'lead', { flags: ['--read-only'] });
  await f.finished(parent, 'lead');
  // While `lead` is not running, three of its tasks finish: one it will accept, one it will close,
  // and one nobody acts on.
  const child = await f.newRun('helpers', as(parent, 'lead'));
  for (const id of ['unseen', 'accepted', 'closed']) {
    await f.start(child, id, { flags: ['--read-only'], env: as(parent, 'lead') });
    await f.finished(child, id);
  }
  await f.command(['accept', child.id, 'accepted', '--note', 'read it'], { env: as(parent, 'lead') });
  await f.command(['close', child.id, 'closed'], { env: as(parent, 'lead') });

  const again = await f.start(parent, 'lead', { flags: ['--read-only'] });
  const brief = fs.readFileSync(path.join(again.outDir, 'orch-brief.md'), 'utf8');
  const section = brief.slice(brief.indexOf('## Tasks you started that wait on you'));
  assert.ok(brief.includes('## Tasks you started that wait on you'), 'the brief does not list the waiting tasks');
  assert.match(section, new RegExp(`- \`unseen\` in run \`${child.id}\` \\(completed, awaiting your review\\): \`node .*orch\\.mjs result ${child.id} unseen\``));
  assert.doesNotMatch(section, /`accepted`|`closed`/);
  await f.finished(parent, 'lead');

  // Once nothing waits on it, the section is gone.
  await f.command(['accept', child.id, 'unseen', '--note', 'read it'], { env: as(parent, 'lead') });
  const third = await f.start(parent, 'lead', { flags: ['--read-only'] });
  assert.ok(!fs.readFileSync(path.join(third.outDir, 'orch-brief.md'), 'utf8').includes('## Tasks you started that wait on you'));
  await f.finished(parent, 'lead');
});
