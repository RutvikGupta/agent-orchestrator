import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonl } from './helpers.mjs';
// Internal import: the model and effort a session's row shows are a function of its transcript,
// checked here on small transcripts (under 1 MB, so nothing is saved under the state root).
import { summarizeEvents } from '../scripts/lib/events.mjs';

function session(t, events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = jsonl(path.join(dir, 'session.jsonl'), events);
  const read = () => {
    const s = summarizeEvents('claude', file, dir);
    return { model: s.model, effort: s.effort, busy: s.busy };
  };
  return { read, append: (more) => fs.appendFileSync(file, more.map((e) => JSON.stringify(e)).join('\n') + '\n') };
}

let ids = 0;
const reply = (model, effort) => ({
  type: 'assistant', effort, perTurnEffort: effort,
  message: { id: `msg_${++ids}`, model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
});
const turnEnd = { type: 'system', subtype: 'turn_duration' };
// What Claude Code writes for a command it runs itself: the command, then its output.
const command = (name, output) => [
  { type: 'user', message: { role: 'user', content: `<command-name>/${name}</command-name>\n<command-args></command-args>` } },
  { type: 'user', message: { role: 'user', content: `<local-command-stdout>${output}</local-command-stdout>` } },
];
const setModel = (name) => command('model', `Set model to ${name} and saved as your default for new sessions`);
const setEffort = (level) => command('effort', `Set effort level to ${level} (saved as your default for new sessions): Some description`);

test('a /model or /effort change shows before the session replies again', (t) => {
  const s = session(t, [reply('claude-opus-5-5', 'xhigh'), turnEnd]);
  assert.deepEqual(s.read(), { model: 'claude-opus-5-5', effort: 'xhigh', busy: false });

  s.append(setEffort('high'));
  assert.deepEqual([s.read().model, s.read().effort], ['claude-opus-5-5', 'high']);

  s.append(setModel('`Fable 5.2`'));
  assert.deepEqual([s.read().model, s.read().effort], ['claude-fable-5-2', 'high']);
});

test('the next reply decides the model and effort again', (t) => {
  const s = session(t, [reply('claude-opus-5-5', 'xhigh'), turnEnd, ...setModel('`Fable 5.2`'), ...setEffort('low')]);
  s.append([reply('claude-fable-5-2-20261101', 'medium'), turnEnd]);
  assert.deepEqual(s.read(), { model: 'claude-fable-5-2-20261101', effort: 'medium', busy: false });
});

test('a model is read from an id, a name in color, or a name with a note after it', (t) => {
  for (const [name, id] of [
    ['claude-haiku-5-5[1m]', 'claude-haiku-5-5'],
    ['\x1b[1mSonnet 5.5\x1b[22m', 'claude-sonnet-5-5'],
    ['`Default (Opus 5.5 with 1M context)`', 'claude-opus-5-5'],
    ['`Opus 6`', 'claude-opus-6'],
  ]) {
    const s = session(t, [reply('claude-fable-5-2', 'high'), turnEnd, ...setModel(name)]);
    assert.equal(s.read().model, id, name);
  }
});

test('output that sets nothing, and a prompt that quotes such output, change nothing', (t) => {
  const before = [reply('claude-fable-5-2', 'high'), turnEnd];
  for (const events of [
    command('model', 'Kept model as `Opus 5.5`'),
    setModel('`Default`'), // a name with no family and version
    command('help', 'Commands: /effort (Set effort level to low, medium or high), /model (Set model to `Opus 5.5`)'),
    [{ type: 'user', message: { role: 'user', content: 'Why did it print "Set effort level to low" and "Set model to `Opus 5.5`"?' } }],
    [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<local-command-stdout>Set effort level to low (saved)' }] } }],
  ]) {
    const s = session(t, [...before, ...events]);
    const { model, effort } = s.read();
    assert.deepEqual([model, effort], ['claude-fable-5-2', 'high'], JSON.stringify(events));
  }
});
