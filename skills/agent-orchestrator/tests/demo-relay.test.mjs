// The demo board's relay (docs/demo/relay.mjs), run directly in a temporary folder. Played as the
// gemini relay, it reports usage as the real one does: none until its result event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventually } from './helpers.mjs';

test('the demo relay playing gemini reports no usage while its session runs, and none when it is stopped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-demo-relay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Its folder decides the agent it plays.
  const relay = path.join(root, 'skills', 'cursor-delegate', 'scripts', 'relay.mjs');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.copyFileSync(new URL('../../../docs/demo/relay.mjs', import.meta.url), relay);
  const script = path.join(root, 'script.json');
  fs.writeFileSync(script, JSON.stringify({
    session: 'demo-gemini', startedAt: new Date().toISOString(),
    steps: [{ t: 'read', file: 'README.md' }, { t: 'say', text: 'Reading the readme.' }],
    end: { status: 'running' },
  }));
  const out = path.join(root, 'out');
  const child = spawn(process.execPath, [relay, '--out-dir', out, '--cd', root, '--model', 'gemini-4-hydrogen', '--effort', 'high', '--demo-script', script], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
  });
  // The relay writes `ready` after its scripted steps and its SIGTERM handler.
  await eventually(() => fs.existsSync(path.join(out, 'ready')), 'the demo relay is ready');
  const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const assistant = events.filter((e) => e.type === 'assistant');
  assert.equal(assistant.length, 2);
  for (const e of assistant) assert.equal(Object.hasOwn(e.message, 'usage'), false, JSON.stringify(e.message));

  child.kill('SIGTERM');
  await exited;
  const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
  assert.deepEqual([result.status, result.model, result.cursorModel, result.usage], ['stopped', 'gemini-4-hydrogen', 'gemini-4-hydrogen-high', undefined]);
});
