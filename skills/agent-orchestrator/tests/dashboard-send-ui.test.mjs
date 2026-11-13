import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The send box of the dashboard page, driven through its real handlers. The page is the served
// index.html (parsed into a small fake DOM) running the whole served app.js in a vm context, against
// a fake dashboard server whose sends and board reads the test answers one by one, in the order it
// chooses. No sockets, no timers and no sleeps: every wait is a handshake with the fake server or a
// few turns of the event loop for promises that are already settled.
const dashboard = new URL('../scripts/dashboard/', import.meta.url);
const script = fs.readFileSync(new URL('app.js', dashboard), 'utf8');
const markup = fs.readFileSync(new URL('index.html', dashboard), 'utf8');

const RUN = 'run-a';
const HINT = 'the agent is mid-step; use steer to interrupt';
// The host's own time format, whatever its locale: the page formats times the same way, so a test that
// needs a time asks `page.time` and never writes one out.
const hostTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---- a small DOM: just what the page's scripts call -------------------------------------------
class Text {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
}
function matchesCompound(el, part) {
  const m = /^([\w-]*)((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(part);
  assert.ok(m, `the fake DOM does not support the selector part ${part}`);
  if (m[1] && el.localName !== m[1]) return false;
  for (const [, kind, name, attr, , value] of m[2].matchAll(/([.#])([\w-]+)|\[([\w-]+)(?:=(["']?)([^\]"']*)\4)?\]/g)) {
    if (kind === '.' && !el.classes().includes(name)) return false;
    if (kind === '#' && el.attrs.id !== name) return false;
    if (attr && (!(attr in el.attrs) || (value !== undefined && el.attrs[attr] !== value))) return false;
  }
  return true;
}
function matchesSelector(el, selector) {
  return selector.split(',').some((alternative) => {
    const parts = alternative.trim().split(/\s+/);
    if (!matchesCompound(el, parts.pop())) return false;
    let node = el;
    for (let i = parts.length - 1; i >= 0; i--) {
      node = node.parentNode;
      while (node && !(node.nodeType === 1 && matchesCompound(node, parts[i]))) node = node.parentNode;
      if (!node) return false;
    }
    return true;
  });
}
class El {
  constructor(tag, document) {
    Object.assign(this, { nodeType: 1, localName: tag, tagName: tag.toUpperCase(), attrs: {}, dataset: {}, children: [], parentNode: null, listeners: {}, document,
      hidden: false, disabled: false, checked: false, value: '', className: '', title: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0,
      style: { setProperty() {}, removeProperty() {} } });
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.classes(), ...names])].join(' '); },
      remove: (...names) => { this.className = this.classes().filter((c) => !names.includes(c)).join(' '); },
      contains: (name) => this.classes().includes(name),
    };
  }
  classes() { return this.className.split(/\s+/).filter(Boolean); }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this.replaceChildren(...(String(value) === '' ? [] : [String(value)])); }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'class') this.className = String(value);
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
    else if (name === 'hidden') this.hidden = true;
    else if (name === 'checked') this.checked = true;
    else if (name === 'title') this.title = String(value);
  }
  // A browser turns anything that is not a node into text, null included.
  append(...kids) { for (const kid of kids) { const node = kid && typeof kid === 'object' ? kid : new Text(kid); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...kids) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { return Promise.all((this.listeners[type] || []).map((fn) => fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event }))); }
  requestSubmit() { this.lastSubmit = this.dispatch('submit'); }
  click() { return this.dispatch('click'); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) { return this.children.flatMap((c) => (c.nodeType === 1 ? [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)] : [])); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.document.activeElement = this; }
  blur() { if (this.document.activeElement === this) this.document.activeElement = null; }
  getBoundingClientRect() { return { top: 0 }; }
  getAnimations() { return []; }
  animate() {}
  scrollTo() {}
  scrollIntoView() {}
}
function parseMarkup(source) {
  const document = { activeElement: null, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } };
  const root = new El('html', document), open = [root], ids = new Map(), voids = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'path']);
  for (const m of source.matchAll(/<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)/gi)) {
    const [, closing, tag, attrs = '', text] = m;
    if (text !== undefined) { open.at(-1).append(text); continue; }
    if (!tag) continue;
    const name = tag.toLowerCase();
    if (closing) { while (open.length > 1 && open.pop().localName !== name); continue; }
    const el = new El(name, document);
    for (const a of attrs.matchAll(/([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '');
    if (el.attrs.id) ids.set(el.attrs.id, el);
    open.at(-1).append(el);
    if (!voids.has(name) && !attrs.trimEnd().endsWith('/')) open.push(el);
  }
  Object.assign(document, {
    documentElement: root,
    getElementById: (id) => ids.get(id) || null,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createElement: (tag) => new El(tag, document),
    createElementNS: (ns, tag) => new El(tag, document),
    createTextNode: (data) => new Text(data),
  });
  return document;
}

// ---- a fake dashboard server ------------------------------------------------------------------
class Board {
  constructor(clock, tasks) {
    this.clock = clock; this.tasks = new Map(tasks.map((id) => [id, []])); this.hidden = new Set(); this.count = 0; this.hold = false;
    // How the next board reads are answered: extra response headers (a cached board carries x-orch-stale and
    // x-orch-error), a refusing status with its body, or no connection at all.
    this.headers = {}; this.status = 200; this.failure = ''; this.down = false;
  }
  // The server's cache could not rebuild the board: it answers with the last one, marked stale.
  goStale(age, error) { this.headers = { 'x-orch-stale': String(age), ...(error === undefined ? {} : { 'x-orch-error': error }) }; }
  goFresh() { this.headers = {}; }
  add(task, { text, from = 'user', read = false, images = 0 }) {
    const message = { id: `m${++this.count}`, time: new Date(this.clock.now).toISOString(), attempt: 1, read, from, text, ...(images ? { images } : {}) };
    this.tasks.get(task).push(message);
    return message;
  }
  markRead(task, id) { this.tasks.get(task).find((m) => m.id === id).read = true; }
  // A cached board that has not rebuilt yet lists nothing of a message until it is shown.
  hide(id) { this.hidden.add(id); }
  show(id) { this.hidden.delete(id); }
  snapshot() {
    const tasks = [...this.tasks].map(([id, stored]) => {
      const listed = stored.filter((m) => !this.hidden.has(m.id)), unread = listed.filter((m) => !m.read);
      return { key: id, id, run: RUN, agent: 'claude', model: 'm', modelLabel: 'm', mode: 'write', state: 'running', phase: 'running', health: 'ok', attempt: 1, elapsed: '1m', steps: 3,
        tokensIn: 1, tokensOut: 1, tokensExact: true, depth: 0, closed: false,
        ...(listed.length ? { inbox: { unread: unread.length, read: listed.length - unread.length, lastSentAt: listed.at(-1).time,
          unreadMessages: unread.map(({ id: mid, time, text }) => ({ id: mid, time, text })), messages: listed.slice(-20).map((m) => ({ ...m })),
          ...(this.delivery && unread.length ? { delivery: { how: 'idle', text: this.delivery } } : {}) } } : {}) };
    });
    return [{ id: RUN, goal: 'demo run', createdAt: new Date(this.clock.now).toISOString(), running: true, activeMs: this.clock.now, runs: [], attention: [],
      totals: { tokensIn: 1, tokensOut: 1, running: 1, finished: 0, exact: true }, tasks }];
  }
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 8; i++) await turn(); };

// `time` stands in for the browser's time formatter (a function of milliseconds), so a test can run the
// page under a locale whatever the host's is; `setup` prepares the board before the page's first read.
async function openPage({ tasks = ['alpha', 'beta'], time, setup } = {}) {
  const clock = { now: Date.UTC(2026, 10, 9, 12, 0, 0) };
  const board = new Board(clock, tasks);
  if (setup) setup(board);
  const document = parseMarkup(markup);
  const calls = [], held = [];
  const storage = () => { const kept = new Map(); return { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); }, removeItem: (k) => { kept.delete(k); } }; };
  const local = storage();
  local.setItem('orchSendKey', 'a'.repeat(48));
  const answer = (status, json) => ({ ok: status < 400, status, json: async () => json });
  const fetch = async (url, init = {}) => {
    if (url === 'api/state') {
      if (board.down) throw new TypeError('Failed to fetch');
      // The answer is fixed when the read starts, however late the test releases it.
      const headers = { ...board.headers }, status = board.status, body = status < 400 ? JSON.stringify(board.snapshot()) : board.failure;
      const response = { ok: status < 400, status, headers: { get: (name) => (name === 'x-orch-server' ? 'one' : headers[name] ?? null) }, text: async () => body };
      return board.hold ? new Promise((resolve) => { held.push(() => resolve(response)); }) : response;
    }
    if (String(url).startsWith('api/events')) return answer(200, { events: [] });
    if (url === 'api/usage') return answer(200, {});
    if (url === 'api/send' || url === 'api/steer') {
      return new Promise((resolve, reject) => {
        const call = { url, init, body: JSON.parse(init.body), headers: init.headers, taken: false, reply: null,
          // What the server does with the message, apart from answering: it is stored once.
          store() {
            this.reply ||= (() => {
              const m = board.add(this.body.task, { text: this.body.text.trim(), images: this.body.images.length });
              return { id: m.id, time: m.time, attempt: 1, images: [], delivery: 'queued for the orch-inbox hook', reaches: true, ...(this.body.steer ? { steer: { waiting: 'no shell command is running' } } : {}) };
            })();
            return this.reply;
          },
          reply200(extra = {}) { resolve(answer(200, { ...this.store(), ...extra })); },
          refuse(status, json) { resolve(answer(status, json)); },
          lose() { reject(new TypeError('Failed to fetch')); },
        };
        calls.push(call);
      });
    }
    throw new Error(`the page fetched an unexpected ${url}`);
  };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  }
  if (time) FakeDate.prototype.toLocaleTimeString = function toLocaleTimeString() { return time(this.getTime()); };
  class FakeURL extends URL { static createObjectURL() { return 'blob:fake'; } static revokeObjectURL() {} }
  class Silent { observe() {} addEventListener() {} }
  class FakeFileReader { readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; queueMicrotask(() => this.onload()); } }
  const sandbox = {
    document, fetch, Date: FakeDate, URL: FakeURL, FileReader: FakeFileReader, localStorage: local, sessionStorage: storage(), EventSource: Silent, ResizeObserver: Silent, MutationObserver: Silent,
    location: { hash: '', pathname: '/', search: '', reload() {} }, history: { replaceState() {} }, getSelection: () => ({ isCollapsed: true, anchorNode: null }),
    matchMedia: () => ({ matches: true }), CSS: { escape: (v) => String(v) }, innerWidth: 1200, addEventListener() {}, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {},
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx);
  await flush();

  const el = (id) => document.getElementById(id);
  const text = (id) => el(id).textContent;
  const page = {
    ctx, board, clock, calls, held, local, el, text,
    time: time || hostTime,
    // The page's status mark: a green dot while live, red text when it is not.
    stamp() { const mark = el('stamp'); return { className: mark.className, text: mark.textContent, title: mark.title }; },
    json: (expression) => JSON.parse(JSON.stringify(vm.runInContext(expression, ctx))),
    // Click a task's row, as a reader does.
    async choose(task) {
      const row = el('runs').querySelector(`tbody.session[data-key="${RUN}/${task}"]`);
      assert.ok(row, `the board lists ${task}`);
      await el('runs').dispatch('click', { target: row });
      await flush();
    },
    type(value) { el('compose-text').value = value; },
    // Enter in the box. Returns the promise of the whole send, which settles when the test has answered it.
    enter(extra = {}) { el('compose-text').dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...extra }); return el('compose').lastSubmit; },
    async next(url = 'api/send') {
      for (let i = 0; i < 50; i++) {
        const call = calls.find((c) => c.url === url && !c.taken);
        if (call) { call.taken = true; return call; }
        await turn();
      }
      throw new Error(`the page never called ${url}`);
    },
    // A board read like the page's own timer: the state, then the panel.
    async poll() { await vm.runInContext('refresh().then(detail)', ctx); await flush(); },
    releaseReads(...order) { for (const i of order) held[i](); },
    tick() { vm.runInContext('tick()', ctx); },
    // What the thread in the details panel and the queue under it show.
    thread() { return el('detail').querySelectorAll('.msg').map((m) => { const [who, , label] = m.querySelector('.k').textContent.split(' · '); return [who, label, m.querySelector('pre').textContent]; }); },
    queue() { const box = el('compose-queue'); return { hidden: box.hidden, head: box.querySelector('.qh')?.textContent ?? null, rows: box.querySelectorAll('.q').map((r) => r.textContent), hint: box.querySelectorAll('.qhint').map((h) => h.textContent) }; },
    entries(task) { return page.json(`(pending.get("${RUN}/${task}")||[]).map(e=>({status:e.status,id:e.id,text:e.text,error:e.error}))`); },
  };
  return page;
}

// Open a page with the first task chosen and the box ready.
async function ready(options) { const page = await openPage(options); await page.choose('alpha'); return page; }

test('Enter puts the message in the thread at once, marked sending, before the server answers', async () => {
  const page = await ready();
  page.type('  Use the v2 API  ');
  const done = page.enter();
  // Nothing has been awaited yet: the thread and the queue already show it, and the box still holds it.
  assert.deepEqual(page.thread(), [['you', 'sending…', 'Use the v2 API']]);
  assert.equal(page.queue().head, 'Waiting for the agent (1)');
  assert.match(page.queue().rows[0], /sending….*Use the v2 API$/);
  assert.equal(page.el('compose-text').value, '  Use the v2 API  ');
  assert.equal(page.el('compose-send').disabled, true);
  assert.equal(page.text('compose-status'), 'Sending…');
  const call = await page.next();
  assert.deepEqual(call.body, { run: RUN, task: 'alpha', text: 'Use the v2 API', images: [], steer: true });
  assert.equal(call.headers['x-orch-token'], 'a'.repeat(48));
  // Still in flight, and a read of a board that does not have it yet changes nothing.
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'sending…', 'Use the v2 API']]);
  // The server stores it and answers with its id; reads are held, so only the reply has changed things.
  page.board.hold = true;
  const reply = call.store();
  call.reply200();
  await done;
  assert.deepEqual(page.thread(), [['you', 'queued', 'Use the v2 API']]);
  assert.deepEqual(page.entries('alpha'), [{ status: 'queued', id: reply.id, text: 'Use the v2 API', error: null }]);
  assert.match(page.queue().head, /^Waiting for the agent \(1\)/);
  assert.equal(page.el('compose-text').value, '');
  assert.match(page.text('compose-status'), /^Sent at /);
  // The board catches up: the server's copy takes the entry's place, with no second line.
  page.board.hold = false;
  page.releaseReads(...page.held.keys());
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'Use the v2 API']]);
  assert.deepEqual(page.entries('alpha'), []);
  assert.equal(page.queue().rows.length, 1);
  // The agent reads it: the same line now says read, and nothing is queued.
  page.board.markRead('alpha', reply.id);
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'read', 'Use the v2 API']]);
  assert.equal(page.queue().hidden, true);
});

test('Shift+Enter adds a line and sends nothing', async () => {
  const page = await ready();
  page.type('one');
  assert.equal(page.enter({ shiftKey: true }), undefined);
  assert.deepEqual(page.thread(), []);
  assert.equal(page.calls.length, 0);
});

test('a queued message stays in the thread until the board lists it, and is never shown twice', async () => {
  const page = await ready();
  page.type('first');
  const done = page.enter();
  const call = await page.next();
  const { id } = call.store();
  page.board.hide(id); // the board has not rebuilt yet
  call.reply200();
  await done;
  await flush();
  for (let i = 0; i < 2; i++) {
    await page.poll();
    assert.deepEqual(page.thread(), [['you', 'queued', 'first']], 'kept while the board lacks it');
    assert.equal(page.queue().rows.length, 1);
  }
  page.board.show(id);
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'queued', 'first']]);
  assert.equal(page.queue().rows.length, 1);
  assert.deepEqual(page.entries('alpha'), []);
});

test('a read that lands between the server storing a message and its reply does not duplicate it', async () => {
  const page = await ready();
  page.type('between');
  const done = page.enter();
  const call = await page.next();
  call.store();
  await page.poll(); // the board lists it while the send has no id yet
  assert.deepEqual(page.thread(), [['you', 'queued', 'between']]);
  assert.equal(page.queue().rows.length, 1);
  call.reply200();
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'between']]);
  assert.deepEqual(page.entries('alpha'), []);
});

test('a lookalike from another sender is not taken for this send once the reply names another id', async () => {
  const page = await ready();
  page.type('ok');
  const done = page.enter();
  const call = await page.next();
  page.board.add('alpha', { text: 'ok' }); // another tab sent the same words
  await page.poll();
  assert.equal(page.thread().length, 1, 'one line while the two cannot be told apart');
  const own = call.store();
  assert.notEqual(own.id, 'm1');
  page.board.hide(own.id);
  call.reply200();
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'ok'], ['you', 'queued', 'ok']]);
  page.board.show(own.id);
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'queued', 'ok'], ['you', 'queued', 'ok']]);
  assert.deepEqual(page.entries('alpha'), []);
});

test('a message sent just after another with the same words is not matched to the first one', async () => {
  const page = await ready();
  page.type('ok');
  let done = page.enter();
  const first = await page.next();
  const firstId = first.store().id;
  page.board.hide(firstId);
  first.reply200();
  await done;
  await flush();
  page.type('ok');
  done = page.enter();
  const second = await page.next();
  page.board.show(firstId); // the board now lists the first message only
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'queued', 'ok'], ['you', 'sending…', 'ok']]);
  const secondId = second.store().id;
  second.reply200();
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'ok'], ['you', 'queued', 'ok']]);
  assert.deepEqual(page.entries('alpha'), []);
  assert.deepEqual(page.json('[...pending.keys()]'), []);
  assert.notEqual(firstId, secondId);
});

test('a failed send is marked failed with its error, and the text stays in the box', async () => {
  const page = await ready();
  page.type('hello');
  const done = page.enter();
  const call = await page.next();
  call.refuse(409, { error: 'task alpha is not running (completed); resume it with a delta brief' });
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'failed', 'hello']]);
  assert.match(page.el('detail').querySelector('.msg .state').textContent, /^Not sent: task alpha is not running \(completed\)/);
  assert.deepEqual(page.entries('alpha'), [{ status: 'failed', id: null, text: 'hello', error: 'task alpha is not running (completed); resume it with a delta brief' }]);
  assert.equal(page.el('compose-text').value, 'hello');
  assert.equal(page.el('compose-send').disabled, false);
  assert.equal(page.el('compose-status').className, 'bad');
  assert.match(page.text('compose-status'), /^Not sent: task alpha is not running/);
  assert.equal(page.queue().hidden, true, 'a failed message is not queued');
  assert.equal(page.board.tasks.get('alpha').length, 0);
});

test('sending again replaces the failed line, whether the failure was a refusal or a lost connection', async () => {
  const page = await ready();
  page.type('hello');
  let done = page.enter();
  (await page.next()).lose();
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'failed', 'hello']]);
  assert.match(page.el('detail').querySelector('.msg .state').textContent, /^Not sent: the dashboard is not reachable/);
  assert.equal(page.el('compose-text').value, 'hello');
  done = page.enter();
  assert.deepEqual(page.thread(), [['you', 'sending…', 'hello']], 'the failed line gives way to the new send');
  const call = await page.next();
  call.reply200();
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'hello']]);
  assert.equal(page.el('compose-text').value, '');
  assert.deepEqual(page.entries('alpha'), []);
});

test('a refused send key is reported in the thread and forgotten', async () => {
  const page = await ready();
  page.type('hello');
  const done = page.enter();
  (await page.next()).refuse(403, { key: 'rejected', error: 'bad key' });
  await done;
  await flush();
  assert.equal(page.local.getItem('orchSendKey'), null);
  assert.match(page.el('detail').querySelector('.msg .state').textContent, /^Not sent: This browser has no key for sending messages yet/);
  assert.equal(page.el('compose-text').value, 'hello');
});

test('a failed line can be dismissed', async () => {
  const page = await ready();
  page.type('hello');
  const done = page.enter();
  (await page.next()).refuse(500, {});
  await done;
  await flush();
  assert.match(page.el('detail').querySelector('.msg .state').textContent, /^Not sent: HTTP 500/);
  await page.el('detail').querySelector('.msg button').click();
  assert.deepEqual(page.thread(), []);
  assert.deepEqual(page.entries('alpha'), []);
  assert.equal(page.el('compose-text').value, 'hello');
});

test('a send whose reply was lost but which the server stored shows once, as the board lists it', async () => {
  const page = await ready();
  page.type('stored');
  const done = page.enter();
  const call = await page.next();
  call.store();
  call.lose();
  await done;
  await flush();
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'queued', 'stored']]);
});

test('an older read that answers after a newer one does not take the board back', async () => {
  const page = await ready();
  page.type('hello');
  const done = page.enter();
  const call = await page.next();
  const { id } = call.store();
  page.board.hide(id);
  call.reply200();
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'hello']]);
  // Two reads in flight: the first saw the board before the message was listed, the second after.
  page.board.hold = true;
  const stale = vm.runInContext('refresh().then(detail)', page.ctx);
  page.board.show(id);
  const fresh = vm.runInContext('refresh().then(detail)', page.ctx);
  page.board.hold = false;
  assert.equal(page.held.length, 2);
  page.releaseReads(1);
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'hello']]);
  assert.deepEqual(page.entries('alpha'), []);
  page.releaseReads(0);
  await Promise.all([stale, fresh]);
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'hello']], 'the stale read was dropped, not shown as an empty thread');
  assert.equal(page.queue().rows.length, 1);
});

test('choosing another task while a send is in flight keeps each task its own message and draft', async () => {
  const page = await ready();
  page.type('for alpha');
  const done = page.enter();
  const call = await page.next();
  await page.choose('beta');
  assert.deepEqual(page.thread(), [], "alpha's message is not in beta's thread");
  assert.equal(page.queue().hidden, true);
  assert.equal(page.el('compose-text').value, '');
  page.type('draft for beta');
  const { id } = call.store();
  call.reply200();
  await done;
  await flush();
  assert.equal(page.el('compose-text').value, 'draft for beta', "beta's draft is untouched by alpha's reply");
  assert.deepEqual(page.thread(), []);
  await page.choose('alpha');
  assert.deepEqual(page.thread(), [['you', 'queued', 'for alpha']]);
  assert.equal(page.el('compose-text').value, '', 'sent, so no draft is left for alpha');
  assert.equal(page.json('[...pending.keys()]').length, 0);
  assert.equal(page.board.tasks.get('alpha')[0].id, id);
  await page.choose('beta');
  assert.equal(page.el('compose-text').value, 'draft for beta');
});

test('a send that fails after another task was chosen leaves its failed line and its draft with its own task', async () => {
  const page = await ready();
  page.type('for alpha');
  const done = page.enter();
  const call = await page.next();
  await page.choose('beta');
  call.refuse(400, { error: 'nope' });
  await done;
  await flush();
  assert.deepEqual(page.thread(), []);
  assert.equal(page.text('compose-status'), '', "beta's status line does not report alpha's failure");
  await page.choose('alpha');
  assert.deepEqual(page.thread(), [['you', 'failed', 'for alpha']]);
  assert.equal(page.el('compose-text').value, 'for alpha');
});

test('a message queued unread for 30 seconds gets a one-line hint about interrupting', async () => {
  const page = await ready();
  page.type('please look at this');
  const done = page.enter();
  const call = await page.next();
  assert.deepEqual(page.queue().hint, [], 'not while sending');
  page.clock.now += 120_000;
  page.tick();
  assert.deepEqual(page.queue().hint, [], 'a send still in flight is not a queued message');
  call.reply200();
  await done;
  await flush();
  assert.deepEqual(page.queue().hint, []);
  page.clock.now += 29_000;
  page.tick();
  assert.deepEqual(page.queue().hint, []);
  page.clock.now += 1_000;
  page.tick();
  assert.deepEqual(page.queue().hint, [HINT]);
  assert.equal(HINT, 'the agent is mid-step; use steer to interrupt');
  assert.equal(page.queue().rows.length, 1);
  // A redraw keeps it, and one more tick adds no second line.
  page.tick();
  await page.poll();
  assert.deepEqual(page.queue().hint, [HINT]);
  // Once the agent reads it, the queue and the hint go.
  page.board.markRead('alpha', page.board.tasks.get('alpha')[0].id);
  await page.poll();
  assert.equal(page.queue().hidden, true);
  assert.deepEqual(page.queue().hint, []);
});

test('the hint counts from when the message was queued, even while the board has not listed it', async () => {
  const page = await ready();
  page.type('slow board');
  const done = page.enter();
  const call = await page.next();
  page.board.hide(call.store().id);
  call.reply200();
  await done;
  await flush();
  page.clock.now += 30_000;
  page.tick();
  assert.deepEqual(page.queue().hint, [HINT]);
});

test('an unread message already on the board gets the hint by its own time, and only in its own task', async () => {
  const page = await openPage();
  page.board.add('alpha', { text: 'sent earlier', from: 'orchestrator' });
  page.clock.now += 45_000;
  await page.choose('alpha');
  assert.deepEqual(page.queue().hint, [HINT]);
  assert.deepEqual(page.thread(), [['orchestrator', 'queued', 'sent earlier']]);
  await page.choose('beta');
  assert.equal(page.queue().hidden, true);
  assert.deepEqual(page.queue().hint, []);
  page.clock.now += 60_000;
  page.tick();
  assert.deepEqual(page.queue().hint, [], 'beta has nothing queued');
});

test('a waiting message shows whole, and the board\'s own line on when it is read replaces the hint', async () => {
  const page = await openPage();
  const text = 'First line of a long message that must not be cut short.\nSecond line, after a line break.';
  page.board.delivery = 'It ended its turn and waits on its own background command: it will not read them until that ends.';
  page.board.add('alpha', { text, from: 'orchestrator' });
  page.clock.now += 45_000;
  await page.choose('alpha');
  const box = page.el('compose-queue');
  assert.equal(box.querySelector('.q .x').textContent, text, 'the whole text, line break kept');
  assert.deepEqual(box.querySelectorAll('.qd').map((p) => p.textContent), [page.board.delivery]);
  assert.deepEqual(page.queue().hint, [], 'the board already says when the agent reads it');
});

test('the waiting list collapses to its heading and opens again, and the choice stays for the next agent', async () => {
  const page = await openPage();
  page.board.delivery = 'It reads them after its next tool call.';
  page.board.add('alpha', { text: 'for alpha', from: 'orchestrator' });
  page.board.add('beta', { text: 'for beta', from: 'orchestrator' });
  await page.choose('alpha');
  const box = page.el('compose-queue');
  const shown = () => ({ rows: page.queue().rows.length, when: box.querySelectorAll('.qd').length, toggle: box.querySelector('.qt').className });
  assert.deepEqual(shown(), { rows: 1, when: 1, toggle: 'qt open' });
  await box.querySelector('.qt').click();
  assert.deepEqual(shown(), { rows: 0, when: 0, toggle: 'qt shut' });
  assert.match(page.queue().head, /Waiting for the agent \(1\)/, 'the heading and its count stay');
  await page.poll();
  assert.equal(shown().rows, 0, 'a redraw keeps it collapsed');
  await page.choose('beta');
  assert.deepEqual(shown(), { rows: 0, when: 0, toggle: 'qt shut' });
  await page.el('compose-queue').querySelector('.qt').click();
  assert.deepEqual(shown(), { rows: 1, when: 1, toggle: 'qt open' });
});

// The Interrupt option and Send now, under whatever time format the page's browser has. The status line
// begins with the server's time, written by the browser's own formatter: its text is not the test's to
// guess ("12.00 p. m." has periods of its own), so the expectation is built from the same formatter.
async function interruptAndSendNow(options) {
  const page = await ready(options);
  page.el('compose-steer').checked = false;
  page.type('no interrupt');
  let done = page.enter();
  let call = await page.next();
  assert.equal(call.body.steer, false);
  call.reply200();
  await done;
  await flush();
  page.el('compose-steer').checked = true;
  page.type('interrupt');
  done = page.enter();
  call = await page.next();
  assert.equal(call.body.steer, true);
  call.reply200({ steer: { stopped: 'npm test', seconds: 4 } });
  await done;
  await flush();
  const sentAt = page.time(Date.parse(page.board.tasks.get('alpha')[1].time));
  assert.equal(page.text('compose-status'), `Sent at ${sentAt}. Stopped \`npm test\` after 4s so it reads it now.`);
  assert.equal(page.el('compose-status').title, `Sent at ${sentAt}. queued for the orch-inbox hook`);
  // Send now posts to the steer endpoint for this task, with the key, and reports what it stopped.
  page.board.hide(page.board.tasks.get('alpha')[1].id);
  await page.poll();
  const button = page.el('compose-queue').querySelector('button.now');
  assert.ok(button, 'queued messages offer Send now');
  const pushed = button.click();
  const steer = await page.next('api/steer');
  assert.deepEqual(steer.body, { run: RUN, task: 'alpha' });
  assert.equal(steer.headers['x-orch-token'], 'a'.repeat(48));
  steer.refuse(200, { queued: 1, steer: { stopped: 'sleep 60' } });
  await pushed;
  await flush();
  assert.equal(page.text('compose-status'), 'Stopped `sleep 60` so it reads it now.');
}

test('the Interrupt option and Send now keep working as before', () => interruptAndSendNow());

// Times as other locales write them: periods inside the time, a meridiem before it, a different
// separator. The status line must not depend on the host's own format.
const TIME_FORMATS = {
  'a dotted 12-hour clock with periods in its meridiem': (ms) => { const d = new Date(ms); return `${String(d.getUTCHours() % 12 || 12).padStart(2, '0')}.${String(d.getUTCMinutes()).padStart(2, '0')} ${d.getUTCHours() < 12 ? 'a. m.' : 'p. m.'}`; },
  'a meridiem written before the time': (ms) => { const d = new Date(ms); return `${d.getUTCHours() < 12 ? '午前' : '午後'}${d.getUTCHours() % 12}:${String(d.getUTCMinutes()).padStart(2, '0')}`; },
  'a time with a trailing period': (ms) => `${new Date(ms).toISOString().slice(11, 16).replace(':', 'h')}.`,
};
for (const [name, time] of Object.entries(TIME_FORMATS)) {
  test(`the sent-at line and Send now do not depend on the browser's time format: ${name}`, async () => {
    // Exercise each format even when it happens to match the host's locale.
    await interruptAndSendNow({ time });
    const page = await ready({ time });
    page.type('check');
    const done = page.enter();
    const call = await page.next();
    call.reply200({ steer: { stopped: 'make', seconds: 2 } });
    await done;
    await flush();
    const expected = `Sent at ${time(page.clock.now)}. Stopped \`make\` after 2s so it reads it now.`;
    assert.equal(page.text('compose-status'), expected);
    // Times in the thread and the queue use the same formatter, and the thread's labels still read.
    assert.deepEqual(page.thread(), [['you', 'queued', 'check']]);
    assert.ok(page.el('detail').querySelector('.msg .k').textContent.includes(time(page.clock.now)));
  });
}

test('images show with the optimistic message at once, and stay attached when the send fails', async () => {
  const page = await ready();
  const file = { name: 'shot.png', type: 'image/png', size: 10 };
  await page.el('compose-file').dispatch('change', { target: { files: [file], value: 'x' } });
  assert.equal(page.el('compose-files').hidden, false);
  page.type('see this');
  let done = page.enter();
  assert.deepEqual(page.thread(), [['you', 'sending…', 'see this\n(1 image attached)']], 'shown before the image has been read');
  assert.match(page.queue().rows[0], /see this \(1 image\)$/);
  let call = await page.next();
  assert.deepEqual(call.body.images, [{ data: 'AAAA' }]);
  call.refuse(400, { error: 'not an image' });
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'failed', 'see this\n(1 image attached)']]);
  assert.equal(page.el('compose-files').hidden, false, 'the image is still attached');
  assert.equal(page.el('compose-text').value, 'see this');
  // Sent again, the board's copy replaces it, with the image count the server keeps.
  done = page.enter();
  call = await page.next();
  call.reply200();
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'see this\n(1 image attached)']]);
  assert.equal(page.el('compose-files').hidden, true);
  assert.deepEqual(page.entries('alpha'), []);
});

test('a queued message the board no longer lists because newer ones pushed it out is dropped', async () => {
  const page = await ready();
  page.type('old');
  const done = page.enter();
  const call = await page.next();
  page.board.hide(call.store().id);
  call.reply200();
  await done;
  await flush();
  await page.poll();
  assert.equal(page.entries('alpha').length, 1);
  for (let i = 0; i < 20; i++) { page.clock.now += 1000; page.board.add('alpha', { text: `later ${i}`, from: 'orchestrator', read: true }); }
  await page.poll();
  assert.equal(page.thread().length, 20);
  assert.deepEqual(page.thread().find(([, , text]) => text === 'old'), undefined);
  assert.deepEqual(page.entries('alpha'), []);
});

test('entries of a task that left the board are forgotten', async () => {
  const page = await ready();
  page.type('hello');
  const done = page.enter();
  (await page.next()).refuse(400, { error: 'nope' });
  await done;
  await flush();
  assert.equal(page.entries('alpha').length, 1);
  page.board.tasks.delete('alpha');
  await page.poll();
  assert.deepEqual(page.json('[...pending.keys()]'), []);
});

// ---- the status mark: live, stale (a cached board) or disconnected --------------------------------
const LIVE = { className: 'live', text: '' };

test('a cached board shows "stale: <reason>" in place of live, and a fresh one restores live', async () => {
  const page = await ready();
  assert.deepEqual({ className: page.stamp().className, text: page.stamp().text }, LIVE);
  assert.match(page.stamp().title, /^updated /);
  page.board.goStale(42, 'cannot read the run state');
  await page.poll();
  assert.deepEqual([page.stamp().className, page.stamp().text], ['live off', 'stale: cannot read the run state']);
  // The title carries the age and the reason, then a time in the browser's own format (not guessed here).
  assert.match(page.stamp().title, /^showing a cached board, 42s old: cannot read the run state · checked \S/);
  // The board is the same as before, so the page redraws nothing; the mark still follows each answer.
  page.board.goStale(130, 'another reason');
  await page.poll();
  assert.deepEqual([page.stamp().className, page.stamp().text], ['live off', 'stale: another reason']);
  assert.match(page.stamp().title, /2m 10s old: another reason/);
  page.board.goFresh();
  await page.poll();
  assert.deepEqual({ className: page.stamp().className, text: page.stamp().text }, LIVE);
  assert.match(page.stamp().title, /^updated /);
});

test('only the first line of the reason shows, and a cached board without a reason still says it is stale', async () => {
  const page = await ready();
  page.board.goStale(5, 'first line\nsecond line: a stack trace');
  await page.poll();
  assert.equal(page.stamp().text, 'stale: first line');
  assert.doesNotMatch(page.stamp().title, /second line/);
  page.board.goStale(7);
  await page.poll();
  assert.deepEqual([page.stamp().className, page.stamp().text], ['live off', 'stale: cached board']);
  // An age of zero is still a cached board; a very long reason is cut for the header, whole in the title.
  const long = `cannot read ${'x'.repeat(200)}`;
  page.board.goStale(0, long);
  await page.poll();
  assert.equal(page.stamp().className, 'live off');
  assert.ok(page.stamp().text.length <= 'stale: '.length + 100 && page.stamp().text.endsWith('…'));
  assert.ok(page.stamp().title.includes(long));
  page.board.goFresh();
  await page.poll();
  assert.equal(page.stamp().className, 'live');
});

test('a cached board is still drawn: only the mark changes, and the next fresh board replaces it', async () => {
  const page = await ready();
  page.board.add('alpha', { text: 'from the cache', from: 'orchestrator', read: true });
  page.board.goStale(20, 'rebuild failed');
  await page.poll();
  assert.deepEqual(page.thread(), [['orchestrator', 'read', 'from the cache']]);
  assert.equal(page.stamp().text, 'stale: rebuild failed');
  page.board.add('alpha', { text: 'newer', from: 'orchestrator', read: true });
  page.board.goFresh();
  await page.poll();
  assert.deepEqual(page.thread().map(([, , text]) => text), ['from the cache', 'newer']);
  assert.equal(page.stamp().className, 'live');
});

test('a refused read (still building, or failed with nothing cached) shows its reason, not a JSON error, and keeps the board', async () => {
  const page = await ready();
  page.board.add('alpha', { text: 'already here', from: 'orchestrator', read: true });
  await page.poll();
  assert.equal(page.thread().length, 1);
  Object.assign(page.board, { status: 503, failure: JSON.stringify({ error: 'building' }) });
  await page.poll(); // would reject if the page parsed the refusal as a board
  assert.deepEqual([page.stamp().className, page.stamp().text], ['live off', 'stale: building']);
  assert.equal(page.thread().length, 1, 'the board it already has stays');
  Object.assign(page.board, { status: 500, failure: 'dashboard worker exited (1)\nat build (state.mjs:1)' });
  await page.poll();
  assert.equal(page.stamp().text, 'stale: dashboard worker exited (1)');
  Object.assign(page.board, { status: 503, failure: '' });
  await page.poll();
  assert.equal(page.stamp().text, 'stale: HTTP 503');
  // The error header, when the server sends one, is the reason.
  Object.assign(page.board, { status: 503, failure: JSON.stringify({ error: 'building' }), headers: { 'x-orch-error': 'worker restarting' } });
  await page.poll();
  assert.equal(page.stamp().text, 'stale: worker restarting');
  Object.assign(page.board, { status: 200, failure: '', headers: {} });
  await page.poll();
  assert.equal(page.stamp().className, 'live');
  assert.equal(page.thread().length, 1);
});

test('a page opened while the first board is still building says so, then shows the board when it is ready', async () => {
  const page = await openPage({ setup: (board) => Object.assign(board, { status: 503, failure: JSON.stringify({ error: 'building' }) }) });
  assert.deepEqual([page.stamp().className, page.stamp().text], ['live off', 'stale: building']);
  assert.equal(page.el('runs').querySelectorAll('tbody.session').length, 0);
  Object.assign(page.board, { status: 200, failure: '' });
  await page.poll();
  assert.deepEqual({ className: page.stamp().className, text: page.stamp().text }, LIVE);
  assert.equal(page.el('runs').querySelectorAll('tbody.session').length, 2);
});

test('a lost connection says disconnected, and the next answer restores live', async () => {
  const page = await ready();
  page.board.down = true;
  await page.poll();
  assert.deepEqual([page.stamp().className, page.stamp().text], ['live off', 'disconnected']);
  page.board.down = false;
  page.board.goStale(3, 'behind');
  await page.poll();
  assert.equal(page.stamp().text, 'stale: behind');
  page.board.goFresh();
  await page.poll();
  assert.deepEqual({ className: page.stamp().className, text: page.stamp().text }, LIVE);
});

test('an older read that answers after a newer one does not change the mark', async () => {
  const page = await ready();
  const base = page.held.length;
  // The older read is cached, the newer one fresh; the fresh one answers first.
  page.board.hold = true;
  page.board.goStale(30, 'rebuild failed');
  const older = vm.runInContext('refresh().then(detail)', page.ctx);
  page.board.goFresh();
  const newer = vm.runInContext('refresh().then(detail)', page.ctx);
  page.board.hold = false;
  page.releaseReads(base + 1);
  await flush();
  assert.equal(page.stamp().className, 'live');
  page.releaseReads(base);
  await Promise.all([older, newer]);
  await flush();
  assert.deepEqual({ className: page.stamp().className, text: page.stamp().text }, LIVE, 'the older, cached answer was dropped');
  // And the other way round: the newer read is cached, the older fresh.
  page.board.hold = true;
  page.board.goFresh();
  const first = vm.runInContext('refresh().then(detail)', page.ctx);
  page.board.goStale(9, 'rebuild failed again');
  const second = vm.runInContext('refresh().then(detail)', page.ctx);
  page.board.hold = false;
  page.releaseReads(base + 3);
  await flush();
  assert.equal(page.stamp().text, 'stale: rebuild failed again');
  page.releaseReads(base + 2);
  await Promise.all([first, second]);
  await flush();
  assert.equal(page.stamp().text, 'stale: rebuild failed again', 'the older, fresh answer was dropped');
});

test('sending, queued, read, failed and steering behave the same while the board is stale', async () => {
  const page = await ready();
  page.board.goStale(60, 'cannot read the run state');
  await page.poll();
  assert.equal(page.stamp().text, 'stale: cannot read the run state');
  // sending, then queued: the cached board does not list the message yet, and the page keeps its own line.
  page.type('over a stale board');
  let done = page.enter();
  assert.deepEqual(page.thread(), [['you', 'sending…', 'over a stale board']]);
  let call = await page.next();
  const { id } = call.store();
  page.board.hide(id);
  call.reply200({ steer: { stopped: 'npm test', seconds: 4 } });
  await done;
  await flush();
  assert.deepEqual(page.thread(), [['you', 'queued', 'over a stale board']]);
  assert.equal(page.text('compose-status'), `Sent at ${page.time(page.clock.now)}. Stopped \`npm test\` after 4s so it reads it now.`);
  assert.equal(page.stamp().text, 'stale: cannot read the run state', 'the send did not touch the mark');
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'queued', 'over a stale board']]);
  assert.equal(page.queue().rows.length, 1);
  assert.equal(page.text('compose-status').startsWith('Sent at '), true, "the mark's changes do not write the send line");
  // Send now still posts to the steer endpoint with the key.
  const pushed = page.el('compose-queue').querySelector('button.now').click();
  const steer = await page.next('api/steer');
  assert.deepEqual(steer.body, { run: RUN, task: 'alpha' });
  assert.equal(steer.headers['x-orch-token'], 'a'.repeat(48));
  steer.refuse(200, { queued: 1, steer: { stopped: 'sleep 60' } });
  await pushed;
  await flush();
  assert.equal(page.text('compose-status'), 'Stopped `sleep 60` so it reads it now.');
  assert.equal(page.stamp().text, 'stale: cannot read the run state');
  // A send that fails over a stale board is failed, with its error, and stays until dismissed.
  page.type('refused');
  done = page.enter();
  assert.deepEqual(page.thread().at(-1), ['you', 'sending…', 'refused']);
  (await page.next()).refuse(409, { error: 'task alpha is not running (completed)' });
  await done;
  await flush();
  assert.deepEqual(page.thread().at(-1), ['you', 'failed', 'refused']);
  await page.poll();
  assert.deepEqual(page.thread().at(-1), ['you', 'failed', 'refused']);
  assert.equal(page.el('compose-text').value, 'refused');
  // The board recovers: the server's copy replaces the queued line, the agent reads it, and the mark is live.
  page.board.goFresh();
  page.board.show(id);
  page.board.markRead('alpha', id);
  await page.poll();
  assert.deepEqual(page.thread(), [['you', 'read', 'over a stale board'], ['you', 'failed', 'refused']]);
  assert.equal(page.queue().hidden, true);
  assert.equal(page.stamp().className, 'live');
});
