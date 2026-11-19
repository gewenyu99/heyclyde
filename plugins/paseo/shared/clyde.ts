import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export type Status = "running" | "asking" | "passed" | "sent-back" | "failed" | "pending" | "skipped" | "done";

/** A question a run or thread is waiting on Wen for. */
export type Ask = {
  kind: "run" | "thread"; id: string; task: string; why: string; question: string; askedAt: string; approve: boolean;
  // For a plan approval: the plan's slices, so Wen can approve from the card.
  retryable?:boolean; fullAccess?:boolean; plan?: string[]; askKey?:string; blockedStage?:string;
};

/** One top-level task: a run the point man started, or a standalone point-man thread. */
export type TaskCard = {
  kind: "run" | "thread"; id: string; name: string; why: string; status: Status;
  checkSummary?:string; pullRequest?: string;
  pips: Status[]; passed: number; running: number; sentBack: number; pending: number;
  current: string; rung?: string; startedAt: string; endedAt?: string; lastActivity?: string; agentId?: string;
};

export type Home = {
  needsYou: Ask[]; tasks: TaskCard[]; doneToday: TaskCard[]; failedToday: TaskCard[];
  background: number; running: number; revision: number;
};

/** One phase inside a piece: a judged stage, such as code-it-works for one slice. */
export type Phase = { stage: string; label: string; status: Status };

/**
 * A piece is one thing the plan says to do: a ship slice, the plan itself, the review, or a task's one job. Its title says
 * what it's for. The skills that build it are its phases, not pieces of their own.
 */
export type Piece = {
  id: string; title: string; status: Status; phases: Phase[]; doneWhen: string[];
  attempts: number; sentBack: number; interrupted: number; verdict: "pass" | "fail" | "pending";
  rung?: string; progress?: string; startedAt?: string; endedAt?: string;
  // The piece wrote its verdict to memory, which is how the next piece gets it.
  handoff: boolean;
};

export type Step = { name: string; pieces: Piece[] };

export type Criterion = { criterion: string; result: "pass" | "fail" | "pending"; evidence?: string };

export type AttemptView = {
  n: number; rung?: string; startedAt: string; endedAt?: string; outcome: string; threadId: string; interrupted: boolean;
  evidence: string; criteria: Criterion[]; checks: { cmd: string; code: number; output: string }[]; judgeRung?: string;
};

export type TaskView = {
  verifiedNotes?:{id:string;title:string;sources:string[]}[];
  retryable?:boolean; fullAccess?:boolean; askKey?:string; completionCriteria?: string[];
  routing?: string[]; auditedHead?: string; pullRequest?: string;
  kind: "run" | "thread"; id: string; name: string; status: Status; startedAt: string; summary: string;
  question?: string; approve: boolean; branch?: string;
  goal: string; lastActivity?: string; diff?: Diff;
  steps: Step[]; attempts: Record<string, AttemptView[]>; selected?: string;
  passed: number; total: number; background: number; agentId?: string;
};

export type Diff = { commits: number; files: number; insertions: number; deletions: number };

export type Transcript = { threadId: string; title: string; rung?: string; turns: { n: number; at: string; prompt: string; text: string }[] };

type Result<T> = { data?: T; error?: string };

const empty = z.object({});

/** The home view, shaped from the daemon on the host. */
export const homeRpc = defineRpc({
  name: "clyde.home",
  input: z.object({workspaceId:z.string().optional()}),
  output: z.custom<Result<Home>>(),
});

/** One task's flow view. */
export const taskRpc = defineRpc({
  name: "clyde.task",
  input: z.object({ kind: z.enum(["run", "thread"]), id: z.string() }),
  output: z.custom<Result<TaskView>>(),
});

/** A background agent's turns, read only. */
export const transcriptRpc = defineRpc({
  name: "clyde.transcript",
  input: z.object({ threadId: z.string() }),
  output: z.custom<Result<Transcript>>(),
});

/** Waits until the daemon's event stream moves past `after`, or the wait times out. Returns the latest revision. */
export const waitRpc = defineRpc({
  name: "clyde.wait",
  input: z.object({ after: z.number() }),
  output: z.object({ revision: z.number() }),
});

/** Answers a run's question, or sends a thread a message. */
export const answerRpc = defineRpc({
  name: "clyde.answer",
  input: z.object({ allowAntigravityFullAccess:z.boolean().optional(), askKey:z.string().optional(), kind: z.enum(["run", "thread"]), id: z.string(), text: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

/** Stops a run or a thread. The screen asks twice before it calls this. */
export const stopRpc = defineRpc({
  name: "clyde.stop",
  input: z.object({ kind: z.enum(["run", "thread"]), id: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

export type QuestOffer = { id: number; title: string; brief: string; done_when: string; priority: string; assignment: string | null; run: string | null };
export type Resident = { id: string; title: string; cwd: string; provider: string; project: string; role: string; areas: string[];
  confirmed: boolean; paused: boolean; offer?: QuestOffer; pickupError?: string; memory: string; model?: string; status?: string };
export const rosterRpc = defineRpc({ name: "clyde.roster", input: z.object({workspaceId:z.string().optional()}), output: z.custom<Resident[]>() });
export const residentRpc = defineRpc({ name: "clyde.resident", input: z.object({ id: z.string(), action: z.enum(["confirm","pause","resume","start","pass"]),
  areas: z.array(z.string().min(1).max(40)).max(32).optional(), role: z.string().trim().min(1).max(160).optional(), questId: z.number().int().optional() }), output: z.object({ ok: z.boolean() }) });

export const steerRpc = defineRpc({name:"clyde.steer",input:z.object({id:z.string(),text:z.string().trim().min(1)}),output:z.object({ok:z.boolean()})});

export const projectChat = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  updatedAt: z.string(),
});
export type ProjectChat = z.infer<typeof projectChat>;

export const projectsRpc = defineRpc({
  name:"clyde.projects",
  input:z.object({workspaceId:z.string().optional()}),
  output:z.array(z.object({id:z.string(),name:z.string(),path:z.string(),chats:z.array(projectChat)})),
});
export const workerModels = ["auto", "sol", "sonnet", "opus", "astra", "neon"] as const;
export const launchRpc = defineRpc({
  name:"clyde.launch", input:z.object({project:z.string().min(1),workspaceId:z.string().optional(),prompt:z.string().trim().min(1).max(12000),criteria:z.array(z.string().trim().min(1).max(4000)).max(64).optional(),
    allowAntigravityFullAccess:z.boolean().optional(),flow:z.enum(["task","ship"]),worker:z.enum(workerModels),requestId:z.string().uuid(),agentId:z.string().optional(),newChat:z.boolean().optional()}),
  output:z.object({id:z.string()}),
});

import { noteSchema,badgeSchema } from "./recall.ts";
export const activitySchema = z.discriminatedUnion("kind",[
  z.object({kind:z.literal("recall"),retrieval:z.string(),badge:badgeSchema.nullish(),page:z.string().optional(),degraded:z.string().nullish(),requested:z.boolean().optional(),used:z.array(z.string()).optional(),notes:z.array(noteSchema),rated:z.boolean(),native:z.boolean().optional(),query:z.string().optional(),receipt:z.string().optional(),choice:z.enum(["helpful","nothing_useful"]).optional(),pendingSync:z.boolean().optional()}),
  z.object({kind:z.literal("notice"),text:z.string()}),
  z.object({kind:z.literal("saved"),title:z.string()}),
  z.object({kind:z.literal("approval"),run:z.string(),key:z.string(),title:z.string(),question:z.string(),approve:z.boolean(),answer:z.string().optional()}),
]);
export type Activity = z.infer<typeof activitySchema>;
export const feedbackRpc = defineRpc({name:"clyde.feedback",input:z.object({agent:z.string(),retrieval:z.string(),verdict:z.enum(["helpful","nothing_useful"]),receipt:z.string().optional()}),output:z.object({ok:z.boolean(),pendingSync:z.boolean()})});
export const respondRpc = defineRpc({name:"clyde.respond",input:z.object({agent:z.string(),run:z.string(),key:z.string(),text:z.string().trim().min(1)}),output:z.object({ok:z.boolean()})});
export const boardQuest = z.object({id:z.number(),title:z.string(),brief:z.string(),done_when:z.string(),priority:z.string(),state:z.string().optional(),claimed_by:z.string().nullish(),project:z.string().nullish(),assignee:z.string().optional(),tags:z.array(z.string()).optional()});
export type BoardQuest = z.infer<typeof boardQuest>;
export const boardRpc = defineRpc({name:"clyde.quests",input:z.object({agent:z.string()}),output:z.array(boardQuest)});
export const spawnQuestRpc = defineRpc({name:"clyde.spawn-quest",input:z.object({agent:z.string(),quest:z.number().int().positive()}),output:z.object({id:z.string()})});

export const recallRpc=defineRpc({name:"clyde.recall",input:z.object({agent:z.string(),query:z.string().trim().min(1).max(500)}),output:z.object({retrieval:z.string(),notes:z.number()})});

export const ratingRpc=defineRpc({name:"clyde.recall-rating",input:z.object({agent:z.string(),retrieval:z.string()}),output:z.object({used:z.array(z.string()).optional(),choice:z.enum(["helpful","nothing_useful"]).optional(),pendingSync:z.boolean()})});

export const removeRpc=defineRpc({name:"clyde.remove",input:z.object({kind:z.enum(["run","thread"]),id:z.string().min(1)}),output:z.object({ok:z.boolean()})});

export const sharedBoardRpc=defineRpc({name:"clyde.shared-quests",input:z.object({}),output:z.object({quests:z.array(boardQuest),legacy:z.boolean()})});

export const readNoteRpc=defineRpc({name:"clyde.read-note",input:z.object({agent:z.string(),id:z.string().min(1)}),output:z.object({text:z.string()})});

/** Opens (or creates) a live Paseo chat to handle a run or thread that needs attention. */
export const openChatRpc = defineRpc({
  name: "clyde.open-chat",
  input: z.object({ kind: z.enum(["run", "thread"]), id: z.string().min(1) }),
  output: z.object({ agentId: z.string().min(1), created: z.boolean().optional() }),
});
