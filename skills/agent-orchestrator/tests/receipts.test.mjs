import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { eventually, fixture, readJson, writeJson } from './helpers.mjs';

// A task's receipts: what it was given (its brief), what each attempt did, and what was accepted
// on what evidence; served by the dashboard and drawn in its details panel.

const report = (outcome) => `Done.\n\n\`\`\`orch-result\n${JSON.stringify({ outcome, changed: [], checks: [], decisions: [], unresolved: [] })}\n\`\`\`\n`;
const rowOf = async (f, run, id) => (await f.json(['status', run.id])).tasks.find((t) => t.id === id);
const briefFile = (run, id, n) => path.join(run.dir, 'tasks', id, `attempt-${n}`, 'orch-brief.md');

// A request with a Host header of our choosing, which fetch does not let a caller set.
function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
}

test('the dashboard serves each attempt\'s brief and log, and refuses what is not a brief of the run', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'work', { config: { finalMessage: 'first attempt report' } });
  const first = await f.finished(run, 'work');
  await f.start(run, 'work', { config: { finalMessage: 'second attempt report' }, flags: ['--json', '--', '--session', first.session] });
  await f.finished(run, 'work');
  const board = await f.dashboard();
  const brief = (query) => board.get(`/api/brief?${query}`);

  await t.test('/api/brief returns the attempt\'s orch-brief.md and its size', async () => {
    for (const n of [1, 2]) {
      const file = briefFile(run, 'work', n);
      const body = await board.json(`/api/brief?run=${run.id}&task=work&attempt=${n}`);
      assert.deepEqual(body, { text: fs.readFileSync(file, 'utf8'), bytes: fs.statSync(file).size });
      assert.match(body.text, /^Fixture task work\./);
    }
    // Like every route, it answers only to the dashboard's own address.
    assert.equal(await getWithHost(new URL(`/api/brief?run=${run.id}&task=work&attempt=1`, board.url), 'attacker.example'), 403);
  });

  await t.test('/api/brief refuses bad ids, a missing brief, and paths outside the run', async () => {
    for (const query of [
      'run=../../outside&task=work&attempt=1', `run=${run.id}&task=../work&attempt=1`, `run=${run.id}&task=Work&attempt=1`,
      `run=${run.id}&task=work`, `run=${run.id}&task=work&attempt=`, `run=${run.id}&task=work&attempt=0`,
      `run=${run.id}&task=work&attempt=-1`, `run=${run.id}&task=work&attempt=1.5`, `run=${run.id}&task=work&attempt=1e2`,
      `run=${run.id}&task=work&attempt=../1`,
    ]) assert.equal((await brief(query)).status, 400, query);
    assert.equal((await brief('run=missing&task=work&attempt=1')).status, 404);
    assert.equal((await brief(`run=${run.id}&task=nobody&attempt=1`)).status, 404);
    assert.equal((await brief(`run=${run.id}&task=work&attempt=9`)).status, 404);
    // A brief that links out of the run, or an attempt folder that does, is not served.
    const outside = path.join(f.root, 'secret.md');
    fs.writeFileSync(outside, 'OUTSIDE-SECRET one');
    fs.mkdirSync(path.dirname(briefFile(run, 'work', 5)), { recursive: true });
    fs.symlinkSync(outside, briefFile(run, 'work', 5));
    fs.mkdirSync(path.join(f.root, 'elsewhere'));
    fs.writeFileSync(path.join(f.root, 'elsewhere', 'orch-brief.md'), 'OUTSIDE-SECRET two');
    fs.symlinkSync(path.join(f.root, 'elsewhere'), path.join(run.dir, 'tasks', 'work', 'attempt-6'));
    for (const n of [5, 6]) {
      const response = await brief(`run=${run.id}&task=work&attempt=${n}`);
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /OUTSIDE-SECRET/);
    }
    // A folder in place of the file is no brief either.
    fs.mkdirSync(briefFile(run, 'work', 7), { recursive: true });
    assert.equal((await brief(`run=${run.id}&task=work&attempt=7`)).status, 404);
    // Nor is a link to another file of the run, such as the task's record or another task's brief.
    fs.mkdirSync(path.dirname(briefFile(run, 'work', 9)), { recursive: true });
    fs.symlinkSync(f.taskFile(run, 'work'), briefFile(run, 'work', 9));
    fs.mkdirSync(path.join(run.dir, 'tasks', 'other'), { recursive: true });
    fs.symlinkSync(path.join(run.dir, 'tasks', 'work', 'attempt-1'), path.join(run.dir, 'tasks', 'other', 'attempt-1'));
    for (const [task, n] of [['work', 9], ['other', 1]]) {
      const response = await brief(`run=${run.id}&task=${task}&attempt=${n}`);
      assert.equal(response.status, 403, `${task} attempt ${n}`);
      assert.doesNotMatch(await response.text(), /Fixture task|"attempt"/);
    }
  });

  await t.test('/api/brief never holds the server up: a pipe is refused at once, and a huge file is read only to its cap', async () => {
    // Opening a pipe for reading used to wait for a writer, and so held up every request.
    fs.mkdirSync(path.dirname(briefFile(run, 'work', 10)), { recursive: true });
    const made = spawnSync('mkfifo', [briefFile(run, 'work', 10)]);
    assert.equal(made.status, 0, String(made.stderr));
    assert.equal((await brief(`run=${run.id}&task=work&attempt=10`)).status, 404);
    assert.equal((await board.json('/api/health')).pid > 0, true, 'the server still answers');
    // A sparse 4 GB file: the answer carries 200 KB of it.
    fs.mkdirSync(path.dirname(briefFile(run, 'work', 11)), { recursive: true });
    const fd = fs.openSync(briefFile(run, 'work', 11), 'w');
    fs.writeSync(fd, 'Huge brief.\n');
    fs.ftruncateSync(fd, 4 * 1024 ** 3);
    fs.closeSync(fd);
    const started = Date.now();
    const body = await board.json(`/api/brief?run=${run.id}&task=work&attempt=11`);
    assert.equal(body.bytes, 4 * 1024 ** 3);
    assert.equal(body.truncated, true);
    assert.ok(body.text.startsWith('Huge brief.\n'));
    assert.ok(Buffer.byteLength(body.text) < 201 * 1024);
    assert.ok(Date.now() - started < 4000, 'read only to its cap');
  });

  await t.test('/api/brief cuts a brief over 200 KB and says so', async () => {
    // A two-byte character straddles the cut: the text must not end in half of it.
    const text = `${'a'.repeat(200 * 1024 - 1)}é${'b'.repeat(100 * 1024)}`;
    fs.mkdirSync(path.dirname(briefFile(run, 'work', 8)), { recursive: true });
    fs.writeFileSync(briefFile(run, 'work', 8), text);
    const body = await board.json(`/api/brief?run=${run.id}&task=work&attempt=8`);
    assert.equal(body.bytes, Buffer.byteLength(text));
    assert.equal(body.truncated, true);
    assert.ok(body.text.startsWith('a'.repeat(200 * 1024 - 1)));
    assert.doesNotMatch(body.text, /[�é]|b/);
    assert.match(body.text, /\n\n… \(truncated: the first 200 KB of 300 KB are shown\)$/);
  });

  await t.test('/api/events reads the attempt asked for, the current one by default', async () => {
    const said = async (query) => (await board.json(`/api/events?run=${run.id}&task=work${query}`)).events.map((e) => e.text).join('\n');
    const current = await said('');
    assert.match(current, /second attempt report/);
    assert.doesNotMatch(current, /first attempt report/);
    const earlier = await said('&attempt=1');
    assert.match(earlier, /first attempt report/);
    assert.doesNotMatch(earlier, /second attempt report/);
    assert.equal(await said('&attempt=2'), current);
    assert.equal(await said('&attempt=9'), current, 'an attempt past the last reads the last, as before');
    for (const bad of ['0', '-1', 'x', '1.5', '']) {
      assert.equal((await board.get(`/api/events?run=${run.id}&task=work&attempt=${bad}`)).status, 400, `attempt=${bad}`);
    }
  });
});

test('each row lists its attempts newest first, and the dashboard rereads an attempt\'s result only when it changes', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  await f.start(run, 'work', { config: { status: 'failed', error: 'Provider exploded\nat stack line' } });
  const first = await f.finished(run, 'work');
  assert.equal(first.state, 'failed');
  await f.start(run, 'work', { config: { finalMessage: report('partial') }, flags: ['--json', '--', '--session', first.session] });
  await f.finished(run, 'work');
  await f.command(['verify', run.id, 'work', '--', 'true']);
  await f.command(['verdict', run.id, 'work', 'clean', '--note', 'reads well']);
  await f.command(['accept', run.id, 'work', '--note', 'gates pass']);

  const row = await rowOf(f, run, 'work');
  assert.deepEqual(row.attempts.map((a) => [a.n, a.reason, a.agent, a.state, a.error, a.outcome]), [
    [2, 'resume', 'claude', 'completed', null, 'partial'],
    [1, 'first', 'claude', 'failed', 'Provider exploded', null],
  ]);
  const [second, firstAttempt] = row.attempts;
  assert.equal(second.resumed, first.session, 'the second attempt resumed the first one\'s session');
  assert.equal(second.resumedAttempt, 1);
  assert.equal(firstAttempt.resumed, null);
  for (const a of row.attempts) {
    assert.ok(Number.isFinite(a.durationMs) && a.durationMs >= 0, `attempt ${a.n} has a duration`);
    assert.equal(a.briefBytes, fs.statSync(briefFile(run, 'work', a.n)).size);
    assert.ok(a.model && a.session);
  }
  assert.equal(row.attempts.reduce((sum, a) => sum + a.tokensIn, 0), row.tokensIn);
  assert.equal(row.attempts.reduce((sum, a) => sum + a.tokensOut, 0), row.tokensOut);
  assert.deepEqual({ ...row.acceptance, at: undefined }, {
    verdict: 'accepted', attempt: 2, at: undefined, by: 'coordinator', commit: await f.git(['rev-parse', 'HEAD']), note: 'gates pass',
  });

  // A task not started yet has no attempts.
  await f.json(['worktree', run.id, 'later', '--no-prep']);
  assert.deepEqual((await rowOf(f, run, 'later')).attempts, []);

  // The first attempt's result, with a fixed modification time, then rewritten with the same size and
  // time: the dashboard keeps what it read. A change of time makes it read the file again.
  const file = path.join(run.dir, 'tasks', 'work', 'attempt-1', 'result.json');
  const fixed = 1_700_000_000;
  fs.utimesSync(file, fixed, fixed);
  const board = await f.dashboard();
  const boardRow = async () => (await board.json('/api/state')).flatMap((s) => s.tasks).find((x) => x.id === 'work' && x.run === run.id);
  assert.equal((await boardRow()).attempts[1].error, 'Provider exploded');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('Provider exploded', 'Provider imploded'));
  fs.utimesSync(file, fixed, fixed);
  // Change the task record too, so a rebuild shows; the cached result must survive it.
  const record = readJson(f.taskFile(run, 'work'));
  writeJson(f.taskFile(run, 'work'), { ...record, why: 'A rebuild marker' });
  const rebuilt = await eventually(async () => { const r = await boardRow(); return r.why === 'A rebuild marker' ? r : null; }, 'the board did not rebuild');
  assert.equal(rebuilt.attempts[1].error, 'Provider exploded', 'an unchanged result.json is not read again');
  fs.utimesSync(file, fixed + 60, fixed + 60);
  await eventually(async () => (await boardRow()).attempts[1].error === 'Provider imploded', 'a changed result.json is read again');
});

// The details panel's receipts, drawn by the page's own functions into a small DOM: its elements
// keep the `tag`, `attrs` and `kids` that the helpers below read, with parent links, simple
// selectors (tag, .class, [attr="value"], lists) and focus, which focusedOn and refocus use.
const app = fs.readFileSync(new URL('../scripts/dashboard/app.js', import.meta.url), 'utf8');
function snippet(from, until) {
  const start = app.indexOf(from), end = app.indexOf(until, start);
  assert.ok(start >= 0 && end > start, `dashboard script must contain ${from}`);
  return app.slice(start, end);
}
function dom({ browser = false } = {}) {
  const doc = { activeElement: null, focusCalls: [], toggles: [] };
  const matchOne = (node, compound) => {
    const m = /^([a-z][a-z0-9]*)?((?:\.[\w-]+|\[[\w-]+="(?:[^"\\]|\\.)*"\])*)$/.exec(compound);
    if (!m) throw new Error(`the test DOM cannot match ${compound}`);
    if (m[1] && node.tag !== m[1]) return false;
    const classes = String(node.attrs.class || '').split(' ');
    for (const [, cls, name, value] of m[2].matchAll(/\.([\w-]+)|\[([\w-]+)="((?:[^"\\]|\\.)*)"\]/g)) {
      if (cls ? !classes.includes(cls) : !(name in node.attrs) || String(node.attrs[name]) !== value.replace(/\\(.)/g, '$1')) return false;
    }
    return true;
  };
  class Node {
    constructor(tag, attrs, kids) { this.tag = tag; this.attrs = attrs || {}; this.kids = []; this.parent = null; this.append(...kids); }
    append(...kids) { for (const k of kids.flat(Infinity)) if (k != null) { if (k instanceof Node) k.parent = this; this.kids.push(k); } }
    replaceChildren(...kids) { for (const k of this.kids) if (k instanceof Node) k.parent = null; this.kids = []; this.append(...kids); }
    get children() { return this.kids; }
    get dataset() { return Object.fromEntries(Object.entries(this.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), String(v)])); }
    matches(selector) { return selector.split(',').some((s) => matchOne(this, s.trim())); }
    contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
    *walk() { for (const k of this.kids) if (k instanceof Node) { yield k; yield* k.walk(); } }
    querySelector(selector) { for (const n of this.walk()) if (n.matches(selector)) return n; return null; }
    focus(options) { doc.activeElement = this; doc.focusCalls.push(JSON.parse(JSON.stringify(options ?? null))); }
  }
  // Like a browser, a <details> created open fires `toggle` (open) soon after: fireToggles().
  const $ = (tag, attrs, ...kids) => {
    const node = new Node(tag, attrs, kids);
    if (browser && tag === 'details' && 'open' in node.attrs) doc.toggles.push(node);
    return node;
  };
  const panel = new Node('section', {}, []);
  Object.defineProperty(panel, 'dataset', { value: {}, writable: true });
  Object.assign(panel, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
  doc.getElementById = () => panel;
  doc.fireToggles = () => { for (const node of doc.toggles.splice(0)) node.attrs.ontoggle?.({ currentTarget: { open: true } }); };
  return { doc, $, panel };
}
const textOf = (node) => (node == null ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node.kids.map(textOf).join(''));
const all = (node, test, out = []) => {
  if (Array.isArray(node)) for (const n of node) all(n, test, out);
  else if (node && typeof node === 'object') { if (test(node)) out.push(node); all(node.kids, test, out); }
  return out;
};
const classed = (node, name) => all(node, (n) => String(n.attrs?.class || '').split(' ').includes(name));
const headings = (node) => all(node, (n) => n.tag === 'h3').map(textOf);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function page(extra = {}, options = {}) {
  const { doc, $, panel } = dom(options);
  const context = vm.createContext({
    $, encodeURIComponent, holding: () => false, closeDetail() {}, rich: (text) => $('div', { class: 'rich' }, text),
    document: doc, CSS: { escape: (v) => String(v).replace(/["\\]/g, '\\$&') }, sel: null, state: [], lastDetail: '',
    fetch: async () => ({ ok: true, json: async () => ({ events: [] }) }), ...extra,
  });
  for (const [from, until] of [['const fmt=', 'const outcome='], ['const cls=', 'let sel=null'], ['const FOCUS_KEYS=', "// A section's own toggles"],
    ["// The agent's structured report", '// Lays out a plan graph'], ['const atBottom=', 'async function limits()'], ['function dur(ms)', 'function tick()']]) {
    vm.runInContext(snippet(from, until), context);
  }
  vm.runInContext('var taskAt=key=>{const[r,k]=key.split("/");return state.find(x=>x.id===r)?.tasks.find(x=>x.key===k)||null}', context);
  return { context, panel, doc, $ };
}

test('the panel shows each check with its saved evidence, and marks a pass without a successful run', () => {
  const { context } = page();
  const checks = [
    { cmd: 'npm test', result: 'pass', evidence: { ran: true, exitCode: 0, atMs: 1 } },
    { cmd: 'npm run lint', result: 'pass', evidence: { ran: false } },
    { cmd: 'npm run e2e', result: 'pass', evidence: { ran: true, exitCode: 1, atMs: 2 } },
    { cmd: 'npm run docs', result: 'fail', evidence: { ran: true, exitCode: 1, atMs: 3 } },
    { cmd: 'npm run bench', result: 'not-run', note: 'too slow' },
  ];
  const view = context.reportView({ state: 'completed', report: { outcome: 'done', checks } });
  const lines = classed(view, 'check');
  assert.deepEqual(lines.map(textOf), [
    'pass · ran, exit 0 npm test',
    'pass · NOT FOUND in the log ⚠ npm run lint',
    'pass · exit 1 ⚠ npm run e2e',
    'fail · exit 1 npm run docs',
    'not-run npm run bench — too slow',
  ]);
  assert.deepEqual(lines.map((l) => l.attrs.class.includes('mismatch')), [false, true, true, false, false], 'only a pass without a successful run is a warning');
  assert.match(lines[1].attrs.title, /no matching run is in the log/);
  assert.match(lines[2].attrs.title, /last run exited 1/);
  assert.match(textOf(view), /evidence is worked out by `orch\.mjs result`/, 'a check without saved evidence gets the note');
  // No note when every check has evidence, while the task runs, or for a native sub-agent.
  for (const t of [{ state: 'completed', report: { outcome: 'done', checks: checks.slice(0, 4) } },
    { state: 'running', report: { outcome: 'done', checks } }, { state: 'completed', native: true, report: { outcome: 'done', checks } }]) {
    assert.doesNotMatch(textOf(context.reportView(t)), /evidence is worked out/);
  }
});

test('a not-run check shows no evidence, and an event-log message shortens its orch-result block', () => {
  const { context } = page();
  const view = context.reportView({ state: 'completed', report: { outcome: 'done', checks: [
    { cmd: 'npm run bench', result: 'not-run', note: 'too slow', evidence: { ran: false } }] } });
  assert.deepEqual(classed(view, 'check').map(textOf), ['not-run npm run bench — too slow']);
  context.sample = 'Done.\n```orch-result\n{"outcome":"done"}\n```\nBye.';
  const said = vm.runInContext('saysText(sample)', context);
  assert.equal(said, 'Done.\n[orch-result block: see the report above]\nBye.');
});

test('the panel lists verifications, review rounds and the acceptance or rejection, and nothing without them', () => {
  const { context } = page();
  const at = '2026-11-05T10:00:00Z';
  const t = {
    attempt: 2,
    verifications: [
      { id: 'v1', cmd: 'npm test', exitCode: 0, passed: true, commit: '0123456789abcdef', dirty: true, by: 'coordinator', startedAt: at, attempt: 1 },
      { id: 'v2', cmd: 'npm run e2e', exitCode: 3, passed: false, commit: 'fedcba9876543210', dirty: false, by: 'coordinator', startedAt: at, attempt: 2 },
      { id: 'v3', cmd: 'sleep 99', exitCode: null, passed: false, timedOut: true, commit: null, dirty: null, by: 'coordinator', startedAt: at, attempt: 2 },
    ],
    reviewRounds: [
      { round: 1, attempt: 1, verdict: 'changes', reviewer: 'coordinator', note: 'handle the empty input', at, verifications: ['v1'] },
      { round: 2, attempt: 2, verdict: 'clean', reviewer: 'reviewer', note: null, at, verifications: ['v2', 'v3'] },
    ],
    acceptance: { verdict: 'accepted', attempt: 2, at, by: 'coordinator', commit: 'abcdef0123456789', note: 'gates pass' },
  };
  const view = context.reviewView(t);
  assert.deepEqual(headings(view), ['Verification and review']);
  const items = all(view, (n) => n.tag === 'li').map(textOf);
  assert.match(items[0], /^v1 pass npm test · exit 0 · 0123456 dirty · attempt 1 · by coordinator · \S/);
  assert.match(items[1], /^v2 fail npm run e2e · exit 3 · fedcba9 · attempt 2 · by coordinator/);
  assert.match(items[2], /^v3 fail sleep 99 · timed out · attempt 2/);
  assert.match(items[3], /^round 1 · attempt 1 · changes · by coordinator · .* · on v1 — handle the empty input$/);
  assert.match(items[4], /^round 2 · attempt 2 · clean · by reviewer · .* · on v2, v3$/);
  const text = textOf(view);
  assert.match(text, /acceptanceaccepted attempt 2 at abcdef0 by coordinator · .* — gates pass/);
  assert.doesNotMatch(text, /earlier attempt/);
  // An acceptance of an earlier attempt says that it does not cover the current one.
  assert.match(textOf(context.reviewView({ ...t, attempt: 3 })), /an earlier attempt: it does not cover attempt 3/);
  // A single attempt leaves attempt numbers off its verifications.
  assert.doesNotMatch(textOf(context.reviewView({ attempt: 1, verifications: [t.verifications[0]] })), /attempt 1/);
  const rejected = textOf(context.reviewView({ attempt: 1, reviewRounds: [{ round: 1, attempt: 1, verdict: 'reject', reviewer: 'coordinator', note: 'wrong approach', at, verifications: [] }],
    acceptance: { verdict: 'rejected', attempt: 1, at, note: 'wrong approach' } }));
  assert.match(rejected, /acceptancerejected attempt 1 · .* — wrong approach/);
  const verdictLine = all(context.reviewView({ attempt: 1, acceptance: { verdict: 'rejected', attempt: 1, at, note: 'wrong approach' } }), (n) => n.tag === 'dd').map(textOf).at(-1);
  assert.match(verdictLine, /^rejected attempt 1 · \S.* — wrong approach$/);
  assert.doesNotMatch(verdictLine, / at [0-9a-f]| by /, 'a rejection names no commit');
  assert.equal(context.reviewView({ attempt: 1 }).length, 0, 'no receipts, no section');
});

const attempts = [
  { n: 3, reason: 'rework', agent: 'codex', model: 'gpt-5', durationMs: 65000, tokensIn: 1500, tokensOut: 300, state: 'completed', outcome: 'done', briefBytes: 12800, resumed: '0199aaaa-bbbb-cccc', resumedAttempt: 2, session: '0199aaaa-bbbb-cccc' },
  { n: 2, reason: 'resume', agent: 'claude', model: 'opus', durationMs: 5000, tokensIn: 100, tokensOut: 30, state: 'needs-decision', outcome: 'blocked', briefBytes: 900, resumed: true, resumedAttempt: null },
  { n: 1, reason: 'first', agent: 'claude', model: 'opus', durationMs: 2000, tokensIn: 50, tokensOut: 10, state: 'failed', error: 'Usage limit reached', outcome: null, briefBytes: 800, resumed: null },
];
const task = (extra = {}) => ({ key: 'k', id: 'work', run: 'r', agent: 'codex', state: 'completed', attempt: 3, elapsed: '1m05s', cd: '/work/repo', branch: 'orch/r/work',
  inbox: { read: 3, unread: 0, messages: [] }, attempts, ...extra });

test('the panel lists attempts newest first, and choosing one shows its log and brief', async () => {
  const fetched = [];
  const { context, panel } = page({
    fetch: async (url) => {
      fetched.push(url);
      if (url.startsWith('api/brief')) return { ok: true, json: async () => ({ text: `brief of ${/attempt=(\d+)/.exec(url)[1]}`, bytes: 10 }) };
      return { ok: true, json: async () => ({ events: [{ kind: 'says', text: `log ${/attempt=(\d+)/.exec(url)?.[1] || 'current'}` }] }) };
    },
  });
  context.state = [{ id: 's', tasks: [task()] }];
  context.sel = 's/k';
  await context.detail();
  const shown = () => panel.children;
  assert.deepEqual(headings(shown()).slice(0, 1), ['Attempts']);
  const lines = classed(shown(), 'att');
  assert.deepEqual(lines.map(textOf), [
    '#3reworkcodex · gpt-51m 05s1.5k in / 300 outcompletedreported done',
    '#2resumeclaude · opus5s100 in / 30 outneeds decisionreported blocked',
    '#1firstclaude · opus2s50 in / 10 outfailed: Usage limit reached',
  ]);
  assert.deepEqual(lines.map((l) => l.attrs.class), ['att on', 'att', 'att']);
  assert.equal(classed(shown(), 'end')[2].attrs.class, 'end state s-bad');
  assert.match(textOf(classed(shown(), 'ctx')), /^Contextbrief 13 KB · resumed attempt 2's session 0199aaaa · 3 messages received · \/work\/repo @ orch\/r\/work$/);
  assert.doesNotMatch(textOf(shown().find((n) => n.tag === 'dl')), /\/work\/repo/, 'the working directory moves to the Context line');
  // The log of the current attempt is asked for by its number, so it cannot be another attempt's.
  assert.match(textOf(shown()), /log 3/);
  assert.equal(fetched.at(-1), 'api/events?run=r&task=work&attempt=3');

  // Choosing attempt 1 shows its log, under a heading that names it.
  lines[2].attrs.onclick();
  await settle();
  assert.equal(fetched.at(-1), 'api/events?run=r&task=work&attempt=1');
  assert.ok(headings(shown()).some((h) => /^Events of attempt 1 \(1, newest last\)show attempt 3$/.test(h)));
  assert.match(textOf(shown()), /log 1/);
  assert.deepEqual(classed(shown(), 'att').map((l) => l.attrs.class), ['att', 'att', 'att on']);
  assert.match(textOf(classed(shown(), 'ctx')), /brief 800 B/, 'the Context line follows the attempt shown');
  assert.doesNotMatch(textOf(classed(shown(), 'ctx')), /session/, 'a first attempt that resumed nothing says nothing about sessions');

  // The Brief opens on request and loads the shown attempt's brief once.
  const details = () => all(shown(), (n) => n.tag === 'details')[0];
  const briefFetches = () => fetched.filter((u) => u.startsWith('api/brief'));
  assert.equal(details().attrs.open, undefined);
  assert.equal(textOf(details()), 'Brief · attempt 1');
  panel.scrollTop = 800; // near the bottom, where a repaint would pin the reader to the newest events
  details().attrs.ontoggle({ currentTarget: { open: true } });
  assert.match(textOf(details()), /Loading…/);
  assert.equal(panel.scrollTop, 800, 'opening the Brief keeps the reader where they are');
  await settle();
  assert.deepEqual(briefFetches(), ['api/brief?run=r&task=work&attempt=1']);
  assert.equal(details().attrs.open, '');
  assert.match(textOf(details()), /brief of 1$/);
  details().attrs.ontoggle({ currentTarget: { open: true } }); // the toggle a rebuilt open <details> fires
  assert.equal(briefFetches().length, 1, 'an open brief is not fetched again');

  // Back to the current attempt: its log, and the open Brief moves to it and loads it.
  classed(shown(), 'linkish')[0].attrs.onclick();
  await settle();
  assert.deepEqual(classed(shown(), 'att').map((l) => l.attrs.class), ['att on', 'att', 'att']);
  assert.ok(headings(shown()).some((h) => h.startsWith('Events (')));
  assert.equal(briefFetches().at(-1), 'api/brief?run=r&task=work&attempt=3');
  assert.match(textOf(details()), /brief of 3$/);
  // Closing it keeps it closed on the next paint.
  details().attrs.ontoggle({ currentTarget: { open: false } });
  context.lastDetail = '';
  context.paint('s/k', task(), false, []);
  assert.equal(details().attrs.open, undefined);
});

// Defect: a failing /api/brief was fetched again on every paint, because each rebuilt <details open>
// fires `toggle`. Only the reader's own opening, or choosing another attempt, may fetch.
test('a brief that fails to load is fetched once, shown once, and tried again only when the reader asks', async () => {
  const fetched = [];
  const { context, panel, doc } = page({
    fetch: async (url) => {
      fetched.push(url);
      if (url.startsWith('api/brief')) return { ok: false, status: 404, json: async () => ({ error: 'no brief for that attempt' }) };
      return { ok: true, json: async () => ({ events: [{ kind: 'says', text: `${url} ${fetched.length}` }] }) };
    },
  }, { browser: true });
  context.state = [{ id: 's', tasks: [task()] }];
  context.sel = 's/k';
  await context.detail();
  const details = () => all(panel.children, (n) => n.tag === 'details')[0];
  const briefFetches = () => fetched.filter((u) => u.startsWith('api/brief'));
  // The browser's own toggles and the board's refreshes, as many as a busy minute brings.
  const churn = async () => {
    for (let i = 0; i < 60; i++) {
      doc.fireToggles();
      if (i % 6 === 0) await context.detail(); // a refresh: a fresh log, so the panel paints again
      await settle();
    }
  };
  details().attrs.ontoggle({ currentTarget: { open: true } });
  await churn();
  assert.deepEqual(briefFetches(), ['api/brief?run=r&task=work&attempt=3'], 'one fetch for one opening');
  assert.equal(details().attrs.open, '');
  assert.equal(all(panel.children, (n) => textOf(n) === 'Not loaded: no brief for that attempt.' && n.tag === 'p').length, 1, 'the error shows once');
  // Closing and opening again tries once more.
  details().attrs.ontoggle({ currentTarget: { open: false } });
  await churn();
  assert.equal(briefFetches().length, 1, 'a closed Brief fetches nothing');
  details().attrs.ontoggle({ currentTarget: { open: true } });
  await churn();
  assert.equal(briefFetches().length, 2);
  // Choosing another attempt with the Brief open loads that attempt's, once.
  classed(panel.children, 'att')[2].attrs.onclick();
  await churn();
  assert.deepEqual(briefFetches().slice(2), ['api/brief?run=r&task=work&attempt=1']);
  assert.match(textOf(details()), /^Brief · attempt 1Not loaded: no brief for that attempt\.$/);
  // The server down: the same, with its own message.
  context.fetch = async (url) => { fetched.push(url); if (url.startsWith('api/brief')) throw new TypeError('Failed to fetch'); return { ok: true, json: async () => ({ events: [] }) }; };
  details().attrs.ontoggle({ currentTarget: { open: false } });
  details().attrs.ontoggle({ currentTarget: { open: true } });
  await churn();
  assert.equal(briefFetches().length, 4);
  assert.match(textOf(details()), /Not loaded: the dashboard is not reachable\.$/);
});

// Defect: detail() checked after its await only that the same row was chosen, so a log that
// arrived late for one attempt was painted under another's heading; and a capped log (400 events)
// that moved on kept its length, so the panel never showed the newer events.
test('a log is painted only under its own attempt, and a capped log that moves on is repainted', async () => {
  const pending = [];
  const { context, panel } = page({ fetch: (url) => new Promise((resolve) => { pending.push({ url, resolve }); }) });
  const answer = async (attempt, events) => {
    const i = pending.findIndex((p) => p.url.endsWith(`&attempt=${attempt}`));
    assert.ok(i >= 0, `a fetch of attempt ${attempt}'s log is pending`);
    pending.splice(i, 1)[0].resolve({ ok: true, json: async () => ({ events }) });
    await settle();
  };
  const said = (text) => [{ kind: 'says', text }];
  const heading = () => headings(panel.children).find((h) => h.startsWith('Events'));
  context.state = [{ id: 's', tasks: [task()] }];
  context.sel = 's/k';
  const first = context.detail();
  classed(panel.children, 'att')[2].attrs.onclick(); // attempt 1 is chosen while attempt 3's log loads
  await answer(3, said('log of attempt 3'));
  await first;
  assert.doesNotMatch(textOf(panel.children), /log of attempt 3/, 'attempt 3\'s late log is not shown under attempt 1');
  assert.equal(heading(), 'Events of attempt 1 (loading…)show attempt 3');
  await answer(1, said('log of attempt 1'));
  assert.equal(heading(), 'Events of attempt 1 (1, newest last)show attempt 3');
  assert.match(textOf(panel.children), /log of attempt 1/);
  // Back on the current attempt, its log, kept from before, shows at once.
  classed(panel.children, 'linkish')[0].attrs.onclick();
  assert.match(textOf(panel.children), /log of attempt 3/);
  await answer(3, said('log of attempt 3'));
  // Two logs of 400 events: the second has moved on by one.
  const capped = (from) => Array.from({ length: 400 }, (_, i) => ({ kind: 'says', text: `event ${from + i}` }));
  let refresh = context.detail();
  await answer(3, capped(0));
  await refresh;
  assert.match(textOf(panel.children), /event 399/);
  refresh = context.detail();
  await answer(3, capped(1));
  await refresh;
  assert.match(textOf(panel.children), /event 400/, 'the newer events show although the count is the same');
  assert.doesNotMatch(textOf(panel.children), /event 0(?!\d)/);
  // A new attempt that starts while the panel follows the current one gets its own log.
  context.state = [{ id: 's', tasks: [task({ attempt: 4, attempts: [{ ...attempts[0], n: 4, state: 'running' }, ...attempts] })] }];
  refresh = context.detail();
  assert.ok(pending.some((p) => p.url === 'api/events?run=r&task=work&attempt=4'));
  await answer(4, said('log of attempt 4'));
  await refresh;
  assert.match(textOf(panel.children), /log of attempt 4/);
  assert.doesNotMatch(textOf(panel.children), /event 400/);
});

// Defect: a refresh rebuilt the panel and dropped the focus from an attempt line, the Brief or
// "show attempt N". The panel now restores it as the board does (focusedOn and refocus).
test('a refresh keeps the focus on the same attempt line, Brief, "show attempt N" or close button', async () => {
  let n = 0;
  const { context, panel, doc } = page({
    fetch: async (url) => ({ ok: true, json: async () => (url.startsWith('api/brief') ? { text: 'brief', bytes: 5 } : { events: [{ kind: 'says', text: `refresh ${++n}` }] }) }),
  });
  context.state = [{ id: 's', tasks: [task()] }];
  context.sel = 's/k';
  await context.detail();
  const keeps = async (find, label) => {
    const before = find();
    assert.ok(before, `${label} is drawn`);
    before.focus();
    doc.focusCalls.length = 0;
    await context.detail(); // a refresh: a new log, so the panel is rebuilt
    const now = doc.activeElement;
    assert.notEqual(now, before, `${label}: the panel was rebuilt`);
    assert.ok(panel.contains(now), `${label}: the focus is in the panel`);
    assert.deepEqual(doc.focusCalls, [{ preventScroll: true }], `${label}: focused once, without scrolling`);
    return now;
  };
  const line = (k) => classed(panel.children, 'att').find((x) => x.attrs['data-n'] === k);
  assert.equal((await keeps(() => line('2'), 'an attempt line')).attrs['data-n'], '2');
  assert.ok((await keeps(() => classed(panel.children, 'bsum')[0], 'the Brief')).matches('.bsum'));
  assert.ok((await keeps(() => classed(panel.children, 'close')[0], 'the close button')).matches('.close'));
  line('1').attrs.onclick();
  await settle();
  const link = await keeps(() => classed(panel.children, 'linkish')[0], '"show attempt 3"');
  // Following the link back to the current attempt leaves the focus on that attempt's line.
  link.attrs.onclick();
  await settle();
  assert.ok(doc.activeElement.matches('.att.on') && doc.activeElement.attrs['data-n'] === '3');
  // A focus outside the panel, such as in the message box, stays where it is.
  const outside = dom().panel; // an element of the page outside the panel
  doc.activeElement = outside;
  doc.focusCalls.length = 0;
  await context.detail();
  assert.equal(doc.activeElement, outside);
  assert.deepEqual(doc.focusCalls, []);
});

test('the Final report leaves out the orch-result block the panel already shows, and the log leaves out empty OUTPUT rows', () => {
  const { context, panel } = page();
  const block = '```orch-result\n{"outcome":"done","changed":[],"checks":[],"decisions":[],"unresolved":[]}\n```';
  const paint = (extra, ev = []) => { context.lastDetail = ''; context.paint('s/k', task({ report: { outcome: 'done', checks: [], decisions: [], unresolved: [] }, ...extra }), false, ev); };
  const final = () => { const i = panel.children.findIndex((n) => n.tag === 'h3' && textOf(n) === 'Final report'); return i < 0 ? null : textOf(panel.children[i + 1]); };
  paint({ finalMessage: `Changed the parser.\n\nAll gates pass.\n\n${block}\n` });
  assert.equal(final(), 'Changed the parser.\n\nAll gates pass.');
  assert.doesNotMatch(textOf(panel.children), /orch-result|"outcome"/);
  // A message that is only the block shows no Final report at all.
  paint({ finalMessage: `${block}\n` });
  assert.equal(final(), null);
  // A block that does not parse stays, so the reader can see what is wrong with it.
  paint({ finalMessage: `Done.\n\n${block.replace('"done"', 'done')}\n`, report: { invalid: true, error: 'Unexpected token' } });
  assert.match(final(), /```orch-result/);
  // A tool event without output text gets no OUTPUT row.
  paint({}, [{ kind: 'tool', text: 'Read src/a.js' }, { kind: 'output', text: '' }, { kind: 'output', text: '  \n' }, { kind: 'tool', text: 'Read src/b.js' }, { kind: 'output', text: 'line 1' }]);
  assert.deepEqual(classed(panel.children, 'ev').map((e) => e.attrs.class), ['ev tool', 'ev tool', 'ev output']);
  assert.ok(headings(panel.children).includes('Events (3, newest last)'));
});

test('main sessions and native sub-agents get no receipts sections, and keep their working directory', () => {
  const { context, panel } = page();
  for (const extra of [{ native: true }, { main: true }]) {
    const t = { key: 'k', id: 'child', agent: 'claude', state: 'completed', cd: '/work/repo', outDir: '/t.jsonl', ...extra };
    context.lastDetail = '';
    context.paint('s/k', t, true, []);
    const text = textOf(panel.children);
    assert.deepEqual(headings(panel.children).filter((h) => !h.startsWith('Events')), [], `${Object.keys(extra)[0]}: no receipts`);
    assert.equal(all(panel.children, (n) => n.tag === 'details').length, 0);
    assert.doesNotMatch(text, /Context|Attempts|Verification/);
    assert.match(text, /working dir\/work\/repo/);
  }
  // A task that orch.mjs prepared but never started has no attempts: no receipts either.
  context.lastDetail = '';
  context.paint('s/k', { key: 'k', id: 'later', run: 'r', agent: '-', state: 'prepared', attempt: 0, attempts: [], cd: '/w' }, false, []);
  assert.doesNotMatch(textOf(panel.children), /Context|Attempts|Brief/);
});
