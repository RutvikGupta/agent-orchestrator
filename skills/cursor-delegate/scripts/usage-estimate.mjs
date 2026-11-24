// A running estimate of a Cursor run's token usage. Cursor's stream-json reports usage only once,
// in its final `result` event, so the relay estimates each model call as the run goes and puts the
// estimate on the Claude-shaped events it writes. The orchestrator shows those totals marked as
// estimates (`~`), and the final event's exact totals replace them.
//
// The estimate: every model call reads the whole context so far (a fixed base for Cursor's own
// prompt, tool schemas and project rules, plus the brief, every tool call and the part of every
// tool result the model sees), most of it from the cache written by the call before. A call writes
// its thinking, its tool calls and its text. Calibration factors per model, learned from earlier
// runs' exact totals, scale the estimate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHARS_PER_TOKEN = 4;
// Cursor's own prompt, tool schemas and the project's rules files, read by every call. Fitted on
// a run in a repository with AGENTS.md and CLAUDE.md; the calibration corrects it per machine.
const BASE_TOKENS = 60000;
// Cursor streams summaries of the model's thinking, which are shorter than what it bills.
const OUTPUT_FACTOR = 1.5;
// Fields of a tool result that the model never reads: an edit's whole file before and after, and a
// second copy of a shell command's output.
const UNSEEN = new Set(["afterFullFileContent", "beforeFullFileContent", "interleavedOutput", "contentBlobId"]);
// How much one finished run moves the calibration, and the bounds of a factor.
const LEARNING_RATE = 0.3;
const FACTOR_RANGE = [0.25, 4];
// Runs this small say little about long ones: they do not change the calibration.
const MIN_CALLS = 3;

const tokens = (chars) => chars / CHARS_PER_TOKEN;
const size = (value) => (value === undefined ? 0 : (typeof value === "string" ? value : JSON.stringify(value)).length);
const clamp = (n) => Math.min(FACTOR_RANGE[1], Math.max(FACTOR_RANGE[0], n));

// Where calibration lives: CURSOR_DELEGATE_STATE, else $XDG_STATE_HOME/cursor-delegate, else
// ~/.local/state/cursor-delegate.
export function calibrationPath(env = process.env) {
  const dir = env.CURSOR_DELEGATE_STATE
    || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "cursor-delegate");
  return path.join(dir, "usage-calibration.json");
}

function readCalibration(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// The part of a tool result the model reads.
function seenResultSize(result) {
  if (!result || typeof result !== "object") return size(result);
  const seen = {};
  for (const [status, part] of Object.entries(result)) {
    seen[status] = part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).filter(([key]) => !UNSEEN.has(key)))
      : part;
  }
  return size(seen);
}

// An estimator for one run of `model` (the base id, such as gemini-4-neon). `briefChars` is the
// prompt's length. `file` is the calibration file; null turns calibration off.
export function createUsageEstimator({ model = null, briefChars = 0, file = calibrationPath() } = {}) {
  const store = file ? readCalibration(file) : {};
  const factors = (model && store[model]) || { input: 1, output: 1, runs: 0 };
  let context = BASE_TOKENS + tokens(briefChars); // what the next call reads
  let previousInput = 0;                          // what the call before read: now in the cache
  let pendingOutput = 0;                          // thinking not yet tied to a call
  let finals = 0;
  const calls = new Map();                        // id -> { input, cached, output } before calibration

  const openCall = (id) => {
    if (calls.has(id)) return calls.get(id);
    const call = { input: context, cached: Math.min(previousInput, context), output: pendingOutput };
    calls.set(id, call);
    previousInput = context;
    context += pendingOutput;
    pendingOutput = 0;
    return call;
  };
  // A call's usage in Claude's field names, scaled by the calibration.
  const usageOf = (call) => {
    const input = call.input * factors.input, cached = call.cached * factors.input;
    return {
      input_tokens: Math.round(input - cached),
      cache_read_input_tokens: Math.round(cached),
      cache_creation_input_tokens: 0,
      output_tokens: Math.round(call.output * OUTPUT_FACTOR * factors.output),
    };
  };

  return {
    factors,
    thinking(text) {
      pendingOutput += tokens(size(text));
    },
    // A Cursor tool_call event: returns { id, usage } for the model call that made it.
    toolCall(event, tool) {
      const id = String(event.model_call_id || event.call_id || `call-${calls.size + 1}`);
      const call = openCall(id);
      if (event.subtype === "started") {
        const args = tokens(size(tool?.args ?? tool?.arguments));
        call.output += args;
        context += args;
      } else if (event.subtype === "completed") {
        context += tokens(seenResultSize(tool?.result));
      }
      return { id, usage: usageOf(call) };
    },
    // The model's text: the last call of a turn.
    text(text) {
      const id = `text-${++finals}`;
      const call = openCall(id);
      const out = tokens(size(text));
      call.output += out;
      context += out;
      return { id, usage: usageOf(call) };
    },
    // The estimate's totals in the result's field names.
    totals() {
      const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const call of calls.values()) {
        const u = usageOf(call);
        sum.inputTokens += u.input_tokens;
        sum.cacheReadTokens += u.cache_read_input_tokens;
        sum.outputTokens += u.output_tokens;
      }
      return sum;
    },
    // Learn from the run's exact usage. Returns the new factors, or null when nothing was learned.
    calibrate(actual) {
      if (!file || !model || !actual || calls.size < MIN_CALLS) return null;
      const raw = { input: 0, output: 0 };
      for (const call of calls.values()) {
        raw.input += call.input;
        raw.output += call.output * OUTPUT_FACTOR;
      }
      const actualInput = (actual.inputTokens || 0) + (actual.cacheReadTokens || 0) + (actual.cacheWriteTokens || 0);
      const actualOutput = actual.outputTokens || 0;
      if (!(raw.input > 0 && raw.output > 0 && actualInput > 0 && actualOutput > 0)) return null;
      const learn = (old, observed) => clamp(factors.runs ? old + LEARNING_RATE * (observed - old) : observed);
      const next = {
        input: learn(factors.input, actualInput / raw.input),
        output: learn(factors.output, actualOutput / raw.output),
        runs: factors.runs + 1,
      };
      try {
        const current = readCalibration(file);
        current[model] = next;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temp, file);
      } catch {
        return null; // calibration is a convenience: never fail the run over it
      }
      return next;
    },
  };
}
