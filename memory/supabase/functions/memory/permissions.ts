// R70 (#75): pure permission, realm, project, computer, and category filtering engine.
// Used by search.ts, deep.ts, service.ts, quests.ts, write.ts, mcp.ts, and ui/data.ts so SQL pre-filtering,
// spreading graph filtering, JS post-checks, quests, and broadcasts enforce the exact same rules.
import type { Sql } from "./db.ts";
import { questMatches, scopeToQuestAgent } from "./quest.ts";

export const AGENT_CONTEXTS = ["work", "home", "hobby", "personal", "both"] as const;
export const ENTRY_CONTEXTS = ["general", "work", "home", "hobby", "personal"] as const;
export const TRANSFERABILITIES = ["general", "context", "project", "computer"] as const;
export const AGENT_TYPES = ["coding", "exploration", "research", "review", "ops", "assistant", "other"] as const;

export const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

export type AgentScope = {
  name: string;
  context: string;
  computer: string | null;
  projects: string[];
  agentType: string;
  strictProjects: boolean;
  sessionRepo?: string | null;
  principal?: string | null;
} | null;

export type EntryMeta = {
  category?: string | null;
  context?: string | null;
  transferability?: string | null;
  project_slug?: string | null;
  computer?: string | null;
  pattern?: string | null;
  scope?: string | null;
};

export type EntryFilter = {
  category?: string | null;
  context?: string | null;
  project?: string | null;
  transferability?: string | null;
};

export type QuestMeta = {
  context?: string | null;
  project?: string | null;
  computer?: string | null;
  agent_type?: string | null;
};

export function normalizeProjectSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(CONTROL, "").trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!s || s.includes("..") || s.includes("//") || !PROJECT_SLUG_RE.test(s)) return null;
  return s;
}

export function normalizeComputer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(CONTROL, " ").trim();
  if (!s || s.length > 64) return null;
  return s;
}

/** 'home' and 'personal' share one equivalence realm; 'work' and 'hobby' are distinct. */
export function canonicalRealm(ctx: string | null | undefined): string {
  const c = (ctx ?? "general").trim().toLowerCase();
  return c === "personal" ? "home" : c;
}

/** Set of entry/quest context values permitted for an agent context, or null when unrestricted ('both' / null). */
export function allowedRealms(ctx: string | null | undefined): Set<string> | null {
  const c = (ctx ?? "both").trim().toLowerCase();
  if (!c || c === "both") return null;
  if (c === "home" || c === "personal") return new Set(["home", "personal"]);
  return new Set([c]);
}

/** Symmetric match for project slugs: exact lowercase match, or short slug matching 'owner/repo' basename.
 * Two distinct 'owner/repo' paths with different owners never collide. */
export function projectMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const xHasSlash = x.includes("/");
  const yHasSlash = y.includes("/");
  if (xHasSlash && !yHasSlash) return x.split("/").pop() === y;
  if (yHasSlash && !xHasSlash) return y.split("/").pop() === x;
  return false;
}

export function agentProjectsOf(agent: AgentScope): string[] {
  if (!agent) return [];
  const declared = (agent.projects ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const useSessionRepo = !(agent.strictProjects && declared.length > 0);
  const repos = useSessionRepo && agent.sessionRepo ? [...declared, agent.sessionRepo.trim().toLowerCase()] : declared;
  return [...new Set(repos.filter(Boolean))];
}

/** Whether an agent may read an entry under optional explicit recall filters.
 * Explicit filters never bypass hard realm, strict_projects, or computer ceilings. */
export function canReadEntry(agent: AgentScope, entry: EntryMeta, explicitFilter?: EntryFilter): boolean {
  // 1. Explicit filters (narrowing only).
  if (explicitFilter) {
    const fc = explicitFilter.category?.trim().toLowerCase();
    if (fc) {
      const ec = (entry.category ?? "general").trim().toLowerCase();
      const ep = (entry.pattern ?? "").trim().toLowerCase();
      if (ec !== fc && ep !== fc) return false;
    }
    const fctx = explicitFilter.context?.trim().toLowerCase();
    if (fctx && fctx !== "all") {
      const ec = (entry.context ?? "general").trim().toLowerCase();
      if (canonicalRealm(ec) !== canonicalRealm(fctx)) return false;
    }
    const fproj = explicitFilter.project?.trim().toLowerCase();
    if (fproj) {
      if (!entry.project_slug || !projectMatches(entry.project_slug, fproj)) return false;
    }
    const ftr = explicitFilter.transferability?.trim().toLowerCase();
    if (ftr) {
      if ((entry.transferability ?? "general").trim().toLowerCase() !== ftr) return false;
    }
  }

  const t = (entry.transferability ?? "general").trim().toLowerCase();
  const ec = (entry.context ?? "general").trim().toLowerCase();

  // 2. Hard realm ceiling (transferability === 'general' is universally readable; non-general binds to realm).
  if (t !== "general" && ec !== "general" && agent) {
    const realms = allowedRealms(agent.context);
    if (realms !== null && !realms.has(ec)) return false;
  }

  // 3. Project isolation (fail closed if project-transferable entry lacks project_slug).
  if (t === "project" && agent) {
    if (!entry.project_slug) return false;
    const mine = agentProjectsOf(agent);
    if (agent.strictProjects) {
      if (!mine.some((ap) => projectMatches(ap, entry.project_slug))) return false;
    } else if (mine.length > 0) {
      const matchedMine = mine.some((ap) => projectMatches(ap, entry.project_slug));
      const matchedExplicit = Boolean(explicitFilter?.project && projectMatches(explicitFilter.project, entry.project_slug));
      if (!matchedMine && !matchedExplicit) return false;
    }
  }

  // 4. Computer isolation (fail closed if computer-transferable entry lacks computer).
  if (t === "computer" && agent) {
    if (!entry.computer) return false;
    const myComp = (agent.computer ?? agent.principal)?.trim().toLowerCase();
    if (!myComp || entry.computer.trim().toLowerCase() !== myComp) return false;
  }

  return true;
}

export function accessDeniedReason(agent: AgentScope, entry: EntryMeta): string {
  const ec = entry.context ?? "general";
  const t = entry.transferability ?? "general";
  const who = agent?.name ?? "this agent";
  if (t === "project" && entry.project_slug) {
    return `Access denied: entry belongs to project ${entry.project_slug} (${ec}) and is outside ${who}'s permissions.`;
  }
  if (t === "computer" && entry.computer) {
    return `Access denied: entry belongs to computer ${entry.computer} (${ec}) and is outside ${who}'s permissions.`;
  }
  return `Access denied: entry belongs to ${ec} (${t}) and is outside ${who}'s permissions.`;
}

/** Whether an agent may see or claim a quest. */
export function questPermitted(
  agent: AgentScope,
  quest: QuestMeta & Record<string, any>,
  explicitFilter?: { project?: string | null },
): { ok: true } | { ok: false; reason: string } {
  return questMatches(scopeToQuestAgent(agent), quest, explicitFilter);
}

/** Whether a registered agent matches a scoped broadcast to 'all'. */
export function messageAgentMatches(
  agent: { name: string; context: string; projects: string[] },
  targetContext?: string | null,
  targetProject?: string | null,
): boolean {
  const tc = targetContext?.trim().toLowerCase();
  if (tc && tc !== "both" && tc !== "all") {
    const realms = allowedRealms(agent.context);
    if (realms !== null && !realms.has(tc)) return false;
  }
  const tp = targetProject?.trim().toLowerCase();
  if (tp) {
    if (!agent.projects?.some((p) => projectMatches(p, tp))) return false;
  }
  return true;
}

function sqlProjectMatch(db: Sql, col: any, target: string) {
  const s = target.trim().toLowerCase();
  if (s.includes("/")) {
    const base = s.split("/").pop()!;
    return db`(lower(${col}) = ${s} or (position('/' in ${col}) = 0 and lower(${col}) = ${base}))`;
  }
  return db`regexp_replace(lower(${col}), '^.*/', '') = ${s}`;
}

function orAll(db: Sql, parts: any[]) {
  return parts.slice(1).reduce((acc, p) => db`${acc} or ${p}`, parts[0]);
}

/** Parameterized SQL filter predicates matching canReadEntry(agent, entry, filter) 1-for-1. */
export function entryWhereClauses(db: Sql, alias: string, agent: AgentScope, filter?: EntryFilter): any[] {
  if (!/^([a-z][a-z0-9_]*)?$/.test(alias)) throw new Error(`Invalid SQL alias ${alias}`);
  const col = (name: string) => db.unsafe(alias ? `${alias}.${name}` : name);
  const clauses: any[] = [];

  if (filter) {
    const fc = filter.category?.trim().toLowerCase();
    if (fc) {
      clauses.push(db`(${col("category")} = ${fc} or ${col("pattern")} = ${fc})`);
    }
    const fctx = filter.context?.trim().toLowerCase();
    if (fctx && fctx !== "all") {
      const r = canonicalRealm(fctx);
      if (r === "home") clauses.push(db`${col("context")} in ('home', 'personal')`);
      else clauses.push(db`${col("context")} = ${r}`);
    }
    const fproj = filter.project?.trim().toLowerCase();
    if (fproj) {
      clauses.push(db`(${col("project_slug")} is not null and ${sqlProjectMatch(db, col("project_slug"), fproj)})`);
    }
    const ftr = filter.transferability?.trim().toLowerCase();
    if (ftr) {
      clauses.push(db`${col("transferability")} = ${ftr}`);
    }
  }

  if (agent) {
    const realms = allowedRealms(agent.context);
    if (realms !== null) {
      clauses.push(db`(${col("transferability")} = 'general' or ${col("context")} = 'general' or ${col("context")} = any(${[...realms]}::text[]))`);
    }

    const mine = agentProjectsOf(agent);
    if (agent.strictProjects) {
      if (mine.length === 0) {
        clauses.push(db`${col("transferability")} <> 'project'`);
      } else {
        const projOr = orAll(db, mine.map((ap) => sqlProjectMatch(db, col("project_slug"), ap)));
        clauses.push(db`(${col("transferability")} <> 'project' or (${col("project_slug")} is not null and (${projOr})))`);
      }
    } else if (mine.length > 0 && !filter?.project?.trim()) {
      const projOr = orAll(db, mine.map((ap) => sqlProjectMatch(db, col("project_slug"), ap)));
      clauses.push(db`(${col("transferability")} <> 'project' or (${col("project_slug")} is not null and (${projOr})))`);
    } else {
      clauses.push(db`(${col("transferability")} <> 'project' or ${col("project_slug")} is not null)`);
    }

    const myComp = (agent.computer ?? agent.principal)?.trim().toLowerCase() ?? null;
    if (myComp) {
      clauses.push(db`(${col("transferability")} <> 'computer' or (${col("computer")} is not null and lower(${col("computer")}) = ${myComp}))`);
    } else {
      clauses.push(db`${col("transferability")} <> 'computer'`);
    }
  }

  return clauses;
}

export function entryWhereSql(db: Sql, alias: string, agent: AgentScope, filter?: EntryFilter) {
  const clauses = entryWhereClauses(db, alias, agent, filter);
  if (!clauses.length) return db``;
  return clauses.reduce((acc, c) => db`${acc} and ${c}`, db``);
}

export function entryWhereStartSql(db: Sql, alias: string, agent: AgentScope, filter?: EntryFilter) {
  const clauses = entryWhereClauses(db, alias, agent, filter);
  if (!clauses.length) return db``;
  return clauses.slice(1).reduce((acc, c) => db`${acc} and ${c}`, db`where ${clauses[0]}`);
}

export function hasFilter(filter?: EntryFilter): boolean {
  if (!filter) return false;
  return Boolean(
    filter.category?.trim() ||
    (filter.context?.trim() && filter.context.trim().toLowerCase() !== "all") ||
    filter.project?.trim() ||
    filter.transferability?.trim(),
  );
}

/** Parameterized SQL filter predicates matching questPermitted(agent, quest, { project }) 1-for-1. */
export function questWhereSql(db: Sql, alias: string, agent: AgentScope, projectFilter?: string | null) {
  if (!/^([a-z][a-z0-9_]*)?$/.test(alias)) throw new Error(`Invalid SQL alias ${alias}`);
  const col = (name: string) => db.unsafe(alias ? `${alias}.${name}` : name);
  const clauses: any[] = [];

  const fproj = projectFilter?.trim().toLowerCase();
  if (fproj) {
    clauses.push(db`(${col("project")} is not null and ${sqlProjectMatch(db, col("project"), fproj)})`);
  }

  if (agent) {
    const realms = allowedRealms(agent.context);
    if (realms !== null) {
      clauses.push(db`(${col("context")} = 'both' or ${col("context")} = any(${[...realms]}::text[]))`);
    }

    const mine = agentProjectsOf(agent);
    if (agent.strictProjects) {
      if (mine.length === 0) {
        clauses.push(db`${col("project")} is null`);
      } else {
        const projOr = orAll(db, mine.map((ap) => sqlProjectMatch(db, col("project"), ap)));
        clauses.push(db`(${col("project")} is null or (${projOr}))`);
      }
    } else if (mine.length > 0) {
      const projOr = orAll(db, mine.map((ap) => sqlProjectMatch(db, col("project"), ap)));
      clauses.push(db`(${col("project")} is null or (${projOr}))`);
    }

    const myComp = (agent.computer ?? agent.principal)?.trim().toLowerCase() ?? null;
    if (myComp) {
      clauses.push(db`(${col("computer")} is null or lower(${col("computer")}) = ${myComp})`);
    } else {
      clauses.push(db`${col("computer")} is null`);
    }

    if (agent.agentType && agent.agentType !== "other") {
      clauses.push(db`(${col("agent_type")} is null or lower(${col("agent_type")}) = ${agent.agentType.trim().toLowerCase()})`);
    }
  }

  if (!clauses.length) return db``;
  return clauses.reduce((acc, c) => db`${acc} and ${c}`, db``);
}
