import type { PluginServerContext } from "@getpaseo/plugin/server";
import { call } from "./daemon.ts";
import type { RawRun, RawThread } from "./shape.ts";

// These are the two read-only tools injected by this plugin into Paseo's own MCP server.
const lookups = new Set(["mcp__paseo__clyde_recall", "mcp__paseo__clyde_recall_more"]);

export function allowRunLookups(server: PluginServerContext) {
  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    if (request.kind !== "tool" || !lookups.has(request.name) || request.actions?.length) return;
    const handle = paseo.agents.ref(agent.id);
    await handle.refresh();
    const native = handle.current();
    if (!native || native.archivedAt || native.provider !== request.provider) return;
    const labels = native.labels ?? {};
    const runId = labels["clyde.run"] ?? labels["clyde.orchestrator"];
    if (typeof runId !== "string" || !/^r-[\da-f-]+$/i.test(runId)) return;
    const run = await call<RawRun>("GET", "/runs/" + encodeURIComponent(runId)).catch(() => null);
    if (!run || run.archivedAt || !["running", "asking"].includes(run.status)) return;
    if (labels["clyde.thread"]) {
      const stage = run.stages.findLast(stage => stage.status === "running");
      const attempt = stage?.attempts.at(-1);
      if (!attempt || attempt.endedAt || attempt.judgeId || attempt.threadId !== labels["clyde.thread"]) return;
      const thread = await call<RawThread>("GET", "/threads/" + encodeURIComponent(attempt.threadId)).catch(() => null);
      if (!thread || thread.status !== "running" || thread.runId !== run.id || thread.paseoAgentId !== agent.id) return;
    } else if (labels["clyde.orchestrator"] !== run.id || run.paseoParentId !== agent.id) return;
    // The host may have resolved or replaced the request while we checked ownership.
    await handle.refresh();
    const pending = handle.current()?.pendingPermissions.find(p => p.id === request.id);
    if (pending?.kind === "tool" && pending.name === request.name && pending.provider === request.provider && !pending.actions?.length)
      await handle.respondToPermission({ requestId: pending.id, response: { behavior: "allow" } });
  });
}
