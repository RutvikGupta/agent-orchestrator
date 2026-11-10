// `skill`: whether the skill's instructions changed since this session or task loaded them, and
// `skill --loaded` to say it has read them again (lib/skill-version.mjs).
import { CLI_PATH } from "../config.mjs";
import { changeLines, markLoaded, skillState } from "../skill-version.mjs";
import { die, emit } from "../util.mjs";

const short = (fingerprint) => fingerprint.slice(0, 16);

export function cmdSkill(args) {
  if (args._.length) die("usage: skill [--loaded] [--json]", 2);
  const state = skillState();
  const { caller, dir } = state;
  const record = args.loaded ? markLoaded(state) : state.recorded;
  const changed = args.loaded ? (caller ? false : null) : state.changed;
  const result = {
    dir,
    caller: caller ? { key: caller.key, label: caller.label } : null,
    recorded: record ? { fingerprint: record.fingerprint, recordedAt: record.recordedAt, commit: record.commit } : null,
    current: { fingerprint: state.current.fingerprint },
    changed,
    files: changed ? state.files : { changed: [], added: [], removed: [] },
    ...(args.loaded ? { loaded: Boolean(record) } : {}),
  };
  const lines = [`skill folder: ${dir}`, `caller: ${caller ? caller.label : "none (no session or task identity, as in a plain terminal, so nothing is recorded for it)"}`];
  if (args.loaded) {
    lines.push(record
      ? `recorded the current fingerprint ${short(record.fingerprint)} as the one you loaded; the notice stops until the skill changes again`
      : `current fingerprint: ${short(state.current.fingerprint)}; nothing was recorded, since this caller has no identity`);
  } else {
    lines.push(
      `recorded fingerprint: ${record ? `${short(record.fingerprint)} (first seen ${record.recordedAt})` : "none yet (the next orch.mjs command of this caller records it)"}`,
      `current fingerprint:  ${short(state.current.fingerprint)}`,
      changed === null ? "changed: unknown, with no record to compare" : changed ? "changed: yes, the skill changed since you loaded it" : "changed: no",
    );
    if (changed) lines.push(...changeLines(state).map((l) => `  ${l}`), `  After you have read it, run: node ${CLI_PATH} skill --loaded`);
  }
  emit(args, result, lines.join("\n"));
}
