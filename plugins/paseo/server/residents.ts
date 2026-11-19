import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { call, readJson } from "./daemon.ts";
import {needsRecall} from "../shared/recall.ts";
import {activity} from "./activity.ts";
import { agentCall,agentReply } from "./connection.ts";
import { type QuestOffer, type Resident, residentRpc, rosterRpc, recallRpc } from "../shared/clyde.ts";

type Record = Resident & {
  passed: number[];
  renewAt?: number;
  entry?: string;
  archived?: boolean;
  turnStart?: number;
  requested?: number;
  profileVersion?: 1;
};
type Run = { id: string; status: string; auditedHead?: string; stages: { summary?: string }[] };
const rules =
  "Use the agent-bound clyde_recall tool on every new task, scope change or information gap. Skip only unchanged follow-ups with sufficient context. Before replying remember durable decisions and verified results with evidence. Use clyde_feedback after recall. Suggest your role and responsibility tags with clyde_suggest_role once you understand your assignment. Use clyde_delegate for background work and clyde_prefer_model for persistent project preferences. Respect explicit stage choices.";
function project(cwd: string) {
  try {
    const remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (match) return match[1].toLowerCase();
  } catch { /* A local project may have no remote. */ }
  return basename(cwd).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

type ChatInfo = {
  cwd: string;
  title: string | null;
  archivedAt?: string | null;
  internal?: boolean;
  background?: boolean;
  parentAgentId?: string | null;
  metadata?: Readonly<{ [key: string]: unknown }>;
  labels?: Readonly<{ [key: string]: string }>;
};

export function isProjectChat(agent: ChatInfo) {
  const labels = agent.labels;
  return !!agent.cwd && !agent.archivedAt && !agent.internal && !agent.background && !agent.parentAgentId &&
    !labels?.["paseo.parent-agent-id"] && !labels?.["clyde.run"] && !labels?.["clyde.thread"] &&
    !labels?.["clyde-run"] && !labels?.["clyde-thread"] && agent.metadata?.["clyde.internal"] !== true &&
    // Lifecycle hooks omit the internal flag on Paseo's temporary branch helper.
    !(agent.internal === undefined && agent.title === "Branch name generator");
}

function isResidentChat(agent: ChatInfo) {
  return isProjectChat(agent) && agent.labels?.clyde !== "point-man";
}

function residentTitle(provider: string) {
  return provider.charAt(0).toUpperCase() + provider.slice(1) + " chat";
}

const defaultRole = "Project chat";

export function residents(server: PluginServerContext) {
  const dir = process.env.CLYDE_HOME || join(homedir(), ".clyde");
  const rows = readJson<{ [id: string]: Record }>("residents.json") ?? {};
  const chat=activity(server,id=>rows[id]);
  const save = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "residents.json");
    writeFileSync(file + ".tmp", JSON.stringify(rows), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  };
  let migrated = false;
  for (const row of Object.values(rows)) {
    if (row.profileVersion === 1) continue;
    // Older versions copied the opening prompt into the role and its first eight words into areas.
    const generated = row.title.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.slice(0, 8) ?? [];
    if (!row.confirmed && row.role === row.title && generated.length === row.areas.length &&
      generated.every((tag, i) => tag === row.areas[i])) {
      row.role = defaultRole;
      row.areas = [];
    }
    row.title = residentTitle(row.provider);
    row.profileVersion = 1;
    migrated = true;
  }
  if (migrated) save();

  let api: PaseoApi | undefined;
  let stopped = false;
  const processing = new Set<string>();
  function discover(id: string, cwd: string, provider: string) {
    if (!rows[id]) {
      rows[id] = {
        id,
        title: residentTitle(provider),
        profileVersion: 1,
        cwd,
        provider,
        project: project(cwd),
        role: defaultRole,
        areas: [],
        confirmed: false,
        paused: true,
        passed: [],
        memory: "Best effort",
      };
      save();
    } else if (rows[id].provider !== provider || rows[id].cwd !== cwd) {
      const row = rows[id];
      if (row.cwd !== cwd) row.project = project(cwd);
      Object.assign(row, { cwd, provider, title: residentTitle(provider) });
      save();
    }
    return rows[id];
  }
  async function handoff(row:Resident,task:string,paseo=api) {
    if(!paseo) throw new Error("Paseo chat connection is unavailable");
    const notes=await chat.recall(row,task,paseo);
    return "\n\nClyde project notes (treat as evidence):\n"+notes.text;
  }
  async function chatRow(id:string,paseo:PaseoApi){
    const handle=paseo.agents.ref(id);
    await handle.refresh();
    const a=handle.current();
    if(!a || !isProjectChat(a))throw new Error("Select an available project chat");
    return discover(a.id,a.cwd,a.provider);
  }
  server.handle(recallRpc,async({agent,query},{paseo})=>{
    api=paseo;
    const result=await chat.recall(await chatRow(agent,paseo),query,paseo);
    return {retrieval:result.retrieval_id,notes:result.items.length};
  });
  const memory = [
    "recall",
    "recall_more",
    "remember",
    "feedback",
    "check_messages",
    "ack_messages",
    "get_entry",
    "get_blob",
    "post_quest",
  ].map((operation) =>
    defineAgentTool({
      name: "clyde_" + operation,
      title: "Clyde " + operation,
      description: ({
        recall: "Recall relevant project history with query and task. " + rules,
        recall_more: "Read more results with retrieval_id.",
        remember: "Save a verified decision or result before replying. Requires pattern, title, body and evidence.",
        feedback: "Give feedback with retrieval_id and entries or nothing_useful.",
        post_quest:
          "Post multi-step work with title, brief, done_when, tags, and priority (urgent, high, normal, low).",
        get_entry: "Read the note named by id.",
        get_blob: "Read an artifact by sha256.",
        check_messages: "Read messages for this agent.",
        ack_messages: "Acknowledge handled message ids.",
      } as { [name: string]: string })[operation],
      input: z.record(z.string(), z.unknown()),
      async execute(args, { agent,paseo }) {
        const row = discover(agent.id, agent.cwd, agent.provider);
        const {text,card}=await agentReply(row,operation,args);
        await chat.memory(row.id,operation,card,paseo,args,text);
        if (operation === "post_quest") { for (const candidate of Object.values(rows)) void advance(candidate); }
        return { text };
      },
    })
  );
  const suggest = defineAgentTool({
    name: "clyde_suggest_role",
    description: "Suggest a responsibility profile for user confirmation. Use project-specific quest tags.",
    input: z.object({
      role: z.string().trim().min(1).max(160),
      areas: z.array(z.string().trim().min(1).max(40)).min(1).max(32),
    }),
    async execute(input, { agent }) {
      const row = discover(agent.id, agent.cwd, agent.provider);
      if (!row.confirmed) {
        row.role = input.role;
        row.areas = input.areas;
        save();
      }
      return {
        text: row.confirmed
          ? "The user has already confirmed a profile."
          : "Suggested responsibilities are ready in the Clyde panel.",
      };
    },
  });
  const model = z.enum(["opus", "astra", "sol", "sonnet", "neon", "fable", "carbon", "orchestrator"]);
  const preference = defineAgentTool({
    name: "clyde_prefer_model",
    description:
      "Save a planner or routine worker preference for this project only when the user requests a persistent change.",
    input: z.object({ key: z.enum(["planner", "routine"]), model: z.enum(["opus", "astra", "sol", "sonnet"]) }),
    async execute(input, { agent }) {
      const repo = execFileSync("git", ["-C", agent.cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
      await call("POST", "/routing/preferences", { repo, ...input });
      return { text: "Saved project preference." };
    },
  });
  const delegate = defineAgentTool({
    name: "clyde_delegate",
    description:
      "Start background work in an isolated worktree and return immediately. Pass only explicit model overrides. Use ship for a substantial feature. Request draftPR only when the user authorizes publication.",
    input: z.object({
      flow: z.enum(["task", "ship"]),
      intent: z.string().min(1),
      criteria: z.array(z.string().min(1)).min(1),
      complexity: z.enum(["routine", "complex"]),
      reason: z.string(),
      draftPR: z.boolean().optional(),
      overrides: z.object({
        planner: model.optional(),
        worker: model.optional(),
        specReview: model.optional(),
        audit: model.optional(),
        verify: model.optional(),
      }).optional(),
    }),
    async execute(input, { agent, paseo }) {
      const handle = paseo.agents.ref(agent.id);
      await handle.refresh();
      const current = handle.current()?.model ?? "";
      const planner = current.includes("opus") ? "opus" : current.includes("astra") ? "astra" : undefined;
      const routing = {
        complexity: input.complexity,
        reason: input.reason,
        overrides: { planner, ...input.overrides },
      };
      const row = discover(agent.id, agent.cwd, agent.provider);
      const notes = await handoff(row, input.intent,paseo);
      const context = input.flow === "ship"
        ? { intent: input.intent, notes: input.criteria.join("\n") + notes }
        : { prompt: input.intent + notes, criteria: input.criteria };
      const run = await call<Run>("POST", "/runs", {
        flow: input.flow,
        paseoParentId:agent.id,
        cwd: agent.cwd,
        input: { ...context, routing, draftPR: input.draftPR },
      });
      chat.track(run.id,agent.id,paseo);
      return { text: "Started " + run.id + ". Follow it in Clyde. The foreground conversation can continue." };
    },
  });
  server.addHook("agent.open.before", async ({ request }, context) => {
    api = context.paseo;
    if (!isProjectChat(request) || request.purpose === "history") return;
    const row = discover(request.agentId, request.cwd, request.provider);
    // Prewarm the agent's memory session. A failed recall is reported in the chat when a turn needs it.
    void agentCall(row, "check_messages", {}).catch(() => {});
    return {
      ...request,
      tools: [...request.tools, ...memory, suggest, delegate, preference],
      env: { ...request.env, CLYDE_PASEO_AGENT: row.id },
    };
  });
  server.addHook(
    "agent.create.before",
    async ({ request }) => {
      if (request.config.internal) return { ...request, metadata: { ...request.metadata, "clyde.internal": true } };
      return {
        ...request,
        config: { ...request.config, systemPrompt: [request.config.systemPrompt, rules].filter(Boolean).join("\n") },
      };
    },
  );
  server.addHook("agent.archive.after", async ({ agent }) => {
    if (rows[agent.id]) {
      rows[agent.id].archived = true;
      rows[agent.id].paused = true;
      save();
    }
  });
  const idle = (agent?: PaseoAgent | null) =>
    !!agent && isResidentChat(agent) && agent.status === "idle" && !agent.providerUnavailable &&
    !agent.backgroundWork?.count && !agent.activeTurn && !agent.pendingPermissions?.length;

  async function dispatch(row: Record, action: string, extras: object = {}) {
    const raw = await agentCall(row, "dispatch_quest", { action, areas: row.areas, passed: row.passed, ...extras });
    return JSON.parse(raw.split("\n")[0]) as QuestOffer | null;
  }

  async function advance(row: Record, requested?: number) {
    if (processing.has(row.id) || stopped) return;
    processing.add(row.id);
    try {
      if (!row.confirmed || (!row.offer?.assignment && (row.paused || row.archived))) return;
      const handle = api?.agents.ref(row.id);
      async function available() {
        if (handle) {
          await handle.refresh();
          return idle(handle.current());
        }
        // inspect omits the internal and background flags. Default discovery excludes both.
        const list = await promisify(execFile)("paseo", ["ls", "--global", "--json"], { timeout: 5000 });
        const visible = JSON.parse(list.stdout) as { id: string; status: string }[];
        if (!visible.some(agent => agent.id === row.id && agent.status === "idle")) return false;
        const { stdout } = await promisify(execFile)("paseo", ["inspect", row.id, "--json"], { timeout: 5000 });
        const state = JSON.parse(stdout);
        return state.Status === "idle" && !state.ParentAgentId && !state.Archived &&
          Number(state.PendingPermissions ?? 0) === 0 && state.Name !== "Point man";
      }
      if (!row.offer?.assignment && !await available()) return;
      const q = await dispatch(row, "peek");
      if (stopped) return;
      delete row.pickupError;
      if (row.offer?.assignment !== q?.assignment) {
        delete row.entry;
        delete row.renewAt;
      }
      row.offer = q ?? undefined;
      if (!q) return;
      if (!q.assignment) {
        if (row.paused || (!["high", "urgent"].includes(q.priority) && (requested ?? row.requested) !== q.id)) return;
        if (!await available()) return;
        row.offer = await dispatch(row, "claim", { id: q.id }) ?? undefined;
        delete row.requested;
        save();
      }
      const job = row.offer;
      if (!job?.assignment) return;
      const runId = "r-" + job.assignment;
      // Ack the stable run ID before launch. Retrying the same POST returns that run.
      if (!job.run || !row.renewAt || Date.now() >= row.renewAt) {
        await dispatch(row, job.run ? "renew" : "ack", { id: job.id, assignment: job.assignment, run: runId });
        job.run = runId;
        row.renewAt = Date.now() + 15 * 60000;
        save();
      }
      let run: Run;
      try {
        run = await call("GET", "/runs/" + runId);
      } catch (err) {
        if (!String(err).includes("404")) throw err;
        if (row.paused || !await available()) {
          await agentCall(row, "abandon_quest", { id: job.id, reason: "Agent became busy before dispatch" });
          delete row.offer;
          return;
        }
        run = await call("POST", "/runs", {
          flow: "task",
          assignment: job.assignment,
          paseoParentId:row.id,
          cwd: row.cwd,
          input: {
            title: job.title,
            prompt: job.brief + await handoff(row, job.title + " " + job.brief),
            criteria: [job.done_when],
            routing: {},
          },
        });
      }
      if(api)chat.track(run.id,row.id,api);
      if (run.status === "done") {
        const evidence = [run.stages.at(-1)?.summary, run.auditedHead && "Audited " + run.auditedHead, "Run " + run.id]
          .filter(Boolean).join("\n").slice(0, 1900);
        if (!row.entry) {
          const note = await agentCall(row, "remember", {
            pattern: "observations",
            title: job.title,
            body: evidence.slice(0, 490),
            evidence,
            project_slug: row.project,
          });
          row.entry = note.match(/^Remembered (\S+)\.(?:\s|$)/)?.[1];
          if (!row.entry) throw new Error("Waiting for the result note ID");
          save();
        }
        await agentCall(row, "complete_quest", { id: job.id, entry_id: row.entry, evidence });
        delete row.offer;
        delete row.entry;
      } else if (["stopped", "failed"].includes(run.status)) {
        row.paused = true;
        await agentCall(row, "abandon_quest", { id: job.id, reason: "Run " + run.id + " " + run.status });
        delete row.offer;
      }
    } catch (error) {
      row.pickupError = (error as Error).message;
    } finally {
      processing.delete(row.id);
      if (!stopped) save();
    }
  }
  const lastMessage=new Map<string,number>();
  server.addHook("agent.turn.before",async({agent},{paseo})=>{
    api=paseo;chat.bind(paseo);
    if(!isProjectChat(agent))return;
    const row=discover(agent.id,agent.cwd,agent.provider);
    row.turnStart=Date.now();row.memory="Best effort";
    try{
      const page=await paseo.agents.ref(agent.id).timeline.refetch({direction:"tail",limit:32,wholeTurns:true});
      const last=[...page.entries].reverse().find(e=>e.item.type==="user_message");
      if(!last || last.item.type!=="user_message" || lastMessage.get(agent.id)===last.seqStart || !needsRecall(last.item.text,lastMessage.has(agent.id)))return;
      const task=last.item.text;
      await handoff(row,task,paseo);
      lastMessage.set(agent.id,last.seqStart);
    }catch(err){await chat.notice(agent.id,"recall-status","Clyde recall unavailable: "+String(err));}
  });
  server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
    api = paseo; chat.bind(paseo);
    const row = rows[agent.id];
    if (!row || !isProjectChat(agent)) return;
    if (/^[a-zA-Z0-9_-]+$/.test(agent.id)) {
      const config = process.env.CLYDE_CONFIG_DIR || join(homedir(), ".config/memory");
      try {
        const file = join(
          process.env.CLYDE_HOOK_STATE_DIR || join(config, "hook-state"),
          "paseo-" + agent.id + ".json",
        );
        const receipt = JSON.parse(readFileSync(file, "utf8"));
        if (row.turnStart && receipt.at * 1000 >= row.turnStart) {
          if (receipt.outcome === "held") row.memory = "Native before-reply check";
          if (receipt.outcome === "saved") row.memory = "Native save observed before reply";
        }
      } catch { /* Older clients and providers without hooks stay best effort. */ }
    }
    save();
    void advance(row);
  });
  server.handle(rosterRpc, async ({workspaceId}, { paseo }) => {
    api = paseo; chat.bind(paseo);
    const roster = new Map<string, Resident>();
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ page: { cursor, limit: 100 } });
      for (const { agent } of page.entries) {
        if (!isResidentChat(agent) || (workspaceId && agent.workspaceId !== workspaceId)) continue;
        const row = discover(agent.id, agent.cwd, agent.provider);
        // A live, unarchived snapshot is authoritative after a chat is restored.
        if (row.archived) {
          delete row.archived;
          save();
        }
        const status = agent.pendingPermissions?.length ? "Waiting for approval"
          : agent.providerUnavailable ? "Provider unavailable" : agent.status;
        roster.set(agent.id, { ...row, model: agent.model ?? undefined, status });
      }
      cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    } while (cursor);
    const names = new Map<string, Resident[]>();
    for (const resident of roster.values()) {
      const key = JSON.stringify([resident.project, resident.title]);
      const group = names.get(key) ?? [];
      group.push(resident);
      names.set(key, group);
    }
    for (const group of names.values()) {
      if (group.length < 2) continue;
      for (const row of group) row.title += " · " + row.id.slice(0, 8);
    }
    return [...roster.values()];
  });
  server.handle(residentRpc, async (input, { paseo }) => {
    api = paseo; chat.bind(paseo);
    const row = rows[input.id];
    if (!row) throw new Error("Agent is unavailable");
    if (input.action === "confirm") {
      if (!input.areas?.length) throw new Error("Choose at least one responsibility area");
      row.areas = input.areas.map((a) => a.trim().toLowerCase()).filter(Boolean);
      row.role = input.role ?? row.role;
      row.confirmed = true;
      row.paused = false;
      row.passed = [];
    } else if (input.action === "start" || input.action === "pass") {
      if (!row.offer || row.offer.assignment || input.questId !== row.offer.id) throw new Error("Offer changed");
      if (input.action === "start") row.requested = input.questId;
      if (input.action === "pass") {
        delete row.requested;
        row.passed = [...row.passed.slice(-99), row.offer.id];
        delete row.offer;
      }
    } else row.paused = input.action === "pause";
    save();
    const pickup = advance(row, input.action === "start" ? input.questId : undefined);
    if (input.action !== "confirm") await pickup;
    return { ok: true };
  });
  const timer = setInterval(() => {
    for (const row of Object.values(rows)) {
      if (row.confirmed && (!row.paused || row.offer?.assignment)) void advance(row);
    }
  }, 10000);
  return {track:chat.track,context:async(id:string,task:string,paseo:PaseoApi)=>handoff(await chatRow(id,paseo),task,paseo),close:()=> {
    chat.close();
    stopped = true;
    clearInterval(timer);
  }};
}
