import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NODE_FALLBACK, nodeBin } from '../scripts/lib/config.mjs';
import { WAIT_SCRIPT } from '../scripts/lib/finish-notice.mjs';
import { PARK_SCRIPT } from '../scripts/lib/park.mjs';

// A Homebrew upgrade or a switch of Node versions deletes the versioned binary that
// process.execPath names. Watchers started before it must still run Node after it.

const real = fs.realpathSync(process.execPath);
const gone = path.join(os.tmpdir(), 'orch-no-such-dir', 'Cellar', 'node', '0.0.0', 'bin', 'node');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-node-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('nodeBin prefers a node on PATH that links to the running binary', (t) => {
  const dir = tempDir(t);
  fs.symlinkSync(real, path.join(dir, 'node'));
  assert.equal(nodeBin({ PATH: [dir, '/usr/bin', '/bin'].join(path.delimiter) }), path.join(dir, 'node'));
});

test('nodeBin keeps the running binary when no node on PATH links to it', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(nodeBin({ PATH: [dir, '/usr/bin', '/bin'].join(path.delimiter) }), process.execPath);
  assert.equal(nodeBin({ PATH: '' }), process.execPath);
});

// A PATH whose only `node` is a link to the running binary, so the fallback is found there.
function pathWithNode(t) {
  const dir = tempDir(t);
  fs.symlinkSync(real, path.join(dir, 'node'));
  return [dir, '/usr/bin', '/bin'].join(path.delimiter);
}

test('the shell fallback runs node from PATH when the recorded binary is gone', { skip: process.platform === 'win32' }, (t) => {
  const env = { ...process.env, PATH: pathWithNode(t) };
  const r = spawnSync('/bin/sh', ['-c', `${NODE_FALLBACK} exec "$@"`, 'probe', gone, '-e', 'process.stdout.write("ran")'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ran');
});

test('the finish watcher still runs its command after the recorded node is gone', { skip: process.platform === 'win32' }, (t) => {
  const env = { ...process.env, PATH: pathWithNode(t) };
  // PID 999999 is not running, so the watcher goes straight to its command; "x" stands for the start time.
  const r = spawnSync('/bin/sh', ['-c', WAIT_SCRIPT, 'finish-notice', '999999', 'x', gone, '-e', 'process.stdout.write(process.argv.at(-1))'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'x');
});

test('the park watcher keeps checking after the recorded node is gone', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const env = { ...process.env, PATH: pathWithNode(t) };
  const inbox = path.join(dir, 'inbox.jsonl');
  fs.writeFileSync(inbox, '');
  // The check script records that it ran and exits 3, which ends the watcher with status 0.
  const marker = path.join(dir, 'ran');
  const check = path.join(dir, 'check.mjs');
  fs.writeFileSync(check, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ')); process.exit(3);\n`);
  const r = spawnSync('/bin/sh', ['-c', PARK_SCRIPT, 'park-watch', gone, check, dir, '1', inbox, '1', '1'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), `check ${dir} 1`);
});
