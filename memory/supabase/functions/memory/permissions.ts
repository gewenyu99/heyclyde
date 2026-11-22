// R70 (#75): pure permission, realm, project, computer, and category filtering engine.
// Used by search.ts, deep.ts, service.ts, quests.ts, write.ts, mcp.ts, and ui/data.ts so SQL pre-filtering,
// spreading graph filtering, JS post-checks, quests, and broadcasts enforce the exact same rules.
import type { Sql } from "./db.ts";
import {
  AGENT_CONTEXTS,
  AGENT_TYPES,
  type AgentScope,
  agentProjectsOf,
  allowedRealms,
  canonicalRealm,
  CATEGORY_RE,
  canReadEntry,
  ENTRY_CONTEXTS,
  type EntryFilter,
  type EntryMeta,
  hasFilter,
  messageAgentMatches,
  normalizeComputer,
  normalizeProjectSlug,
  PROJECT_SLUG_RE,
  projectMatches,
  type QuestMeta,
  accessDeniedReason,
  TRANSFERABILITIES,
} from "./core/permissions.ts";
import { questPermitted } from "./core/quest.ts";

export {
  accessDeniedReason,
  AGENT_CONTEXTS,
  AGENT_TYPES,
  agentProjectsOf,
  allowedRealms,
  canonicalRealm,
  canReadEntry,
  CATEGORY_RE,
  ENTRY_CONTEXTS,
  hasFilter,
  messageAgentMatches,
  normalizeComputer,
  normalizeProjectSlug,
  PROJECT_SLUG_RE,
  projectMatches,
  questPermitted,
  TRANSFERABILITIES,
};
export type { AgentScope, EntryFilter, EntryMeta, QuestMeta };

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
