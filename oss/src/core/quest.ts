// Single canonical quest routing matcher used by MCP tools, hooks board, and query filters.
import {
  AGENT_CONTEXTS,
  AGENT_TYPES,
  type AgentScope,
  agentProjectsOf,
  allowedRealms,
  normalizeComputer,
  normalizeProjectSlug,
  projectMatches,
  type QuestMeta,
} from "./permissions.ts";

export type QuestTarget = {
  types?: string[];
  harness?: string | null;
  device_id?: number | null;
  device?: string | null;
  repo?: string | null;
  context?: string | null;
};

export type QuestAgent = {
  name?: string | null;
  family?: string | null;
  context?: string | null;
  type?: string | null;
  agentType?: string | null;
  harness?: string | null;
  deviceId?: number | null;
  device?: string | null;
  principal?: string | null;
  computer?: string | null;
  repos?: string[];
  projects?: string[];
  strictProjects?: boolean;
  sessionRepo?: string | null;
} | null;

export function parseQuestTarget(raw: unknown): { target: QuestTarget; errs: string[] } {
  if (raw === undefined || raw === null) return { target: {}, errs: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { target: {}, errs: ["target must be an object with optional types, harness, device_id, device, repo and context."] };
  }
  const obj = raw as Record<string, unknown>;
  const out: QuestTarget = {};
  const errs: string[] = [];

  if (obj.types !== undefined && obj.types !== null) {
    if (!Array.isArray(obj.types)) {
      errs.push(`target.types must be an array of: ${AGENT_TYPES.join(", ")}.`);
    } else {
      const clean: string[] = [];
      for (const t of obj.types) {
        const s = typeof t === "string" ? t.trim().toLowerCase() : "";
        if (!(AGENT_TYPES as readonly string[]).includes(s)) {
          errs.push(`target.types entries must be one of ${AGENT_TYPES.join(", ")}.`);
          break;
        }
        if (!clean.includes(s)) clean.push(s);
      }
      if (clean.length) out.types = clean;
    }
  }

  if (obj.harness !== undefined && obj.harness !== null && obj.harness !== "") {
    if (typeof obj.harness !== "string" || !obj.harness.trim() || obj.harness.trim().length > 64) {
      errs.push("target.harness must be 1 to 64 characters.");
    } else {
      out.harness = obj.harness.trim();
    }
  }

  if (obj.device_id !== undefined && obj.device_id !== null && obj.device_id !== "") {
    const did = Number(obj.device_id);
    if (!Number.isSafeInteger(did) || did <= 0) errs.push("target.device_id must be a positive integer.");
    else out.device_id = did;
  }

  if (obj.device !== undefined && obj.device !== null && obj.device !== "") {
    const dev = normalizeComputer(obj.device);
    if (!dev) errs.push("target.device must be 1 to 64 characters.");
    else out.device = dev;
  }

  if (obj.repo !== undefined && obj.repo !== null && obj.repo !== "") {
    const repo = normalizeProjectSlug(obj.repo);
    if (!repo) errs.push("target.repo must be a valid project slug like clyde or owner/repo.");
    else out.repo = repo;
  }

  if (obj.context !== undefined && obj.context !== null && obj.context !== "") {
    const ctx = typeof obj.context === "string" ? obj.context.trim().toLowerCase() : "";
    if (!(AGENT_CONTEXTS as readonly string[]).includes(ctx)) {
      errs.push(`target.context must be one of ${AGENT_CONTEXTS.join(", ")}.`);
    } else {
      out.context = ctx;
    }
  }

  return { target: out, errs };
}

function asTarget(raw: unknown): QuestTarget {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as QuestTarget : {};
}

export function scopeToQuestAgent(scope: AgentScope): QuestAgent {
  if (!scope) return null;
  return {
    name: scope.name,
    context: scope.context,
    computer: scope.computer,
    projects: scope.projects,
    repos: scope.projects,
    type: scope.agentType,
    agentType: scope.agentType,
    strictProjects: scope.strictProjects,
    sessionRepo: scope.sessionRepo ?? null,
    principal: scope.principal ?? null,
  };
}

/** Decides whether `agent` may see and claim `quest`. */
export function questMatches(
  agent: QuestAgent,
  quest: Record<string, unknown>,
  options?: { project?: string | null; checkAssignee?: boolean },
): { ok: true } | { ok: false; reason: string } {
  const target = asTarget(quest.target);
  const explicitRepo = target.repo?.trim().toLowerCase() || null;
  const effectiveRepo = explicitRepo ?? (quest.project ? String(quest.project).trim().toLowerCase() : null);

  const fproj = options?.project?.trim().toLowerCase();
  if (fproj && (!effectiveRepo || !projectMatches(effectiveRepo, fproj))) {
    return { ok: false, reason: `project filter ${fproj} does not match` };
  }

  if (options?.checkAssignee && quest.assignee && quest.assignee !== "any") {
    const who = [agent?.name, agent?.family].filter(Boolean).map((x) => String(x).toLowerCase());
    if (!who.includes(String(quest.assignee).toLowerCase())) {
      return { ok: false, reason: `quest is for ${String(quest.assignee)}` };
    }
  }

  const qc = (target.context ?? (quest.context ? String(quest.context) : "both")).trim().toLowerCase();
  if (qc !== "both" && agent?.context) {
    const realms = allowedRealms(agent.context);
    if (realms !== null && !realms.has(qc)) {
      return { ok: false, reason: `quest context ${qc} does not match ${agent.name ?? "agent"}'s ${agent.context} realm` };
    }
  }

  const types = Array.isArray(target.types) && target.types.length
    ? target.types.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : quest.agent_type
    ? [String(quest.agent_type).trim().toLowerCase()]
    : [];
  if (types.length) {
    const myType = (agent?.type ?? agent?.agentType ?? "other").trim().toLowerCase();
    if (!types.includes(myType)) {
      return { ok: false, reason: `quest requires agent type ${types.join(" or ")}, not ${myType}` };
    }
  }

  if (target.harness) {
    const wantHarness = target.harness.trim().toLowerCase();
    const myHarness = (agent?.harness ?? "").trim().toLowerCase();
    if (!myHarness || myHarness !== wantHarness) {
      return { ok: false, reason: `quest requires harness ${target.harness}` };
    }
  }

  if (target.device_id !== undefined && target.device_id !== null) {
    if (agent?.deviceId === undefined || agent?.deviceId === null || Number(agent.deviceId) !== Number(target.device_id)) {
      return { ok: false, reason: `quest requires device #${target.device_id}` };
    }
  }

  const targetDevice = target.device ?? quest.computer ?? null;
  if (targetDevice) {
    const wantDev = String(targetDevice).trim().toLowerCase();
    const myDev = [agent?.computer, agent?.device, agent?.principal].find((v) => v && String(v).trim());
    if (!myDev || String(myDev).trim().toLowerCase() !== wantDev) {
      return { ok: false, reason: `quest requires device ${String(targetDevice)}` };
    }
  }

  if (effectiveRepo) {
    const combinedProjects = [
      ...(agent?.repos ?? []),
      ...(agent?.projects ?? []),
    ];
    const mine = agent
      ? agentProjectsOf({
        name: agent.name ?? "agent",
        context: agent.context ?? "both",
        computer: agent.computer ?? null,
        projects: combinedProjects,
        agentType: agent.type ?? agent.agentType ?? "other",
        strictProjects: Boolean(agent.strictProjects),
        sessionRepo: agent.sessionRepo ?? null,
        principal: agent.principal ?? null,
      })
      : [];
    if (explicitRepo) {
      if (!mine.some((ap) => projectMatches(ap, explicitRepo))) {
        return { ok: false, reason: `quest requires repo ${explicitRepo}` };
      }
    } else if (agent) {
      if (agent.strictProjects || mine.length > 0) {
        if (!mine.some((ap) => projectMatches(ap, effectiveRepo))) {
          return { ok: false, reason: `quest project ${effectiveRepo} is outside ${agent.name ?? "agent"}'s projects` };
        }
      }
    }
  }

  return { ok: true };
}

/** Whether an agent may see or claim a quest. */
export function questPermitted(
  agent: AgentScope,
  quest: QuestMeta & Record<string, unknown>,
  explicitFilter?: { project?: string | null },
): { ok: true } | { ok: false; reason: string } {
  return questMatches(scopeToQuestAgent(agent), quest, explicitFilter);
}
