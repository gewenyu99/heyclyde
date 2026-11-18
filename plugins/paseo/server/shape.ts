/**
 * Pure shaping from the daemon's threads and runs to the plugin's views. No I/O, so harness/test can import it directly.
 * Only top-level work is a task. Workers, judges and reviewers are background agents, counted and never listed.
 * A task's pieces are what its plan says to do, titled in plain words. The skills that build a piece are its phases.
 */
import type { Ask, AttemptView, Criterion, Home, Phase, Piece, Status, Step, TaskCard, TaskView, Transcript } from "../shared/clyde";

export type RawRung = { backend: string; model?: string; effort?: string };
export type RawTurn = { n: number; prompt: string; startedAt: string; endedAt?: string; ok?: boolean; text?: string };
export type RawThread = {
  cwd?:string;
  id: string; title: string; status: string; rung: RawRung; runId?: string; stage?: string; readOnly?: boolean;
  parentThreadId?: string; progress?: string; createdAt: string; updatedAt: string; turns: RawTurn[];
};
export type RawCheck = { cmd: string; code: number; output: string };
export type RawVerdict = { verdict: "pass" | "fail"; criteria: { criterion: string; pass: boolean; evidence: string }[]; notes?: string };
export type RawAttempt = {
  n: number; rung: RawRung; threadId: string; startedAt: string; endedAt?: string; ok?: boolean; reason?: string;
  result?: { status: string; summary: string; evidence: { criterion: string; evidence: string }[] };
  checks?: RawCheck[]; judgeId?: string; judgeRung?: RawRung; verdict?: RawVerdict;
};
export type RawStage = {
  name: string; status: string; attempts: RawAttempt[]; summary?: string; startedAt: string; endedAt?: string;
  skill?: string; role?: string; entry?: string;
};
export type RawAsk = { kind: string; question: string; askedAt: string; answer?: string };
export type RawSlice = { id: string; title?: string; acceptance?: string[] };
export type RawRun = {
  repo?:string;
  routes?: Record<string, {model: string; reason: string}>; auditedHead?: string;
  id: string; flow: string; title: string; status: string; input?: { intent?: string; prompt?: string; title?: string };
  parentThreadId?: string; branch?: string; base?: string; cwd?: string; stages: RawStage[]; question?: string; asks?: RawAsk[];
  plan?: { intent?: string; slices?: RawSlice[] }; createdAt: string; updatedAt: string; endedAt?: string;
};

const CODE_STAGES = ["code-it-works", "code-it-good", "code-it-clean"];
const PHASE_LABEL: Record<string, string> = { "code-it-works": "works", "code-it-good": "good", "code-it-clean": "clean" };
// Throwaway threads from wiring checks never belong on Wen's screen.
const TEST_TITLE = /^(reply with just|wake test|mirror( pi)? test|test\b)/i;
// A daemon restart cuts a turn off. That's not the worker failing, so it never counts as sent back.
const INTERRUPTED = /lost when the daemon stopped/i;
const ROW = 4;

export function rung(r?: RawRung): string | undefined {
  if (!r) return undefined;
  return [r.backend, r.model, r.effort].filter(Boolean).join(" · ");
}

function firstSentence(text: string | undefined, max = 110): string {
  // Prompts often open with a label like "GOAL:" that says nothing on its own.
  const t = (text ?? "").replace(/\s+/g, " ").trim().replace(/^(goal|task|intent)\s*:\s*/i, "");
  const cut = t.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? t;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

function sameDay(iso: string | undefined, now: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

const interrupted = (a: RawAttempt) => a.ok === false && INTERRUPTED.test(a.reason ?? "");
const failed = (a: RawAttempt) => !interrupted(a) && (a.ok === false || a.verdict?.verdict === "fail");

function stageStatus(s: RawStage): Status {
  if (s.status === "passed") return "passed";
  if (s.status === "running") return s.attempts.some(failed) ? "sent-back" : "running";
  if (s.status === "asking") return "asking";
  if (s.status === "failed") return "failed";
  if (s.status === "skipped") return "skipped";
  return "pending";
}

function runStatus(r: RawRun): Status {
  if (r.status === "asking") return "asking";
  if (r.status === "done") return "done";
  if (r.status === "failed" || r.status === "stopped") return "failed";
  return "running";
}

/** A piece's status from its phases: the live phase wins, then a failure, then all passed, else pending. */
function rollUp(phases: Phase[]): Status {
  for (const s of ["asking", "sent-back", "running", "failed"] as Status[]) if (phases.some((p) => p.status === s)) return s;
  if (phases.length && phases.every((p) => p.status === "passed" || p.status === "skipped")) return "passed";
  if (phases.some((p) => p.status === "passed")) return "running";
  return "pending";
}

function makePiece(id: string, title: string, phases: { stage: string; label: string; record?: RawStage }[], doneWhen: string[], threads: Map<string, RawThread>): Piece {
  const ran = phases.flatMap((p) => (p.record ? [p.record] : []));
  const attempts = ran.flatMap((s) => s.attempts);
  const live = ran.find((s) => s.status === "running" || s.status === "asking");
  const last = (live ?? ran[ran.length - 1])?.attempts.slice(-1)[0];
  const judged = [...attempts].reverse().find((a) => a.verdict);
  const ps: Phase[] = phases.map((p) => ({ stage: p.stage, label: p.label, status: p.record ? stageStatus(p.record) : "pending" }));
  const status = rollUp(ps);
  const checks = doneWhen.length ? doneWhen : [...attempts].reverse().find((a) => a.checks?.length)?.checks?.map((c) => c.cmd) ?? [];
  const progress = live && last ? threads.get(last.threadId)?.progress : undefined;
  return {
    id, title, status, phases: ps, doneWhen: checks,
    attempts: attempts.filter((a) => !interrupted(a)).length, sentBack: attempts.filter(failed).length, interrupted: attempts.filter(interrupted).length,
    verdict: status === "passed" ? "pass" : judged?.verdict?.verdict ?? "pending",
    rung: rung(last?.rung), progress: progress && progress !== "SessionEnd" ? progress : undefined,
    startedAt: ran[0]?.startedAt, endedAt: status === "passed" ? ran[ran.length - 1]?.endedAt : undefined,
    handoff: ran.some((s) => !!s.entry),
  };
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Rows in hand-off order: the plan, the slices four to a row, the review. Without a plan yet, every stage is its own piece,
 * named for what it does. A task flow is one piece titled with the task.
 */
export function steps(r: RawRun, threads: RawThread[] = []): Step[] {
  const byThread = new Map(threads.map((t) => [t.id, t]));
  const byName = new Map(r.stages.map((s) => [s.name, s]));
  const used = new Set<string>();
  const take = (name: string) => { used.add(name); return byName.get(name); };
  const out: Step[] = [];

  const plans = r.stages.filter((s) => /^plan(-\d+)?$/.test(s.name));
  if (plans.length) {
    out.push({ name: "Plan", pieces: [makePiece("PLAN", "Plan the work and get it approved",
      plans.map((s, i) => ({ stage: s.name, label: plans.length > 1 ? `round ${i + 1}` : "plan", record: take(s.name) })), [], byThread)] });
  }

  const slices = r.plan?.slices ?? [];
  if (slices.length) {
    const pieces = slices.map((slice, i) => {
      const own = r.stages.filter((s) => s.name.split(":")[1] === slice.id || s.name === slice.id);
      const phases = own.length && own.every((s) => !CODE_STAGES.includes(s.name.split(":")[0]))
        ? own.map((s) => ({ stage: s.name, label: "build", record: take(s.name) }))
        : CODE_STAGES.map((skill) => ({ stage: `${skill}:${slice.id}`, label: PHASE_LABEL[skill], record: take(`${skill}:${slice.id}`) }));
      return makePiece(`S${i + 1}`, slice.title || slice.id, phases, slice.acceptance ?? [], byThread);
    });
    chunk(pieces, ROW).forEach((row, i) => {
      const from = i * ROW + 1;
      out.push({ name: row.length > 1 ? `Slices ${from}–${from + row.length - 1}` : `Slice ${from}`, pieces: row });
    });
  }

  for (const s of r.stages) {
    if (used.has(s.name)) continue;
    used.add(s.name);
    const title = s.name === "task" ? r.title : s.name === "review" ? "Review the whole branch" : s.name;
    const name = s.name === "task" ? "Task" : s.name === "review" ? "Review" : "Other";
    const p = makePiece(s.name === "task" ? "TASK" : s.name.toUpperCase().slice(0, 8), title, [{ stage: s.name, label: s.name === "task" ? "build" : s.name, record: s }], [], byThread);
    const last = out[out.length - 1];
    if (last && last.name === name) last.pieces.push(p);
    else out.push({ name, pieces: [p] });
  }
  if (r.flow === "ship" && slices.length && !byName.has("review")) {
    out.push({ name: "Review", pieces: [makePiece("REVIEW", "Review the whole branch", [{ stage: "review", label: "review" }], [], byThread)] });
  }
  return out;
}

function counts(pips: Status[]) {
  return {
    passed: pips.filter((p) => p === "passed").length,
    running: pips.filter((p) => p === "running" || p === "sent-back" || p === "asking").length,
    sentBack: pips.filter((p) => p === "sent-back").length,
    pending: pips.filter((p) => p === "pending").length,
  };
}

const isLive = (p: Piece) => p.status === "running" || p.status === "sent-back" || p.status === "asking";

function livePhase(p: Piece): string {
  const ph = p.phases.find((x) => x.status === "running" || x.status === "sent-back" || x.status === "asking");
  return ph && p.phases.length > 1 ? ` · ${ph.label}` : "";
}

function runCard(r: RawRun, agents: Record<string, string>, threads: RawThread[]): TaskCard {
  const all = steps(r, threads).flatMap((s) => s.pieces);
  const pips = all.map((p) => p.status);
  const live = all.find(isLive);
  const rep = r.stages[0]?.attempts[0]?.threadId;
  return {
    kind: "run", id: r.id, name: r.title, why: firstSentence(r.input?.intent ?? r.input?.prompt), status: runStatus(r),
    pips, ...counts(pips),
    current: live ? `${live.id === "PLAN" || live.id === "TASK" ? "" : `${live.id} `}${live.title}${livePhase(live)}${live.progress ? ` — ${live.progress}` : ""}`
      : r.status === "done" ? "All pieces passed" : "Waiting to start",
    rung: live?.rung, startedAt: r.createdAt, endedAt: r.endedAt, lastActivity: lastActivity(r, threads), agentId: rep ? agents[rep] : undefined,
  };
}

/** The latest sign of life: the run record or any thread working on it. */
function lastActivity(r: RawRun, threads: RawThread[]): string {
  const ids = new Set(r.stages.flatMap((st) => st.attempts.flatMap((a) => [a.threadId, a.judgeId].filter(Boolean) as string[])));
  return [r.updatedAt, ...threads.filter((t) => ids.has(t.id)).map((t) => t.updatedAt)].sort().slice(-1)[0];
}

function threadCard(t: RawThread, agents: Record<string, string>): TaskCard {
  const status: Status = t.status === "running" || t.status === "queued" ? "running" : t.status === "failed" ? "failed" : "done";
  const pips: Status[] = [status === "done" ? "passed" : status];
  const last = t.turns[t.turns.length - 1];
  return {
    kind: "thread", id: t.id, name: t.title, why: firstSentence(t.turns[0]?.prompt), status, pips, ...counts(pips),
    current: t.progress && t.progress !== "SessionEnd" ? t.progress : status === "running" ? "Working" : "Turn finished",
    rung: rung(t.rung), startedAt: t.createdAt, endedAt: status === "done" ? last?.endedAt : undefined, lastActivity: t.updatedAt, agentId: agents[t.id],
  };
}

/** A standalone thread is the point man's when no run, stage, parent or read-only flag marks it as background. */
function standalone(t: RawThread): boolean {
  return !t.runId && !t.stage && !t.readOnly && !t.parentThreadId && !TEST_TITLE.test(t.title);
}

/** A standalone thread that ended its last turn with a question is waiting on Wen. */
function threadAsk(t: RawThread, now: Date): Ask | null {
  const last = t.turns[t.turns.length - 1];
  if (t.status !== "idle" || !last?.ok || !last.endedAt || now.getTime() - Date.parse(last.endedAt) > 12 * 3600_000) return null;
  const lines = (last.text ?? "").trim().split("\n").filter((l) => l.trim());
  const question = lines[lines.length - 1]?.trim() ?? "";
  if (!question.endsWith("?")) return null;
  return { kind: "thread", id: t.id, task: t.title, why: firstSentence(t.turns[0]?.prompt), question, askedAt: last.endedAt, approve: false };
}

export function home(threads: RawThread[], runs: RawRun[], agents: Record<string, string>, revision: number, now = new Date()): Home {
  const top = runs.filter((r) => !r.parentThreadId && !TEST_TITLE.test(r.title));
  const needsYou: Ask[] = [];
  for (const r of top) {
    if (r.status !== "asking") continue;
    const open = [...(r.asks ?? [])].reverse().find((a) => a.answer === undefined);
    needsYou.push({
      kind: "run", id: r.id, task: r.title, why: firstSentence(r.input?.intent ?? r.input?.prompt),
      question: r.question ?? open?.question ?? "", askedAt: open?.askedAt ?? r.updatedAt, approve: open?.kind === "approve",
      plan: open?.kind === "approve" ? r.plan?.slices?.map((s, i) => `S${i + 1} · ${s.title ?? s.id}`) : undefined,
    });
  }
  const solo = threads.filter(standalone);
  for (const t of solo) {
    const ask = threadAsk(t, now);
    if (ask) needsYou.push(ask);
  }
  const live = (c: TaskCard) => c.status === "running" || c.status === "asking";
  const cards = [
    ...top.filter((r) => r.status === "running" || r.status === "asking" || (r.status === "done" && sameDay(r.endedAt, now))).map((r) => runCard(r, agents, threads)),
    ...solo.filter((t) => t.status === "running" || t.status === "queued" || (t.status === "idle" && sameDay(t.turns[t.turns.length - 1]?.endedAt, now))).map((t) => threadCard(t, agents)),
  ];
  const background = threads.filter((t) => !standalone(t) && !TEST_TITLE.test(t.title) && (t.status === "running" || t.status === "queued")).length;
  return {
    needsYou: needsYou.sort((a, b) => a.askedAt.localeCompare(b.askedAt)),
    tasks: cards.filter(live).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    doneToday: cards.filter((c) => !live(c)).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "")),
    background, running: cards.filter((c) => c.status === "running").length, revision,
  };
}

function attemptView(a: RawAttempt): AttemptView {
  const claimed = new Map((a.result?.evidence ?? []).map((e) => [e.criterion, e.evidence]));
  const criteria: Criterion[] = a.verdict
    ? a.verdict.criteria.map((c) => ({ criterion: c.criterion, result: c.pass ? "pass" : "fail", evidence: c.evidence }))
    : [...claimed.keys()].map((criterion) => ({ criterion, result: "pending" }));
  const cut = interrupted(a);
  const outcome = cut ? "Interrupted by a restart" : a.verdict ? (a.verdict.verdict === "pass" ? "Passed" : "Sent back")
    : a.ok === false ? "Failed" : a.endedAt ? "Awaiting judge" : "Working";
  const evidence = a.result
    ? a.result.summary
    : cut ? "The daemon restarted during this turn. The next attempt picked up the same work." : a.reason ?? "No result posted yet.";
  return {
    n: a.n, rung: rung(a.rung), startedAt: a.startedAt, endedAt: a.endedAt, outcome, threadId: a.threadId, interrupted: cut,
    evidence, criteria, checks: a.checks ?? [], judgeRung: rung(a.judgeRung),
  };
}

function summary(r: RawRun, all: Piece[], live?: Piece): string {
  const passed = all.filter((p) => p.status === "passed").length;
  const where = r.status === "done" ? `All ${all.length} pieces passed.` : `${passed} of ${all.length} pieces have passed.`;
  const now = r.status === "asking" ? "It is waiting on you."
    : !live ? ""
    : live.status === "asking" ? `${live.title} is waiting on you.`
    : live.status === "sent-back" ? `${live.title} is back with its worker after ${live.sentBack} failed verdict${live.sentBack === 1 ? "" : "s"}.`
    : `Working on ${live.title}${livePhase(live).replace(" · ", ", ")}.`;
  return [where, now].filter(Boolean).join(" ");
}

export function task(r: RawRun, threads: RawThread[], agents: Record<string, string>): TaskView {
  const s = steps(r, threads);
  const all = s.flatMap((x) => x.pieces);
  const live = all.find(isLive);
  const attempts: Record<string, AttemptView[]> = {};
  for (const st of r.stages) attempts[st.name] = st.attempts.map(attemptView);
  const ids = new Set(r.stages.flatMap((st) => st.attempts.flatMap((a) => [a.threadId, a.judgeId].filter(Boolean) as string[])));
  const open = [...(r.asks ?? [])].reverse().find((a) => a.answer === undefined);
  const rep = r.stages[0]?.attempts[0]?.threadId;
  return {
    kind: "run", id: r.id, name: r.title, status: runStatus(r), startedAt: r.createdAt,
    routing: Object.entries(r.routes ?? {}).map(([stage, s]) => stage + ": " + s.model + " · " + s.reason), auditedHead: r.auditedHead,
    goal: firstSentence(r.plan?.intent ?? r.input?.intent ?? r.input?.prompt, 220), summary: summary(r, all, live),
    lastActivity: lastActivity(r, threads),
    question: r.status === "asking" ? r.question ?? open?.question : undefined, approve: open?.kind === "approve", branch: r.branch,
    steps: s, attempts, selected: (live ?? all.filter((p) => p.status !== "pending").slice(-1)[0] ?? all[0])?.id,
    passed: all.filter((p) => p.status === "passed").length, total: all.length,
    background: threads.filter((t) => ids.has(t.id) && (t.status === "running" || t.status === "queued")).length,
    agentId: rep ? agents[rep] : undefined,
  };
}

export function threadTask(t: RawThread, agents: Record<string, string>): TaskView {
  const card = threadCard(t, agents);
  const status: Status = card.status === "done" ? "passed" : card.status;
  const p: Piece = {
    id: "TASK", title: t.title, status, phases: [{ stage: t.id, label: "thread", status }], doneWhen: [],
    attempts: t.turns.length, sentBack: 0, interrupted: 0, verdict: "pending", rung: rung(t.rung),
    progress: t.progress && t.progress !== "SessionEnd" ? t.progress : undefined, startedAt: t.createdAt, handoff: false,
  };
  const ask = threadAsk(t, new Date());
  return {
    kind: "thread", id: t.id, name: t.title, status: card.status, startedAt: t.createdAt,
    goal: firstSentence(t.turns[0]?.prompt, 220), summary: `${t.turns.length} turn${t.turns.length === 1 ? "" : "s"} so far. ${card.current}.`,
    lastActivity: t.updatedAt, question: ask?.question, approve: false, steps: [{ name: "Thread", pieces: [p] }],
    attempts: { [t.id]: t.turns.map((turn) => ({
      n: turn.n, rung: rung(t.rung), startedAt: turn.startedAt, endedAt: turn.endedAt, interrupted: false,
      outcome: turn.endedAt ? (turn.ok ? "Done" : "Failed") : "Working", threadId: t.id, evidence: firstSentence(turn.text, 400), criteria: [], checks: [],
    })) },
    selected: "TASK", passed: status === "passed" ? 1 : 0, total: 1, background: 0, agentId: agents[t.id],
  };
}

export function transcript(t: RawThread): Transcript {
  return {
    threadId: t.id, title: t.title, rung: rung(t.rung),
    turns: t.turns.map((x) => ({ n: x.n, at: x.startedAt, prompt: x.prompt.slice(0, 600), text: x.text ?? "" })),
  };
}
