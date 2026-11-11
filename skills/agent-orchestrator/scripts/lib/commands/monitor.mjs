// `status`, `wait`, and `watch`: follow a run's tasks while they run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTES_FILE, markNotesRead, noteMainWait, noteText, reviewRemindMs, unreadNotes } from "../addressee.mjs";
import { callerTask } from "../finish-notice.mjs";
import { agoText, shortText, table } from "../format.mjs";
import { INBOX_FILE, QUESTIONS_FILE, inboxWake } from "../inbox.mjs";
import { acceptedNow, lifecycleHints, phaseMap } from "../lifecycle.mjs";
import { manualMerge, planProgress, readPlan, waitsOnText } from "../plan.mjs";
import { reviveParked } from "../park.mjs";
import { reportHints } from "../report.mjs";
import { retryTask } from "../retry.mjs";
import { taskAttention } from "../escalate.mjs";
import { CLI_PATH, RUNS_DIR, WAIT_POLL_MS } from "../config.mjs";
import { launcherLabel, markNoticesSeen, mayAct, noticeText, noticesFile, ownershipOf, touchOwner, unseenNotices } from "../ownership.mjs";
import { listRuns, listTasks, loadRun, loadTask, shownName } from "../runs.mjs";
import { die, emit, parseDuration, readJson, writeJson } from "../util.mjs";
import { renderTree, statusText } from "../views.mjs";

const short = (sha) => String(sha || "").slice(0, 12);

// Every task of the run's plan, in plan order, started or not, for `status`. `status` is `waiting`
// (not started, and a prerequisite is not integrated yet: `waitsOn` names each one and its phase),
// `ready` (not started, every prerequisite integrated; `briefProblem` says when its brief is not
// ready, `manual` when it is a babysitter that `dispatch` leaves to be started by hand), or the
// phase of a started task: running, needs-decision, awaiting-review, accepted, integrated, failed.
// An integrated task also carries `integratedCommit` and `integratedInto` (null when none was recorded).
function plannedTasksOf(run, plan, rows) {
  const phases = phaseMap(run, rows, plan);
  const progress = planProgress(plan, phases, run.dir);
  const waiting = new Map(progress.blocked.map((b) => [b.task.id, b.waitsOn]));
  const unbriefed = new Map(progress.unbriefed.map((u) => [u.task.id, u.problem]));
  const manual = new Set(progress.manual.map((t) => t.id));
  // A planned task that has a record shows its name (`rename`).
  const names = new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name]));
  return plan.tasks.map((t) => {
    const base = { id: t.id, name: names.get(t.id) || null, goal: t.goal, type: t.type ?? "implement", agent: t.agent, tier: t.tier ?? null, readOnly: Boolean(t.readOnly), dependsOn: t.dependsOn || [] };
    if (waiting.has(t.id)) return { ...base, status: "waiting", waitsOn: waiting.get(t.id) };
    if (unbriefed.has(t.id)) return { ...base, status: "ready", briefProblem: unbriefed.get(t.id) };
    if (manual.has(t.id)) return { ...base, status: "ready", manual: true };
    const phase = phases.get(t.id);
    if (phase !== "integrated") return { ...base, status: phase && phase !== "prepared" ? phase : "ready" };
    // The receipt `integrate` recorded; a read-only task is integrated by collecting its result, and has none.
    const record = loadTask(run, t.id);
    return { ...base, status: "integrated", integratedCommit: record?.integratedCommit ?? null, integratedInto: record?.integratedInto ?? null };
  });
}

const STATUS_ORDER = ["waiting", "ready", "running", "needs-decision", "awaiting-review", "accepted", "integrated", "failed"];

function planLines(plan, planned, unplanned, shown = new Map()) {
  if (!plan) return [];
  const counts = new Map();
  for (const t of planned) counts.set(t.status, (counts.get(t.status) || 0) + 1);
  const order = [...STATUS_ORDER, ...[...counts.keys()].filter((s) => !STATUS_ORDER.includes(s))].filter((s) => counts.has(s));
  const note = (t) => (t.waitsOn
    ? `waits on ${waitsOnText(t.waitsOn.map((w) => ({ ...w, id: shown.get(w.id) || w.id })))}`
    : t.briefProblem ? `brief ${t.briefProblem}`
      : t.manual ? "start by hand: it babysits a pull request"
        : t.integratedCommit ? `at ${short(t.integratedCommit)}${t.integratedInto ? ` in ${t.integratedInto}` : ""}`
          : "");
  return [
    `plan: ${shortText(plan.goal, 100)} (${planned.length} task${planned.length === 1 ? "" : "s"}: ${order.map((s) => `${counts.get(s)} ${s}`).join(", ")})`,
    table(planned.map((t) => ({ id: t.name || t.id, status: t.status, note: note(t) })), ["id", "status", "note"]),
    ...(unplanned.length ? [`recorded outside the plan: ${unplanned.join(", ")}`] : []),
  ];
}

// Tasks whose branch is already in the branch they would merge into (someone merged it by hand, or
// from another checkout), though the run does not record them as integrated. manualMerge leaves out
// read-only tasks, integrated ones and branches with no commits of their own, so any phase may show.
// Reading a repository must never make `status` fail: a task whose check errors is left out.
function manualMergesOf(run, rows) {
  const found = [];
  for (const row of rows) {
    try {
      const task = loadTask(run, row.id);
      const merged = task && manualMerge(run, task);
      if (merged) found.push({ id: row.id, phase: row.phase, ...merged });
    } catch {}
  }
  return found;
}

// `integrate --already-merged` takes an accepted task only, so the line names what is left to do.
function manualMergeLines(run, merges, shown = new Map()) {
  const cmd = (rest) => `node ${CLI_PATH} ${rest}`;
  const record = (id) => cmd(`integrate ${run.id} ${id} --already-merged`);
  return merges.flatMap((m) => [
    `warning: ${shown.get(m.id) || m.id}'s branch ${m.branch} (${short(m.commit)}) is already in ${m.into}, but ${shown.get(m.id) || m.id} is not recorded as integrated (${m.phase}).`,
    m.phase === "accepted"
      ? `  record it: ${record(m.id)}`
      : m.phase === "awaiting-review"
        ? `  review it and accept it (${cmd(`accept ${run.id} ${m.id}`)}), then record it: ${record(m.id)}`
        : `  once it is finished, reviewed and accepted, record it: ${record(m.id)}`,
  ]);
}

export function cmdStatus(args) {
  const run = loadRun(args._[0]);
  const tasks = listTasks(run);
  const own = ownershipOf(run);
  const notices = unseenNotices(run);
  const ownership = { owner: launcherLabel(own.direct), mine: own.mine, readOnly: !mayAct(own), orphaned: own.orphaned };
  // `plannedTasks` lists the whole plan, including tasks that never started; `unplannedTasks` the
  // recorded tasks that no plan entry names; `manualMerges` the tasks whose branch was merged by hand.
  // Each is an empty list when nothing applies. `tasks` is unchanged.
  const plan = readPlan(run.dir);
  const plannedTasks = plan ? plannedTasksOf(run, plan, tasks) : [];
  const unplannedTasks = plan ? tasks.filter((t) => !plan.tasks.some((p) => p.id === t.id)).map((t) => t.id) : [];
  const shown = new Map(tasks.map((t) => [t.id, shownName(t)]));
  const manualMerges = manualMergesOf(run, tasks);
  emit(
    args,
    { run: run.id, dir: run.dir, tasks, plannedTasks, unplannedTasks, manualMerges, ownership, ...(notices.length ? { changedByOthers: notices.map((n) => ({ ...n, text: noticeText(n) })) } : {}) },
    [statusText(run, tasks, notices), ...planLines(plan, plannedTasks, unplannedTasks.map((id) => shown.get(id) || id), shown), ...manualMergeLines(run, manualMerges, shown)].join("\n"),
  );
}

// Replace the waiting Node process with a small shell, then resume the same command and PID.
// Keep state in a private file rather than argv/environment (large inboxes can exceed ARG_MAX).
// Older Node releases and Windows retain the ordinary timer loop.
export function parkHelper(deadline, command, args, state, { pids = [], files = [], checkedAt = Date.now() } = {}) {
  if (typeof process.execve !== "function" || process.platform === "win32") return false;
  // Do not discard a retry notice still buffered behind a slow stdout/stderr consumer.
  if (process.stdout.writableLength || process.stderr.writableLength) return false;
  const max = parseDuration(process.env.AGENT_ORCH_PARK_MAX ?? "30s");
  if (!(max > 0) || !Number.isFinite(max)) die("AGENT_ORCH_PARK_MAX must be a finite positive duration", 2);
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-park-"));
    const file = path.join(dir, "state.json");
    const marker = path.join(dir, "marker");
    fs.writeFileSync(file, JSON.stringify({ args, state, execArgv: process.execArgv }), { mode: 0o600 });
    fs.writeFileSync(marker, "", { mode: 0o600 });
    // Bash 3.2's -nt compares whole seconds. Start before the Node snapshot so changes
    // during that snapshot or in the marker's second cannot disappear in the handoff.
    // Check only after sleeping: a recently read file causes at most one extra poll.
    const stamp = Math.floor(checkedAt / 1000) - 1;
    fs.utimesSync(marker, stamp, stamp);
    const module = command === "cmdWait" ? import.meta.url : new URL("./inbox.mjs", import.meta.url).href;
    // The shell's name, and a comment that starts the resumed source, are the command it stands
    // for, so `ps` shows a parked or resumed wait as `orch.mjs wait <run dir>` (waitsOn, addressee.mjs).
    const label = `${CLI_PATH} ${command === "cmdWait" ? "wait" : "nap"} ${args._.join(" ")}`;
    const source = `/* ${label.replace(/\*\//g, "* /")} */ import fs from 'node:fs'; const file=process.argv[1]; const {args,state,execArgv}=JSON.parse(fs.readFileSync(file,'utf8')); fs.rmSync(process.argv[2],{recursive:true}); process.execArgv=execArgv; const mod=await import(${JSON.stringify(module)}); await mod.${command}(args,state);`;
    // Only sleep forks. PID checks, file tests and the bounded countdown are shell builtins.
    // Function arguments retain each path literally, including whitespace and newlines.
    const script = `file=$1; dir=$2; ticks=$3; tail=$4; marker=$dir/marker; shift 4
pids=; n=$1; shift
while [ "$n" -gt 0 ]; do pids="$pids $1"; shift; n=$((n-1)); done
child=
trap '[ -z "$child" ] || kill "$child" 2>/dev/null; rm -rf "$dir"; trap - TERM; kill -TERM "$$"' TERM
trap '[ -z "$child" ] || kill "$child" 2>/dev/null; rm -rf "$dir"; trap - INT; kill -INT "$$"' INT
changed() {
  for pid in $pids; do kill -0 "$pid" 2>/dev/null || return 0; done
  n=$1; shift
  for f do
    [ "$n" -gt 0 ] || break
    [ "$f" -nt "$marker" ] && return 0
    n=$((n-1))
  done
  return 1
}
woke=0
while [ "$ticks" -gt 0 ]; do
  sleep 1 & child=$!; wait "$child"; child=
  ticks=$((ticks-1))
  if changed "$@"; then woke=1; break; fi
done
if [ "$woke" -eq 0 ] && [ "$tail" != 0 ]; then sleep "$tail" & child=$!; wait "$child"; child=; fi
n=$1; shift
while [ "$n" -gt 0 ]; do shift; n=$((n-1)); done
exec "$@" "$file" "$dir"`;
    const ms = Math.min(max, Math.max(0, deadline - Date.now()));
    const watchedPids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    const watchedFiles = [...new Set(files)];
    process.execve("/bin/sh", ["sh", "-c", script, label,
      file, dir, String(Math.floor(ms / 1000)), String((ms % 1000) / 1000),
      String(watchedPids.length), ...watchedPids.map(String), String(watchedFiles.length), ...watchedFiles,
      process.execPath, ...process.execArgv, "--input-type=module", "-e", source], process.env);
  } catch {
    // A missing execve facility or unwritable temporary folder must not break waiting.
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  return false;
}

// The review reminder: a finished task that has waited longer than AGENT_ORCH_REVIEW_REMIND (10m;
// 0 turns it off) without being accepted, closed or given a verdict on its current attempt. A
// babysitter never awaits review. `wait` exits 5 for it once per interval per task, recorded in
// the run's review-reminders.json ({task: {attempt, at}}), and prints the commands that clear it.
const REMINDERS_FILE = "review-reminders.json";
function reviewsDue(run, tasks, now = Date.now()) {
  const every = reviewRemindMs();
  if (!(every > 0)) return [];
  const sent = readJson(path.join(run.dir, REMINDERS_FILE)) || {};
  return tasks.filter((t) => {
    if (t.phase !== "awaiting-review" || String(t.mode || "").startsWith("babysit") || !((t.awaitingReviewMs ?? 0) >= every)) return false;
    if (loadTask(run, t.id)?.closedAt || t.reviewRounds?.some((r) => r.attempt === t.attempt)) return false;
    const last = sent[t.id];
    return !last || last.attempt !== t.attempt || !(now - Date.parse(last.at) < every);
  });
}

function remindText(run, t) {
  const cmd = (rest) => `node ${CLI_PATH} ${rest}`;
  const ways = t.mode === "read-only"
    ? [`read it, which closes it: ${cmd(`result ${run.id} ${shownName(t)}`)}`, `or close it: ${cmd(`close ${run.id} ${shownName(t)}`)}`]
    : [
      `accept it after committing its work: ${cmd(`accept ${run.id} ${shownName(t)} --note "<why>"`)}`,
      `or ask for changes, then resume it: ${cmd(`verdict ${run.id} ${shownName(t)} changes --note "<fixes>"`)}`,
      `or close it if you handled it another way: ${cmd(`close ${run.id} ${shownName(t)}`)}`,
    ];
  return [`${shownName(t)} has waited ${agoText(t.awaitingReviewMs || 0)} for review: not accepted, closed or given a verdict. Handle it now:`, ...ways.map((w) => `  ${w}`)].join("\n");
}

export async function cmdWait(args, resumed = null) {
  const wake = inboxWake(resumed?.inbox);
  const run = loadRun(args._[0]);
  // Reviving a parked watcher and retrying a task change the run: only the owner's `wait` does them.
  // Another agent session's `wait` changes nothing at all (ownership.mjs): it records no live main
  // wait, reads no notes and shows no reminders, which stay for the run's own session.
  const own = ownershipOf(run);
  const mine = own.mine;
  const may = mayAct(own);
  // A wait that no orch task runs is the launching session's (or a terminal's): it records that it
  // is live (addressee.mjs) and prints the notes that the run's tasks sent with `tell`.
  const main = !callerTask() && may;
  const ids = args._.slice(1);
  const timeout = args.timeout === undefined ? 9 * 60000 : parseDuration(args.timeout);
  const deadline = resumed ? (resumed.deadline ?? Infinity) : timeout === 0 ? Infinity : Date.now() + timeout;
  // A long wait hands itself to a shell and back, without exiting: record the owner's use now.
  if (mine && !resumed) touchOwner(run);
  const snapshot = () => {
    let rows = listTasks(run);
    // A parked babysitter whose watcher died (after a reboot, say) gets a new one; an adopted
    // relay changes the rows, so read them again.
    if (mine && reviveParked(run, rows).length) rows = listTasks(run);
    // The relay can write its result and exit between describe()'s result read and process
    // check. Health then sees that file; reread this inconsistent snapshot before waking wait.
    return rows.some((t) => t.state === "aborted" && !t.result && t.health === "ok") ? listTasks(run) : rows;
  };
  const attention = (tasks) => tasks.flatMap((t) => {
    const item = taskAttention(t, Boolean(loadTask(run, t.id)?.closedAt));
    return item ? [{ task: t.id, attempt: t.attempt, ...item }] : [];
  });
  const key = (item) => JSON.stringify([item.task, item.attempt, item.kind]);
  let previous = resumed ? new Set(resumed.previous) : null;
  let polled = Boolean(resumed);
  // By default wait returns as soon as any watched task has an unread result: it finished, and
  // nobody has collected it with `result`, closed it, accepted it, or resolved its decision. That
  // includes a task that finished while no wait was running, for example while the orchestrator
  // reviewed an earlier one, so re-arming wait never strands it. --all keeps the old behavior:
  // return only when every watched task has finished.
  const unread = (t) => {
    if (["running", "prepared"].includes(t.state)) return false;
    const record = loadTask(run, t.id) || {};
    if (record.closedAt || acceptedNow(record) || record.decisionResolvedAttempt === t.attempt) return false;
    return t.state !== "needs-decision" || record.decisionSeenAttempt !== t.attempt;
  };
  for (;;) {
    const checkedAt = Date.now();
    if (main) noteMainWait(run, checkedAt);
    let tasks = snapshot().filter((t) => (ids.length ? ids.includes(t.id) : t.state !== "prepared"));
    if (!tasks.length) die(ids.length ? `no tasks named ${ids.join(", ")}` : "no started tasks in this run");
    // Snapshot before retries, so attention already present at entry never wakes a repeated wait.
    previous ??= new Set(attention(tasks).map(key));
    let retried = false;
    for (const task of mine ? tasks : []) {
      const message = retryTask(run, task);
      if (message) {
        (args.json ? process.stderr : process.stdout).write(`${message}\n`);
        retried = true;
      }
    }
    if (retried) tasks = snapshot().filter((t) => tasks.some((previous) => previous.id === t.id));
    const finishedNow = tasks.filter(unread);
    // A change someone else made to the caller's tasks wakes it once, even when it came before this
    // wait started: the owner learns of it without asking (ownership.mjs).
    const notices = unseenNotices(run);
    const changed = notices.map((n) => ({ task: n.task, attempt: n.attempt, kind: "changed-by-other", label: `${n.action} by ${n.user ? "the user" : "someone else"}`, reason: noticeText(n), notice: n.id }));
    const needing = [...attention(tasks), ...changed];
    const newAttention = needing.some((item) => item.kind === "changed-by-other" || !previous.has(key(item)));
    previous = new Set(needing.map(key));
    const running = tasks.filter((t) => t.state === "running");
    const done = running.length === 0 || (!args.all && finishedNow.length > 0);
    // A finish notice about a task this wait watches is no reason to wake: the finished result
    // wakes it (exit 0) and names the task. The notice stays unread for the hook or `inbox`.
    const message = wake.check((m) => m.kind === "finished" && m.about?.run === run.id && tasks.some((t) => t.id === m.about.task));
    const notes = main ? unreadNotes(run) : [];
    const due = may ? reviewsDue(run, tasks) : [];
    // An open question for the session wakes its wait every time, until it is answered with
    // `send`, even one asked before this wait began.
    const asked = main ? tasks.filter((t) => t.state === "running" && t.sessionQuestion) : [];
    const wakes = newAttention || due.length > 0 || asked.length > 0;
    if (wakes || done || message || notes.length || Date.now() >= deadline) {
      // A named task (`rename`) shows its name in place of its id; commands take either.
      const label = (id) => shownName(tasks.find((t) => t.id === id)) || id;
      const asking = tasks.filter((t) => t.state === "needs-decision").map(shownName);
      // Questions this wait does not own: for the user, or, in a wait that an orch task runs, any.
      const questions = needing.filter((item) => item.kind === "question" && !asked.some((t) => t.id === item.task)).map((item) => label(item.task));
      const limited = tasks.filter((t) => t.limitHit).map((t) => `${shownName(t)} (${t.agent})`);
      const hint =
        // A change someone else made shows in statusText(), once.
        needing.filter((item) => item.kind !== "changed-by-other").map((item) => `\n${label(item.task)}: ${item.label} — ${item.reason}`).join("") +
        (questions.length ? `\n${questions.join(", ")} asked ${main ? "the user" : "a question"} and ${questions.length > 1 ? "keep" : "keeps"} working: ${main ? "it waits on the dashboard for the user's answer" : `answer what your brief covers with \`node ${CLI_PATH} send ${run.id} <task> "<answer>"\``} (SKILL.md, "Decisions agents hand back")` : "") +
        (asking.length ? `\n${asking.join(", ")} handed back a decision: read \`result\`, decide, and resume (SKILL.md, "Decisions agents hand back")` : "") +
        (limited.length ? `\n${limited.join(", ")} stopped on a usage limit: ping the user, and resume on the other agent if it is ready (SKILL.md, "Usage limits")` : "") +
        [...lifecycleHints(run, tasks), ...reportHints(run, tasks)].map((line) => `\n${line}`).join("") +
        due.map((t) => `\n${remindText(run, t)}`).join("");
      const unreadText = finishedNow.length ? `\n(${finishedNow.map(shownName).join(", ")} finished and nobody has read ${finishedNow.length > 1 ? "their results" : "its result"}: review ${finishedNow.length > 1 ? "them" : "it"} now with \`result\`, or \`close\` what you handled another way${running.length ? `, then wait again for ${running.map(shownName).join(", ")}` : ""})` : "";
      const reminded = `\n(review overdue: ${due.map(shownName).join(", ")})${done ? unreadText : ""}`;
      const open = asked.map((t) => `\n${shownName(t)} asked you, ${agoText(Date.now() - Date.parse(t.sessionQuestion.time))} ago, and keeps working: "${t.sessionQuestion.text.replace(/\s+/g, " ").slice(0, 300)}"${t.sessionQuestion.open > 1 ? ` (+${t.sessionQuestion.open - 1} more)` : ""}. Answer it now with \`node ${CLI_PATH} send ${run.id} ${shownName(t)} "<answer>"\`: wait exits 5 until you do.`).join("");
      const tail = newAttention ? "\n(a task needs attention)" : due.length ? reminded : asked.length ? `\n(${asked.map(shownName).join(", ")} ${asked.length > 1 ? "wait" : "waits"} for your answer)${done ? unreadText : ""}` : done ? unreadText : message || notes.length ? "" : "\n(still running: wait timed out)";
      const noted = notes.length ? `\n${notes.map(noteText).join("\n")}\n(${notes.length > 1 ? "notes" : "a note"} from your tasks, sent with \`tell\`: no answer needed)` : "";
      emit(args, {
        run: run.id, finished: done, tasks, attention: needing, ...(message ? { message } : {}),
        ...(due.length ? { reminders: due.map((t) => ({ task: t.id, attempt: t.attempt, waitedMs: t.awaitingReviewMs })) } : {}),
        ...(notes.length ? { notes } : {}),
        ...(asked.length ? { questions: asked.map((t) => ({ task: t.id, ...t.sessionQuestion })) } : {}),
      }, `${statusText(run, tasks, notices)}${hint}${open}${tail}${message ? `\n${message.hint}` : ""}${noted}`);
      if (message) {
        if (wakes || done) writeJson(wake.pendingPath, { id: message.id });
        else fs.rmSync(wake.pendingPath, { force: true });
      }
      try {
        if (due.length) {
          const file = path.join(run.dir, REMINDERS_FILE);
          const at = new Date().toISOString();
          writeJson(file, { ...readJson(file), ...Object.fromEntries(due.map((t) => [t.id, { attempt: t.attempt, at }])) });
        }
        markNotesRead(run, notes.map((n) => n.id));
        markNoticesSeen(run, notices); // each owner acknowledges a change for itself (ownership.mjs)
      } catch (error) {
        process.stderr.write(`orch: could not record the reminders or notes as shown (${error.message}); they will show again\n`);
      }
      process.exit(wakes ? 5 : done ? 0 : message || notes.length ? 6 : 3);
    }
    if (polled) {
      const files = [...wake.files, ...(main ? [path.join(run.dir, NOTES_FILE)] : [])];
      const pids = [];
      for (const task of tasks) {
        const dir = path.join(run.dir, "tasks", task.id);
        files.push(path.join(dir, INBOX_FILE), path.join(dir, QUESTIONS_FILE), path.join(dir, "task.json"));
        if (task.outDir) files.push(path.join(task.outDir, "result.json"));
      }
      files.push(noticesFile(run));
      for (const task of tasks) {
        // Parked babysitters remain running without a relay. A dead PID only asks Node
        // for another snapshot; it never decides whether any task has finished.
        if (task.state === "running" && task.phase !== "parked") pids.push(loadTask(run, task.id)?.pid);
      }
      parkHelper(deadline, "cmdWait", { ...args, _: [run.dir, ...ids] },
        { deadline: Number.isFinite(deadline) ? deadline : null, previous: [...previous], inbox: wake.snapshot },
        { pids, files, checkedAt });
    }
    // Short waits usually finish within the first interval; avoid a handoff for those.
    polled = true;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

export async function cmdWatch(args) {
  const tty = process.stdout.isTTY && !args.once;
  const interval = Math.max(1, Number(args.interval || 2)) * 1000;
  const pick = () => {
    if (args._[0]) return [loadRun(args._[0])];
    const runs = listRuns();
    if (args.all) return runs;
    // Default: every run with a running task, else the most recent run.
    const active = runs.filter((r) => listTasks(r).some((t) => t.state === "running"));
    return active.length ? active : runs.slice(0, 1);
  };
  for (;;) {
    const runs = pick();
    const body = runs.length ? renderTree(runs, tty) : `no runs in ${RUNS_DIR}`;
    const header = `agent-orchestrator · ${new Date().toLocaleTimeString()}${tty ? ` · every ${interval / 1000}s · Ctrl-C to exit` : ""}`;
    process.stdout.write(tty ? `\x1b[H\x1b[2J${header}\n\n${body}\n` : `${header}\n\n${body}\n`);
    if (!tty) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
