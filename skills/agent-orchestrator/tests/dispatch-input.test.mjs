import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, readJson, writeJson } from './helpers.mjs';

const PARKED = [
  'PARKED: PR #42 waits for a human review',
  'Every check passed; nothing is unpushed.',
  '```orch-result',
  '{"outcome":"parked","changed":[],"checks":[],"decisions":[],"unresolved":[]}',
  '```',
].join('\n');

// Every file under the tasks folder, by relative path: a new attempt, retry brief or watcher shows up here.
function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? files(file, base) : [path.relative(base, file)];
  }).sort();
}

for (const bad of ['abc', '1.5']) {
  test(`dispatch --follow --max ${bad} is refused before it retries a task or restarts a watcher`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const file = path.join(f.root, 'plan-input.json');
    const entry = { id: 'retry', goal: 'Build retry', type: 'implement', owns: ['src/retry'], dependsOn: [], agent: 'claude', tier: 'complex',
      why: 'Fixture plan', brief: f.brief('retry', { status: 'failed', error: 'HTTP 503' }) };
    writeJson(file, { goal: 'Reject a bad --max', tasks: [entry] });
    await f.command(['plan', run.id, file]);
    await f.command(['dispatch', run.id]);
    // A planned task that failed transiently: the next --follow pass would resume it.
    assert.equal((await f.finished(run, 'retry')).health, 'transient-error');
    // A babysitter whose attempt ended parked, with no watcher: the next --follow pass would restart one.
    const sit = await f.start(run, 'sit', { flags: ['--unplanned'] });
    await f.finished(run, 'sit');
    const result = path.join(sit.outDir, 'result.json');
    writeJson(result, { ...readJson(result), finalMessage: PARKED });
    writeJson(f.taskFile(run, 'sit'), { ...readJson(f.taskFile(run, 'sit')), babysit: true, pr: { number: 42, url: 'https://github.com/example/repo/pull/42' } });

    const tasks = path.join(run.dir, 'tasks');
    const before = { files: files(tasks), retry: readJson(f.taskFile(run, 'retry')), sit: readJson(f.taskFile(run, 'sit')) };
    const refused = await f.command(['dispatch', run.id, '--follow', '--max', bad], { code: 2 });
    assert.match(refused.stderr, /--max needs a whole number/);
    assert.deepEqual(files(tasks), before.files, 'no retry brief, attempt or watcher file');
    assert.deepEqual(readJson(f.taskFile(run, 'retry')), before.retry);
    assert.deepEqual(readJson(f.taskFile(run, 'sit')), before.sit);
    assert.equal(readJson(f.taskFile(run, 'retry')).attempt, 1);
    assert.equal(files(tasks).some((name) => /retry-\d+\.md$|park-watcher-/.test(name)), false);
  });
}
