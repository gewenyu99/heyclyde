import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineAgentTool, type PluginHandlerContext, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { wranglerRpc } from "../shared/clyde.ts";
import { call, readJson } from "./daemon.ts";
import { listAllAgents } from "./residents.ts";
import type { RawRun, RawThread } from "./shape.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type ProviderId = Parameters<PaseoApi["providers"]["listModels"]>[0];

const WRANGLER_PREFS: Array<{ provider: string; models: string[] }> = [
  { provider: "antigravity", models: ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-low"] },
  { provider: "claude", models: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"] },
  { provider: "codex", models: ["gpt-6.2-sol", "gpt-6-luna"] },
];

function fullAccessMode(provider: string): string | undefined {
  const backend = provider.split("/")[0];
  if (backend === "claude") return "bypassPermissions";
  if (backend === "codex" || backend === "antigravity") return "full-access";
  return undefined;
}

function canonical(p?: string): string {
  if (!p) return "";
  try { return realpathSync(p); } catch { return p; }
}

function clip(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

export async function pickWranglerProvider(paseo: PaseoApi, cwd: string): Promise<string | undefined> {
  let snap = await paseo.providers?.snapshot?.({ cwd }).catch(() => null);
  let entries = snap?.entries ?? [];
  let ready = entries.filter((e) => e.enabled !== false && e.status === "ready");
  if (!ready.length && entries.some((e) => e.enabled !== false && e.status === "loading") && paseo.providers?.waitForReady) {
    snap = await paseo.providers.waitForReady({ cwd, timeoutMs: 10_000 }).catch(() => snap);
    ready = (snap?.entries ?? []).filter((e) => e.enabled !== false && e.status === "ready");
  }
  const modelsFor = async (provider: string, inline?: { id: string; isSelectable?: boolean }[]) => {
    const list = inline?.length
      ? inline
      : (await paseo.providers?.listModels?.(provider as ProviderId, { cwd }).catch(() => null))?.models ?? [];
    return list.filter((m) => m.isSelectable !== false).map((m) => m.id);
  };
  for (const pref of WRANGLER_PREFS) {
    const entry = ready.find((e) => e.provider === pref.provider);
    if (!entry) continue;
    const ids = await modelsFor(pref.provider, entry.models);
    const exact = pref.models.find((m) => ids.includes(m));
    if (exact) return `${pref.provider}/${exact}`;
    const fuzzy = ids.find((id) => /hydrogen|sonnet|haiku|sol|luna/i.test(id));
    if (fuzzy) return `${pref.provider}/${fuzzy}`;
  }
  for (const entry of ready) {
    const ids = await modelsFor(entry.provider, entry.models);
    if (ids[0]) return `${entry.provider}/${ids[0]}`;
  }
  return undefined;
}

function wranglerSystemPrompt(run: RawRun): string {
  return [
    `You are the fast sidekick wrangler for Clyde run ${run.id} ("${run.title}").`,
    "You sit beside the workflows DAG and the live worker chat to help Wen inspect, edit, steer, and wrangle the other agents in this run.",
    "Always call clyde_run_snapshot first when asked about status, the DAG, what the main chat is doing, or before steering/messaging another agent.",
    "You have real run-control tools: clyde_run_snapshot (reads full DAG + live worker/lead chat messages), clyde_steer_run (adds instructions to the run), clyde_message_agent (messages a worker or lead Paseo chat in this run), clyde_edit_plan (updates plan slices/criteria), clyde_answer_run (answers an open run ask), and clyde_stop_run (stops the run).",
    "Only mutate the run, edit the plan, answer asks, message workers, or stop the run when Wen explicitly asks you to. Confirm what you changed with concrete IDs and keep replies concise.",
  ].join("\n");
}

async function readChatTail(paseo: PaseoApi, agentId?: string): Promise<Array<{ role: string; text: string }>> {
  if (!agentId) return [];
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 16, wholeTurns: true });
    const out: Array<{ role: string; text: string }> = [];
    for (const entry of page.entries ?? []) {
      const item = entry.item as { type: string; text?: string; name?: string; status?: string };
      if (item.type === "user_message" && item.text?.trim()) out.push({ role: "user", text: clip(item.text, 500) });
      else if (item.type === "assistant_message" && item.text?.trim()) out.push({ role: "assistant", text: clip(item.text, 800) });
      else if (item.type === "tool_call") out.push({ role: "tool", text: `${item.status ?? "running"}: ${item.name ?? "tool"}` });
    }
    return out.slice(-14);
  } catch {
    return [];
  }
}

export function wrangler(server: PluginServerContext) {
  const dir = () => process.env.CLYDE_HOME || join(homedir(), ".clyde");
  const saved = readJson<Record<string, string>>("wranglers.json") ?? {};
  const creating = new Map<string, Promise<{ agentId: string; model?: string; created?: boolean }>>();

  function persist() {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const file = join(dir(), "wranglers.json");
    writeFileSync(file + ".tmp", JSON.stringify(saved), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }

  function runIdForAgent(agent: { labels?: Readonly<Record<string, string>> }): string {
    const id = agent.labels?.["clyde.wrangler"] ?? agent.labels?.["clyde.run"];
    if (!id || !/^r-[\da-f-]+$/i.test(id)) throw new Error("This wrangler is not attached to a Clyde run.");
    return id;
  }

  const tools = [
    defineAgentTool({
      name: "clyde_run_snapshot",
      title: "Read Clyde run DAG and chats",
      description: "Read the full orchestration DAG (plan, stages, attempts, checks, judge verdicts, open asks, worker threads) and recent messages from the live worker and lead Paseo chats.",
      input: z.object({}),
      async execute(_args, { agent, paseo }) {
        const runId = runIdForAgent(agent as { labels?: Readonly<Record<string, string>> });
        const [run, allThreads] = await Promise.all([
          call<RawRun>("GET", "/runs/" + encodeURIComponent(runId)),
          call<RawThread[]>("GET", "/threads"),
        ]);
        const runThreads = allThreads.filter((t) => t.runId === runId && !t.archivedAt);
        const activeWorker = runThreads.findLast((t) => t.paseoAgentId && (t.status === "running" || t.status === "queued"))
          ?? runThreads.findLast((t) => t.paseoAgentId);
        const [workerTail, leadTail] = await Promise.all([
          readChatTail(paseo, activeWorker?.paseoAgentId),
          run.paseoParentId && run.paseoParentId !== activeWorker?.paseoAgentId
            ? readChatTail(paseo, run.paseoParentId)
            : Promise.resolve([]),
        ]);
        const snapshot = {
          run: {
            id: run.id,
            title: run.title,
            flow: run.flow,
            status: run.status,
            cwd: run.cwd,
            branch: run.branch,
            question: run.question,
            error: run.error,
            paseoParentId: run.paseoParentId,
            plan: run.plan,
            stages: run.stages.map((s) => ({
              name: s.name,
              status: s.status,
              summary: clip(s.summary, 400),
              attempts: s.attempts.slice(-3).map((a) => ({
                n: a.n,
                threadId: a.threadId,
                rung: a.rung,
                ok: a.ok,
                reason: clip(a.reason, 300),
                verdict: a.verdict,
                checks: a.checks?.map((c) => ({ cmd: c.cmd, code: c.code, output: clip(c.output, 300) })),
              })),
            })),
          },
          agents: runThreads.map((t) => ({
            threadId: t.id,
            paseoAgentId: t.paseoAgentId,
            stage: t.stage,
            title: t.title,
            status: t.status,
            rung: t.rung,
            progress: clip(t.progress, 240),
          })),
          activeWorkerChat: activeWorker?.paseoAgentId ? { agentId: activeWorker.paseoAgentId, recent: workerTail } : null,
          leadChat: run.paseoParentId ? { agentId: run.paseoParentId, recent: leadTail } : null,
        };
        return { text: JSON.stringify(snapshot, null, 2) };
      },
    }),
    defineAgentTool({
      name: "clyde_steer_run",
      title: "Steer this Clyde run",
      description: "Send steering guidance into this Clyde run so active and upcoming stages follow Wen's updated direction.",
      input: z.object({ text: z.string().trim().min(1).max(4000) }),
      async execute(input, { agent }) {
        const runId = runIdForAgent(agent as { labels?: Readonly<Record<string, string>> });
        await call("POST", `/runs/${encodeURIComponent(runId)}/steer`, { text: input.text });
        return { text: `Steered run ${runId}.` };
      },
    }),
    defineAgentTool({
      name: "clyde_message_agent",
      title: "Message an agent in this run",
      description: "Send a direct message to a Paseo worker or lead agent belonging to this run. Omit agentId to message the current active worker.",
      input: z.object({
        agentId: z.string().trim().min(1).optional(),
        text: z.string().trim().min(1).max(6000),
      }),
      async execute(input, { agent, paseo }) {
        const runId = runIdForAgent(agent as { labels?: Readonly<Record<string, string>> });
        const [run, allThreads] = await Promise.all([
          call<RawRun>("GET", "/runs/" + encodeURIComponent(runId)),
          call<RawThread[]>("GET", "/threads"),
        ]);
        const allowed = new Set<string>();
        if (run.paseoParentId) allowed.add(run.paseoParentId);
        const runThreads = allThreads.filter((t) => t.runId === runId && !t.archivedAt && t.paseoAgentId);
        for (const t of runThreads) allowed.add(t.paseoAgentId!);
        const targetId = input.agentId ?? runThreads.findLast((t) => t.status === "running")?.paseoAgentId ?? runThreads.at(-1)?.paseoAgentId ?? run.paseoParentId;
        if (!targetId || !allowed.has(targetId)) {
          throw new Error("Target agent does not belong to this run.");
        }
        await paseo.agents.ref(targetId).send(input.text);
        return { text: `Sent message to agent ${targetId}.` };
      },
    }),
    defineAgentTool({
      name: "clyde_answer_run",
      title: "Answer an open run ask",
      description: "Answer an open plan approval or question on this run (for example 'yes' or requested changes) when Wen asks you to.",
      input: z.object({ text: z.string().trim().min(1).max(4000) }),
      async execute(input, { agent }) {
        const runId = runIdForAgent(agent as { labels?: Readonly<Record<string, string>> });
        await call("POST", `/runs/${encodeURIComponent(runId)}/answer`, { text: input.text, via: "wrangler" });
        return { text: `Submitted answer to run ${runId}.` };
      },
    }),
    defineAgentTool({
      name: "clyde_edit_plan",
      title: "Edit this run's plan",
      description: "Update the run's saved plan (intent and slices) when Wen asks to adjust scope, add/remove slices, or edit acceptance criteria.",
      input: z.object({ plan: z.record(z.string(), z.unknown()) }),
      async execute(input, { agent }) {
        const runId = runIdForAgent(agent as { labels?: Readonly<Record<string, string>> });
        await call("POST", `/runs/${encodeURIComponent(runId)}/plan`, { plan: input.plan });
        return { text: `Updated plan for run ${runId}.` };
      },
    }),
    defineAgentTool({
      name: "clyde_stop_run",
      title: "Stop this Clyde run",
      description: "Stop this Clyde run when Wen explicitly asks to halt it.",
      input: z.object({}),
      async execute(_args, { agent }) {
        const runId = runIdForAgent(agent as { labels?: Readonly<Record<string, string>> });
        await call("POST", `/runs/${encodeURIComponent(runId)}/stop`, {});
        return { text: `Stopped run ${runId}.` };
      },
    }),
  ];

  server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose === "history" || !request.labels?.["clyde.wrangler"]) return;
    return {
      ...request,
      tools: [...request.tools, ...tools],
    };
  });

  server.handle(wranglerRpc, async ({ runId }, { paseo }) => {
    const inflight = creating.get(runId);
    if (inflight) return inflight;

    const task = (async () => {
      const run = await call<RawRun>("GET", "/runs/" + encodeURIComponent(runId));
      const all = await listAllAgents(paseo);
      const cachedId = saved[runId];
      const existing = (cachedId ? all.find((a) => a.id === cachedId && !a.archivedAt) : undefined)
        ?? all.find((a) => !a.archivedAt && a.labels?.["clyde.wrangler"] === runId);
      if (existing) {
        if (saved[runId] !== existing.id) {
          saved[runId] = existing.id;
          persist();
        }
        return { agentId: existing.id, model: existing.model ? `${existing.provider}/${existing.model}` : existing.provider, created: false };
      }

      const cwd = run.cwd || run.repo || process.cwd();
      const provider = await pickWranglerProvider(paseo, cwd);
      if (!provider) throw new Error("No ready Hydrogen or Sonnet-class provider is available in Paseo.");
      const modeId = fullAccessMode(provider);
      const workspaces = (await paseo.workspaces.list()).entries;
      const runPath = canonical(cwd);
      const repoPath = canonical(run.repo);
      const ws = workspaces.find((w) => !w.archivingAt && !(w as { archivedAt?: string | null }).archivedAt && canonical(w.workspaceDirectory) === runPath)
        ?? workspaces.find((w) => !w.archivingAt && !(w as { archivedAt?: string | null }).archivedAt && repoPath && canonical(w.workspaceDirectory) === repoPath);
      const labels = { "clyde.wrangler": runId, "clyde.run": runId };
      const title = ("Wrangler · " + (run.title || runId)).slice(0, 72);
      const systemPrompt = wranglerSystemPrompt(run);
      const idempotencyKey = `clyde-wrangler-${runId}`;
      const createWith = (mode?: string) => {
        const config = { provider, ...(mode ? { modeId: mode } : {}), systemPrompt };
        return ws && paseo.workspaces?.ref
          ? paseo.workspaces.ref(ws.id).agents.create({ idempotencyKey, title, labels, background: true, config })
          : paseo.agents.create({ cwd, idempotencyKey, title, labels, background: true, config });
      };
      let handle;
      try {
        handle = await createWith(modeId);
      } catch (err) {
        if (modeId && /mode/i.test(String(err))) {
          handle = await createWith(provider.startsWith("claude") ? "auto" : undefined);
        } else {
          throw err;
        }
      }
      saved[runId] = handle.id;
      persist();
      return { agentId: handle.id, model: provider, created: true };
    })();

    creating.set(runId, task);
    try {
      return await task;
    } finally {
      if (creating.get(runId) === task) creating.delete(runId);
    }
  });
}
