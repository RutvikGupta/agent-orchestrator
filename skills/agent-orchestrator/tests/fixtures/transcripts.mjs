import path from 'node:path';
import { jsonl, writeJson } from '../helpers.mjs';

export function claudeTranscripts(f, session) {
  const timestamp = new Date().toISOString();
  const project = path.join(f.claude, 'projects', 'fixture-project');
  const user = (text, extra = {}) => ({ type: 'user', timestamp, cwd: f.repo,
    message: { role: 'user', content: text }, ...extra });
  const assistant = (text, done = true) => ({ type: 'assistant', timestamp, effort: 'xhigh', message: {
    id: 'fixture-message', model: 'claude-opus-5-5', stop_reason: done ? 'end_turn' : 'tool_use',
    content: done ? [{ type: 'text', text }] : [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'README.md' } }],
    usage: { input_tokens: 10, output_tokens: 5 },
  } });
  const main = jsonl(path.join(project, `${session}.jsonl`), [
    user('Run the fixture tasks.'), assistant('The main turn finished.'),
    { type: 'system', subtype: 'turn_duration', timestamp, durationMs: 12 },
    user('Summary of the prior conversation.', { isCompactSummary: true }),
  ]);
  const children = {};
  const cases = {
    running: [user('Read the file.'), assistant('', false)],
    completed: [user('Give a report.'), assistant('Finished the report.')],
    stopped: [user('Read the file.'), assistant('', false), user('[Request interrupted by user for tool use]')],
    'needs-decision': [user('Choose a plan.'), assistant('NEEDS DECISION:\nWhich scope should I use? Recommendation: keep the scope.')],
  };
  for (const [state, events] of Object.entries(cases)) {
    const file = jsonl(path.join(project, session, 'subagents', `agent-${state}.jsonl`), events);
    writeJson(file.replace(/\.jsonl$/, '.meta.json'), { agentType: 'general-purpose', description: state });
    children[state] = file;
  }
  return { main, children };
}

export function codexTranscript(f) {
  const id = '019a0000-0000-7000-8000-000000000001';
  const timestamp = new Date().toISOString();
  const date = timestamp.slice(0, 10).replaceAll('-', '/');
  return jsonl(path.join(f.codex, 'sessions', date, `rollout-${id}.jsonl`), [
    { type: 'session_meta', timestamp, payload: { id, timestamp, cwd: f.repo } },
    { type: 'turn_context', timestamp, payload: { turn_id: id, cwd: f.repo, model: 'gpt-6.1-sol', effort: 'medium' } },
    { type: 'event_msg', timestamp, payload: { type: 'item_completed', item: {
      type: 'UserMessage', content: [{ type: 'input_text', text: 'Read a fixture.' }],
    } } },
    { type: 'event_msg', timestamp, payload: { type: 'item_completed', item: {
      type: 'AgentMessage', content: [{ type: 'output_text', text: 'Codex fixture transcript reply.' }],
    } } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', last_agent_message: 'Codex fixture transcript reply.' } },
  ]);
}
