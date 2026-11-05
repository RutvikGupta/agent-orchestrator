import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../scripts/dashboard/app.js', import.meta.url), 'utf8');
function snippet(from, until) {
  const start = app.indexOf(from), end = app.indexOf(until, start);
  assert.ok(start >= 0 && end > start, `dashboard script must contain ${from}`);
  return app.slice(start, end);
}

// Execute the actual served handlers with controlled browser interfaces. The separate audit
// also exercises these interactions in Chromium; this net needs only Node, like the suite.
test('dashboard close and Escape clear selection and return the table to full width', () => {
  let refreshes = 0;
  const events = {}, classes = new Set();
  const context = vm.createContext({
    sel: 'section/task', lastDetail: 'old', lastState: 'old', refresh: () => refreshes++,
    document: { querySelector: () => ({ classList: { add: (value) => classes.add(value) } }),
      addEventListener: (event, callback) => { events[event] = callback; } },
  });
  vm.runInContext(snippet('function closeDetail()', 'document.getElementById("runs")'), context);
  events.keydown({ key: 'Enter' });
  assert.equal(context.sel, 'section/task');
  events.keydown({ key: 'Escape' });
  assert.equal(context.sel, null);
  assert.equal(context.lastDetail, '');
  assert.equal(context.lastState, '');
  assert.ok(classes.has('no-detail'));
  assert.equal(refreshes, 1);
  context.sel = 'section/another';
  context.closeDetail();
  assert.equal(context.sel, null);
  assert.equal(refreshes, 2);
});

test('dashboard jump buttons move to the ends and update their visibility', () => {
  const events = {};
  const panel = { scrollTop: 300, scrollHeight: 1000, clientHeight: 200,
    addEventListener: (name, callback) => { events[name] = callback; } };
  const up = {}, down = {};
  class Observer { constructor(callback) { this.callback = callback; } observe() { this.callback(); } }
  const context = vm.createContext({ document: { getElementById: (id) => ({ detail: panel, 'jump-top': up, 'jump-bottom': down })[id] },
    ResizeObserver: Observer, MutationObserver: Observer });
  vm.runInContext(snippet('const atBottom=', 'async function detail()'), context);
  vm.runInContext(snippet('// Jump to the top', '// Drag the divider'), context);
  assert.equal(up.hidden, false);
  assert.equal(down.hidden, false);
  up.onclick(); events.scroll();
  assert.equal(panel.scrollTop, 0);
  assert.equal(up.hidden, true);
  down.onclick(); events.scroll();
  assert.equal(panel.scrollTop, 1000);
  assert.equal(down.hidden, true);
});

test('text selection and pointer holds survive refresh until the reader releases them', async () => {
  const callbacks = {};
  const panel = { contains: (node) => node === 'selected' };
  let selection = { isCollapsed: false, anchorNode: 'selected' };
  let refreshed = 0, detailed = 0;
  const context = vm.createContext({
    document: { addEventListener: (name, cb) => { callbacks[name] = cb; }, getElementById: () => panel },
    getSelection: () => selection, setTimeout: (fn) => fn(),
    refresh: async () => { refreshed++; }, detail: () => { detailed++; }, lastState: 'before', lastDetail: 'before',
  });
  vm.runInContext(snippet('let pressed=null,behind=false;', 'async function refresh()'), context);
  assert.equal(vm.runInContext('holding(document.getElementById("runs"))', context), true);
  vm.runInContext('behind=true;catchUp()', context);
  assert.equal(refreshed, 0);
  selection = { isCollapsed: true };
  callbacks.selectionchange();
  await Promise.resolve();
  assert.equal(refreshed, 1);
  assert.equal(detailed, 1);
  callbacks.pointerdown({ target: 'selected' });
  vm.runInContext('behind=true;catchUp()', context);
  assert.equal(refreshed, 1);
  callbacks.pointerup();
  await Promise.resolve();
  assert.equal(refreshed, 2);
});

test('a new dashboard server reloads the browser and SSE change calls the refresh handler', async () => {
  let reloaded = 0, kept = 0;
  const listeners = {};
  const context = vm.createContext({
    server: 'old-server', fetch: async () => ({ headers: { get: () => 'new-server' } }),
    location: { reload: () => reloaded++ }, keepState: () => kept++,
  });
  vm.runInContext(snippet('async function refresh()', '// The agent\'s structured report'), context);
  await context.refresh();
  assert.equal(reloaded, 1);
  assert.equal(kept, 1, 'the tab keeps its chosen row and drafts across the reload');
  const soon = () => {};
  vm.runInNewContext(snippet('const presence=new EventSource(', 'function showEscalation('), {
    soon, EventSource: class {
      constructor(url) { assert.equal(url, 'api/presence'); }
      addEventListener(name, fn) { listeners[name] = fn; }
    },
  });
  assert.equal(listeners.change, soon);
});

test('clicking a parent caret closes and reopens its native children without selecting a row', () => {
  const events = {}, manual = new Map();
  let refreshes = 0, selections = 0;
  const context = vm.createContext({
    manual, live: new Map([['section/main', true]]), lastState: 'old',
    isOpen: (key) => manual.get(key)?.open ?? true,
    refresh: () => refreshes++, getSelection: () => ({ isCollapsed: true }), choose: () => selections++,
    document: { getElementById: () => ({ addEventListener: (name, fn) => { events[name] = fn; } }) },
  });
  vm.runInContext(snippet('document.getElementById("runs").addEventListener("click"', '// Ask once'), context);
  const event = { target: { closest: (selector) => selector.startsWith('.caret') ? { dataset: { key: 'section/main' } } : null } };
  events.click(event);
  assert.equal(manual.get('section/main').open, false);
  events.click(event);
  assert.equal(manual.get('section/main').open, true);
  assert.equal(refreshes, 2);
  assert.equal(selections, 0);
});

test('clicking anywhere on a row with sub-agents opens it, and clicking the chosen row again closes it', () => {
  const events = {}, manual = new Map();
  const context = vm.createContext({
    manual, live: new Map(), lastState: 'old', sel: null,
    isOpen: (key) => manual.get(key)?.open ?? false,
    refresh: () => {}, getSelection: () => ({ isCollapsed: true }),
    document: { getElementById: () => ({ addEventListener: (name, fn) => { events[name] = fn; } }) },
  });
  context.choose = (row) => { context.sel = row?.dataset.key ?? context.sel; };
  vm.runInContext(snippet('function toggleRow(', '// Ask once'), context);
  const row = (key, kids) => ({ dataset: { key }, querySelector: () => (kids ? {} : null) });
  const click = (target) => events.click({ target: { closest: (selector) => (selector === 'tbody.session' ? target : null) } });
  const parent = row('section/main', true);
  click(parent);
  assert.equal(context.sel, 'section/main');
  assert.equal(manual.get('section/main').open, true);
  click(parent);
  assert.equal(manual.get('section/main').open, false);
  click(parent);
  assert.equal(manual.get('section/main').open, true);
  // Choosing another row first, then the parent, opens it again instead of closing it.
  click(parent);
  click(row('section/leaf', false));
  assert.equal(context.sel, 'section/leaf');
  assert.equal(manual.has('section/leaf'), false);
  click(parent);
  assert.equal(manual.get('section/main').open, true);
  events.keydown({ key: 'Enter', target: { closest: (selector) => (selector === 'tbody.session' ? parent : null) } });
  assert.equal(manual.get('section/main').open, false);
});

test('selecting a row opens its detail panel and schedules its live log', async () => {
  let refreshed = 0, detailed = 0;
  const classes = new Set(['no-detail']);
  let composed = 0;
  const marked = [];
  const context = vm.createContext({ sel: null, lastState: 'previous', compose: () => { composed++; },
    document: {
      querySelector: () => ({ classList: { remove: (name) => classes.delete(name) } }),
      querySelectorAll: () => [{ classList: { remove: () => marked.push('unmarked old row') } }],
    },
    refresh: async () => { refreshed++; }, detail: () => { detailed++; },
  });
  vm.runInContext(snippet('function choose(el)', '// Choose a session'), context);
  context.choose(null);
  assert.equal(refreshed, 0);
  context.choose({ dataset: { key: 'section/native-child' }, classList: { add: () => marked.push('marked new row') } });
  assert.deepEqual(marked, ['unmarked old row', 'marked new row'], 'the row is marked at once, before any refresh');
  assert.equal(detailed, 1, 'the details panel paints at once, before the board refreshes');
  await Promise.resolve();
  assert.equal(context.sel, 'section/native-child');
  assert.equal(composed, 1, 'the message box follows the new selection at once');
  assert.equal(classes.has('no-detail'), false);
  assert.equal(refreshed, 1);
  assert.equal(detailed, 1);
});

test('details fetch transcript logs for main and native rows and attempt logs for launched tasks', async () => {
  const fetched = [];
  const panel = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, dataset: {}, replaceChildren(...children) { this.children = children; } };
  const context = vm.createContext({
    sel: null, state: [], lastDetail: '', holding: () => false,
    document: { getElementById: () => panel },
    fetch: async (url) => { fetched.push(url); return { json: async () => ({ events: [{ kind: 'says', text: 'Live fixture output.' }] }) }; },
    $: (tag, attrs, ...children) => ({ tag, attrs, children }), fmt: String, cls: String, reportView: () => [], closeDetail() {},
  });
  vm.runInContext(snippet('const atBottom=', 'async function limits()'), context);
  for (const [kind, flags, expected] of [
    ['main', { main: true, outDir: '/main transcript.jsonl' }, 'api/transcript?file=%2Fmain%20transcript.jsonl'],
    ['native', { native: true, outDir: '/child.jsonl' }, 'api/transcript?file=%2Fchild.jsonl'],
    ['task', { run: 'actual-run' }, 'api/events?run=actual-run&task=task'],
  ]) {
    context.sel = `section/${kind}`;
    context.state = [{ id: 'section', tasks: [{ key: kind, id: kind, agent: 'claude', state: 'running', ...flags }] }];
    await context.detail();
    assert.equal(fetched.at(-1), expected);
    assert.match(JSON.stringify(panel.children), /Live fixture output/);
    assert.equal(panel.dataset.sel, `section/${kind}`);
    assert.equal(panel.scrollTop, panel.scrollHeight);
  }
});

// Clicking another row while the panel still fetches the previous row's log must show the new
// row: the earlier fetch, finishing last, used to repaint the panel with the old row's details.
function detailContext(shown) {
  const calls = { pending: [], painted: [], release: () => { for (const release of calls.pending.splice(0)) release(); } };
  const context = vm.createContext({
    sel: 'run/a', lastDetail: '', encodeURIComponent,
    state: [{ id: 'run', tasks: [{ key: 'a', run: 'run', id: 'a' }, { key: 'b', run: 'run', id: 'b' }] }],
    fetch: () => new Promise((resolve) => { calls.pending.push(() => resolve({ json: async () => ({ events: [{ kind: 'says', text: 'fresh' }] }) })); }),
    document: { getElementById: () => ({ dataset: { sel: shown } }) },
    taskAt: (key) => ({ key: key.split('/')[1], run: 'run', id: key.split('/')[1] }),
  });
  vm.runInContext(snippet('// The latest log fetched for each recently shown row', 'async function limits()'), context);
  context.paint = (key, t, ext, ev) => calls.painted.push([key, ev === null ? 'loading' : ev.map((e) => e.text).join()]);
  return { context, calls };
}

test('a log fetch for a row chosen earlier does not repaint the details panel', async () => {
  const { context, calls } = detailContext('run/a');
  const pending = context.detail();
  context.sel = 'run/b';
  calls.release();
  await pending;
  assert.deepEqual(calls.painted, []);
});

// Switching rows used to wait for the whole board and the row's log before anything changed.
test('a newly chosen row paints at once, then again with its fresh log', async () => {
  const { context, calls } = detailContext('run/a');
  context.sel = 'run/b';
  const pending = context.detail();
  assert.deepEqual(calls.painted, [['run/b', 'loading']], 'painted before its log arrived');
  calls.release();
  await pending;
  assert.deepEqual(calls.painted, [['run/b', 'loading'], ['run/b', 'fresh']]);
  // Coming back to it shows the log it last had while the new one loads.
  context.sel = 'run/a';
  const back = context.detail();
  context.sel = 'run/b';
  context.document.getElementById = () => ({ dataset: { sel: 'run/a' } });
  const again = context.detail();
  assert.deepEqual(calls.painted.at(-1), ['run/b', 'fresh']);
  calls.release();
  await Promise.all([back, again]);
});

// Hovering a row loads its log, so choosing it right after paints the log at once, with no
// second load.
test('a row hovered before it is chosen paints its log at once', async () => {
  const { context, calls } = detailContext('run/a');
  context.preload('run/b');
  context.preload('run/b');
  assert.equal(calls.pending.length, 1, 'one load per row at a time');
  calls.release();
  await new Promise((resolve) => setImmediate(resolve));
  context.sel = 'run/b';
  const chosen = context.detail();
  assert.deepEqual(calls.painted, [['run/b', 'fresh']], 'the hovered log paints the moment the row is chosen');
  calls.release();
  await chosen;
});

// Replies show links by what they point at, not as a wall of URL-encoded text.
test('reply links show a short label', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(snippet('function linkLabel(url)', 'function inline(text)'), context);
  assert.equal(context.linkLabel('https://10.0.0.5:8080/dags/CI_SMOKE__example_v1/grid?dag_run_id=manual__2026-11-03T18%3A39%3A02.984980%2B00%3A00'),
    'CI_SMOKE__example_v1 · manual__2026-11-03T18:39:02.984980');
  assert.equal(context.linkLabel('https://github.com/example-org/example-repo/pull/123'), 'example-repo#123');
  assert.equal(context.linkLabel('https://github.com/example-org/example-repo/pull/123#discussion_r123'), 'example-repo#123 (comment)');
  assert.equal(context.linkLabel('https://example.com/a/very/long/path/that/goes/on/and/on/file.txt'), 'example.com/…/file.txt');
});

// The graph view's layout, run from the served page in a bare context. Results cross the context
// boundary through JSON, so they compare as plain data.
function layout() {
  const context = vm.createContext({});
  vm.runInContext(snippet('function graphLayout(', '// The graph view of a section'), context);
  return (nodes, edges = [], options = {}) => JSON.parse(JSON.stringify(context.graphLayout(nodes.map((id) => (typeof id === 'string' ? { id } : id)), edges.map(([from, to]) => ({ from, to })), options)));
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function assertNoOverlap(nodes) {
  for (const [i, a] of nodes.entries()) {
    for (const b of nodes.slice(i + 1)) assert.ok(!overlaps(a, b), `${a.id} and ${b.id} overlap`);
    for (const v of [a.x, a.y, a.w, a.h]) assert.ok(Number.isFinite(v), `${a.id} has a finite position`);
  }
}
// Points along an edge's path (M, cubic C and straight L segments), sampled finely enough that a
// segment through a task's box lands a point inside it.
function edgePoints(d) {
  const points = [];
  let at = null;
  for (const [, cmd, args] of d.matchAll(/([MCL])([^MCL]*)/g)) {
    const n = args.trim().split(/\s+/).map(Number);
    if (cmd === 'M') points.push((at = n));
    else if (cmd === 'L') {
      for (let i = 1; i <= 64; i++) points.push([at[0] + ((n[0] - at[0]) * i) / 64, at[1] + ((n[1] - at[1]) * i) / 64]);
      at = n;
    } else {
      const xs = [at[0], n[0], n[2], n[4]], ys = [at[1], n[1], n[3], n[5]];
      const bez = (p, t) => (1 - t) ** 3 * p[0] + 3 * (1 - t) ** 2 * t * p[1] + 3 * (1 - t) * t ** 2 * p[2] + t ** 3 * p[3];
      for (let i = 1; i <= 64; i++) points.push([bez(xs, i / 64), bez(ys, i / 64)]);
      at = [n[4], n[5]];
    }
  }
  return points;
}
// No edge segment crosses a task's box (touching it at the ends is how it starts and arrives), and
// every edge stays inside the drawing.
function assertEdgesClear(g) {
  for (const e of g.edges) {
    for (const [x, y] of edgePoints(e.d)) {
      assert.ok(x >= 0 && x <= g.width && y >= 0 && y <= g.height, `${e.from} → ${e.to} leaves the drawing at ${x},${y}`);
      for (const n of g.nodes) assert.ok(!(x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h), `${e.from} → ${e.to} crosses ${n.id} at ${x},${y}`);
    }
  }
}

// Lanes stack from the top of the drawing to its bottom without overlapping, in order; each task sits
// inside its lane's band with room for its attention outline and badge, every edge stays inside the
// band of the lane its tasks share, and only the last lane holds the tasks linked to no other.
function assertLanes(g) {
  let y = 0, group = 0;
  const alone = new Set(), names = ['independent · running', 'independent · needs attention', 'independent'];
  for (const [i, lane] of g.lanes.entries()) {
    assert.equal(lane.index, i);
    assert.equal(lane.y, y, `lane ${i} starts where lane ${i - 1} ends`);
    assert.ok(lane.h > 0);
    y = lane.y + lane.h;
    assert.ok(lane.group >= group, 'lanes go by group: running, then needing someone, then the rest');
    group = lane.group;
    if (lane.independent) {
      assert.ok(!alone.has(lane.group), 'one independent lane per group');
      alone.add(lane.group);
      assert.equal(lane.label, names[lane.group]);
      if (lane.group < 2) assert.ok(i === 0 || g.lanes[i - 1].group < lane.group, `${lane.label} leads its group`);
      else assert.equal(i, g.lanes.length - 1, 'the independent lane of finished or planned tasks closes the drawing');
    } else assert.equal(lane.label, null);
  }
  assert.equal(y, g.height, 'the lanes fill the drawing');
  const band = (n) => g.lanes[n.lane];
  for (const n of g.nodes) {
    assert.ok(band(n).ids.includes(n.id), `${n.id} is listed in its lane`);
    assert.ok(n.y - 7 >= band(n).y && n.y + n.h + 4 <= band(n).y + band(n).h, `${n.id} sits inside lane ${n.lane}`);
  }
  assert.deepEqual(g.lanes.flatMap((l) => l.ids).sort(), g.nodes.map((n) => n.id).sort(), 'every task is in exactly one lane');
  const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    assert.equal(at[e.from].lane, at[e.to].lane, `${e.from} → ${e.to} links tasks of one lane`);
    const { y: top, h } = band(at[e.from]);
    for (const [, py] of edgePoints(e.d)) assert.ok(py > top && py < top + h, `${e.from} → ${e.to} stays inside its lane`);
  }
  // The reading order holds every task once: lane by lane; a chain column by column and top to bottom;
  // a grid row by row and left to right.
  assert.deepEqual([...g.order].sort(), g.nodes.map((n) => n.id).sort());
  for (let i = 1; i < g.order.length; i++) {
    const a = at[g.order[i - 1]], b = at[g.order[i]];
    if (a.lane !== b.lane) { assert.ok(a.lane < b.lane, `${a.id} reads before ${b.id}`); continue; }
    const [p, q] = g.lanes[a.lane].independent ? [[a.row, a.layer], [b.row, b.layer]] : [[a.layer, a.row], [b.layer, b.row]];
    assert.ok(p[0] < q[0] || (p[0] === q[0] && p[1] < q[1]), `${a.id} reads before ${b.id}`);
  }
}

test('graphLayout puts each task one column after the longest chain before it', () => {
  const g = layout()(['a', 'b', 'c', 'd', 'solo'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'd']]);
  const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.deepEqual(g.nodes.map((n) => [n.id, n.layer]), [['a', 0], ['b', 1], ['c', 1], ['d', 2], ['solo', 0]], 'a → d also runs through b, so d is in column 2');
  assert.ok(at.a.x < at.b.x && at.b.x === at.c.x && at.c.x < at.d.x, 'columns run left to right');
  assert.deepEqual(g.lanes.map((l) => [l.ids, l.independent]), [[['a', 'b', 'c', 'd'], false], [['solo'], true]], 'solo, linked to no task, has the last lane');
  assert.deepEqual([at.a.lane, at.solo.lane, at.solo.row, at.solo.x], [0, 1, 0, at.a.x]);
  assert.ok(g.width >= at.d.x + at.d.w && g.height >= Math.max(...g.nodes.map((n) => n.y + n.h)), 'the drawing fits its size');
  // Each edge is a cubic curve from the task's right side to its dependent's left side; one that
  // skips a column crosses it on a straight lane of its own.
  const ab = g.edges.find((e) => e.from === 'a' && e.to === 'b');
  assert.deepEqual([ab.x1, ab.y1, ab.x2, ab.y2], [at.a.x + at.a.w, at.a.y + at.a.h / 2, at.b.x, at.b.y + at.b.h / 2]);
  assert.match(ab.d, new RegExp(`^M${ab.x1} ${ab.y1}C[-\\d. ]+ ${ab.x2} ${ab.y2}$`));
  const ad = g.edges.find((e) => e.from === 'a' && e.to === 'd');
  assert.match(ad.d, new RegExp(`^M${ad.x1} ${ad.y1}C[-\\d. ]+ ${at.b.x} [-\\d.]+L${at.b.x + at.b.w} [-\\d.]+C[-\\d. ]+ ${ad.x2} ${ad.y2}$`));
  assertNoOverlap(g.nodes);
  assertEdgesClear(g);
  assertLanes(g);
  assert.deepEqual(layout()([]), { width: 0, height: 0, order: [], nodes: [], edges: [], lanes: [] });
});

test('graphLayout keeps each column in plan order whatever the states in a lane, and keeps tasks put as the plan grows', () => {
  const run = layout();
  // c comes before d in the plan, so it stays above d even though their edges cross.
  const crossed = run(['a', 'b', 'c', 'd'], [['b', 'c'], ['a', 'd'], ['a', 'c']]);
  const at = Object.fromEntries(crossed.nodes.map((n) => [n.id, n]));
  assert.deepEqual([at.c.layer, at.c.row, at.d.layer, at.d.row], [1, 0, 1, 1]);
  assert.ok(at.c.y < at.d.y);
  // Determinism: within one lane, states and other fields, and the order of the edges, move nothing;
  // only the lane's group (running, needs someone, the rest) follows its tasks' states.
  const placed = (g) => ({ ...g, lanes: g.lanes.map(({ group, ...lane }) => lane) });
  const ids = ['setup', 'api', 'db', 'ui', 'docs', 'e2e', 'ship'];
  const edges = [['setup', 'api'], ['setup', 'db'], ['api', 'ui'], ['db', 'ui'], ['docs', 'e2e'], ['ui', 'e2e'], ['e2e', 'ship'], ['api', 'ship']];
  const first = run(ids, edges);
  const states = ['running', 'completed', 'failed', null, 'needs-decision', 'prepared', 'running'];
  assert.deepEqual(placed(run(ids.map((id, i) => ({ id, state: states[i], phase: i % 2 ? 'integrated' : 'awaiting-review', attempts: i, planned: i % 2 === 0 })), edges)), placed(first));
  assert.deepEqual(run(ids, [...edges].reverse()), first);
  assert.deepEqual(run(ids, [...edges, ...edges]), first, 'a repeated edge is drawn once');
  // Within each column of each lane, rows follow plan order.
  for (const key of new Set(first.nodes.map((n) => `${n.lane}/${n.layer}`))) {
    const column = first.nodes.filter((n) => `${n.lane}/${n.layer}` === key);
    assert.deepEqual(column.map((n) => n.row), column.map((_, i) => i), `column ${key} (lane/layer) is in plan order`);
    for (let i = 1; i < column.length; i++) assert.ok(column[i - 1].y < column[i].y);
  }
  assertNoOverlap(first.nodes);
  assertEdgesClear(first);
  assertLanes(first);
  // A task added at the end of the plan and one started outside it: every other task keeps its place.
  const grown = run([...ids, 'late', 'hotfix'], [...edges, ['ship', 'late'], ['setup', 'late']]);
  const before = Object.fromEntries(first.nodes.map((n) => [n.id, n]));
  for (const n of grown.nodes.filter((n) => before[n.id])) assert.deepEqual(n, before[n.id], `${n.id} stays put`);
  assertEdgesClear(grown);
  assertLanes(grown);
  // A task with no dependencies that feeds a late task: its long edge passes below the middle tasks.
  const skip = run(['api', 'ui', 'docs', 'e2e'], [['api', 'ui'], ['ui', 'e2e'], ['docs', 'e2e']]);
  assert.equal(skip.edges.find((e) => e.from === 'docs').d.split('L').length, 2, 'docs → e2e crosses one column');
  assertEdgesClear(skip);
  assertLanes(skip);
});

test('graphLayout never overlaps nodes in a large plan', () => {
  // A fixed pseudo-random plan of 40 tasks, each depending on up to three earlier ones.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const edges = [];
  for (let i = 1; i < ids.length; i++) for (let k = 0; k < 3; k++) if (next() < 0.5) edges.push([ids[Math.floor(next() * i)], ids[i]]);
  const g = layout()(ids, edges);
  assert.equal(g.nodes.length, 40);
  assertNoOverlap(g.nodes);
  assertEdgesClear(g);
  assertLanes(g);
  const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  for (const [from, to] of edges) assert.ok(at[from].layer < at[to].layer, `${from} is left of ${to}`);
});

test('graphLayout cuts a dependency cycle instead of looping, and skips edges it cannot draw', () => {
  const g = layout()(['a', 'b', 'c', 'x', 'x'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'x'], ['a', 'missing']]);
  assert.deepEqual(g.nodes.map((n) => [n.id, n.layer]), [['a', 0], ['b', 1], ['c', 2], ['x', 0]], 'cut at a, the first in plan order; a repeated id is drawn once');
  assert.deepEqual(g.edges.map((e) => [e.from, e.to]), [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  assertNoOverlap(g.nodes);
  // The back edge c → a used to run straight through b. It now runs below every task and still
  // arrives at a's left side from the left.
  assertEdgesClear(g);
  const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  const ca = g.edges.find((e) => e.from === 'c');
  const bottom = Math.max(...g.nodes.filter((n) => n.lane === at.c.lane).map((n) => n.y + n.h));
  assert.ok(edgePoints(ca.d).some(([, y]) => y > bottom), 'c → a passes below the tasks of its lane');
  assert.deepEqual(g.lanes.map((l) => [l.ids, l.independent]), [[['a', 'b', 'c'], false], [['x'], true]]);
  assertLanes(g);
  assert.deepEqual([ca.x1, ca.x2, ca.y2], [at.c.x + at.c.w, at.a.x, at.a.y + at.a.h / 2]);
  assert.match(ca.d, new RegExp(`C[-\\d. ]+ ${at.a.x - 20} ${ca.y2} ${ca.x2} ${ca.y2}$`), 'its last turn ends heading right, where the arrowhead points');
  // Two cycles and nothing else: their back edges take separate channels.
  const two = layout()(['p', 'q', 'r', 's'], [['p', 'q'], ['q', 'p'], ['r', 's'], ['s', 'r']]);
  assert.equal(two.nodes.length, 4);
  assertNoOverlap(two.nodes);
  assertEdgesClear(two);
  assertLanes(two);
  const channels = two.edges.filter((e) => e.x2 < e.x1).map((e) => Math.max(...edgePoints(e.d).map(([, y]) => y)));
  assert.equal(new Set(channels).size, 2, 'one channel per back edge');
  // A cycle in a wider plan, entering a middle column: still clear of every task.
  const wide = layout()(['s', 'a', 'b', 'c', 'd', 'e'], [['s', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'b'], ['s', 'e'], ['e', 'd']]);
  assertNoOverlap(wide.nodes);
  assertEdgesClear(wide);
  assertLanes(wide);
});

test('graphLayout gives each chain of linked tasks a lane, in plan order, and the unlinked tasks the last one', () => {
  const run = layout();
  const ids = ['c', 'a', 'solo1', 'b', 'd', 'solo2', 'e'], edges = [['a', 'b'], ['c', 'd'], ['d', 'e']];
  const g = run(ids, edges);
  assert.deepEqual(g.lanes.map((l) => [l.ids, l.independent]), [[['c', 'd', 'e'], false], [['a', 'b'], false], [['solo1', 'solo2'], true]],
    'lanes come in plan order of their first task; the tasks linked to no other share the last');
  assert.deepEqual(g.nodes.map((n) => [n.id, n.lane, n.layer, n.row]),
    [['c', 0, 0, 0], ['a', 1, 0, 0], ['solo1', 2, 0, 0], ['b', 1, 1, 0], ['d', 0, 1, 0], ['solo2', 2, 1, 0], ['e', 0, 2, 0]]);
  assertLanes(g);
  assertNoOverlap(g.nodes);
  assertEdgesClear(g);
  const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.ok(at.c.x === at.a.x && at.a.x === at.solo1.x && at.d.x === at.b.x && at.b.x === at.solo2.x, 'columns line up across lanes');
  // Lanes stand clearly further apart than rows within one (measured in a grid one column wide).
  const narrow = Object.fromEntries(run(ids, edges, { fit: 1 }).nodes.map((n) => [n.id, n]));
  const rowGap = narrow.solo2.y - (narrow.solo1.y + narrow.solo1.h);
  assert.ok(rowGap > 0);
  for (let i = 1; i < g.lanes.length; i++) {
    const above = g.nodes.filter((n) => n.lane === i - 1), below = g.nodes.filter((n) => n.lane === i);
    const gap = Math.min(...below.map((n) => n.y)) - Math.max(...above.map((n) => n.y + n.h));
    assert.ok(gap >= 2 * rowGap, `lanes ${i - 1} and ${i} are ${gap}px apart, rows ${rowGap}px`);
  }
  // Only the independent lane is labelled, above its tasks.
  assert.deepEqual(g.lanes.map((l) => l.labelY !== null), [false, false, true]);
  const last = g.lanes[2];
  assert.ok(last.labelY > last.y && last.labelY < at.solo1.y - 7, 'the label sits between the band\'s top and its first task');
  // Deterministic, whatever the order of the edges; a new lone task joins the last lane, and nothing else moves.
  assert.deepEqual(run(ids, [...edges].reverse()), g);
  const grown = run([...ids, 'solo3'], edges);
  for (const n of g.nodes) assert.deepEqual(grown.nodes.find((x) => x.id === n.id), n, `${n.id} stays put`);
  assert.deepEqual(grown.lanes.at(-1).ids, ['solo1', 'solo2', 'solo3']);
  // Every task linked: no independent lane. Every task alone: one independent lane.
  assert.ok(run(['a', 'b'], [['a', 'b']]).lanes.every((l) => !l.independent));
  assert.deepEqual(run(['x', 'y']).lanes.map((l) => [l.ids, l.independent]), [[['x', 'y'], true]]);
  // A link added between two lanes merges them into one, in the plan order of its first task.
  assert.deepEqual(run(ids, [...edges, ['b', 'e']]).lanes.map((l) => l.ids), [['c', 'a', 'b', 'd', 'e'], ['solo1', 'solo2']]);
});

test('graphLayout puts lanes with running work first, then those that need someone, then the rest', () => {
  const run = layout();
  const t = (id, state = 'completed', attention = null) => ({ id, state, attention });
  // Four chains (a, b, c, d, in plan order) and three lone tasks.
  const edges = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2']];
  const nodes = [t('a1'), t('a2'), t('lone1'), t('b1', 'running'), t('b2', null), t('c1'), t('c2', 'completed', 'awaiting-review'),
    t('lone2', 'failed', 'failed'), t('d1'), t('d2', 'running'), t('lone3', 'running')];
  const g = run(nodes, edges);
  const lanes = (layout) => layout.lanes.map((l) => [l.ids.join(' '), l.group, l.independent]);
  assert.deepEqual(lanes(g), [['lone3', 0, true], ['b1 b2', 0, false], ['d1 d2', 0, false], ['lone2', 1, true], ['c1 c2', 1, false], ['a1 a2', 2, false], ['lone1', 2, true]],
    'running lanes, then those that need someone, then finished ones, each in plan order; a running or needing lone task leads its group, a finished one closes the drawing');
  assert.deepEqual(g.lanes.map((l) => l.label), ['independent · running', null, null, 'independent · needs attention', null, null, 'independent']);
  const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.deepEqual([at.b1.layer, at.b2.layer, at.d1.layer, at.d2.layer], [0, 1, 0, 1], 'a chain keeps its layering whichever task runs');
  assertLanes(g);
  assertNoOverlap(g.nodes);
  assertEdgesClear(g);
  // A decision or a failure counts as needing someone; a silent task is still running; planned work is the rest.
  assert.deepEqual(lanes(run([t('p', null), t('q', 'needs-decision', 'needs-decision'), t('r', 'running', 'silent'), t('s', 'aborted', 'failed')])),
    [['r', 0, true], ['q s', 1, true], ['p', 2, true]]);
});

test('graphLayout keeps lanes put while their group holds, and moves only the lane whose group changes', () => {
  const run = layout();
  const t = (id, state = 'completed', attention = null) => ({ id, state, attention });
  const edges = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2']];
  const plan = (states) => ['a1', 'a2', 'lone1', 'b1', 'b2', 'c1', 'c2', 'lone2', 'd1', 'd2', 'lone3'].map((id) => t(id, ...(states[id] || [])));
  const base = { b1: ['running'], c2: ['completed', 'awaiting-review'], lone2: ['failed', 'failed'], d2: ['running'], lone3: ['running'] };
  const g = run(plan(base), edges);
  // States change, but every lane and lone task stays in its group: nothing moves.
  const same = { b2: ['running'], b1: ['completed'], c1: ['needs-decision', 'needs-decision'], a1: [null], lone2: ['needs-decision', 'needs-decision'], d2: ['running', 'silent'], lone3: ['running'] };
  assert.deepEqual(run(plan(same), edges), g);
  // d finishes: its lane joins the finished ones, after a in plan order. The lanes above it stay put.
  const moved = run(plan({ ...base, d2: ['completed'] }), edges);
  assert.deepEqual(moved.lanes.map((l) => l.ids.join(' ')), ['lone3', 'b1 b2', 'lone2', 'c1 c2', 'a1 a2', 'd1 d2', 'lone1']);
  const before = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  for (const id of ['lone3', 'b1', 'b2']) assert.deepEqual(moved.nodes.find((n) => n.id === id), before[id], `${id} stays put`);
  assertLanes(moved);
  // a starts running: within the running group it goes by plan order, ahead of b, not by when it started.
  assert.deepEqual(run(plan({ ...base, a1: ['running'] }), edges).lanes.map((l) => l.ids.join(' ')), ['lone3', 'a1 a2', 'b1 b2', 'd1 d2', 'lone2', 'c1 c2', 'lone1']);
  // A lone task that starts running joins the running independent lane, in plan order there.
  assert.deepEqual(run(plan({ ...base, lone1: ['running'] }), edges).lanes.map((l) => l.ids.join(' ')), ['lone1 lone3', 'b1 b2', 'd1 d2', 'lone2', 'c1 c2', 'a1 a2']);
});

test('graphLayout puts running unlinked tasks at the top, never under a chain that awaits review or is planned', () => {
  const run = layout();
  const t = (id, state = 'completed', attention = null) => ({ id, state, attention });
  // The board the user saw: research feeds a design awaiting review, then a planned review; the
  // running tasks are linked to nothing.
  const nodes = [t('research-a'), t('research-b'), t('design', 'completed', 'awaiting-review'), t('review', null), t('testinfra', 'running'),
    t('impl-5', 'running'), t('mode-matrix'), t('impl-1'), t('blocked', 'failed', 'failed')];
  const g = run(nodes, [['research-a', 'design'], ['research-b', 'design'], ['design', 'review']]);
  assert.deepEqual(g.lanes.map((l) => [l.label, l.ids.join(' ')]), [
    ['independent · running', 'testinfra impl-5'], ['independent · needs attention', 'blocked'],
    [null, 'research-a research-b design review'], ['independent', 'mode-matrix impl-1']]);
  const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  for (const id of ['testinfra', 'impl-5']) for (const other of ['research-a', 'design', 'review', 'mode-matrix']) assert.ok(at[id].y < at[other].y, `${id} sits above ${other}`);
  assertLanes(g);
  assertNoOverlap(g.nodes);
  assertEdgesClear(g);
});

test('graphLayout wraps an independent lane into a grid as wide as fits, left to right then top to bottom', () => {
  const run = layout();
  const ids = Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const cells = (g, only = () => true) => g.nodes.filter((n) => only(n.id)).map((n) => [n.layer, n.row]);
  // With no width given, 4 columns: five rows instead of one column of twenty.
  const g = run(ids);
  assert.deepEqual(cells(g), ids.map((_, i) => [i % 4, Math.floor(i / 4)]));
  assert.deepEqual(g.order, ids, 'it reads in plan order');
  assert.ok(g.height < 450, `five rows tall (${g.height}px), not twenty`);
  assertLanes(g);
  assertNoOverlap(g.nodes);
  // As many columns as fit the panel's width: two here, and at least one when none fits.
  const two = 2 * 12 + 2 * 184 + 64;
  const narrow = run(ids, [], { fit: two });
  assert.deepEqual(cells(narrow).slice(0, 3), [[0, 0], [1, 0], [0, 1]]);
  assert.ok(narrow.width <= two);
  assert.deepEqual(new Set(run(ids, [], { fit: 100 }).nodes.map((n) => n.layer)), new Set([0]));
  // At most 4, or as many as the widest chain has columns when that is more.
  assert.equal(Math.max(...run(ids, [], { fit: 10_000 }).nodes.map((n) => n.layer)) + 1, 4);
  const chain = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'], links = chain.slice(1).map((c, i) => [chain[i], c]);
  const wide = run([...chain, ...ids], links, { fit: 10_000 });
  assert.equal(Math.max(...wide.nodes.filter((n) => n.id.startsWith('t')).map((n) => n.layer)) + 1, 6);
  const at = Object.fromEntries(wide.nodes.map((n) => [n.id, n]));
  assert.ok(at.t05.x === at.c5.x && at.t06.x === at.c0.x, 'the grid lines up with the chain\'s columns');
  assertLanes(wide);
  assertNoOverlap(wide.nodes);
  assertEdgesClear(wide);
});

test('clicking a graph node, or pressing Enter on it, chooses its task; the view toggle is remembered', () => {
  const events = {}, chosen = [], picked = [], stored = {}, redrawn = [];
  const context = vm.createContext({
    manual: new Map(), live: new Map(), lastState: 'old', sel: null, isOpen: () => false, refresh: () => {}, redrawSection: (id) => redrawn.push(id),
    getSelection: () => ({ isCollapsed: true }), choose: (el) => chosen.push(el.dataset.key), pick: (row) => picked.push(row),
    sessionStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } },
    document: { getElementById: () => ({ addEventListener: (name, fn) => { events[name] = fn; } }) },
  });
  vm.runInContext(snippet('const graphShown=', '// Rows are rebuilt when data changes'), context);
  vm.runInContext(snippet('document.getElementById("runs").addEventListener("click"', '// Ask once'), context);
  const at = (match, el) => ({ closest: (selector) => (selector.split(',').some((s) => s.startsWith(match)) ? el : null) });
  const node = { dataset: { key: 'section/run~api' } };
  events.click({ target: at('.gnode', node) });
  events.keydown({ key: 'Enter', target: at('.gnode', node) });
  assert.deepEqual(chosen, ['section/run~api', 'section/run~api']);
  assert.deepEqual(picked, [], 'a node is not a tree row: nothing opens or closes');
  events.click({ target: at('.view', { dataset: { run: 'section', view: 'graph' } }) });
  assert.deepEqual(JSON.parse(stored.orchGraphView), ['section']);
  events.click({ target: at('.view', { dataset: { run: 'section', view: 'tree' } }) });
  assert.deepEqual(JSON.parse(stored.orchGraphView), []);
  assert.deepEqual(redrawn, ['section', 'section'], 'each toggle redraws its own section');
});

// A small DOM, enough for the page's own refresh(), section and graph drawing and click handler to
// run under Node: elements with attributes, classes, data-*, focus, and simple selectors (tags,
// classes, [attr="value"], descendants, lists).
function fakeDom() {
  const doc = { activeElement: null, focusCalls: [] };
  const parse = (selector) => selector.split(',').map((part) => part.trim().split(/\s+/).map((compound) => {
    const c = { tag: null, classes: [], attrs: [] };
    const re = /([a-z][a-z0-9]*)|\.([\w-]+)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]/gy;
    let m, at = 0;
    while (at < compound.length && (m = re.exec(compound))) {
      if (m[1]) c.tag = m[1]; else if (m[2]) c.classes.push(m[2]); else c.attrs.push([m[3], m[4]?.replace(/\\(.)/g, '$1')]);
      at = re.lastIndex;
    }
    if (at !== compound.length) throw new Error(`fake DOM cannot parse ${selector}`);
    return c;
  }));
  const one = (el, c) => el.nodeType === 1 && (!c.tag || el.localName === c.tag) && c.classes.every((k) => el.classList.contains(k))
    && c.attrs.every(([k, v]) => el.attributes.has(k) && (v === undefined || el.attributes.get(k) === v));
  const chain = (el, cs) => one(el, cs.at(-1)) && (cs.length === 1 || [...ancestors(el)].some((a) => chain(a, cs.slice(0, -1))));
  function* ancestors(el) { for (let p = el.parentNode; p; p = p.parentNode) yield p; }
  class Text { constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; } get textContent() { return this.data; } }
  class El {
    constructor(tag) { this.nodeType = 1; this.localName = tag; this.attributes = new Map(); this.childNodes = []; this.parentNode = null; this.listeners = {}; this.scrollLeft = 0; }
    get className() { return this.attributes.get('class') || ''; }
    set className(v) { this.attributes.set('class', String(v)); }
    get classList() {
      const list = () => this.className.split(/\s+/).filter(Boolean);
      return { contains: (c) => list().includes(c), add: (c) => { if (!list().includes(c)) this.className = [...list(), c].join(' '); },
        remove: (c) => { this.className = list().filter((x) => x !== c).join(' '); } };
    }
    get dataset() { return Object.fromEntries([...this.attributes].filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v])); }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(new Text(v)); }
    append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? new Text(k) : k; n.parentNode?.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1); n.parentNode = this; this.childNodes.push(n); } }
    replaceChildren(...kids) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...kids); }
    replaceWith(n) { const p = this.parentNode; p.childNodes[p.childNodes.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    *descendants() { for (const c of this.childNodes) if (c.nodeType === 1) { yield c; yield* c.descendants(); } }
    querySelectorAll(selector) { const cs = parse(selector); return [...this.descendants()].filter((e) => cs.some((c) => chain(e, c))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    matches(selector) { return parse(selector).some((c) => chain(this, c)); }
    closest(selector) { for (let x = this; x?.nodeType === 1; x = x.parentNode) if (x.matches(selector)) return x; return null; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    focus(options) { doc.focusCalls.push(JSON.parse(JSON.stringify(options ?? null))); doc.activeElement = this; }
    getBoundingClientRect() { return { top: 0 }; }
    getAnimations() { return []; }
  }
  const byId = Object.fromEntries(['runs', 'detail', 'stamp', 'need', 'grand'].map((id) => [id, new El(id === 'runs' || id === 'detail' ? 'section' : 'span')]));
  const listeners = {};
  Object.assign(doc, {
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    fire: (name, event = {}) => { for (const fn of listeners[name] || []) fn(event); },
    createElement: (t) => new El(t), createElementNS: (ns, t) => new El(t), createTextNode: (t) => new Text(t),
    getElementById: (id) => byId[id] || null, querySelectorAll: (s) => byId.runs.querySelectorAll(s),
  });
  return doc;
}

// The page's board, drawn by its own code into the fake DOM from a state the test changes.
// With `realHold`, the page's own press and selection hold runs too, with its timers run by the test.
function boardPage({ realHold = false } = {}) {
  const doc = fakeDom(), stored = {};
  const page = { doc, root: doc.getElementById('runs'), board: [], fetches: 0, held: false, timers: [], chosen: [], picked: [] };
  const context = vm.createContext({
    document: doc, sessionStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } }, stored,
    matchMedia: () => ({ matches: true }), CSS: { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) },
    fetch: async () => { page.fetches++; return { headers: { get: () => null }, text: async () => JSON.stringify(page.board) }; },
    getSelection: () => ({ isCollapsed: !page.held, anchorNode: page.held ? page.root : null }), tick() {}, compose() {}, preload() {}, detail() {},
    choose: (el) => page.chosen.push(el), pick: (row) => page.picked.push(row), setTimeout: (fn) => page.timers.push(fn),
    ...(realHold ? {} : { holding: () => page.held }),
  });
  if (realHold) vm.runInContext(snippet('let pressed=null,behind=false;', 'async function refresh()'), context);
  vm.runInContext(app.slice(0, app.indexOf('// Choosing a row')), context);
  vm.runInContext(snippet('async function refresh()', "// The agent's structured report"), context);
  vm.runInContext(snippet('function graphLayout(', '// Where the details panel scrolls'), context);
  vm.runInContext(snippet('document.getElementById("runs").addEventListener("click"', '// Ask once'), context);
  page.refresh = () => context.refresh();
  page.run = (code) => vm.runInContext(code, context);
  page.find = (selector, key, value) => page.root.querySelectorAll(selector).find((e) => e.dataset[key] === value) || null;
  page.click = (target) => page.root.listeners.click[0]({ target });
  page.stored = stored;
  return page;
}
const taskRow = (id, extra = {}) => ({ key: `r~${id}`, id, depth: 0, parentKey: null, state: 'running', agent: 'claude', modelLabel: 'opus', mode: 'write',
  attempt: 1, elapsed: '1m', steps: 3, tokensIn: 10, tokensOut: 5, tokensExact: true, now: 'working', ...extra });
const graphNode = (id, extra = {}) => ({ id, title: `Build ${id}`, type: 'implement', agent: 'claude', tier: null, planned: false, ready: false,
  state: 'completed', phase: 'integrated', attempts: 1, attention: null, key: `r~${id}`, delegated: 0, ...extra });
const boardSection = (id) => ({
  id, goal: `Goal ${id}`, createdAt: '2026-11-05T10:00:00Z', attention: [], totals: { running: 1, finished: 1, tokensIn: 20, tokensOut: 10, exact: true },
  tasks: [taskRow('a', { state: 'completed' }), taskRow('b')],
  runs: [{ id: 'r', goal: 'Run r', parent: null, graph: {
    nodes: [graphNode('a'), graphNode('b', { phase: 'awaiting-review', attention: 'awaiting-review' }), graphNode('c', { planned: true, state: null, phase: null, key: null, attempts: 0 })],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] } }],
});

test('a redraw keeps focus on the same tree row, graph node or toggle, and never takes it from outside the board', async () => {
  const page = boardPage(), { doc, root } = page;
  page.board = [boardSection('s1'), boardSection('s2')];
  await page.refresh();
  // Each redraw replaces the focused element; its replacement gets the focus, without scrolling.
  const keeps = async (selector, key, value) => {
    const old = page.find(selector, key, value);
    assert.ok(old, `${selector} ${value} is drawn`);
    old.focus();
    doc.focusCalls.length = 0;
    page.board[1].tasks[1].now = `still working ${Math.random()}`; // any change redraws the whole board
    await page.refresh();
    const now = doc.activeElement;
    assert.notEqual(now, old, 'the board was rebuilt');
    assert.ok(root.contains(now) && now.matches(selector) && now.dataset[key] === value, `focus is back on ${selector} ${value}`);
    assert.deepEqual(doc.focusCalls, [{ preventScroll: true }]);
    assert.equal(page.run('refocusing'), false);
  };
  await keeps('tbody.session', 'key', 's1/r~a');
  await keeps('.view', 'view', 'graph');
  page.run('graphShown.add("s1")');
  page.board[0].goal = 'Graph view now';
  await page.refresh();
  await keeps('.gnode', 'node', 's1/r/b');
  await keeps('.gnode', 'node', 's1/r/c'); // a planned node, which has no task key yet
  // Focus outside the board, such as in the message box, stays where it is.
  const box = doc.createElement('textarea');
  box.focus();
  doc.focusCalls.length = 0;
  page.board[1].tasks[1].now = 'outside';
  await page.refresh();
  assert.equal(doc.activeElement, box);
  assert.deepEqual(doc.focusCalls, []);
});

test('Tree and Graph redraw their own section at once, even with text selected on the board', async () => {
  const page = boardPage(), { doc, root } = page;
  page.board = [boardSection('s1'), boardSection('s2')];
  await page.refresh();
  const other = page.find('.run', 'run', 's2');
  page.held = true; // text is selected in the board: refresh() holds every redraw back
  const fetches = page.fetches;
  const graphButton = root.querySelectorAll('.view').find((b) => b.dataset.run === 's1' && b.dataset.view === 'graph');
  graphButton.focus();
  page.click(graphButton);
  let s1 = page.find('.run', 'run', 's1');
  assert.ok(s1.classList.contains('graph-mode') && s1.querySelector('svg') && !s1.querySelector('table'), 's1 shows its graph at once');
  assert.equal(page.find('.run', 'run', 's2'), other, 'the other section, and the selection in it, are left alone');
  assert.equal(page.fetches, fetches, 'drawn from the board already loaded');
  assert.deepEqual(JSON.parse(page.stored.orchGraphView), ['s1']);
  assert.ok(doc.activeElement.matches('.view[data-view="graph"]') && doc.activeElement.getAttribute('aria-pressed') === 'true' && root.contains(doc.activeElement));
  page.click(root.querySelectorAll('.view').find((b) => b.dataset.run === 's1' && b.dataset.view === 'tree'));
  s1 = page.find('.run', 'run', 's1');
  assert.ok(!s1.classList.contains('graph-mode') && s1.querySelector('table'), 's1 is back to its tree');
  // Other updates still wait for the selection to clear.
  page.board[1].goal = 'Changed';
  await page.refresh();
  assert.equal(page.find('.run', 'run', 's2'), other);
});

test('graph nodes and edges: awaiting review apart from integrated, and edges dashed until met', async () => {
  const page = boardPage();
  page.board = [boardSection('s1')];
  page.run('graphShown.add("s1")');
  await page.refresh();
  const node = (id) => page.find('.gnode', 'node', `s1/r/${id}`);
  assert.ok(node('a').classList.contains('d-ok'), 'integrated is green');
  assert.ok(node('b').classList.contains('d-review') && !node('b').classList.contains('d-ok'), 'awaiting review has its own color');
  assert.ok(node('b').querySelector('text.gword.s-review') && node('a').querySelector('text.gword.s-completed'));
  assert.ok(node('b').querySelector('rect.gattn.a-awaiting-review'));
  const edges = page.root.querySelectorAll('path.gedge');
  assert.deepEqual(edges.map((e) => e.className), ['gedge met', 'gedge'], 'a → b is met (a is integrated); b → c is not yet');
});

test('graph edges and the awaiting-review color stand out by 3:1 or more in both themes', () => {
  const css = fs.readFileSync(new URL('../scripts/dashboard/app.css', import.meta.url), 'utf8');
  const hex6 = (h) => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join('')}` : h);
  const vars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):(#(?:[0-9a-f]{6}|[0-9a-f]{3}))(?![0-9a-f])/gi)].map((m) => [m[1], hex6(m[2])]));
  const light = vars(css.match(/:root\{([^}]*)\}/)[1]);
  const dark = { ...light, ...vars(css.match(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)[1]) };
  const rule = (selector) => css.match(new RegExp(`(?:^|\\})${selector.replace(/\./g, '\\.')}\\{([^}]*)\\}`, 'm'))?.[1];
  const prop = (selector, name) => rule(selector)?.match(new RegExp(`(?:^|;)${name}:([^;]+)`))?.[1];
  const luminance = (hex) => {
    const [r, g, b] = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [theme, colors] of [['light', light], ['dark', dark]]) {
    for (const [selector, name] of [['.gedge', 'stroke'], ['.garrow', 'fill'], ['.gedge.met', 'stroke'], ['.garrow.met', 'fill'], ['.gedge.hot', 'stroke'],
      ['.gnode.d-review .box', 'stroke'], ['.gword.s-review', 'fill'], ['.gattn.a-awaiting-review', 'stroke']]) {
      const value = prop(selector, name);
      assert.match(value || '', /^var\(--[\w-]+\)$/, `${selector} sets ${name} from a theme variable`);
      const color = colors[value.slice(6, -1)];
      for (const bg of ['bg', 'card']) assert.ok(contrast(color, colors[bg]) >= 3, `${theme}: ${selector} ${color} on --${bg} ${colors[bg]} is ${contrast(color, colors[bg]).toFixed(2)}:1`);
    }
    assert.notEqual(colors.review, colors.ok, `${theme}: awaiting review is not the integrated green`);
  }
  assert.match(rule('.gedge'), /stroke-dasharray:\d/, 'an unmet dependency is dashed');
  assert.match(rule('.gedge.met'), /stroke-dasharray:none/, 'a met one is solid');
});

test('each run of a section draws in its own framed panel, headed by its goal, short id and counts', async () => {
  const page = boardPage();
  const sec = boardSection('s1');
  sec.runs[0] = { ...sec.runs[0], id: '20261105-101500-ship-it', goal: 'Ship the feature end to end, with docs, a review and a long goal that the header cuts short' };
  for (const n of sec.runs[0].graph.nodes) if (n.key) n.key = `${sec.runs[0].id}~${n.id}`;
  // A nested run that task a delegated: two tasks linked to no other, so one independent lane.
  sec.runs.push({ id: '20261105-103000-helpers', goal: 'Helpers for a', parent: { run: sec.runs[0].id, task: 'a' }, graph: {
    nodes: [graphNode('x', { key: 'h~x', state: 'running', phase: 'running' }), graphNode('y', { key: 'h~y', attention: 'needs-decision', state: 'needs-decision', phase: 'needs-decision' })], edges: [] } });
  page.board = [sec];
  page.run('graphShown.add("s1")');
  await page.refresh();
  const panels = page.root.querySelectorAll('.gpanel');
  assert.equal(panels.length, 2, 'one panel per run');
  const [main, nested] = panels;
  const text = (panel, selector) => panel.querySelector(selector)?.textContent;
  assert.equal(main.dataset.run, `s1/${sec.runs[0].id}`);
  assert.equal(text(main, '.ghead .ggoal'), sec.runs[0].goal, 'the whole goal, which CSS cuts to one line');
  assert.match(main.querySelector('.ghead').getAttribute('title'), /^Ship the feature end to end.*cuts short\nrun 20261105-101500-ship-it$/);
  assert.equal(text(main, '.ghead .grun'), 'ship-it', 'the short run id');
  assert.equal(text(main, '.ghead .gcount'), '3 tasks · 1 awaiting review');
  assert.equal(main.querySelector('.ghead .gfrom'), null);
  assert.ok(!main.classList.contains('nested'));
  assert.ok(nested.classList.contains('nested') && nested.getAttribute('style') === '--depth:1', 'a nested run is indented under an accent line');
  assert.equal(text(nested, '.ghead .gfrom'), 'delegated by a');
  assert.equal(text(nested, '.ghead .gcount'), '2 tasks · 1 running · 1 needs decision');
  // Each panel holds its own graph, with its own tasks only.
  for (const [panel, run] of [[main, sec.runs[0]], [nested, sec.runs[1]]]) {
    assert.equal(panel.querySelectorAll('svg').length, 1);
    assert.deepEqual(panel.querySelectorAll('.gnode').map((g) => g.dataset.node), run.graph.nodes.map((n) => `s1/${run.id}/${n.id}`));
    assert.ok(panel.querySelector('.gwrap')?.dataset.run === `s1/${run.id}`, 'its scroll box keeps its horizontal scroll across redraws');
  }
  // Lanes: the main run's chain is one band; the nested run's lone running task and lone task that
  // needs a decision each have a labelled band of their group.
  assert.equal(main.querySelectorAll('rect.glane').length, 1);
  assert.equal(main.querySelector('text.glabel'), null);
  assert.deepEqual(nested.querySelectorAll('text.glabel').map((l) => l.textContent), ['independent · running', 'independent · needs attention']);
});

test('Tab follows the drawing: graph nodes are in the page lane by lane, column by column, top to bottom', async () => {
  const page = boardPage();
  const sec = boardSection('s1');
  sec.runs[0].graph = { nodes: [graphNode('done1'), graphNode('b'), graphNode('a'), graphNode('run1', { state: 'running', phase: 'running' }), graphNode('c'), graphNode('done2')],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] };
  page.board = [sec];
  page.run('graphShown.add("s1")');
  await page.refresh();
  const nodes = page.root.querySelectorAll('.gnode');
  assert.deepEqual(nodes.map((g) => g.dataset.node.split('/').pop()), ['run1', 'a', 'b', 'c', 'done1', 'done2'],
    'the running lone task, then the chain from its first column, then the finished lone tasks; plan order was done1 b a run1 c done2');
  assert.ok(nodes.every((g) => g.getAttribute('tabindex') === '0'), 'every node is in the Tab order, in page order');
});

test('a press holds the board until it ends, so the click lands on the element pressed; one redraw then catches up', async () => {
  const page = boardPage({ realHold: true }), { doc, root } = page;
  page.board = [boardSection('s1'), boardSection('s2')];
  page.run('graphShown.add("s1")');
  await page.refresh();
  const settle = async () => { while (page.timers.length) page.timers.shift()(); await new Promise((resolve) => setImmediate(resolve)); };
  for (const [selector, key, value, end] of [['.gnode', 'node', 's1/r/b', 'pointerup'], ['tbody.session', 'key', 's2/r~a', 'pointerup'], ['.gnode', 'node', 's1/r/a', 'pointercancel']]) {
    const pressed = page.find(selector, key, value), fetches = page.fetches;
    doc.fire('pointerdown', { target: pressed });
    page.board[1].tasks[1].now = `busy during ${value} ${end}`;
    await page.refresh(); // a poll lands while the pointer is down
    assert.equal(page.fetches, fetches + 1);
    assert.ok(root.contains(pressed), `${value} is still on the board while pressed`);
    doc.fire(end, {});
    if (end === 'pointerup') page.click(pressed); // the browser's click follows the release, before any timer
    assert.ok(root.contains(pressed), 'the click is handled before the board catches up');
    await settle();
    assert.equal(page.fetches, fetches + 2, 'one redraw catches up');
    assert.ok(!root.contains(pressed) && page.find(selector, key, value), 'the board is redrawn after the release');
  }
  assert.deepEqual(page.chosen.map((g) => g.dataset.node), ['s1/r/b'], 'the pressed graph node is chosen');
  assert.deepEqual(page.picked.map((row) => row.dataset.key), ['s2/r~a'], 'the pressed tree row is chosen');
  // Without a press, a poll redraws at once.
  page.board[1].tasks[1].now = 'no press';
  const before = page.find('tbody.session', 'key', 's2/r~a');
  await page.refresh();
  assert.ok(!root.contains(before));
});
