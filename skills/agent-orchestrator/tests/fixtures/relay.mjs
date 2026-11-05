// Copied to both <agent>-delegate/scripts/relay.mjs by the test harness.
// These literal capability markers match the real Claude relay's source checks:
// "--allow-domain" "--allow-publish" "--no-sandbox"
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const value = (flag) => argv[argv.indexOf(flag) + 1];
const out = value('--out-dir');
const brief = fs.readFileSync(value('--brief'), 'utf8');
const config = JSON.parse(/<!-- fake-relay (.*?) -->/.exec(brief)?.[1] || '{}');
const claude = process.argv[1].includes('claude-delegate');
const session = argv.includes('--session') ? value('--session') : `fixture-${claude ? 'claude' : 'codex'}`;
const startedAt = new Date().toISOString();
const model = value('--model');
const effort = value('--effort');
const event = (entry) => fs.appendFileSync(path.join(out, 'events.jsonl'), `${JSON.stringify(entry)}\n`);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'invocation.json'), JSON.stringify({
  argv, cwd: process.cwd(), depth: process.env.AGENT_ORCH_DEPTH,
  run: process.env.AGENT_ORCH_RUN, task: process.env.AGENT_ORCH_TASK,
}));
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
    event({ type: 'assistant', effort, message: {
      id: 'message-1', model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: finalMessage }],
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
    } });
    event({ type: 'result', subtype: exitCode ? 'error_during_execution' : 'success',
      is_error: Boolean(exitCode), result: config.error || finalMessage, session_id: session,
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
      total_cost_usd: 0.01 });
  } else {
    event({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: finalMessage } });
    event({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } });
    if (exitCode) event({ type: 'turn.failed', error: { message: config.error || finalMessage } });
  }
  fs.writeFileSync(path.join(out, 'final.txt'), finalMessage);
  const result = {
    schema: 'delegate-relay.result.v1', status, exitCode, signal, finalMessage,
    ...(claude ? { sessionId: session } : { threadId: session }),
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
