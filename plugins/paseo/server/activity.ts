import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import {
  type Activity,
  activitySchema,
  type BoardQuest,
  boardQuest,
  boardRpc,
  sharedBoardRpc,
  feedbackRpc,
  ratingRpc,
  type Resident,
  respondRpc,
  spawnQuestRpc,
} from "../shared/clyde.ts";
import { recallPacket } from "../shared/recall.ts";
import { agentCall, agentReply,sharedBoardReply } from "./connection.ts";
import { call, readJson } from "./daemon.ts";

type Origin = {
  agent: string;
  resultNote?: string;
  job?: {
    quest: number;
    brief: string;
    criterion: string;
    title: string;
    cwd: string;
    leaseCheck?: number;
    note?: string;
    complete?: boolean;
    confirmed?: boolean;
  };
};
type Ask = { key: string; kind: string; question: string; answer?: string };
type Run = {
  archivedAt?: string;
  id: string;
  title: string;
  status: string;
  asks: Ask[];
  auditedHead?: string;
  stages: { summary?: string }[];
};
const priorityRank=(p:string)=>({urgent:0,high:1,normal:2,low:3} as Record<string,number>)[p]??4;
const keyFor = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
export function activity(server: PluginServerContext, rowFor: (id: string) => Resident | undefined) {
  const dir = process.env.CLYDE_HOME || join(homedir(), ".clyde");
  const origins = readJson<Record<string, Origin>>("chat-runs.json") ?? {};
  type Vote = {
    agent: string;
    retrieval: string;
    verdict: "helpful" | "nothing_useful";
    receipt?: string;
    pendingSync: boolean;
    attempted: number;
  };
  const voteFile = join(dir, "recall-ratings.json");
  const votes = readJson<Record<string, Vote>>("recall-ratings.json") ?? {};
  const sending = new Set<string>();
  function saveVotes() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(voteFile + ".tmp", JSON.stringify(votes), { mode: 0o600 });
    renameSync(voteFile + ".tmp", voteFile);
  }
  const delivered = new Map<string, string>();
  const inFlight = new Set<string>();
  let api: PaseoApi | undefined, closed = false, polling = false;
  const save = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "chat-runs.json");
    writeFileSync(file + ".tmp", JSON.stringify(origins), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  };
  function track(run: string, agent: string, paseo: PaseoApi) {
    api = paseo;
    if (!origins[run]) {
      origins[run] = { agent };
      save();
    }
  }
  async function append(agent: string, id: string, data: Activity) {
    if (!api || closed) return;
    const key = agent + "/" + id, value = JSON.stringify(data);
    if (delivered.get(key) === value) return;
    await api.agents.ref(agent).timeline.append({
      type: "plugin",
      kind: "clyde-activity",
      version: 1,
      id,
      data: activitySchema.parse(data),
    });
    delivered.set(key, value);
  }
  async function rated(agent: string, id: string, choice: "helpful" | "nothing_useful", pendingSync: boolean) {
    const previous = delivered.get(agent + "/recall-" + id);
    if (previous) {
      const data = activitySchema.parse(JSON.parse(previous));
      if (data.kind === "recall") return append(agent, "recall-" + id, { ...data, rated: true, choice, pendingSync });
    }
  }
  async function memory(
    agent: string,
    tool: string,
    card: unknown,
    paseo: PaseoApi,
    args: Record<string, unknown>,
    text = "",
  ) {
    api = paseo;
    if (tool === "remember") {
      const title = String(args.title || "Project decision");
      await append(agent, "saved-" + keyFor(JSON.stringify([title, args.body])), { kind: "saved", title });
      return;
    }
    if (tool === "recall" || tool === "recall_more") {
      const packet = recallPacket(card, text);
      await append(agent, "recall-" + packet.retrieval_id, {
        kind: "recall",
        retrieval: packet.retrieval_id,
        notes: packet.items,
        query: packet.query ?? String(args.query ?? ""),
        ...(packet.card_receipt ? { receipt: packet.card_receipt } : {}),
        rated: false,
      });
    }
  }
  async function recall(row: Resident, task: string, paseo: PaseoApi) {
    // The bound agent already has strict project permissions. An explicit project filter also hides general preferences.
    const args = { query: task.slice(0, 300), task: task.slice(0, 500) };
    const reply = await agentReply(row, "recall", args);
    await memory(row.id, "recall", reply.card, paseo, args, reply.text);
    return { text: reply.text, ...recallPacket(reply.card, reply.text) };
  }
  async function transmit(key: string, v: Vote) {
    if (sending.has(key)) return;
    const row = rowFor(v.agent);
    if (!row) return;
    sending.add(key);
    try {
      v.attempted = Date.now();
      saveVotes();
      const reply = await agentCall(row, "feedback", {
        retrieval_id: v.retrieval,
        card_vote: true,
        verdict: v.verdict,
        ...(v.receipt ? { card_receipt: v.receipt } : {}),
      });
      // An old server may have accepted the agent's per-note feedback before the person clicked.
      // Its "Already logged" cannot acknowledge this vote.
      if (/^Logged\.(?:\s|$)/.test(reply) && votes[key] === v) {
        v.pendingSync = false;
        saveVotes();
      }
    } catch {
      /* Keep the local vote for a retry with this agent's credentials. */
    } finally {
      sending.delete(key);
    }
  }
  server.handle(ratingRpc, async ({ agent, retrieval }) => {
    const v = votes[keyFor(agent + "/" + retrieval)];
    return { choice: v?.verdict, pendingSync: v?.pendingSync ?? false };
  });
  server.handle(feedbackRpc, async ({ agent, retrieval, verdict, receipt }, { paseo }) => {
    if (!rowFor(agent)) throw new Error("Agent unavailable");
    const key = keyFor(agent + "/" + retrieval);
    const v = votes[key] = { agent, retrieval, verdict, receipt, attempted: 0, pendingSync: true };
    saveVotes();
    await transmit(key, v);
    api = paseo;
    if (votes[key] === v) await rated(agent, retrieval, verdict, v.pendingSync);
    return { ok: true, pendingSync: v.pendingSync };
  });
  server.handle(respondRpc, async ({ agent, run, key, text }, { paseo }) => {
    if (origins[run]?.agent !== agent) throw new Error("This question belongs to another chat");
    api = paseo;
    const updated = await call<Run>("POST", "/runs/" + encodeURIComponent(run) + "/answer", {
      text,
      askKey: key,
      via: "paseo",
    });
    await asks(updated, agent);
    return { ok: true };
  });
  async function asks(run: Run, agent: string) {
    for (const ask of run.asks ?? []) {
      await append(agent, "ask-" + keyFor(run.id + "/" + ask.key), {
        kind: "approval",
        run: run.id,
        key: ask.key,
        title: run.title,
        question: ask.question,
        approve: ask.kind === "approve" && /^approve\b/i.test(ask.question),
        ...(ask.answer!==undefined ? {answer:ask.answer} : run.archivedAt ? {answer:"Task removed"} : {}),
      });
    }
  }
  async function board(agent: string) {
    const row = rowFor(agent);
    if (!row) throw new Error("Open the project chat before reading quests.");
    const { card } = await agentReply(row, "list_quests", { show: "open", limit: 50 });
    const result = z.object({ quests: z.array(boardQuest) }).safeParse(card);
    if (!result.success) throw new Error("Clyde did not return a structured quest board.");
    return result.data.quests;
  }
  server.handle(sharedBoardRpc,async()=>{
    const all:BoardQuest[]=[];
    let after=0;
    for(;;){
      let reply;
      try{reply=await sharedBoardReply({show:"board",after,limit:50});}
      catch(error){
        if(after||!/show must be open, mine, done or all/i.test(String(error)))throw error;
        // An older service still exposes its signed-in MCP board. Never borrow an agent's profile to widen visibility.
        const {card}=await sharedBoardReply({show:"all",context:"all",limit:50});
        const rows=z.object({quests:z.array(boardQuest.extend({state:z.string()}))}).parse(card).quests;
        return {legacy:true,quests:rows.sort((a,b)=>priorityRank(a.priority)-priorityRank(b.priority)||a.id-b.id)};
      }
      const page=z.object({quests:z.array(boardQuest),after:z.number().int().nullable()}).parse(JSON.parse(reply.text.split("\n")[0]));
      all.push(...page.quests);
      if(page.after===null)break;
      if(page.after<=after)throw Error("Clyde returned an invalid board cursor");
      after=page.after;
    }
    return {legacy:false,quests:all.sort((a,b)=>priorityRank(a.priority)-priorityRank(b.priority)||a.id-b.id)};
  });
  server.handle(boardRpc, async ({ agent }, { paseo }) => {
    api = paseo;
    return board(agent);
  });
  async function launch(run: string, origin: Origin) {
    try {
      return await call<Run>("GET", "/runs/" + run);
    } catch (e) {
      if (!String(e).includes("404")) throw e;
    }

    const row = rowFor(origin.agent), job = origin.job;
    if (!row || !job) throw new Error("Quest owner unavailable");
    // Reclaiming the same lease is idempotent. The run ID is also the local POST idempotency key.
    if (!job.confirmed) {
      const brief = await agentCall(row, "claim_quest", { id: job.quest, lease_minutes: 480 });
      job.brief = brief;
      job.confirmed = true;
      job.leaseCheck = Date.now();
      save();
    }
    return call<Run>("POST", "/runs", {
      flow: "task",
      assignment: run.slice(2),
      paseoParentId:origin.agent,
      cwd: job.cwd,
      input: {
        title: job.title,
        prompt: job.brief +
          (api ? "\nClyde project notes:\n" + (await recall(row, job.title + " " + job.brief, api)).text : ""),
        criteria: [job.criterion],
        routing: {},
      },
    });
  }
  server.handle(spawnQuestRpc, async ({ agent, quest }, { paseo }) => {
    api = paseo;
    const key = agent + "/" + quest;
    if (inFlight.has(key)) throw new Error("This quest is already starting");
    inFlight.add(key);
    try {
      const existing = Object.entries(origins).find(([, o]) =>
        o.agent === agent && o.job?.quest === quest && !o.job?.complete
      );
      if (existing) {
        await launch(...existing);
        return { id: existing[0] };
      }
      const item: BoardQuest | undefined = (await board(agent)).find((q) => q.id === quest);
      if (!item) throw new Error("This quest is no longer open");
      const run = "r-" + randomUUID(),
        origin: Origin = {
          agent,
          job: { quest, title: item.title, brief: item.brief, criterion: item.done_when, cwd: rowFor(agent)!.cwd },
        };
      origins[run] = origin;
      save();
      try {
        await launch(run, origin);
      } catch (err) {
        if (!origin.job!.confirmed) {
          delete origins[run];
          save();
        }
        throw err;
      }
      return { id: run };
    } finally {
      inFlight.delete(key);
    }
  });
  async function tick() {
    if (closed || polling || !Object.keys(origins).length) return;
    polling = true;
    try {
      const runs = await call<Run[]>("GET", "/runs");
      const byId = new Map(runs.map((r) => [r.id, r]));
      for (const [id, origin] of Object.entries(origins)) {
        try {
          const row = rowFor(origin.agent), job = origin.job, run = byId.get(id);
          if (run) await asks(run, origin.agent);
          if (run?.status === "done" && row && !job && !origin.resultNote) {
            const evidence = [run.stages.at(-1)?.summary, run.auditedHead && "Audited " + run.auditedHead, run.id]
              .filter(Boolean).join("\n").slice(0, 1900);
            const args = {
              pattern: "observations",
              title: run.title,
              body: evidence.slice(0, 490),
              evidence,
              project_slug: row.project,
            };
            const note = await agentCall(row, "remember", args);
            const entry = note.match(/^Remembered (\S+)\.(?:\s|$)/)?.[1];
            if (!entry) throw new Error("Waiting for acknowledged result note");
            if (api) await memory(row.id, "remember", null, api, args);
            origin.resultNote = entry;
            save();
          }
          if (!row || !job || job.complete || inFlight.has(origin.agent + "/" + job.quest)) continue;
          if (!run) {
            if (job.confirmed) {
              await agentCall(row, "update_quest", { id: job.quest, note: "Recovering " + id });
              await launch(id, origin);
            }
            continue;
          }
          if (run.status === "done") {
            const evidence = [run.stages.at(-1)?.summary, run.auditedHead, id].filter(Boolean).join("\n").slice(
              0,
              1900,
            );
            if (!job.note) {
              const note = await agentCall(row, "remember", {
                pattern: "observations",
                title: job.title,
                body: evidence.slice(0, 490),
                evidence,
              });
              job.note = note.match(/^Remembered (\S+)\./)?.[1];
              save();
            }
            if (!job.note) throw new Error("Waiting for a result note");
            await agentCall(row, "complete_quest", { id: job.quest, evidence, entry_id: job.note });
            job.complete = true;
            save();
          } else if (["stopped", "failed"].includes(run.status)) {
            await agentCall(row, "abandon_quest", { id: job.quest, reason: id + " " + run.status });
            job.complete = true;
            save();
          } else if (Date.now() - (job.leaseCheck ?? 0) > 900000) {
            await agentCall(row, "update_quest", { id: job.quest, note: "Working in " + id });
            job.leaseCheck = Date.now();
            save();
          }
        } catch (error) {
          console.warn("Clyde chat handoff:", String(error).slice(0, 250));
        }
      }
    } catch {
      /* The local daemon can reconnect. */
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(() => {
    void tick();
    const next = Object.entries(votes).find(([key, v]) =>
      v.pendingSync && rowFor(v.agent) && !sending.has(key) && Date.now() - v.attempted >= 900000
    );
    if (next) void transmit(...next);
  }, 4000);
  return {
    track,
    recall,
    notice: (agent: string, id: string, text: string) => append(agent, id, { kind: "notice", text }),
    memory,
    bind: (p: PaseoApi) => {
      api = p;
    },
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
}
