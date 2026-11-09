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

// A small DOM, enough for the page's own refresh(), section drawing and click handler to
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
  const page = { doc, root: doc.getElementById('runs'), board: [], fetches: 0, held: false, timers: [], picked: [] };
  const context = vm.createContext({
    document: doc, sessionStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } }, stored,
    matchMedia: () => ({ matches: true }), CSS: { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) },
    fetch: async () => { page.fetches++; return { headers: { get: () => null }, text: async () => JSON.stringify(page.board) }; },
    getSelection: () => ({ isCollapsed: !page.held, anchorNode: page.held ? page.root : null }), tick() {}, compose() {}, preload() {}, detail() {},
    pick: (row) => page.picked.push(row), setTimeout: (fn) => page.timers.push(fn),
    ...(realHold ? {} : { holding: () => page.held }),
  });
  if (realHold) vm.runInContext(snippet('let pressed=null,behind=false;', 'async function refresh()'), context);
  vm.runInContext(app.slice(0, app.indexOf('// Choosing a row')), context);
  vm.runInContext(snippet('async function refresh()', "// The agent's structured report"), context);
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
const boardSection = (id) => ({
  id, goal: `Goal ${id}`, createdAt: '2026-11-05T10:00:00Z', attention: [], totals: { running: 1, finished: 1, tokensIn: 20, tokensOut: 10, exact: true },
  tasks: [taskRow('a', { state: 'completed' }), taskRow('b')],
  runs: [{ id: 'r', goal: 'Run r', parent: null }],
});

test('a redraw keeps focus on the same tree row or toggle, and never takes it from outside the board', async () => {
  const page = boardPage(), { doc, root } = page;
  page.board = [boardSection('s1'), boardSection('s2')];
  page.board[0].tasks.push(taskRow('old', { state: 'completed', older: true })); // folded away: the section's toggle shows
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
  await keeps('.older', 'run', 's1');
  // Focus outside the board, such as in the message box, stays where it is.
  const box = doc.createElement('textarea');
  box.focus();
  doc.focusCalls.length = 0;
  page.board[1].tasks[1].now = 'outside';
  await page.refresh();
  assert.equal(doc.activeElement, box);
  assert.deepEqual(doc.focusCalls, []);
});

test('the older toggle redraws its own section at once, even with text selected on the board', async () => {
  const page = boardPage(), { doc, root } = page;
  page.board = [boardSection('s1'), boardSection('s2')];
  page.board[0].tasks.push(taskRow('old', { state: 'completed', older: true }));
  await page.refresh();
  const other = page.find('.run', 'run', 's2');
  assert.equal(page.find('tbody.session', 'key', 's1/r~old'), null, 'the older row is folded away');
  page.held = true; // text is selected in the board: refresh() holds every redraw back
  const fetches = page.fetches;
  const button = page.find('.older', 'run', 's1');
  assert.equal(button.textContent, 'show 1 older');
  button.focus();
  page.click(button);
  assert.ok(page.find('tbody.session', 'key', 's1/r~old'), 's1 lists its older row at once');
  assert.equal(page.find('.run', 'run', 's2'), other, 'the other section, and the selection in it, are left alone');
  assert.equal(page.fetches, fetches, 'drawn from the board already loaded');
  assert.ok(doc.activeElement.matches('.older[data-run="s1"]') && root.contains(doc.activeElement), 'the toggle keeps the focus');
  assert.equal(doc.activeElement.textContent, 'hide older');
  page.click(page.find('.older', 'run', 's1'));
  assert.equal(page.find('tbody.session', 'key', 's1/r~old'), null, 's1 folds it away again');
  // Other updates still wait for the selection to clear.
  page.board[1].goal = 'Changed';
  await page.refresh();
  assert.equal(page.find('.run', 'run', 's2'), other);
});

test('a press holds the board until it ends, so the click lands on the element pressed; one redraw then catches up', async () => {
  const page = boardPage({ realHold: true }), { doc, root } = page;
  page.board = [boardSection('s1'), boardSection('s2')];
  await page.refresh();
  const settle = async () => { while (page.timers.length) page.timers.shift()(); await new Promise((resolve) => setImmediate(resolve)); };
  for (const [selector, key, value, end] of [['tbody.session', 'key', 's1/r~b', 'pointerup'], ['tbody.session', 'key', 's2/r~a', 'pointerup'], ['tbody.session', 'key', 's1/r~a', 'pointercancel']]) {
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
  assert.deepEqual(page.picked.map((row) => row.dataset.key), ['s1/r~b', 's2/r~a'], 'each pressed tree row is chosen; a cancelled press chooses none');
  // Without a press, a poll redraws at once.
  page.board[1].tasks[1].now = 'no press';
  const before = page.find('tbody.session', 'key', 's2/r~a');
  await page.refresh();
  assert.ok(!root.contains(before));
});
