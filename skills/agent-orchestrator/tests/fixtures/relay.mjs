// Copied to each relay folder by the test harness: claude-delegate, codex-delegate, and
// cursor-delegate (gemini). The folder decides the vendor it plays. The gemini relay writes Claude's
// stream-json shape with no cost, puts the session id and usage in result.json, and, like the real
// cursor-delegate relay, exits 2 on a flag outside its contract (after writing invocation.json).
// These literal capability markers match the real Claude relay's source checks:
// "--allow-domain" "--allow-publish" "--no-sandbox"
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const value = (flag) => argv[argv.indexOf(flag) + 1];
const out = value('--out-dir');
const brief = fs.readFileSync(value('--brief'), 'utf8');
// A brief without a fake-relay comment, such as one a parked babysitter's watcher writes, uses
// FAKE_RELAY_CONFIG from the environment.
const config = JSON.parse(/<!-- fake-relay (.*?) -->/.exec(brief)?.[1] || process.env.FAKE_RELAY_CONFIG || '{}');
const vendor = process.argv[1].includes('claude-delegate') ? 'claude' : process.argv[1].includes('cursor-delegate') ? 'gemini' : 'codex';
const gemini = vendor === 'gemini';
const claude = vendor !== 'codex'; // Claude's event shape: Claude, and Gemini through the cursor relay
const session = argv.includes('--session') ? value('--session') : `fixture-${vendor}`;
const startedAt = new Date().toISOString();
const model = value('--model');
const effort = value('--effort');
const event = (entry) => fs.appendFileSync(path.join(out, 'events.jsonl'), `${JSON.stringify(entry)}\n`);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'invocation.json'), JSON.stringify({
  argv, cwd: process.cwd(), depth: process.env.AGENT_ORCH_DEPTH,
  run: process.env.AGENT_ORCH_RUN, task: process.env.AGENT_ORCH_TASK,
  compactWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null,
}));
if (gemini) {
  const VALUE_FLAGS = new Set(['--brief', '--cd', '--out-dir', '--model', '--effort', '--sandbox', '--deny', '--allow', '--session', '--timeout']);
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) { i++; continue; }
    if (argv[i] === '--read-only') continue;
    process.stderr.write(`cursor-delegate: unknown argument ${argv[i]}\n`);
    process.exit(2);
  }
  if (argv.includes('--sandbox') && !['enabled', 'disabled'].includes(value('--sandbox'))) process.exit(2);
}
// A larger last model call, for tests of the handoff limits: `contextTokens` input tokens.
const usage = { input_tokens: config.contextTokens ? config.contextTokens - 20 : 100, cache_read_input_tokens: 20, output_tokens: 30 };
event(claude
  ? { type: 'system', subtype: 'init', session_id: session, model }
  : { type: 'thread.started', thread_id: session });
for (const extra of config.extraEvents || []) event(extra);
// A shell command running under the relay, as an agent's pending tool call would be; its pid is in
// shell.pid. `shell` is the exact shell argv (for example ["/bin/bash", "-c", "sleep 61"]).
if (config.shell) {
  const { spawn } = await import('node:child_process');
  const child = spawn(config.shell[0], config.shell.slice(1), { stdio: 'ignore' });
  fs.writeFileSync(path.join(out, 'shell.pid'), String(child.pid));
}

function finish(status = config.status || 'completed', signal = null) {
  const finalMessage = config.finalMessage ?? 'Fixture task finished.';
  const exitCode = status === 'completed' ? 0 : 1;
  if (claude) {
    // The gemini relay reports usage once, in its result event, and no cost.
    event({ type: 'assistant', effort, message: {
      id: 'message-1', model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: finalMessage }],
      ...(gemini ? {} : { usage }),
    } });
    event({ type: 'result', subtype: exitCode ? 'error_during_execution' : 'success',
      is_error: Boolean(exitCode), result: config.error || finalMessage, session_id: session,
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
      ...(gemini ? {} : { total_cost_usd: 0.01 }) });
  } else {
    event({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: finalMessage } });
    event({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } });
    if (exitCode) event({ type: 'turn.failed', error: { message: config.error || finalMessage } });
  }
  fs.writeFileSync(path.join(out, 'final.txt'), finalMessage);
  const result = {
    schema: 'delegate-relay.result.v1', status, exitCode, signal, finalMessage,
    ...(claude ? { sessionId: session } : { threadId: session }),
    // As the real gemini relay does: `model` is the base id given with --model, and `cursorModel` the
    // id Cursor ran, which carries the effort (gemini-4-neon-high).
    ...(gemini ? { agentVersion: 'fixture-cursor 1.0', cursorModel: effort ? `${model}-${effort}` : model,
      usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 0 }, stderrTail: '' } : {}),
    model, effort, touchedFiles: config.touchedFiles || [], finishedAt: new Date().toISOString(),
    startedAt, readOnlyViolation: config.readOnlyViolation ?? false, error: config.error || null,
  };
  fs.writeFileSync(path.join(out, 'result.json.tmp'), JSON.stringify(result));
  fs.renameSync(path.join(out, 'result.json.tmp'), path.join(out, 'result.json'));
  process.exit(exitCode);
}
process.on('SIGTERM', () => finish('stopped', 'SIGTERM'));
// Publish readiness only after events and the signal handler are installed.
fs.writeFileSync(path.join(out, 'ready'), '');
if (config.hold) {
  const poll = setInterval(() => {
    if (fs.existsSync(path.join(out, 'release'))) finish();
  }, 10);
  // A missing release is a fixture failure, never a successful timed completion.
  setTimeout(() => { clearInterval(poll); finish('timeout'); }, 30_000);
} else {
  // A bounded delay also prevents a broken test from leaving a permanent relay behind.
  setTimeout(finish, Math.min(config.delayMs || 0, 30_000));
}
