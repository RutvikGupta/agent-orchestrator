import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard's order rule for dragged sections and rows, cut out of the served page and run with
// no document: the pure functions between the rule's comment and the line that reads the browser's
// storage.
const app = fs.readFileSync(new URL('../scripts/dashboard/app.js', import.meta.url), 'utf8');
const from = app.indexOf('// The order rule for what the user dragged.');
const until = app.indexOf('// The memories, kept in this browser', from);
assert.ok(from >= 0 && until > from, 'the page holds the order rule');
const context = vm.createContext({});
vm.runInContext(`${app.slice(from, until)};this.rule={heldOrder,validOrders,keptOrders,sectionOrder,treeRows,rowTarget,moveKey,dropMemo,listName};`, context);
// Values from the vm context have its own Array prototype; JSON makes them comparable here.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const rule = Object.fromEntries(Object.entries(context.rule).map(([name, fn]) => [name, (...args) => plain(fn(...args))]));

const row = (key, parentKey = null, extra = {}) => ({ key, parentKey, ...extra });
const section = (id, tasks) => ({ id, tasks });
// A section's rows in tree order, as the server sends them: a main session, two agents with rows
// under them, and a third agent.
const tree = () => [
  row('~main', null, { main: true }),
  row('a', '~main'), row('a1', 'a'), row('a2', 'a'), row('a2x', 'a2'),
  row('b', '~main'), row('b1', 'b'),
  row('c', '~main'),
];
const keys = (tasks) => tasks.map((t) => t.key);

test('an order holds while the automatic order of its list is unchanged', () => {
  const memo = { auto: ['x', 'y', 'z'], order: ['z', 'x', 'y'] };
  assert.deepEqual(rule.heldOrder(['x', 'y', 'z'], memo), { keys: ['z', 'x', 'y'], valid: true });
  // Board after board, the same automatic order keeps showing the user's.
  for (let i = 0; i < 3; i++) assert.deepEqual(rule.heldOrder(['x', 'y', 'z'], memo).keys, ['z', 'x', 'y']);
  // Nothing remembered: the automatic order.
  assert.deepEqual(rule.heldOrder(['x', 'y'], undefined), { keys: ['x', 'y'], valid: false });
});

test('an item that moved, appeared or left in the automatic order drops the remembered order', () => {
  const memo = { auto: ['x', 'y', 'z'], order: ['z', 'x', 'y'] };
  for (const [why, auto] of [['moved', ['y', 'x', 'z']], ['appeared', ['x', 'y', 'z', 'w']], ['appeared first', ['w', 'x', 'y', 'z']], ['left', ['x', 'z']]]) {
    assert.deepEqual(rule.heldOrder(auto, memo), { keys: auto, valid: false }, why);
  }
  // A memory that is not a reordering of its own keys is never shown.
  assert.equal(rule.heldOrder(['x', 'y'], { auto: ['x', 'y'], order: ['x', 'x'] }).valid, false);
  assert.equal(rule.heldOrder(['x', 'y'], { auto: ['x', 'y'], order: 'yx' }).valid, false);
});

test('stored data that is not a well-formed memory is dropped and never throws', () => {
  // A key that cannot become a string threw while the rule sorted it, and the board stayed blank.
  const bad = { toString: null };
  assert.deepEqual(context.rule.heldOrder(['s1', 's2'], { auto: ['s1', 's2'], order: [bad, 's2'] }).valid, false);
  const ok = { auto: ['x', 'y'], order: ['y', 'x'] };
  const stored = {
    sections: { auto: ['s1', 's2'], order: [bad, 's2'] }, number: 5, empty: null, text: 'xy', list: ['x'],
    notArrays: { auto: 'xy', order: ['x', 'y'] }, repeated: { auto: ['x', 'x'], order: ['x', 'x'] },
    otherKeys: { auto: ['x', 'y'], order: ['x', 'z'] }, numbers: { auto: [1, 2], order: [2, 1] }, short: { auto: ['x', 'y'], order: ['y'] }, ok,
  };
  assert.deepEqual(plain(context.rule.validOrders(stored)), { ok });
  for (const v of [null, undefined, 5, 'text', ['x'], true]) assert.deepEqual(plain(context.rule.validOrders(v)), {});
});

test('on a new board each list keeps or drops its own order: a change in one list leaves the others', () => {
  const board = [section('s1', tree()), section('s2', [row('p'), row('q'), row('r')])];
  const memos = {
    sections: { auto: ['s1', 's2'], order: ['s2', 's1'] },
    [rule.listName('s1', '~main')]: { auto: ['a', 'b', 'c'], order: ['c', 'a', 'b'] },
    [rule.listName('s1', 'a')]: { auto: ['a1', 'a2'], order: ['a2', 'a1'] },
    [rule.listName('s2', null)]: { auto: ['p', 'q', 'r'], order: ['r', 'q', 'p'] },
  };
  assert.deepEqual(rule.keptOrders(board, memos), memos, 'an unchanged board keeps every order');
  // In s1, b now comes before a: only the list under s1's main session is forgotten. The rows under
  // a, s2's rows and the sections keep theirs.
  const moved = tree();
  moved.splice(5, 2);
  moved.splice(1, 0, row('b', '~main'), row('b1', 'b'));
  const kept = rule.keptOrders([section('s1', moved), board[1]], memos);
  assert.deepEqual(Object.keys(kept).sort(), ['sections', rule.listName('s1', 'a'), rule.listName('s2', null)].sort());
  // A row that appears under a forgets only the list under a.
  const grown = [section('s1', [...tree(), row('a3', 'a')]), board[1]];
  assert.deepEqual(Object.keys(rule.keptOrders(grown, memos)).sort(), ['sections', rule.listName('s1', '~main'), rule.listName('s2', null)].sort());
  // The sections swap in the automatic order: only the sections' order is forgotten.
  assert.deepEqual(Object.keys(rule.keptOrders([board[1], board[0]], memos)).sort(), Object.keys(memos).filter((n) => n !== 'sections').sort());
  // A section that leaves the board takes its lists with it, and changes the sections' list.
  assert.deepEqual(Object.keys(rule.keptOrders([board[0]], memos)).sort(), [rule.listName('s1', '~main'), rule.listName('s1', 'a')].sort());
});

test('sections show in the held order while it is valid', () => {
  const board = [section('s1', []), section('s2', []), section('s3', [])];
  assert.deepEqual(rule.sectionOrder(board, { sections: { auto: ['s1', 's2', 's3'], order: ['s3', 's1', 's2'] } }).map((s) => s.id), ['s3', 's1', 's2']);
  assert.deepEqual(rule.sectionOrder(board, { sections: { auto: ['s2', 's1', 's3'], order: ['s3', 's1', 's2'] } }).map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(rule.sectionOrder(board, {}).map((s) => s.id), ['s1', 's2', 's3']);
});

test('a row moves with every row under it, and the main session row stays first', () => {
  const run = section('s1', tree());
  assert.deepEqual(keys(rule.treeRows(run, {})), keys(tree()), 'no held order: the server order');
  const memos = { [rule.listName('s1', '~main')]: { auto: ['a', 'b', 'c'], order: ['c', 'a', 'b'] } };
  assert.deepEqual(keys(rule.treeRows(run, memos)), ['~main', 'c', 'a', 'a1', 'a2', 'a2x', 'b', 'b1']);
  // An order under a nested parent moves that row's own subtree, inside its parent's block.
  memos[rule.listName('s1', 'a')] = { auto: ['a1', 'a2'], order: ['a2', 'a1'] };
  assert.deepEqual(keys(rule.treeRows(run, memos)), ['~main', 'c', 'a', 'a2', 'a2x', 'a1', 'b', 'b1']);
  // Another section's orders do not apply here.
  assert.deepEqual(keys(rule.treeRows(section('s2', tree()), memos)), keys(tree()));
});

test('a row lands only beside a row with the same parent in its own section', () => {
  const tasks = tree();
  // Over a sibling: before or after it, as the pointer says.
  assert.deepEqual(rule.rowTarget(tasks, 'c', 'a', false), { target: 'a', after: false });
  assert.deepEqual(rule.rowTarget(tasks, 'c', 'b', true), { target: 'b', after: true });
  // Over a row under a sibling: after that sibling's whole subtree, never under it.
  assert.deepEqual(rule.rowTarget(tasks, 'c', 'a2x', false), { target: 'a', after: true });
  assert.deepEqual(rule.rowTarget(tasks, 'a1', 'a2x', false), { target: 'a2', after: true });
  // Under another parent, over its own parent or its own subtree, or over another section's row: nowhere.
  assert.equal(rule.rowTarget(tasks, 'a1', 'b1', false), null);
  assert.equal(rule.rowTarget(tasks, 'a1', 'b', false), null);
  assert.equal(rule.rowTarget(tasks, 'a1', 'a', false), null);
  assert.equal(rule.rowTarget(tasks, 'a', 'a2x', false), null);
  assert.equal(rule.rowTarget(tasks, 'a', 'elsewhere', false), null);
  // The main session row neither moves nor takes a row beside it.
  assert.equal(rule.rowTarget(tasks, '~main', 'a', false), null);
  assert.equal(rule.rowTarget(tasks, 'a', '~main', false), null);
  // With no main session, the top-level rows move among themselves.
  assert.deepEqual(rule.rowTarget([row('p'), row('q'), row('q1', 'q')], 'p', 'q1', false), { target: 'q', after: true });
  // A drop keeps every row under its parent: the new order lists the same siblings.
  const shown = ['a', 'b', 'c'], at = rule.rowTarget(tasks, 'c', 'a2x', false);
  assert.deepEqual(rule.moveKey(shown, 'c', at.target, at.after), ['a', 'c', 'b']);
});

test('a drop that changes nothing remembers nothing, and one back to the automatic order forgets', () => {
  const auto = ['a', 'b', 'c'];
  assert.equal(rule.dropMemo(auto, auto, 'b', 'a', true), undefined, 'b dropped just after a stays put');
  assert.equal(rule.dropMemo(auto, auto, 'b', 'c', false), undefined);
  assert.deepEqual(rule.dropMemo(auto, auto, 'c', 'a', false), { auto, order: ['c', 'a', 'b'] });
  assert.deepEqual(rule.dropMemo(auto, ['c', 'a', 'b'], 'b', 'c', false), { auto, order: ['b', 'c', 'a'] });
  assert.equal(rule.dropMemo(auto, ['c', 'a', 'b'], 'c', 'b', true), null, 'back to the automatic order');
  assert.deepEqual(rule.moveKey(auto, 'x', 'a', false), auto, 'an unknown key moves nothing');
});
