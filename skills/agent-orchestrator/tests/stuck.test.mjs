import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fixture, jsonl, readJson } from './helpers.mjs';
// Internal imports: the stuck rule is a function of one event stream, checked here over many small
// streams (under 1 MB, so nothing is saved or read under the state root) without a relay for each.
// The CLI tests below check the same rule end to end, and the classifier with rows as /api/state has.
import { stuckOf, summarizeEvents } from '../scripts/lib/events.mjs';
import { attentionOf, byUrgency } from '../scripts/lib/dashboard-state.mjs';

let ids = 0;
const quoted = (command) => `/bin/zsh -lc '${command.replaceAll("'", "'\\''")}'`;
const claude = {
  run(command, result, extra = {}) {
    const id = `toolu_${++ids}`;
    return [
      { type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
      { type: 'user', ...extra, message: { content: [{ type: 'tool_result', tool_use_id: id, ...result }] } },
    ];
  },
  fail: (command, code = 1, output = 'boom') => claude.run(command, { is_error: true, content: `Exit code ${code}\n${output}` }),
  ok: (command, output = 'done') => claude.run(command, { content: [{ type: 'text', text: output }] }),
  // A piped command's result: exit code `code`, with `output`.
  piped: (command, output, code = 0) => (code ? claude.fail(command, code, output) : claude.ok(command, output)),
  edit(name = 'Edit', failed = false, extra = {}) {
    const id = `toolu_${++ids}`;
    return [
      { type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name, input: { file_path: 'src/a.js' } }] } },
      { type: 'user', ...extra, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: failed ? 'String to replace not found' : 'Updated src/a.js' }] } },
    ];
  },
};
const codex = {
  run(command, exit_code, output = '', status = exit_code === 0 ? 'completed' : 'failed') {
    const item = { id: `item_${++ids}`, type: 'command_execution', command: quoted(command) };
    return [
      { type: 'item.started', item: { ...item, aggregated_output: '', exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { ...item, aggregated_output: output, exit_code, status } },
    ];
  },
  fail: (command, code = 1, output = 'boom') => codex.run(command, code, output),
  ok: (command, output = 'done') => codex.run(command, 0, output),
  piped: (command, output, code = 0) => codex.run(command, code, output),
  edit: (name, failed = false) => [{ type: 'item.completed', item: { id: `item_${++ids}`, type: 'file_change', status: failed ? 'failed' : 'completed', changes: [{ path: 'src/a.js', kind: 'update' }] } }],
};
const agents = { claude, codex };
const times = (n, make) => Array.from({ length: n }, make).flat();
const at = (events, iso) => events.map((e, i) => (i === events.length - 1 ? { ...e, timestamp: iso } : e));

// Streams in a temporary folder: `stuck(agent, events)` reads a new stream; `open` keeps one to append.
function streams(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stuck-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const open = (agent, events = []) => {
    const file = jsonl(path.join(dir, `${++n}.jsonl`), events);
    return {
      file,
      append: (more) => fs.appendFileSync(file, more.map((e) => JSON.stringify(e)).join('\n') + '\n'),
      // As describe() does: bring the summary up to date, then read the flag from it.
      stuck: () => (summarizeEvents(agent, file, dir), stuckOf(agent, file, dir)),
      summary: () => summarizeEvents(agent, file, dir),
    };
  };
  return { open, stuck: (agent, events) => open(agent, events).stuck() };
}

for (const agent of ['claude', 'codex']) {
  const a = agents[agent];

  test(`${agent}: three failing runs with only reads between them are stuck`, (t) => {
    const { stuck } = streams(t);
    const reads = [...a.ok('cat test.log'), ...a.fail('grep -n parse src/a.js'), ...a.ok('git diff'), ...a.ok("sed -n '1,40p' src/a.js")];
    assert.equal(stuck(agent, [...a.fail('npm test'), ...reads, ...a.fail('npm test')]), null, 'two failures are not enough');
    assert.deepEqual(stuck(agent, [...a.fail('npm test'), ...reads, ...a.fail('npm test'), ...a.ok('ls'), ...a.fail('npm test')]),
      { command: 'npm test', failures: 3, firstMs: null, lastMs: null, firstIndex: 2 });
    const timed = stuck(agent, [
      ...at(a.fail('npm test'), '2026-11-05T10:00:00.000Z'), ...a.fail('npm test'), ...at(a.fail('npm test'), '2026-11-05T10:02:00.000Z'),
    ]);
    assert.equal(timed.firstMs, Date.parse('2026-11-05T10:00:00.000Z'));
    assert.equal(timed.lastMs, Date.parse('2026-11-05T10:02:00.000Z'));
  });

  test(`${agent}: the key drops shell and timeout wrappers but keeps cd, pipes and redirects`, (t) => {
    const { stuck } = streams(t);
    const same = stuck(agent, [...a.fail("bash -lc 'npm   test'"), ...a.fail('timeout 600 npm test'), ...a.fail('npm \t  test')]);
    assert.equal(same.command, 'npm test');
    assert.equal(same.failures, 3);
    assert.equal(stuck(agent, [...a.fail('cd a && npm test'), ...a.fail('cd a && npm test'), ...a.fail('cd b && npm test'), ...a.fail('cd a && npm test')]), null);
    assert.equal(stuck(agent, times(3, () => a.fail('cd a && npm test'))).command, 'cd a && npm test');
    assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test 2>&1'), ...a.fail('npm test')]), null, 'a redirect is part of the key');
    assert.equal(stuck(agent, times(3, () => a.fail("node check.js 'a  b'"))).command, "node check.js 'a  b'", 'quoted spacing stays');
  });

  test(`${agent}: an edit, another command, a wait, a sleep or a success ends the streak`, (t) => {
    const { stuck } = streams(t);
    const breakers = {
      edit: a.edit('Edit'),
      'unknown command': a.ok('make fmt'),
      'failing unknown command': a.fail('make fmt'),
      sleep: a.ok('sleep 5'),
      nap: a.ok('node /skills/agent-orchestrator/scripts/orch.mjs nap 30s'),
      success: a.ok('npm test'),
      ...(agent === 'claude' ? {
        Write: claude.edit('Write'), MultiEdit: claude.edit('MultiEdit'), NotebookEdit: claude.edit('NotebookEdit'),
        'sub-agent edit': claude.edit('Edit', false, { parent_tool_use_id: 'toolu_task' }),
        'sub-agent command': claude.run('make fmt', { content: 'formatted' }, { parent_tool_use_id: 'toolu_task' }),
      } : {}),
    };
    for (const [name, events] of Object.entries(breakers)) {
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...events, ...a.fail('npm test')]), null, name);
      const again = stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...events, ...times(3, () => a.fail('npm test'))]);
      assert.equal(again?.failures, 3, `${name}: a new streak starts after it`);
      assert.ok(again.firstIndex > 4, name);
    }
  });

  test(`${agent}: a failed edit, a declined or denied command, and a read message leave the streak`, (t) => {
    const { stuck } = streams(t);
    const keep = {
      'failed edit': a.edit('Edit', true),
      'inbox read': a.ok('node /skills/agent-orchestrator/scripts/orch.mjs inbox run-1 task --ack'),
      'status read': a.ok('node /skills/agent-orchestrator/scripts/orch.mjs status run-1'),
      ...(agent === 'codex'
        ? { declined: codex.run('make fmt', null, '', 'declined') }
        : {
          denied: claude.run('make fmt', { is_error: true, content: 'Permission to use Bash with command make fmt has been denied.' }),
          'sub-agent read': claude.run('cat src/a.js', { content: 'x' }, { parent_tool_use_id: 'toolu_task' }),
        }),
    };
    for (const [name, events] of Object.entries(keep)) {
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...events, ...a.fail('npm test')])?.failures, 3, name);
    }
    if (agent === 'claude') {
      const sub = { parent_tool_use_id: 'toolu_task' };
      assert.equal(stuck(agent, times(3, () => claude.run('npm test', { is_error: true, content: 'Exit code 1' }, sub))), null, "a sub-agent's failures never count");
    }
  });

  test(`${agent}: waiting and polling commands are never stuck, and break a streak`, (t) => {
    const { stuck } = streams(t);
    const cli = 'node /skills/agent-orchestrator/scripts/orch.mjs';
    for (const command of [
      `${cli} pr-watch 12 --repo example-org/example-repo`, `${cli} wait run-1 --timeout 5m`, 'timeout 900 node scripts/orch.mjs wait run-1',
      'gh pr checks 12', 'gh run watch 99', 'sleep 30 && gh pr checks 12', 'while ! gh pr checks 12; do sleep 30; done',
    ]) {
      assert.equal(stuck(agent, times(4, () => a.fail(command, 3, 'checks pending'))), null, command);
    }
    assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail(`${cli} wait run-1`, 3), ...a.fail('npm test'), ...a.fail('gh pr checks 1', 8), ...a.fail('npm test')]), null);
  });

  test(`${agent}: gh with global flags, and probe commands, are polling: never failures, and they break a streak`, (t) => {
    const { stuck } = streams(t);
    for (const command of [
      'gh -R example-org/example-repo pr checks 12', 'gh --repo example-org/example-repo pr checks 12', 'gh --hostname git.example.com run watch 99',
      'gh pr --repo example-org/example-repo checks 12', 'curl -sf http://localhost:3000/health', 'wget -q -O- http://localhost:3000', 'nc -z localhost 5432',
      'test -f out/ready', '[ -f out/ready ]', '[[ -f out/ready ]]', 'pgrep -f vite', 'ps -p 4242', 'until curl -sf http://localhost:3000; do sleep 2; done',
    ]) {
      assert.equal(stuck(agent, times(4, () => a.fail(command))), null, command);
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...a.fail(command), ...a.fail('npm test')]), null, `${command} breaks a streak`);
    }
    assert.equal(stuck(agent, times(3, () => a.fail('gh -R example-org/example-repo pr view 12')))?.failures, 3, 'other gh commands can fail');
  });

  test(`${agent}: exits 130 and 143 are interrupts, not failures`, (t) => {
    const { stuck } = streams(t);
    for (const code of [130, 143]) {
      assert.equal(stuck(agent, times(3, () => a.fail('npm test', code))), null, code);
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test', code), ...a.fail('npm test')]), null, `${code} does not count`);
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test', code), ...a.fail('npm test'), ...a.fail('npm test')])?.failures, 3, `${code} does not break`);
    }
  });

  test(`${agent}: a command piped into tail, head or grep fails only on a failure marker`, (t) => {
    const { stuck } = streams(t);
    for (const filter of ['tail -20', 'head -50', 'grep -E "FAIL|passed"']) {
      const command = `npm test 2>&1 | ${filter}`;
      for (const marker of ['FAIL src/parse.test.js', ' FAIL  src/a.test.js', 'FAILED tests/test_a.py::test_x - assert 1 == 2',
        'Tests: 2 failed, 10 passed', 'not ok 3 - parses dates', '    not ok 1 - nested', 'Traceback (most recent call last):\n  File "a.py"',
        'AssertionError: expected 1 to equal 2']) {
        assert.equal(stuck(agent, times(3, () => a.piped(command, `ok 1\n${marker}\nend`)))?.failures, 3, `${filter}: ${marker}`);
      }
      for (const output of ['Tests: 0 failed, 12 passed', '12 passed\n0 failed', 'all good', 'no FAILures here', 'test_failed_input PASSED']) {
        assert.equal(stuck(agent, times(3, () => a.piped(command, output))), null, `${filter}: ${output}`);
      }
      assert.equal(stuck(agent, times(3, () => a.piped(command, '', 1))), null, `${filter}: exit 1 without a marker is unknown`);
      assert.equal(stuck(agent, [...a.piped(command, 'FAIL a'), ...a.piped(command, 'ok'), ...a.piped(command, 'FAIL a'), ...a.piped(command, 'FAIL a')])?.failures, 3,
        `${filter}: an unknown run neither counts nor breaks`);
    }
  });

  test(`${agent}: a redirect makes a command not read-only`, (t) => {
    const { stuck } = streams(t);
    const writes = ['cat a.txt > b.txt', 'echo note >> NOTES.md', 'grep -n x src/a.js &> out.txt', 'cat <<\'EOF\' > notes.md\nhello\nEOF',
      'grep x src/a.js | tee out.txt', "sed -i 's/a/b/' src/a.js", "find . -name '*.tmp' -delete", 'find . -exec rm {} ;',
      'git checkout -- src/a.js', "awk '{ print > \"out.txt\" }' src/a.js", 'echo "$(touch x)"', 'cat `touch x`', "sed -n 'w out.txt' src/a.js"];
    for (const command of writes) {
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...a.ok(command), ...a.fail('npm test')]), null, command);
    }
    const reads = ['grep -rn parse src > /dev/null', 'grep -n x src/a.js 2>&1', 'cat a.txt 2>/dev/null | head -5', 'ls -la && pwd',
      "find . -name '*.js'", 'git status --short', 'git -C sub log --oneline -5', "sed -n '1,20p' src/a.js", 'jq .name package.json',
      'cd src && grep -n x a.js', 'echo done', 'wc -l src/a.js', 'stat src/a.js', 'file src/a.js', 'rg -n parse', 'less README.md',
      "awk '{ print $1 }' src/a.js", 'for f in a.js b.js; do cat "$f"; done', 'echo "a > b"', 'tail -n 20 test.log >&2',
      'cat <<EOF\nnpm install > x\nEOF'];
    for (const command of reads) {
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...a.ok(command), ...a.fail('npm test')])?.failures, 3, command);
    }
  });
}

test('Claude reads an exit code only from the first line of an error result', (t) => {
  const { stuck } = streams(t);
  assert.equal(stuck('claude', times(3, () => claude.ok('npm test', 'Example output\nExit code 1'))), null, 'successful output');
  assert.equal(stuck('claude', times(3, () => claude.run('npm test', { is_error: true, content: 'Error: build failed\nExit code 1' }))), null, 'below the first line');
  assert.equal(stuck('claude', times(3, () => claude.run('npm test', { is_error: true, content: 'Error: Exit code 2\nbuild failed' })))?.failures, 3, 'Error: Exit code N');
  assert.equal(stuck('claude', times(3, () => claude.run('npm test', { is_error: true, content: [{ type: 'text', text: 'Exit code 7\nfailed' }] })))?.failures, 3, 'block content');
  assert.equal(stuck('claude', times(3, () => claude.run('npm test', { is_error: true, content: 'Command timed out after 2m' }))), null, 'no exit code is unknown');
});

test('Codex counts a failed command without an exit code, but not a declined one', (t) => {
  const { stuck } = streams(t);
  assert.equal(stuck('codex', times(3, () => codex.run('npm test', null, '', 'failed')))?.failures, 3);
  assert.equal(stuck('codex', times(3, () => codex.run('npm test', null, '', 'declined'))), null);
  // A completion seen twice counts once; one without a started event counts too.
  const [started, done] = codex.fail('npm test');
  assert.equal(stuck('codex', [started, done, done, ...codex.fail('npm test')]), null);
  assert.equal(stuck('codex', [...times(3, () => codex.fail('npm test').slice(1))])?.failures, 3);
});

test('a piped run without an exit code fails only on a failure marker, and an unfinished one never does', (t) => {
  const { stuck } = streams(t);
  const command = 'npm test 2>&1 | tail -5';
  assert.equal(stuck('codex', times(3, () => codex.run(command, null, 'Tests: 0 failed, 12 passed', 'failed'))), null, '"0 failed" is not a failure');
  assert.equal(stuck('codex', times(3, () => codex.run(command, null, 'Tests: 2 failed, 10 passed', 'failed')))?.failures, 3);
  // A Claude run that was interrupted, or still runs in the background, is unknown whatever it printed.
  const interrupted = () => {
    const [use, result] = claude.ok(command, 'FAIL src/a.test.js');
    return [use, { ...result, tool_use_result: { interrupted: true } }];
  };
  const background = () => {
    const [use, result] = claude.ok(command, 'Command running in background with ID: b1\nFAIL src/a.test.js');
    use.message.content[0].input.run_in_background = true;
    return [use, result];
  };
  assert.equal(stuck('claude', times(3, interrupted)), null, 'interrupted');
  assert.equal(stuck('claude', times(3, background)), null, 'background');
});

test('alternating failing reads keep one episode however far the ring moves, and streaks stay within the ring', (t) => {
  const { open } = streams(t);
  const stream = open('codex');
  const shown = new Set();
  for (let i = 0; i < 150; i++) {
    stream.append([...codex.fail('cat missing-a'), ...codex.fail('cat missing-b')]);
    const stuck = stream.stuck();
    if (stuck) shown.add(`${stuck.command} @${stuck.firstIndex} ×${stuck.failures === i + 1 ? 'n' : stuck.failures}`);
  }
  assert.deepEqual([...shown], ['cat missing-a @2 ×n'], 'the same command and first failure throughout');
  const summary = stream.summary();
  assert.equal(summary.actions.length, 200);
  assert.deepEqual(summary.streaks, {
    '#cat missing-a': { firstIndex: 2, firstMs: null, count: 150, lastIndex: 598, lastMs: null },
    '#cat missing-b': { firstIndex: 4, firstMs: null, count: 150, lastIndex: 600, lastMs: null },
  });
  // Reads of another key leave both streaks open, until their last runs leave the ring.
  stream.append(times(199, () => codex.ok('ls')));
  assert.deepEqual(Object.keys(stream.summary().streaks), ['#cat missing-b']);
  assert.equal(stream.stuck().command, 'cat missing-b');
  stream.append(codex.ok('ls'));
  assert.deepEqual(stream.summary().streaks, {});
  assert.equal(stream.stuck(), null);
});

test('sed is read-only only with -n and a script that cannot write, read or run', (t) => {
  const { stuck } = streams(t);
  const between = (agent, command) => {
    const a = agents[agent];
    return stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...a.ok(command), ...a.fail('npm test')])?.failures ?? null;
  };
  const writes = ["sed -n -e'w out.txt' in.txt", 'sed -n -f fix.sed in.txt', "sed -n --expression='w out.txt' in.txt", "sed -n 's/a/b/w out.txt' in.txt",
    "sed -n 's/a/date/e' in.txt", "sed -n '1e date' in.txt", "sed -n '/x/r other.txt' in.txt", "sed -n '$R other.txt' in.txt", "sed -n '/x/W out.txt' in.txt",
    "sed -n '/x/{p;w out.txt' in.txt", "sed -ni 'p' in.txt", 'sed -n --in-place p in.txt', 'sed -n -i.bak p in.txt', "sed '1,5p' in.txt", 'sed -n',
    'sed -n -l 5 p in.txt'];
  const reads = ["sed -n '1,20p' in.txt", "sed -n -e '/start/,/end/p' in.txt", "sed -nE 's/(a+)/\\1/p' in.txt", "sed -n '/error/{p;q}' in.txt",
    "sed --quiet '$p' in.txt", "sed -n '/Exception/I,+3p' in.txt", "sed -n 'y/abc/xyz/;p' in.txt", 'sed -n -e 10p -e 20p in.txt', "sed -n '0~4p' in.txt"];
  for (const agent of ['claude', 'codex']) {
    for (const command of writes) assert.equal(between(agent, command), null, `${agent}: ${command}`);
    for (const command of reads) assert.equal(between(agent, command), 3, `${agent}: ${command}`);
  }
});

test('ANSI-C quoting, substitutions, and environment that picks a program make a command not read-only', (t) => {
  const { stuck } = streams(t);
  const commands = ["find . $'-exec' rm {} +", "find . -name x $'-delete'", 'cat <<EOF\n$(rm -f src/a.js)\nEOF', 'cat <<EOF\n`rm -f src/a.js`\nEOF',
    "cat <<'EOF'\n$(rm -f src/a.js)\nEOF", 'cat <(rm -f src/a.js)', 'grep x src/a.js >(cat)', "echo $'\\x41'", 'ls $(rm -f src/a.js)', 'echo "`rm -f x`"',
    'GIT_EXTERNAL_DIFF=./wipe.sh git diff', 'env LESSOPEN="|rm %s" less README.md', 'git -c core.pager=./wipe.sh log', 'rg --pre ./wipe.sh x'];
  for (const agent of ['claude', 'codex']) {
    const a = agents[agent];
    for (const command of commands) {
      assert.equal(stuck(agent, [...a.fail('npm test'), ...a.fail('npm test'), ...a.ok(command), ...a.fail('npm test')]), null, `${agent}: ${command}`);
    }
  }
});

test('AGENT_ORCH_STUCK_REPEATS sets the number of failures; invalid values keep 3', (t) => {
  const { open } = streams(t);
  const before = process.env.AGENT_ORCH_STUCK_REPEATS;
  t.after(() => (before === undefined ? delete process.env.AGENT_ORCH_STUCK_REPEATS : (process.env.AGENT_ORCH_STUCK_REPEATS = before)));
  const stream = open('codex', [...codex.fail('npm test'), ...codex.fail('npm test')]);
  for (const [value, expected] of [['2', 2], ['3', null], ['1', null], ['x', null], ['2.5', null]]) {
    process.env.AGENT_ORCH_STUCK_REPEATS = value;
    assert.equal(stream.stuck()?.failures ?? null, expected, value);
  }
  stream.append(codex.fail('npm test'));
  process.env.AGENT_ORCH_STUCK_REPEATS = '4';
  assert.equal(stream.stuck(), null);
  delete process.env.AGENT_ORCH_STUCK_REPEATS;
  assert.equal(stream.stuck().failures, 3);
});

test('the ring keeps 200 plain actions, read only from appended lines, and a long streak keeps its start', (t) => {
  const { open } = streams(t);
  const stream = open('claude');
  for (let i = 0; i < 150; i++) {
    stream.append([...claude.fail('npm test'), ...claude.ok('cat test.log')]);
    if (i % 50 === 0) stream.stuck();
  }
  const summary = stream.summary();
  assert.equal(summary.actions.length, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.actions)), summary.actions, 'JSON-friendly');
  assert.deepEqual(stream.stuck(), { command: 'npm test', failures: 150, firstMs: null, lastMs: null, firstIndex: 2 });
  stream.append(claude.edit());
  assert.equal(stream.stuck(), null);
});

test('stuck ranks after failed and before awaiting review, waits from its first failure, and only while running', () => {
  const stuck = { command: 'npm test', failures: 3, firstMs: 1000, lastMs: 2000, firstIndex: 7 };
  const lastActiveMs = Date.now() - 5000;
  const row = { state: 'running', stuck, lastActiveMs };
  assert.deepEqual(attentionOf(row, false), {
    kind: 'stuck', rank: 2.5, label: 'stuck', reason: '`npm test` failed 3 times with no change in between', sinceMs: 1000,
  });
  assert.equal(attentionOf({ ...row, stuck: { ...stuck, firstMs: null } }, false).sinceMs, lastActiveMs);
  assert.match(attentionOf({ ...row, stuck: { ...stuck, command: 'x'.repeat(200) } }, false).reason, /^`x{79}…` failed 3 times/);
  assert.equal(attentionOf({ ...row, health: 'silent', quietMs: 3e6 }, false).kind, 'stuck');
  assert.equal(attentionOf({ ...row, health: 'dead' }, false).kind, 'failed');
  assert.equal(attentionOf({ ...row, state: 'completed' }, false).kind, 'awaiting-review');
  assert.equal(attentionOf(row, true), null);
  const lane = [attentionOf({ state: 'running', health: 'silent', quietMs: 1 }, false), attentionOf({ state: 'completed', lastActiveMs }, false), attentionOf(row, false), attentionOf({ state: 'failed' }, false)];
  assert.deepEqual(lane.sort(byUrgency).map((item) => [item.kind, item.rank]), [['failed', 2], ['stuck', 2.5], ['awaiting-review', 3], ['silent', 4]]);
});

for (const agent of ['claude', 'codex']) {
  test(`${agent}: status, watch and the dashboard show a stuck task while it runs, and never once it finishes`, async (t) => {
    const f = await fixture(t);
    const run = await f.newRun();
    const a = agents[agent];
    const task = await f.start(run, 'loop', { agent, config: { hold: true, extraEvents: [...a.fail('npm test'), ...a.ok('cat test.log'), ...a.fail('npm test'), ...a.fail('npm test')] } });
    await f.ready(task);
    const row = (await f.json(['status', run.id])).tasks[0];
    assert.equal(row.state, 'running');
    // Line 1 is the relay's first event, so the first failure completes on line 3.
    assert.deepEqual(row.stuck, { command: 'npm test', failures: 3, firstMs: null, lastMs: null, firstIndex: 3 });
    assert.match((await f.command(['status', run.id])).stdout, /stuck: `npm test` failed 3× · /);
    assert.match((await f.command(['watch', run.id, '--once'])).stdout, /stuck: `npm test` failed 3× · /);
    if (agent === 'claude') {
      const board = await f.dashboard();
      const section = (await board.json('/api/state')).find((s) => s.tasks.some((r) => r.id === 'loop'));
      assert.deepEqual(section.attention.map((item) => [item.id, item.kind, item.rank, item.reason]),
        [['loop', 'stuck', 2.5, '`npm test` failed 3 times with no change in between']]);
      assert.equal(section.tasks.find((r) => r.id === 'loop').stuck.firstIndex, 3);
    }
    f.release(task);
    const done = await f.finished(run, 'loop');
    assert.equal(done.stuck, null);
    assert.doesNotMatch((await f.command(['status', run.id])).stdout, /stuck/);
    assert.doesNotMatch((await f.command(['watch', run.id, '--once'])).stdout, /stuck/);
  });
}

test('a new stuck task wakes wait with exit 5', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'loop', { agent: 'codex', config: { hold: true, extraEvents: codex.fail('npm test') } });
  await f.ready(task);
  const waited = await f.waitAfterPoll([run.id, '--timeout', '0'], async () => {
    fs.appendFileSync(path.join(task.outDir, 'events.jsonl'), [...codex.ok('cat test.log'), ...codex.fail('npm test'), ...codex.fail('npm test')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  }, { code: 5 });
  assert.match(waited.stdout, /loop: stuck — `npm test` failed 3 times with no change in between/);
  assert.match(waited.stdout, /a task needs attention/);
  f.release(task);
  await f.finished(run, 'loop');
});

test('status writes no file for a stuck task', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'loop', { config: { hold: true, extraEvents: times(3, () => claude.fail('npm test')) } });
  await f.ready(task);
  const files = () => {
    const out = {};
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else out[file] = `${fs.statSync(file).size}:${fs.statSync(file).mtimeMs}`;
      }
    };
    walk(f.state);
    return out;
  };
  const before = files();
  assert.equal((await f.json(['status', run.id])).tasks[0].stuck.failures, 3);
  await f.command(['status', run.id]);
  await f.command(['watch', run.id, '--once']);
  assert.deepEqual(files(), before);
});

test('a saved summary carries the ring to a new process', async (t) => {
  const f = await fixture(t);
  const run = await f.newRun();
  const task = await f.start(run, 'loop', { config: { hold: true } });
  await f.ready(task);
  const file = path.join(task.outDir, 'events.jsonl');
  // Over 1 MB, so `status` saves the summary under the fixture's state root.
  const pad = { type: 'queue-operation', operation: 'enqueue', content: 'x'.repeat(1_200_000) };
  fs.appendFileSync(file, [pad, ...claude.fail('npm test'), ...claude.ok('cat test.log'), ...claude.fail('npm test'), ...claude.fail('npm test')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const first = (await f.json(['status', run.id])).tasks[0].stuck;
  assert.deepEqual(first, { command: 'npm test', failures: 3, firstMs: null, lastMs: null, firstIndex: 4 });
  const dir = path.join(f.state, 'cache', 'summaries');
  const saved = fs.readdirSync(dir).map((name) => readJson(path.join(dir, name))).find((s) => s.file === file);
  assert.ok(saved, 'summary saved');
  assert.equal(saved.summary.actions.length, 4);
  assert.deepEqual(saved.summary.actions.map((x) => x.outcome), ['fail', 'ok', 'fail', 'fail']);
  assert.deepEqual(saved.summary.streaks, { '#npm test': { firstIndex: 4, firstMs: null, count: 3, lastIndex: 10, lastMs: null } });
  // Change the first failing command in place. A full parse would now see two failures; the saved
  // summary, used for the same file, still has three.
  const text = fs.readFileSync(file, 'utf8');
  const at = Buffer.byteLength(text.slice(0, text.indexOf('"command":"npm test"')));
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, '"command":"npm tesX"', at);
  fs.closeSync(fd);
  assert.deepEqual((await f.json(['status', run.id])).tasks[0].stuck, first);
  fs.appendFileSync(file, claude.fail('npm test').map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual((await f.json(['status', run.id])).tasks[0].stuck, { ...first, failures: 4 });
  f.release(task);
  await f.finished(run, 'loop');
});

test('escalation notifies once per stuck episode, and again for a new one', async (t) => {
  const f = await fixture(t);
  const module = new URL('../scripts/lib/escalate.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createEscalator, taskAttention } from ${JSON.stringify(module)};
    const notices = [];
    const tick = createEscalator({ url: 'http://127.0.0.1/', broadcast: (message) => notices.push(message) });
    const row = (firstIndex, failures = 3) => {
      const task = { id: 'loop', key: 'loop', state: 'running', attempt: 1, lastActiveMs: 1, stuck: { command: 'npm test', failures, firstMs: null, lastMs: null, firstIndex } };
      return { ...task, attention: taskAttention(task, false) };
    };
    const at = (task, now) => tick([{ id: 'run', tasks: [task] }], now);
    at(row(10), 1000);
    at(row(10, 4), 5999);
    assert.equal(notices.length, 0);
    at(row(10, 5), 6000);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'stuck');
    assert.match(notices[0].text, /npm test. failed 5 times/);
    at(row(10, 9), 30000);
    assert.equal(notices.length, 1, 'the same episode notifies once');
    at({ ...row(10), stuck: null, attention: null }, 31000);
    at(row(40), 32000);
    at(row(40), 36999);
    assert.equal(notices.length, 1);
    at(row(40), 37000);
    assert.equal(notices.length, 2, 'a new episode in the same attempt notifies again');
    at(row(40, 7), 60000);
    assert.equal(notices.length, 2);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...f.env, AGENT_ORCH_ESCALATE_AFTER: '5s', AGENT_ORCH_NOTIFY: 'off' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('the dashboard page marks a stuck row and colors its attention tag', () => {
  const app = fs.readFileSync(new URL('../scripts/dashboard/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../scripts/dashboard/app.css', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(`${app.split('\n').find((line) => line.startsWith('const nowText='))};this.nowText=nowText;`, context);
  const stuck = { command: 'npm test', failures: 3, firstMs: null, lastMs: null, firstIndex: 3 };
  assert.equal(context.nowText({ now: '$ cat test.log', stuck }), 'stuck: `npm test` failed 3× · $ cat test.log');
  assert.equal(context.nowText({ now: 'thinking', stuck: null }), 'thinking');
  assert.equal(context.nowText({ stuck: { ...stuck, command: 'y'.repeat(50) } }), `stuck: \`${'y'.repeat(29)}…\` failed 3× · `);
  assert.match(app, /class:"nowrow"\},\$\("td",\{\.\.\.indent\(32\),colspan:"10"\},nowText\(t\)\)/);
  assert.match(css, /\.a-stuck \.tag\{color:var\(--run\)\}/);
});
