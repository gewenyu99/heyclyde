import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { call } from "./daemon.ts";
import type { RawRun, RawThread } from "./shape.ts";

type Agent = NonNullable<ReturnType<ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>["current"]>>;
type Request = Agent["pendingPermissions"][number];
// These are the two read-only tools injected by this plugin into Paseo's own MCP server.
const lookups = new Set(["mcp__paseo__clyde_recall", "mcp__paseo__clyde_recall_more"]);
function lookup(request: Request): boolean {
  return request.kind === "tool" && lookups.has(request.name) &&
    (request.actions === undefined || (Array.isArray(request.actions) && request.actions.length === 0));
}
function samePath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const path = (value: string) => { try { return realpathSync(value); } catch { return resolve(value); } };
  return path(a) === path(b);
}

async function ownsRun(native: Agent | null | undefined, agentId: string, provider: string): Promise<boolean> {
  if (!native || native.id !== agentId || native.archivedAt || native.provider !== provider) return false;
  const labels = native.labels ?? {};
  const runId = labels["clyde.run"] ?? labels["clyde.orchestrator"];
  if (typeof runId !== "string" || !/^r-[\da-f-]+$/i.test(runId)) return false;
  const run = await call<RawRun>("GET", "/runs/" + encodeURIComponent(runId), undefined, { recover: false });
  if (!run || run.id !== runId || run.archivedAt || run.endedAt || !["running", "asking"].includes(run.status)) return false;
  if (labels["clyde.thread"]) {
    if (run.status !== "running" || labels["clyde.run"] !== run.id) return false;
    const stage = run.stages.findLast(stage => stage.status === "running");
    const attempt = stage?.attempts.at(-1);
    if (!stage || stage.endedAt || !attempt || attempt.endedAt || attempt.result || attempt.verdict || attempt.ok === false || attempt.judgeId || attempt.threadId !== labels["clyde.thread"]) return false;
    const thread = await call<RawThread>("GET", "/threads/" + encodeURIComponent(attempt.threadId), undefined, { recover: false });
    return !!thread && thread.id === attempt.threadId && thread.status === "running" && !thread.archivedAt && !thread.readOnly && thread.runId === run.id && thread.stage === stage.name && thread.rung.backend === provider && thread.paseoAgentId === agentId && samePath(thread.cwd, run.cwd) && samePath(native.cwd, thread.cwd);
  }
  return labels["clyde.orchestrator"] === run.id && run.paseoParentId === agentId;
}

export function allowRunLookups(server: PluginServerContext) {
  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    if (!lookup(request)) return;
    try {
      const handle = paseo.agents.ref(agent.id);
      await handle.refresh();
      if (!await ownsRun(handle.current(), agent.id, request.provider)) return;
      // Native requests and the active attempt can both change while ownership is checked.
      await handle.refresh();
      const current = handle.current();
      if (!await ownsRun(current, agent.id, request.provider)) return;
      const pending = current?.pendingPermissions?.filter(p => p.id === request.id) ?? [];
      if (pending.length === 1 && lookup(pending[0]) && pending[0].name === request.name && pending[0].provider === request.provider)
        await handle.respondToPermission({ requestId: pending[0].id, response: { behavior: "allow" } });
    } catch {
      // Unavailable ownership or response services leave the native request pending for explicit review.
    }
  });
}
