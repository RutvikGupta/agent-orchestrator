// What a task may do: the sandbox, network, write-directory, and permission-rule arguments that
// `start` passes to a relay.

import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_TOKEN_FILE, HOME, PR_DIR, SKILL_DIR } from "./config.mjs";
import { die, git } from "./util.mjs";

// Network access for one task. Delegated agents get the network by default, as sub-agents inside
// an unsandboxed session do; `--offline` turns it off. Claude's shell sandbox then allows every
// host, plus the macOS certificate service that Go tools such as gh need, and deny rules for
// common gh write commands keep publishing with the orchestrator. Codex gets network access in
// write mode only, because its read-only sandbox stays offline.
const GH_AUTH_DENY = ["login", "logout", "refresh", "setup-git", "switch", "token"].map((c) => `auth ${c}`);
const GH_TOKEN_DENY = ["Bash(gh auth status *--show-token*)"];
const GH_WRITE_COMMANDS = [
  ...GH_AUTH_DENY,
  "gist", "label", "release", "secret", "variable",
  "pr create", "pr merge", "pr close", "pr reopen", "pr comment", "pr review", "pr edit", "pr ready",
  "issue create", "issue comment", "issue close", "issue reopen", "issue edit", "issue delete",
  "repo create", "repo delete", "repo edit", "repo fork", "repo rename",
  "workflow run", "workflow enable", "workflow disable", "run rerun", "run cancel", "run delete",
];
const GH_API_WRITE_FLAGS = ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"];
// Commits and pushes, which a task that may not publish never runs. Claude's relay denies these
// itself unless it is given --allow-publish; the gemini relay gets them as rules. The wildcard forms
// cover `git -C <dir> push` too.
const GIT_PUBLISH_DENY = ["git commit*", "git * commit*", "git push*", "git * push*"];
// The credential files that agent file tools may never read or write: the list the claude-delegate
// relay denies itself (its CREDENTIAL_PATHS; tests/gemini.test.mjs keeps the two equal),
// and the configured Claude, Codex and dashboard paths that credentialFiles adds. A path that ends
// in /** is a folder.
export const CREDENTIAL_PATHS = [
  "~/.ssh/**", "~/.aws/**", "~/.config/gcloud/**", "~/.docker/config.json",
  "~/.netrc", "~/.git-credentials", "~/.claude/.credentials*", "~/.codex/auth.json",
  "~/.local/state/agent-orchestrator/dashboard-token",
  "~/.config/gh/**", "~/.config/graphite/**", "~/.config/github-copilot/**",
  "~/.boto", "~/.kube/**", "~/.fly/**", "~/.gnupg/**", "~/.npmrc", "~/.claude.json",
];

export function relayHasNetworkPatch(relay) {
  return Boolean(relay && fs.readFileSync(relay, "utf8").includes('"--allow-domain"'));
}

// A babysitter is a Claude task that owns one pull request until it lands, so it may commit and
// push (never force) and reply on GitHub. It also writes the worktree's shared git directory and
// the pr-watch state, both outside its working directory.
const BABYSIT_GH_DENY = [
  ...GH_AUTH_DENY,
  "gist", "secret", "variable", "release", "repo create", "repo delete", "repo edit", "repo fork",
  "repo rename", "pr close", "issue delete", "workflow enable", "workflow disable", "run delete",
];
const FORCE_PUSH_DENY = [
  "git push --force*", "git push * --force*", "git push -f", "git push -f *", "git push * -f", "git push * -f *",
  "git push *+*", "git * push --force*", "git * push * --force*", "git * push -f*", "git * push * -f*",
  "gh pr merge --admin*", "gh pr merge * --admin*",
];

// Developer tools keep caches and state under the home directory, outside the task's working
// directory, so the shell sandbox would block them (uv, pre-commit, and other commit hooks and
// gates). Every Claude write task may write these; a babysitter also gets Graphite's state, which
// publishing needs.
const TOOL_WRITE_DIRS = [".cache", "Library/Caches", ".local/share/uv"].map((d) => path.join(HOME, d));
const PUBLISH_WRITE_DIRS = [".config/graphite", ".local/share/graphite"].map((d) => path.join(HOME, d));

// Claude's sandbox proxy refuses SSH (github.com:22), so git and tools built on it (Graphite's gt)
// cannot fetch or push over an SSH remote. Rewriting GitHub SSH URLs to HTTPS for the task's git
// sends them through the allowed proxy, authenticated by the user's gh credential helper.
export function gitHttpsEnv(base) {
  const n = Number(base.GIT_CONFIG_COUNT || 0);
  const env = { GIT_CONFIG_COUNT: String(n + 2), GIT_TERMINAL_PROMPT: "0" };
  ["git@github.com:", "ssh://git@github.com/"].forEach((from, i) => {
    env[`GIT_CONFIG_KEY_${n + i}`] = "url.https://github.com/.insteadOf";
    env[`GIT_CONFIG_VALUE_${n + i}`] = from;
  });
  return env;
}

function writeDirArgs(dirs) {
  return dirs.filter((d) => fs.existsSync(d)).flatMap((d) => ["--allow-write", d]);
}

function babysitRelayArgs(relay, cd) {
  if (!fs.readFileSync(relay, "utf8").includes('"--allow-publish"')) {
    const patch = path.join(SKILL_DIR, "references", "claude-delegate-network.patch");
    die(`the claude-delegate relay has no --allow-publish option; re-apply: patch -d ${path.dirname(path.dirname(relay))} -p1 < ${patch}`);
  }
  const common = git(cd, ["rev-parse", "--git-common-dir"], { allowFail: true });
  fs.mkdirSync(PR_DIR, { recursive: true });
  const writable = [PR_DIR, ...(common ? [path.resolve(cd, common)] : []), ...TOOL_WRITE_DIRS, ...PUBLISH_WRITE_DIRS].filter((d) => fs.existsSync(d));
  const deny = [...BABYSIT_GH_DENY.flatMap((c) => [`Bash(gh ${c})`, `Bash(gh ${c} *)`]), ...FORCE_PUSH_DENY.map((r) => `Bash(${r})`)];
  return [
    "--allow-domain", "*", "--allow-go-tls", "--allow-publish",
    ...writable.flatMap((d) => ["--allow-write", d]),
    ...deny.flatMap((r) => ["--deny", r]),
  ];
}

function networkRelayArgs(key, relay, readOnly, offline) {
  if (offline) {
    const caches = key === "claude" && !readOnly && relayHasNetworkPatch(relay) ? writeDirArgs(TOOL_WRITE_DIRS) : [];
    return { network: "off", args: caches, note: null };
  }
  if (key === "codex") {
    if (readOnly) return { network: "off", args: [], note: "Codex keeps its read-only sandbox offline; for network access, start the task in write mode with a brief that forbids edits" };
    return { network: "on", args: ["--network-access"], note: null };
  }
  if (readOnly) return { network: "off", args: [], note: null }; // Claude's read-only mode has no shell
  if (!relayHasNetworkPatch(relay)) {
    const patch = path.join(SKILL_DIR, "references", "claude-delegate-network.patch");
    return { network: "off", args: [], note: `the claude-delegate relay has no --allow-domain option, so this task has no network; re-apply: patch -d ${path.dirname(path.dirname(relay))} -p1 < ${patch}` };
  }
  const deny = [
    ...GH_WRITE_COMMANDS.flatMap((c) => [`Bash(gh ${c})`, `Bash(gh ${c} *)`]),
    ...GH_API_WRITE_FLAGS.map((f) => `Bash(gh api *${f} *)`),
  ];
  return { network: "on", args: ["--allow-domain", "*", "--allow-go-tls", ...writeDirArgs(TOOL_WRITE_DIRS), ...deny.flatMap((r) => ["--deny", r])], note: null };
}

// What a task may do. By the user's choice, tasks run outside the agents' sandboxes by default,
// like sub-agents of an interactive session: full network and the user's files and tool state.
// Credential file tools remain denied. `--sandbox` confines a task as before; `--offline` implies
// it, because only the sandbox can block the network. Read-only tasks keep their read-only enforcement either way.
// Permission rules still deny commits, pushes, and gh write commands (a babysitter may commit and
// push, but never force).
// `publish`: a write task may commit, push without force, and write to GitHub, as babysitters do,
// unless the user asked to review its work first (start --no-publish). The dangerous commands stay
// denied either way: force pushes, admin merges, secrets, and creating or deleting repositories.
function relaySafetyProfile({ key, relay, cd, readOnly, offline, sandbox, confine = false, babysit, publish = true }) {
  if (readOnly || offline || sandbox) {
    const net = babysit ? { network: "on", args: babysitRelayArgs(relay, cd), note: null } : networkRelayArgs(key, relay, readOnly, offline);
    return { ...net, args: [...net.args, ...(key === "claude" && (confine || (!readOnly && (offline || sandbox))) ? ["--confine"] : [])], sandboxed: !readOnly, httpsGit: key === "claude" && net.network === "on" };
  }
  if (key === "codex") return { network: "on", args: ["--sandbox", "danger-full-access"], note: null, sandboxed: false, httpsGit: false };
  if (!fs.readFileSync(relay, "utf8").includes('"--no-sandbox"')) {
    const patch = path.join(SKILL_DIR, "references", "claude-delegate-network.patch");
    const net = babysit ? { network: "on", args: babysitRelayArgs(relay, cd), note: null } : networkRelayArgs(key, relay, readOnly, offline);
    const note = `the claude-delegate relay has no --no-sandbox option, so this task runs sandboxed; re-apply: patch -d ${path.dirname(path.dirname(relay))} -p1 < ${patch}`;
    return { ...net, note, sandboxed: true, httpsGit: net.network === "on" };
  }
  const publishes = babysit || publish;
  const deny = publishes
    ? [...BABYSIT_GH_DENY.flatMap((c) => [`Bash(gh ${c})`, `Bash(gh ${c} *)`]), ...FORCE_PUSH_DENY.map((r) => `Bash(${r})`)]
    : [...GH_WRITE_COMMANDS.flatMap((c) => [`Bash(gh ${c})`, `Bash(gh ${c} *)`]), ...GH_API_WRITE_FLAGS.map((f) => `Bash(gh api *${f} *)`)];
  return {
    network: "on",
    args: ["--no-sandbox", ...(confine ? ["--confine"] : []), ...(publishes ? ["--allow-publish"] : []), ...deny.flatMap((r) => ["--deny", r])],
    note: null,
    sandboxed: false,
    httpsGit: false,
  };
}

// The configured paths of the credentials the orchestrator knows: the dashboard token, and Claude's
// and Codex's own, wherever CLAUDE_CONFIG_DIR and CODEX_HOME put them.
function configuredCredentials() {
  return [
    DASHBOARD_TOKEN_FILE,
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), ".credentials*"),
    path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "auth.json"),
  ];
}

// Claude's absolute file-rule form has two leading slashes. One slash is project-relative.
function credentialRelayArgs() {
  return configuredCredentials().flatMap((p) => ["Read", "Edit", "Write"].flatMap((tool) =>
    ["--deny", `${tool}(//${path.resolve(p).replaceAll("\\", "/").replace(/^\/+/, "")})`]));
}

// Every credential path, absolute, for the gemini relay's Cursor rules: Read(/abs/path/**) for a
// folder, Read(/abs/file) for a file. Cursor's Write rules cover edits too.
export function credentialFiles() {
  const home = (p) => (p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p);
  const all = [...CREDENTIAL_PATHS.map(home), ...configuredCredentials()].map((p) => path.resolve(p).replaceAll("\\", "/"));
  return [...new Set(all)];
}

// The shell commands a task may not run, as Claude's Bash(...) rules: with `publishing`, the
// dangerous ones (force pushes, admin merges, secrets, creating or deleting repositories, token
// reads); without it, every gh write command as well. Claude and gemini share this list.
function shellDenyRules(publishing) {
  const commands = publishing ? BABYSIT_GH_DENY : GH_WRITE_COMMANDS;
  return [
    ...commands.flatMap((c) => [`Bash(gh ${c})`, `Bash(gh ${c} *)`]),
    ...(!publishing ? GH_API_WRITE_FLAGS.map((f) => `Bash(gh api *${f} *)`) : []),
    ...FORCE_PUSH_DENY.map((r) => `Bash(${r})`),
    ...GH_TOKEN_DENY,
  ];
}

// What start refuses for an agent before it builds the relay's arguments, or null.
export function unsupportedMode({ key, offline, confine }) {
  if (key !== "gemini") return null;
  if (offline) return "--offline is not supported for gemini: Cursor's sandbox has not been shown to block the network. Use --agent claude or codex for an offline task";
  if (confine) return "--confine applies to Claude tasks only; a gemini task takes --sandbox or --read-only";
  return null;
}

// A gemini task (the cursor-delegate relay, which runs Cursor's `agent` CLI). Its file tools never
// read or write the credential files, and its shell never runs the commands shellDenyRules lists;
// without publishing it never commits or pushes either. These are Cursor permission rules, so
// Claude's Bash(x) becomes Shell(x). Write mode runs outside Cursor's sandbox, like the other agents;
// --sandbox runs inside it and, as a sandboxed Claude task does, does not publish. --read-only
// reaches the relay from start itself. --offline and --confine are refused (unsupportedMode).
function geminiSafety({ readOnly, sandbox, babysit, publish = true }) {
  const publishing = !readOnly && !sandbox && (babysit || publish);
  const shell = [
    ...shellDenyRules(publishing).map((rule) => rule.replace(/^Bash\(/, "Shell(")),
    ...(publishing ? [] : GIT_PUBLISH_DENY.map((c) => `Shell(${c})`)),
  ];
  const files = credentialFiles().flatMap((p) => [`Read(${p})`, `Write(${p})`]);
  const mode = readOnly ? [] : ["--sandbox", sandbox ? "enabled" : "disabled"];
  return {
    network: "on",
    args: [...mode, ...[...files, ...shell].flatMap((rule) => ["--deny", rule])],
    note: null,
    sandboxed: Boolean(sandbox && !readOnly),
    httpsGit: false,
  };
}

export function relaySafetyArgs(options) {
  if (options.key === "gemini") return geminiSafety(options);
  const profile = relaySafetyProfile(options);
  if (options.key !== "claude") return profile;
  const publishing = profile.args.includes("--allow-publish");
  const rules = shellDenyRules(publishing);
  const existingRules = new Set(profile.args.filter((_, i) => profile.args[i - 1] === "--deny"));
  const extraRules = rules.filter((rule) => !existingRules.has(rule));
  return { ...profile, args: [...profile.args, ...credentialRelayArgs(), ...extraRules.flatMap((r) => ["--deny", r])] };
}
