import test from 'node:test';
import assert from 'node:assert/strict';
import { tabsOf } from '../scripts/lib/commands/dashboard.mjs';

// `dashboard --open` reuses a running server. It opens a tab when none shows the board, and also when
// every open tab lacks the send key, since only a tab that `--open` opened gets the key.

test('no tab: open one', () => {
  assert.deepEqual(tabsOf({ tabs: 0, keyedTabs: 0, pageAgoMs: null }), { tabOpen: false, keyless: false });
});

test('open tabs that all lack the key: open a keyed one', () => {
  assert.deepEqual(tabsOf({ tabs: 2, keyedTabs: 0, pageAgoMs: 500 }), { tabOpen: true, keyless: true });
});

test('one keyed tab is enough', () => {
  assert.deepEqual(tabsOf({ tabs: 2, keyedTabs: 1, pageAgoMs: 500 }), { tabOpen: true, keyless: false });
});

test('a server too old to count keyed tabs is taken to have the key', () => {
  assert.deepEqual(tabsOf({ tabs: 1, pageAgoMs: 500 }), { tabOpen: true, keyless: false });
  assert.deepEqual(tabsOf({ pid: null, pageAgoMs: null }), { tabOpen: false, keyless: false });
});

test('a tab that only polled recently, with no presence stream, is not known to lack the key', () => {
  assert.deepEqual(tabsOf({ tabs: 0, keyedTabs: 0, pageAgoMs: 3000 }), { tabOpen: true, keyless: false });
});
