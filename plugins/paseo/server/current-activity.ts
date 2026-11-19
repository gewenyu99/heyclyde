/** Enrich only current workers; one native list scan serves the entire Board. No run state is changed. */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { readJson } from './daemon.ts';
import type { RawRun, RawThread } from './shape.ts';

type Paseo = PluginHandlerContext['paseo'];
type Native = Awaited<ReturnType<Paseo['agents']['list']>>['entries'][number]['agent'];
const path = (value:string) => { try { return realpathSync(value); } catch { return resolve(value); } };
function samePath(a?:string|null,b?:string|null) { return !!a && !!b && path(a) === path(b); }

export function workspaceActivity(threads:RawThread[], runs:RawRun[], paths:(string|undefined)[]) {
  const roots = paths.filter((value):value is string => !!value);
  const matches = (value?:string) => roots.some(root => samePath(value,root));
  const scopedRuns = runs.filter(run => matches(run.repo) || matches(run.cwd));
  const ids = new Set(scopedRuns.map(run => run.id));
  return { runs:scopedRuns, threads:threads.filter(thread => thread.runId ? ids.has(thread.runId) : matches(thread.cwd)) };
}

export async function currentActivity(paseo:Paseo, threads:RawThread[], runs:RawRun[], focusRunId?:string):Promise<RawThread[]> {
  const current = runs.flatMap(run => {
    if (run.status !== 'running' || run.archivedAt || run.endedAt) return [];
    const stage = run.stages.findLast(stage => stage.status === 'running' || stage.status === 'asking');
    const attempt = stage?.attempts.at(-1);
    if (stage?.status !== 'running' || stage.endedAt || !attempt || attempt.result || attempt.endedAt || attempt.verdict || attempt.judgeId || attempt.ok === false) return [];
    const worker = threads.find(thread => thread.id === attempt.threadId);
    return worker && worker.runId === run.id && !worker.archivedAt && !worker.readOnly && worker.status === 'running' && samePath(worker.cwd,run.cwd || run.repo) ? [worker] : [];
  });
  if (!current.length) return threads;
  const native = new Map<string,Native>();
  const wanted = new Set(current.map(thread => thread.paseoAgentId).filter((id):id is string => !!id));
  try {
    if (focusRunId) {
      const worker = current.find(thread => thread.runId === focusRunId && thread.paseoAgentId);
      if (worker) { const handle = paseo.agents.ref(worker.paseoAgentId!); await handle.refresh(); const agent = handle.current(); if (agent) native.set(agent.id,agent); }
    } else if (wanted.size) {
      let cursor:string|undefined;
      const seen = new Set<string>();
      do {
        const page = await paseo.agents.list({page:{cursor,limit:100}});
        for (const {agent} of page.entries) if (wanted.has(agent.id)) native.set(agent.id,agent);
        if (native.size === wanted.size || !page.pageInfo?.hasMore) break;
        const next = page.pageInfo.nextCursor;
        if (!next || seen.has(next)) break;
        seen.add(next); cursor = next;
      } while (true);
    }
  } catch { /* Sparse or older native APIs must not turn historical launcher text into a live block. */ }
  const workers = new Map(current.map(worker => {
    const list = /^[A-Za-z0-9._-]{1,64}$/.test(worker.id) ? readJson<NonNullable<RawThread['workList']>>(`lists/thread:${worker.id}.json`) : null;
    const agent = worker.paseoAgentId ? native.get(worker.paseoAgentId) : undefined;
    const verified = agent && agent.id === worker.paseoAgentId && !agent.archivedAt && agent.provider === worker.rung.backend && agent.labels?.['clyde.run'] === worker.runId && agent.labels?.['clyde.thread'] === worker.id && samePath(agent.cwd,worker.cwd);
    return [worker.id, {...worker,
      ...(list && Array.isArray(list.items) ? {workList:{items:list.items.filter(item => item && typeof item.text === "string" && typeof item.updatedAt === "string" && ["todo","doing","done","blocked"].includes(item.status))}} : {}),
      ...(verified ? {nativeActivity:{permissionPending:Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0,observedAt:new Date().toISOString(),status:agent.status,lastActivityAt:agent.updatedAt}} : {nativeActivity:undefined}),
    }] as const;
  }));
  return threads.map(thread => workers.get(thread.id) ?? thread);
}
