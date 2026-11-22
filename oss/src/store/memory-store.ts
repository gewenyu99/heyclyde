// Dialect-neutral Clyde MemoryStore over pluggable SQL connectors, blobs, and LLM providers.
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { fromBool, fromJson, nowIso, ph, queryBuilder, tbl, todayDate, toBool, toFloat32Bytes, toJson, toNullableBool } from "../connectors/query.ts";
import type { SqlConnection, SqlConnector, SqlRow } from "../connectors/types.ts";
import { capLine, closingLine, deepLabel, DEPTHS, moreLine, NOTHING_MORE, PAGE_HEAD, renderDeepItem } from "../core/deep-rules.ts";
import { eventTexts, MIN_QUOTE, quoteIn, squash } from "../core/evidence.ts";
import {
  computeTemperatureAndAge,
  features,
  finalScore,
  relevanceOf,
  temperatureKnobsFrom,
} from "../core/features.ts";
import {
  BAD_VERDICT,
  checkFeedback,
  feedbackFooter,
  NOTE_MAX,
  REMIND_MAX,
  reminderLine,
} from "../core/feedback.ts";
import {
  CAP,
  type CardVote,
  CO_USE,
  coPairs,
  coUsed,
  DORMANT,
  faded,
  LINK_CAP,
  LINK_DOWN,
  LINK_FLOOR,
  LINK_UP,
  MISS_EASE,
  MISS_FREE,
  type Outcome,
  OUTCOME_WHY,
  outcomesOf,
  REINFORCE,
  step,
  STEPS,
  type Steps,
  WAIT_MINUTES,
} from "../core/learn.ts";
import { classifyPromptShift } from "../core/nudge.ts";
import { DEFAULT_PARAM_SETS, ParamError, type Params, type ParamSet, resolveParams, SPREAD, spreadKnobs } from "../core/params.ts";
import {
  accessDeniedReason,
  AGENT_CONTEXTS,
  AGENT_TYPES,
  type AgentScope,
  allowedRealms,
  canReadEntry,
  CATEGORY_RE,
  ENTRY_CONTEXTS,
  type EntryFilter,
  hasFilter,
  messageAgentMatches,
  normalizeComputer,
  normalizeProjectSlug,
  TRANSFERABILITIES,
} from "../core/permissions.ts";
import { parseQuestTarget, questMatches, questPermitted, scopeToQuestAgent } from "../core/quest.ts";
import {
  type ArmResult,
  bestFirst,
  bestFirstRanked,
  bigrams,
  boost,
  byScore,
  clip,
  CO_USE_SESSIONS,
  discount,
  type Edges,
  estimateTokens,
  type Frontier,
  hasCjk,
  kindLabel,
  linkTypeWeight,
  packEntries,
  phrasePatterns,
  type Ranked,
  renderEntry,
  rrf,
  type Scoped,
  scored,
  spread,
  titlePatterns,
  tokens,
  type Trace,
  unscored,
} from "../core/ranking.ts";
import { redact, redactText } from "../core/redact.ts";
import { renderTrialItem, TRIAL_CHANCES } from "../core/trial.ts";
import {
  AGENT_NAME,
  AUTHORITY,
  BLOB_KINDS,
  blobKindOf,
  BODY_SHORT,
  CORE_KINDS,
  decodeUtf8,
  DEFAULT_CATEGORY,
  digestPayload,
  EVIDENCE_KINDS,
  FIELDS,
  FREE_LINKS,
  ID_RE,
  isTextMedia,
  KIND_LIST,
  LINK_TYPES,
  makeId,
  MAX_BLOB_BYTES,
  MAX_BLOBS,
  MAX_BLOBS_BYTES,
  MAX_CHARS,
  MEDIA_TYPE_RE,
  PATTERNS,
  RANK,
  Refused,
  SCOPE_RE,
  SENSITIVITY,
  SHA_RE,
  sha256Hex,
  slug,
  START_CONFIDENCE,
  unstorable,
} from "../core/write-rules.ts";
import type { BlobStore } from "../runtime/blobs.ts";
import type { ClydeConfig } from "../runtime/config.ts";
import type { LlmProvider } from "../runtime/llm.ts";
import { bm25Chinese, bm25English } from "./bm25.ts";
import { VectorIndex } from "./vectors.ts";

export { Refused };

export type AgentIdentity = {
  name: string;
  family: string;
  principal: string;
  session: string | null;
  context: string | null;
  profile: string | null;
  computer?: string | null;
  projects?: string[];
  repos?: string[];
  agentType?: string | null;
  harness?: string | null;
  deviceId?: number | null;
  strictProjects?: boolean;
  sessionRepo?: string | null;
};

export type WriteOrigin = {
  agent: string;
  context: string | null;
  session: string | null;
  profile?: string | null;
  computer?: string | null;
  projects?: string[];
  repo?: string | null;
  agentScope?: AgentIdentity | null;
};

export type ExportLine = { table: string; row: SqlRow };

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g;
const EXPORT_TABLES = [
  "source", "entry", "link", "co_use", "blob", "entry_blob", "entry_provenance",
  "agent", "agent_binding", "device", "mcp_session", "mcp_client", "retrieval",
  "event", "feedback", "confidence_log", "message", "message_delivery",
  "quest", "quest_note", "quest_blob", "param_set", "allocation", "setting",
];
const MAX_LINE = 120;
const PROVENANCE_MAX = 160;
const LEASE_MIN = 15;
const LEASE_MAX = 480;
const LEASE_DEFAULT = 120;
const PRIORITIES = ["urgent", "high", "normal", "low"];
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const FEEDBACK_SAYS: Record<string, Outcome> = { helpful: "used", used: "used", irrelevant: "irrelevant", wrong: "wrong" };

function agentScopeOf(who: AgentIdentity | null | undefined): AgentScope {
  if (!who || who.context === null) return null;
  return {
    name: who.name,
    context: who.context,
    computer: who.computer ?? null,
    projects: who.repos?.length ? [...new Set([...who.repos, ...(who.projects ?? [])])] : (who.projects ?? []),
    agentType: who.agentType ?? "other",
    strictProjects: Boolean(who.strictProjects),
    sessionRepo: who.sessionRepo ?? null,
    principal: who.principal,
  };
}

function whoToQuestAgent(who: AgentIdentity | null | undefined) {
  if (!who) return null;
  return {
    name: who.name,
    family: who.family,
    context: who.context,
    type: who.agentType ?? (who.context === null ? null : "other"),
    agentType: who.agentType ?? (who.context === null ? null : "other"),
    harness: who.harness ?? null,
    deviceId: who.deviceId ?? null,
    principal: who.principal,
    computer: who.computer ?? null,
    repos: who.repos ?? who.projects ?? [],
    projects: who.projects ?? [],
    strictProjects: Boolean(who.strictProjects),
    sessionRepo: who.sessionRepo ?? null,
  };
}

function provenanceText(row: SqlRow, viewer: { device?: string | null; context?: string | null; session?: string | null } | null): string {
  const parts: string[] = [];
  if (row.prov_agent) parts.push(`by ${row.prov_agent}`);
  if (row.prov_device && row.prov_device !== viewer?.device) parts.push(`on ${row.prov_device}`);
  if (row.prov_repo) parts.push(`in ${row.prov_repo}`);
  if (row.prov_agent_context && row.prov_agent_context !== viewer?.context) parts.push(`(${row.prov_agent_context})`);
  if (!parts.length) return "";
  const joined = parts.join(" ");
  return joined.length <= PROVENANCE_MAX ? joined : joined.slice(0, PROVENANCE_MAX - 1) + "…";
}

function familyOf(name: string): string {
  const s = name.toLowerCase();
  if (s.includes("claude")) return "claude";
  if (s.includes("codex") || s.includes("openai") || s.includes("chatgpt")) return "codex";
  if (s.includes("gemini") || s.includes("antigravity")) return "gemini";
  return s.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

export function agentNameFrom(client: string): string {
  return familyOf(client);
}

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isIsoDate(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v);
}

function parseEntryRow(r: SqlRow): SqlRow {
  return {
    ...r,
    confidence: Number(r.confidence ?? 0.5),
    chances_left: Number(r.chances_left ?? 0),
    miss_streak: Number(r.miss_streak ?? 0),
    written_seq: Number(r.written_seq ?? 0),
    verified: r.verified === null || r.verified === undefined ? null : fromBool(r.verified),
  };
}

function searchableProject(row: SqlRow): boolean {
  return row.pattern !== "projects" || (row.origin !== "seed" && !String(row.id).startsWith("notes-"));
}

function repoOfCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1)?.toLowerCase() ?? null;
}

function base64ToBytes(s: string): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

type GraphCache = {
  links: SqlRow[];
  superseded: Set<string>;
  nodes: Map<string, SqlRow>;
  edges: Map<string, Edges>;
  at: number;
};

export class MemoryStore {
  readonly connector: SqlConnector;
  readonly blobs: BlobStore;
  readonly llm: LlmProvider;
  readonly config: ClydeConfig;
  readonly ownerId: string;
  readonly ownerLabel: string;
  private readonly vectors = new VectorIndex();
  private graphCache: GraphCache | null = null;
  private readonly ftsCache = new Map<string, boolean>();
  private readonly paramCache = new Map<string, ParamSet>();

  constructor(connector: SqlConnector, blobs: BlobStore, llm: LlmProvider, config: ClydeConfig) {
    this.connector = connector;
    this.blobs = blobs;
    this.llm = llm;
    this.config = config;
    this.ownerId = config.server.owner_id;
    this.ownerLabel = config.server.owner_name || "the owner";
  }

  private T(name: string): string {
    return tbl(name, this.connector);
  }

  private p(idx: number): string {
    return ph(this.connector.dialect, idx);
  }

  private async useFts5(): Promise<boolean> {
    if (!this.connector.supportsFts5 || this.config.database.fts_backend === "js-bm25") return false;
    if (this.ftsCache.has("ok")) return this.ftsCache.get("ok")!;
    const ok = typeof this.connector.ftsSearchEnglish === "function" && typeof this.connector.ftsSearchChinese === "function";
    this.ftsCache.set("ok", ok);
    return ok;
  }

  forgetGraph(): void {
    this.graphCache = null;
  }

  async getClock(conn: SqlConnection = this.connector): Promise<number> {
    const rows = await conn.query<{ value: string }>(
      `SELECT value FROM ${this.T("setting")} WHERE name = ${this.p(1)}`,
      ["recall_clock_seq"],
    );
    return Number(rows[0]?.value ?? 0);
  }

  async tickClock(conn: SqlConnection = this.connector): Promise<number> {
    const cur = await this.getClock(conn);
    const next = cur + 1;
    await conn.execute(
      `UPDATE ${this.T("setting")} SET value = ${this.p(1)} WHERE name = ${this.p(2)}`,
      [String(next), "recall_clock_seq"],
    );
    return next;
  }

  private async loadParamSet(setId: string): Promise<ParamSet> {
    const hit = this.paramCache.get(setId);
    if (hit) return hit;
    const rows = await this.connector.query<{ id: string; arm: string; params_json: string }>(
      `SELECT id, arm, params_json FROM ${this.T("param_set")} WHERE id = ${this.p(1)}`,
      [setId],
    );
    if (!rows.length) {
      const fallback = DEFAULT_PARAM_SETS.find((s) => s.id === setId) ?? DEFAULT_PARAM_SETS[2];
      return fallback;
    }
    const set: ParamSet = {
      id: rows[0].id,
      arm: rows[0].arm,
      params: fromJson<Params>(rows[0].params_json, DEFAULT_PARAM_SETS[2].params),
    };
    this.paramCache.set(setId, set);
    return set;
  }

  private async pickArmParamSet(): Promise<ParamSet> {
    const arm = this.config.ranking.arm;
    const rows = await this.connector.query<{ id: string; arm: string; params_json: string }>(
      `SELECT p.id, p.arm, p.params_json FROM ${this.T("allocation")} a JOIN ${this.T("param_set")} p ON p.id = a.param_set WHERE a.role IN ('default', 'live') AND a.weight > 0 AND p.arm = ${this.p(1)} ORDER BY a.weight DESC, p.id LIMIT 1`,
      [arm],
    );
    if (rows.length) {
      return { id: rows[0].id, arm: rows[0].arm, params: fromJson<Params>(rows[0].params_json, DEFAULT_PARAM_SETS[2].params) };
    }
    const id = `${arm}.v1`;
    return await this.loadParamSet(id);
  }

  async getSessionMeta(sessionId: string | null | undefined, conn: SqlConnection = this.connector) {
    if (!sessionId) return null;
    const rows = await conn.query<{ id: string; client: string | null; agent: string | null; cwd: string | null; repo: string | null; harness_session_id: string | null }>(
      `SELECT id, client, agent, cwd, repo, harness_session_id FROM ${this.T("mcp_session")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, sessionId],
    );
    return rows[0] ?? null;
  }

  async ensureSession(sessionId: string, clientName: string, harnessSessionId?: string | null, cwd?: string | null): Promise<void> {
    const existing = await this.getSessionMeta(sessionId);
    const now = nowIso();
    const repo = repoOfCwd(cwd);
    if (!existing) {
      await this.connector.execute(
        `INSERT INTO ${this.T("mcp_session")} (owner_id, id, client, agent, cwd, repo, harness_session_id, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)})`,
        [this.ownerId, sessionId, clientName, agentNameFrom(clientName), cwd ?? null, repo, harnessSessionId ?? null, now],
      );
      return;
    }
    if (cwd || harnessSessionId) {
      await this.connector.execute(
        `UPDATE ${this.T("mcp_session")} SET cwd = COALESCE(${this.p(1)}, cwd), repo = COALESCE(${this.p(2)}, repo), harness_session_id = COALESCE(${this.p(3)}, harness_session_id) WHERE owner_id = ${this.p(4)} AND id = ${this.p(5)}`,
        [cwd ?? null, repo, harnessSessionId ?? null, this.ownerId, sessionId],
      );
    }
  }

  async resolveAgent(principal: string, clientName: string): Promise<AgentIdentity> {
    const family = agentNameFrom(clientName);
    const bindings = await this.connector.query<{ agent_name: string }>(
      `SELECT agent_name FROM ${this.T("agent_binding")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND client = ${this.p(3)}`,
      [this.ownerId, principal, clientName],
    );
    if (bindings.length) {
      const agents = await this.connector.query<SqlRow>(
        `SELECT * FROM ${this.T("agent")} WHERE owner_id = ${this.p(1)} AND name = ${this.p(2)}`,
        [this.ownerId, bindings[0].agent_name],
      );
      if (agents[0]) {
        const a = agents[0];
        const projects = fromJson<string[]>(a.projects_json, []);
        const repos = fromJson<string[]>(a.repos_json, []);
        return {
          name: a.name,
          family,
          principal,
          session: null,
          context: a.context,
          profile: `${a.name}, a ${a.context} agent on ${a.surface}`,
          computer: a.computer,
          projects,
          repos,
          agentType: a.agent_type,
          harness: a.harness,
          strictProjects: fromBool(a.strict_projects),
        };
      }
    }
    return { name: family, family, principal, session: null, context: null, profile: null };
  }

  async registerAgent(principal: string, clientName: string, args: Record<string, unknown>) {
    const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
    const context = typeof args.context === "string" ? args.context.trim().toLowerCase() : "";
    const surface = typeof args.surface === "string" ? args.surface.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim() : "";
    const errs: string[] = [];
    if (!AGENT_NAME.test(name) || ["all", "memory"].includes(name)) errs.push("name must be 1-40 lowercase letters, digits, dashes or underscores.");
    if (!(AGENT_CONTEXTS as readonly string[]).includes(context)) errs.push(`context must be one of ${AGENT_CONTEXTS.join(", ")}.`);
    if (!surface || surface.length > 64) errs.push("surface is required (1-64 chars).");
    if (!description || description.length > 500) errs.push("description is required (1-500 chars).");

    const nickname = typeof args.nickname === "string" && args.nickname.trim() ? args.nickname.trim().toLowerCase() : null;
    if (nickname && !AGENT_NAME.test(nickname)) errs.push("nickname must be 1-40 lowercase letters, digits, dashes or underscores.");

    const agentType = typeof args.type === "string" && args.type.trim() ? args.type.trim().toLowerCase() : "other";
    if (!(AGENT_TYPES as readonly string[]).includes(agentType)) errs.push(`type must be one of ${AGENT_TYPES.join(", ")}.`);

    const computer = args.computer !== undefined && args.computer !== null ? normalizeComputer(args.computer) : principal;
    if (args.computer !== undefined && args.computer !== null && !computer) errs.push("computer must be 1-64 characters.");

    const harness = typeof args.harness === "string" && args.harness.trim() ? args.harness.trim() : clientName;
    const strictProjects = args.strict_projects === true;

    const cleanSlugs = (raw: unknown, label: string): string[] => {
      if (raw === undefined || raw === null) return [];
      if (!Array.isArray(raw)) {
        errs.push(`${label} must be an array of slugs.`);
        return [];
      }
      const out: string[] = [];
      for (const item of raw) {
        const s = normalizeProjectSlug(item);
        if (!s) errs.push(`Invalid slug in ${label}: ${String(item)}`);
        else if (!out.includes(s)) out.push(s);
      }
      return out;
    };
    const projects = cleanSlugs(args.projects, "projects");
    const repos = cleanSlugs(args.repos, "repos");

    if (errs.length) throw new Refused(errs.join("\n"));

    if (nickname) {
      const clash = await this.connector.query<{ name: string }>(
        `SELECT name FROM ${this.T("agent")} WHERE owner_id = ${this.p(1)} AND nickname = ${this.p(2)} AND name <> ${this.p(3)}`,
        [this.ownerId, nickname, name],
      );
      if (clash.length) throw new Refused(`Nickname "${nickname}" is already used by agent "${clash[0].name}".`);
    }

    const now = nowIso();
    await this.connector.transaction(async (tx) => {
      const existing = await tx.query<{ name: string }>(
        `SELECT name FROM ${this.T("agent")} WHERE owner_id = ${this.p(1)} AND name = ${this.p(2)}`,
        [this.ownerId, name],
      );
      if (existing.length) {
        await tx.execute(
          `UPDATE ${this.T("agent")} SET nickname = ${this.p(1)}, context = ${this.p(2)}, surface = ${this.p(3)}, description = ${this.p(4)}, projects_json = ${this.p(5)}, repos_json = ${this.p(6)}, computer = ${this.p(7)}, agent_type = ${this.p(8)}, harness = ${this.p(9)}, strict_projects = ${this.p(10)}, updated_at = ${this.p(11)} WHERE owner_id = ${this.p(12)} AND name = ${this.p(13)}`,
          [nickname, context, surface, description, toJson(projects), toJson(repos), computer, agentType, harness, toBool(strictProjects), now, this.ownerId, name],
        );
      } else {
        await tx.execute(
          `INSERT INTO ${this.T("agent")} (owner_id, name, nickname, context, surface, description, projects_json, repos_json, computer, agent_type, harness, strict_projects, created_at, updated_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, ${this.p(10)}, ${this.p(11)}, ${this.p(12)}, ${this.p(13)}, ${this.p(14)})`,
          [this.ownerId, name, nickname, context, surface, description, toJson(projects), toJson(repos), computer, agentType, harness, toBool(strictProjects), now, now],
        );
      }
      const bound = await tx.query<{ agent_name: string }>(
        `SELECT agent_name FROM ${this.T("agent_binding")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND client = ${this.p(3)}`,
        [this.ownerId, principal, clientName],
      );
      if (bound.length) {
        await tx.execute(
          `UPDATE ${this.T("agent_binding")} SET agent_name = ${this.p(1)}, updated_at = ${this.p(2)} WHERE owner_id = ${this.p(3)} AND principal = ${this.p(4)} AND client = ${this.p(5)}`,
          [name, now, this.ownerId, principal, clientName],
        );
      } else {
        await tx.execute(
          `INSERT INTO ${this.T("agent_binding")} (owner_id, principal, client, agent_name, updated_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)})`,
          [this.ownerId, principal, clientName, name, now],
        );
      }
    });

    return { name, nickname, context, surface, computer, agent_type: agentType, projects, repos, strict_projects: strictProjects };
  }

  private async indexFts(conn: SqlConnection, entryId: string, searchText: string): Promise<void> {
    if (!(await this.useFts5())) return;
    await conn.execute(`DELETE FROM ${this.T("entry_fts")} WHERE entry_id = ?`, [entryId]);
    await conn.execute(`DELETE FROM ${this.T("entry_fts_zh")} WHERE entry_id = ?`, [entryId]);
    await conn.execute(`INSERT INTO ${this.T("entry_fts")} (entry_id, text) VALUES (?, ?)`, [entryId, searchText]);
    const zhTerms = bigrams(searchText);
    if (zhTerms.length) {
      await conn.execute(`INSERT INTO ${this.T("entry_fts_zh")} (entry_id, bigrams) VALUES (?, ?)`, [entryId, zhTerms.join(" ")]);
    }
  }

  private async dropFts(conn: SqlConnection, entryId: string): Promise<void> {
    if (!(await this.useFts5())) return;
    await conn.execute(`DELETE FROM ${this.T("entry_fts")} WHERE entry_id = ?`, [entryId]);
    await conn.execute(`DELETE FROM ${this.T("entry_fts_zh")} WHERE entry_id = ?`, [entryId]);
  }

  // ---- Write pipeline (`remember`) ----
  async validateEntry(payload: unknown, caller: "agent" | "runtime", agentName = "agent", profile: string | null = null): Promise<SqlRow> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Refused("An entry is a JSON object.");
    const raw = payload as SqlRow;
    const errs = Object.keys(raw).filter((k) => !FIELDS.has(k)).sort().map((k) => `Unknown field ${k}.`);
    const bad = [...unstorable(raw)];
    if (bad.length) throw new Refused([...errs, ...bad].join("\n"));

    const maxAuthority = caller === "agent" ? "draft" : "approved";
    const agent = caller === "agent";
    const p: SqlRow = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined));
    const e: SqlRow = {
      pattern: p.pattern,
      title: cleanText(p.title),
      body: cleanText(p.body),
      authority: p.authority ?? (agent ? "draft" : undefined),
      scope: p.scope ?? "global",
      kind: p.kind,
      sensitivity: p.sensitivity ?? "normal",
      lang: cleanText(p.lang ?? "en"),
      evidence_kind: p.evidence_kind,
      evidence: cleanText(p.evidence),
      project: p.project || null,
    };

    if (typeof e.pattern !== "string" || !PATTERNS.has(e.pattern)) {
      errs.push(`pattern must be one of ${[...PATTERNS].sort().join(", ")}.`);
    }
    if (!e.title) errs.push("title is required.");
    if (!e.body) errs.push("body is required. It's the summary recall ranks on.");
    for (const [field, cap] of Object.entries(MAX_CHARS)) {
      if (e[field] && String(e[field]).length > cap) {
        errs.push(`${field} is ${String(e[field]).length} characters. The limit is ${cap}, so put long material in an artifact.`);
      }
    }
    if (agent && e.body && String(e.body).length > BODY_SHORT && String(e.body).length <= MAX_CHARS.body && p.long !== true) {
      errs.push(
        `body is ${String(e.body).length} characters. Keep a memory under ${BODY_SHORT} characters and put the detail in an artifact ` +
          `(artifacts: [{name, kind, text}]), or pass long: true.`,
      );
    }
    if (typeof e.authority !== "string" || !AUTHORITY.has(e.authority)) errs.push("authority must be draft, observed or approved.");
    else if (RANK[e.authority] > RANK[maxAuthority]) {
      errs.push(`authority ${e.authority} is above ${maxAuthority}, the most this caller may write.`);
    }
    if (!(typeof e.scope === "string" && SCOPE_RE.test(e.scope))) {
      errs.push(`scope ${JSON.stringify(e.scope ?? null)} must be global, domain:<x>, repo:<x> or run:<id>.`);
    }
    if (e.kind !== undefined && (typeof e.kind !== "string" || !(CORE_KINDS as readonly string[]).includes(e.kind))) {
      errs.push(`kind ${JSON.stringify(e.kind)} must be one of ${CORE_KINDS.join(", ")}.`);
    }
    e.evidence_event = null;
    if ("evidence_event" in p) {
      if (/^\d{1,18}$/.test(String(p.evidence_event)) && Number(p.evidence_event) > 0) e.evidence_event = String(p.evidence_event);
      else errs.push("evidence_event must be an event id.");
    }
    if (typeof e.sensitivity !== "string" || !SENSITIVITY.has(e.sensitivity)) errs.push("sensitivity must be normal, private or confidential.");
    if (!e.lang) errs.push("lang must be a language code like en.");
    if (typeof e.evidence_kind !== "string" || !EVIDENCE_KINDS.has(e.evidence_kind)) {
      errs.push(`evidence_kind must be one of ${[...EVIDENCE_KINDS].sort().join(", ")}.`);
    }
    if (!e.evidence) errs.push("evidence is required and can't be empty.");
    if (e.evidence_kind === "quote" && e.authority === "draft") errs.push(`A quote of ${this.ownerLabel} can't back a draft.`);

    if ("valid_from" in p && !isIsoDate(p.valid_from)) errs.push(`valid_from ${JSON.stringify(p.valid_from)} must be a YYYY-MM-DD date.`);
    e.valid_from = "valid_from" in p ? p.valid_from : todayDate();

    if ("category" in p) {
      const cat = typeof p.category === "string" ? p.category.trim().toLowerCase() : "";
      if (!CATEGORY_RE.test(cat)) errs.push("category must be 1 to 40 lowercase letters, digits or dashes.");
      else e.category = cat;
    }
    if ("context" in p) {
      const ctx = typeof p.context === "string" ? p.context.trim().toLowerCase() : "";
      if (!(ENTRY_CONTEXTS as readonly string[]).includes(ctx)) errs.push("context must be general, work, home, hobby or personal.");
      else e.context = ctx;
    }
    if ("transferability" in p) {
      const tr = typeof p.transferability === "string" ? p.transferability.trim().toLowerCase() : "";
      if (!(TRANSFERABILITIES as readonly string[]).includes(tr)) errs.push("transferability must be general, context, project or computer.");
      else e.transferability = tr;
    }
    if ("project_slug" in p) {
      const ps = normalizeProjectSlug(p.project_slug);
      if (!ps) errs.push("project_slug must be a valid project slug like clyde or owner/repo.");
      else e.project_slug = ps;
    }
    if ("computer" in p) {
      const comp = normalizeComputer(p.computer);
      if (!comp) errs.push("computer must be 1 to 64 characters.");
      else e.computer = comp;
    }

    if (e.project !== null && typeof e.project !== "string") errs.push("project must be an entry id.");
    else if (e.project === null && e.pattern !== "projects") {
      if (agent) {
        e.project = `notes-${AGENT_NAME.test(agentName) ? agentName : "agent"}`;
        e.notesProject = true;
      } else {
        errs.push(
          "project is required unless pattern is projects. It's the id of the projects entry this belongs to." +
            (String(e.scope).startsWith("run:") ? ` For a run, create its projects entry in scope ${e.scope} first.` : ""),
        );
      }
    }

    const explicitId = (p.id ?? "") !== "";
    if (agent && "source" in p) errs.push("An agent can't name a source. memory records the write as an agent session.");
    if (agent && explicitId) errs.push("An agent can't choose an id. memory generates one from the payload.");

    const rawSource = agent
      ? { kind: "session", title: profile ? `${profile}, through remember` : "An agent session, through remember" }
      : p.source;
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
      errs.push("source is required: {kind, title, uri} for a new one, or {id} for one memory already has.");
    } else {
      const sr = rawSource as SqlRow;
      const src: SqlRow = { id: sr.id || null, kind: cleanText(sr.kind), title: cleanText(sr.title), uri: cleanText(sr.uri) };
      if (src.id === null) {
        if (!(src.kind && src.title)) errs.push("A new source needs a kind and a title.");
        const { canonical } = await import("../core/write-rules.ts");
        src.id = `${slug(String(src.kind || "source"))}-${(await sha256Hex(canonical([src.kind, src.title, src.uri]))).slice(0, 10)}`;
      } else if (!(typeof src.id === "string" && ID_RE.test(src.id))) {
        errs.push("source.id must be letters, digits, '.', '_' and '-'.");
      }
      e.source = src;
    }

    // Links and supersedes.
    const rawLinks = p.links ?? [];
    if (!(Array.isArray(rawLinks) && rawLinks.every((l) => l && typeof l === "object" && !Array.isArray(l)))) {
      errs.push("links must be a list of {type, to}.");
      e.links = [];
    } else {
      const linkMap = new Map<string, [string, string]>();
      for (const l of rawLinks as SqlRow[]) {
        const t = l.type, to = l.to;
        if (t === "part_of") errs.push("Set part_of with project, not links.");
        else if (t === "supersedes") errs.push("Set supersedes with supersedes, not links.");
        else if (typeof t !== "string" || !FREE_LINKS.has(t)) errs.push(`link type ${JSON.stringify(t ?? null)} must be one of ${[...FREE_LINKS].sort().join(", ")}.`);
        if (!(typeof to === "string" && to)) errs.push("Every link needs a `to` entry id.");
        else if (typeof t === "string" && FREE_LINKS.has(t)) linkMap.set(`${t}\0${to}`, [t, to]);
      }
      e.links = [...linkMap.values()];
    }

    const rawSup = p.supersedes ?? [];
    if (!(Array.isArray(rawSup) && rawSup.every((v) => typeof v === "string" && v))) {
      errs.push("supersedes must be a list of entry ids.");
      e.supersedes = [];
    } else {
      e.supersedes = [...new Set(rawSup as string[])];
    }

    // Inline / cited artifacts.
    const rawBlobs = [
      ...(Array.isArray(p.artifacts) ? p.artifacts : p.artifacts === undefined ? [] : [p.artifacts]),
      ...(Array.isArray(p.blobs) ? p.blobs : p.blobs === undefined ? [] : [p.blobs]),
    ];
    e.blobs = await this.parseBlobsInput(rawBlobs, errs);

    e.digest = await digestPayload(raw);
    e.id = explicitId && !agent ? String(p.id) : makeId(raw, e.digest);
    if (!ID_RE.test(e.id)) errs.push("id must be letters, digits, '.', '_' and '-', starting with a letter or digit.");
    if (e.project !== null && e.project === e.id) errs.push("An entry can't be part of itself.");
    if ((e.links as [string, string][]).some(([, to]) => to === e.id)) errs.push("An entry can't link to itself.");
    if ((e.supersedes as string[]).includes(e.id)) errs.push("An entry can't supersede itself.");
    if (errs.length) throw new Refused(errs.join("\n"));
    return e;
  }

  private async parseBlobsInput(value: unknown[], errs: string[]): Promise<SqlRow[]> {
    if (!value.every((b) => b && typeof b === "object" && !Array.isArray(b))) {
      errs.push("artifacts must be a list of {name, kind, text | base64 | sha256}.");
      return [];
    }
    if (value.length > MAX_BLOBS) {
      errs.push(`An entry has ${value.length} artifacts. The limit is ${MAX_BLOBS}.`);
      return [];
    }
    const out: SqlRow[] = [];
    const names = new Set<string>();
    for (const b of value as SqlRow[]) {
      const name = cleanText(b.name);
      if (!name) errs.push("Every blob needs a name.");
      else if (names.has(name)) errs.push(`Two blobs are named ${name}.`);
      if (name) names.add(name);
      const label = name || "without a name";
      let kind: string | null = null;
      if (b.kind !== undefined && b.kind !== null) {
        if (typeof b.kind === "string" && BLOB_KINDS.has(b.kind)) kind = b.kind;
        else errs.push(`Blob ${label} has kind ${JSON.stringify(b.kind)}. Use one of ${KIND_LIST}.`);
      }
      const given = ["text", "base64", "sha256"].filter((k) => k in b);
      if (given.length !== 1) {
        errs.push(`Blob ${label} needs text, base64 or sha256, not several or none.`);
        continue;
      }
      let mediaType = b.media_type;
      const typeOk = () => {
        if (mediaType === undefined || mediaType === null) return true;
        if (typeof mediaType === "string" && MEDIA_TYPE_RE.test(mediaType.toLowerCase())) {
          mediaType = mediaType.toLowerCase();
          return true;
        }
        errs.push(`Blob ${label} needs a media_type like text/markdown, not ${JSON.stringify(mediaType)}.`);
        return false;
      };
      const safeName = name ? redactText(name)[0] : name;
      if (given[0] === "sha256") {
        if (typeof b.sha256 !== "string" || !SHA_RE.test(b.sha256)) {
          errs.push(`Blob ${label} has a sha256 that isn't 64 hex digits.`);
          continue;
        }
        typeOk();
        out.push({ name: safeName, kind, media_type: mediaType ?? null, sha256: b.sha256.toLowerCase(), cited: true });
        continue;
      }
      let data: Uint8Array;
      let defaultType: string;
      if ("text" in b) {
        if (typeof b.text !== "string") {
          errs.push(`Blob ${label} has text that isn't a string.`);
          continue;
        }
        data = new TextEncoder().encode(redactText(b.text)[0]);
        defaultType = "text/plain";
      } else {
        const decoded = base64ToBytes(b.base64);
        if (!decoded) {
          errs.push(`Blob ${label} has base64 that doesn't decode.`);
          continue;
        }
        data = decoded;
        defaultType = "application/octet-stream";
      }
      if (data.length > MAX_BLOB_BYTES) errs.push(`Blob ${label} is ${data.length} bytes. The limit is ${MAX_BLOB_BYTES}.`);
      if (!typeOk()) continue;
      mediaType = mediaType ?? defaultType;
      const asText = "base64" in b ? decodeUtf8(data) : null;
      if (asText !== null && (isTextMedia(String(mediaType)) || !asText.includes("\0"))) {
        const [redacted, found] = redactText(asText);
        if (isTextMedia(String(mediaType)) || found.length) data = new TextEncoder().encode(redacted);
      }
      out.push({
        name: safeName,
        kind: kind ?? blobKindOf(String(mediaType), safeName ?? ""),
        media_type: mediaType,
        content: data,
        sha256: await sha256Hex(data),
      });
    }
    const total = out.reduce((n, b) => n + (b.content?.length ?? 0), 0);
    if (total > MAX_BLOBS_BYTES) errs.push(`The blobs add up to ${total} bytes. The limit for one entry is ${MAX_BLOBS_BYTES}.`);
    return out;
  }

  resolveEntryDefaults(e: SqlRow, principal: string, origin: WriteOrigin | null, sessionRepo: string | null = null) {
    const category = e.category ?? DEFAULT_CATEGORY[e.pattern] ?? "general";
    const scopeStr = String(e.scope ?? "global");
    const projectSlug = e.project_slug ??
      (scopeStr.startsWith("repo:") ? normalizeProjectSlug(scopeStr.slice(5)) : null) ??
      normalizeProjectSlug(origin?.repo ?? sessionRepo) ??
      (origin?.projects?.length === 1 ? normalizeProjectSlug(origin.projects[0]) : null);
    const computer = e.computer ?? origin?.computer ?? (principal && principal !== "anyone" ? normalizeComputer(principal) : null);
    const callerRealm = origin?.context && ["work", "home", "hobby", "personal"].includes(origin.context) ? origin.context : null;

    let context: string;
    let transferability: string;
    if (e.context !== undefined && e.transferability !== undefined) {
      context = e.context;
      transferability = e.transferability;
    } else if (e.transferability !== undefined) {
      transferability = e.transferability;
      context = transferability === "general" ? "general" : (callerRealm ?? "general");
    } else if (e.context !== undefined) {
      context = e.context;
      transferability = context === "general" ? "general" : (projectSlug ? "project" : "context");
    } else if (scopeStr.startsWith("repo:") || projectSlug) {
      transferability = "project";
      context = callerRealm ?? "general";
    } else if (scopeStr === "global" && ["preferences", "recommendations", "references"].includes(e.pattern)) {
      context = "general";
      transferability = "general";
    } else if (callerRealm) {
      context = callerRealm;
      transferability = "context";
    } else {
      context = "general";
      transferability = "general";
    }
    return { category, context, transferability, project_slug: projectSlug, computer };
  }

  private async classifyEntry(e: SqlRow, caller: "agent" | "runtime") {
    const claimed: string = e.kind ?? (caller === "runtime" && e.evidence_kind === "quote" ? "user" : "observation");
    let kind = claimed;
    let verified: boolean | null = null;
    if (claimed === "fact" || (claimed === "user" && (caller === "agent" || e.evidence_event !== null))) {
      const bare = squash(String(e.evidence).replace(/\[redacted:[^\]]*\]/g, ""));
      if (bare.length >= MIN_QUOTE && /^\d{1,18}$/.test(String(e.evidence_event ?? ""))) {
        const rows = await this.connector.query<{ id: number; event: string; payload_json: string }>(
          `SELECT id, event, payload_json FROM ${this.T("event")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
          [this.ownerId, Number(e.evidence_event)],
        );
        const ev = rows[0];
        if (ev) {
          const payload = fromJson<unknown>(ev.payload_json, {});
          const matched = eventTexts(ev.event, payload).some((t) => quoteIn(t, String(e.evidence)));
          verified = matched && (claimed !== "user" || ev.event === "UserPromptSubmit");
        } else {
          verified = false;
        }
      } else {
        verified = false;
      }
      if (!verified) kind = "observation";
    }
    return { kind, verified, ...(START_CONFIDENCE[kind] ?? START_CONFIDENCE.observation) };
  }

  async remember(
    payload: unknown,
    caller: "agent" | "runtime",
    agentName = "agent",
    principal = "anyone",
    origin: WriteOrigin | null = null,
  ): Promise<{ id: string; blobs: SqlRow[]; embedded: boolean }> {
    const e = await this.validateEntry(payload, caller, agentName, origin?.profile ?? null);
    e.prov = {
      device: principal,
      agent: origin?.agent ?? agentName,
      context: origin?.context ?? null,
      session: origin?.session ?? null,
    };

    const existing = await this.connector.query<{ payload_sha256: string }>(
      `SELECT payload_sha256 FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, e.id],
    );
    if (existing.length) {
      if (existing[0].payload_sha256 !== e.digest) {
        throw new Refused(`Entry ${e.id} already exists. Write a new entry that supersedes it.`);
      }
      return { id: e.id, blobs: await this.blobsOf(e.id), embedded: false };
    }

    let sessionRepo = origin?.repo ?? null;
    if (sessionRepo === null && origin?.session) {
      const sess = await this.getSessionMeta(origin.session);
      sessionRepo = sess?.repo ?? null;
    }
    Object.assign(e, this.resolveEntryDefaults(e, principal, origin, sessionRepo));
    if (e.transferability === "project" && !e.project_slug) {
      throw new Refused('transferability "project" requires project_slug (or a repo/single-project agent).');
    }
    if (e.transferability === "computer" && !e.computer) {
      throw new Refused('transferability "computer" requires computer (or a named device/agent computer).');
    }

    for (const f of ["title", "body", "evidence"]) e[f] = redactText(String(e[f]))[0];
    const classified = await this.classifyEntry(e, caller);
    Object.assign(e, classified);

    await this.resolveCitedBlobs(e, principal, agentScopeOf(origin?.agentScope));
    for (const b of e.blobs as SqlRow[]) {
      if (b.cited) continue;
      const text = isTextMedia(b.media_type) ? decodeUtf8(b.content) : null;
      b.size = (b.content as Uint8Array).byteLength;
      b.text = text;
      b.stored = this.blobs.storageOn() && (text === null || b.size > this.blobs.inlineMaxBytes) ? "storage" : "db";
    }

    const titleOnly = e.sensitivity === "private" || e.sensitivity === "confidential";
    let screenWhy: string | null = null;
    try {
      const screenInput = titleOnly
        ? String(e.title)
        : [e.title, e.body, e.evidence, ...(e.blobs as SqlRow[]).map((b) => String(b.text ?? "").slice(0, 4000))].join("\n\n");
      screenWhy = await this.llm.screenWrite(screenInput);
    } catch (err) {
      throw new Refused(`memory couldn't screen this note right now (${(err as Error).message.slice(0, 80)}), so it wrote nothing. Try again later.`);
    }
    if (screenWhy) {
      for (const b of (e.blobs as SqlRow[]).filter((x) => x.uploaded)) {
        await this.blobs.remove(b.sha256, "incoming");
        await this.connector.execute(
          `DELETE FROM ${this.T("upload")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND sha256 = ${this.p(3)}`,
          [this.ownerId, principal, b.sha256],
        );
      }
      throw new Refused(screenWhy[0].toUpperCase() + screenWhy.slice(1));
    }

    const scope = agentScopeOf(origin?.agentScope);
    const uploads = (e.blobs as SqlRow[]).filter((b) => b.uploaded);

    // Put storage blobs first; clean up if transaction fails.
    const blobShas = (e.blobs as SqlRow[]).map((b) => b.sha256 as string);
    const existingBlobs = new Set<string>();
    if (blobShas.length) {
      const q = queryBuilder(this.connector.dialect)
        .raw(`SELECT sha256 FROM ${this.T("blob")} WHERE owner_id = `)
        .val(this.ownerId)
        .raw(" AND sha256 IN ")
        .inList(blobShas)
        .build();
      for (const r of await this.connector.query<{ sha256: string }>(q.sql, q.params)) existingBlobs.add(r.sha256);
    }
    for (const b of e.blobs as SqlRow[]) b.existing = Boolean(b.existing) || existingBlobs.has(b.sha256);

    const newStorageBytes = (e.blobs as SqlRow[]).filter((b) => !b.existing).reduce((n, b) => n + Number(b.size ?? 0), 0);
    if (newStorageBytes > 0) {
      const usedRows = await this.connector.query<{ total: number }>(
        `SELECT COALESCE(SUM(size), 0) AS total FROM ${this.T("blob")} WHERE owner_id = ${this.p(1)}`,
        [this.ownerId],
      );
      const used = Number(usedRows[0]?.total ?? 0);
      if (used + newStorageBytes > this.blobs.maxQuotaBytes) {
        throw new Refused(`These blobs need ${newStorageBytes} bytes, and memory holds ${used} of its ${this.blobs.maxQuotaBytes}.`);
      }
    }

    const putList = (e.blobs as SqlRow[]).filter((b) => !b.cited && !b.existing && b.stored === "storage");
    const putDone: string[] = [];
    try {
      for (const b of putList) {
        await this.blobs.put(b.sha256, b.media_type, b.content, "final");
        putDone.push(b.sha256);
      }
      await this.connector.transaction(async (tx) => {
        const again = await tx.query<{ payload_sha256: string }>(
          `SELECT payload_sha256 FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
          [this.ownerId, e.id],
        );
        if (again.length) return;
        await this.ensureNotesProject(tx, e);
        await this.checkWriteTargets(tx, e, scope);
        await this.insertEntryTx(tx, e);
      });
    } catch (err) {
      for (const sha of putDone) {
        const ref = await this.connector.query<{ sha256: string }>(
          `SELECT sha256 FROM ${this.T("blob")} WHERE owner_id = ${this.p(1)} AND sha256 = ${this.p(2)}`,
          [this.ownerId, sha],
        );
        if (!ref.length) await this.blobs.remove(sha, "final").catch(() => {});
      }
      throw err;
    }

    for (const b of uploads) {
      await this.connector.execute(
        `DELETE FROM ${this.T("upload")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND sha256 = ${this.p(3)}`,
        [this.ownerId, principal, b.sha256],
      );
      if (b.existing) await this.blobs.remove(b.sha256, "incoming").catch(() => {});
    }
    this.forgetGraph();
    return {
      id: e.id,
      blobs: (e.blobs as SqlRow[]).map((b) => ({ name: b.name, sha256: b.sha256, kind: b.kind, size: b.size })),
      embedded: false,
    };
  }

  private async resolveCitedBlobs(e: SqlRow, principal: string, agentScope: AgentScope): Promise<void> {
    const cited = (e.blobs as SqlRow[]).filter((b) => b.cited);
    if (!cited.length) return;
    const shas = cited.map((b) => b.sha256 as string);

    const uq = queryBuilder(this.connector.dialect)
      .raw(`SELECT sha256, size, media_type FROM ${this.T("upload")} WHERE owner_id = `)
      .val(this.ownerId)
      .raw(" AND principal = ")
      .val(principal)
      .raw(" AND sha256 IN ")
      .inList(shas)
      .build();
    const waiting = new Map((await this.connector.query<SqlRow>(uq.sql, uq.params)).map((r) => [r.sha256 as string, r]));

    const bq = queryBuilder(this.connector.dialect)
      .raw(`SELECT b.sha256, b.size, b.media_type, b.stored, n.sensitivity, n.category, n.context, n.transferability, n.project_slug, n.computer, n.pattern, n.scope FROM ${this.T("blob")} b LEFT JOIN ${this.T("entry_blob")} x ON x.owner_id = b.owner_id AND x.sha256 = b.sha256 LEFT JOIN ${this.T("entry")} n ON n.owner_id = x.owner_id AND n.id = x.entry_id WHERE b.owner_id = `)
      .val(this.ownerId)
      .raw(" AND b.sha256 IN ")
      .inList(shas)
      .build();
    const held = new Map<string, SqlRow>();
    for (const r of await this.connector.query<SqlRow>(bq.sql, bq.params)) {
      const prev = held.get(r.sha256 as string) ?? { sha256: r.sha256, size: Number(r.size), media_type: r.media_type, stored: r.stored, public: false };
      if (r.sensitivity && r.sensitivity !== "private" && canReadEntry(agentScope, r)) prev.public = true;
      held.set(r.sha256 as string, prev);
    }

    for (const b of cited) {
      const up = waiting.get(b.sha256);
      const row = held.get(b.sha256);
      let checked = null;
      if (up && this.blobs.storageOn()) {
        try {
          checked = await this.blobs.inspectIncoming(b.sha256, { size: Number(up.size), media_type: String(up.media_type) });
        } catch (err) {
          await this.connector.execute(
            `DELETE FROM ${this.T("upload")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND sha256 = ${this.p(3)}`,
            [this.ownerId, principal, b.sha256],
          );
          throw new Refused((err as Error).message);
        }
      }
      if (checked) {
        const found = checked.text === null ? [] : redactText(checked.text)[1];
        if (found.length) {
          await this.blobs.remove(b.sha256, "incoming");
          await this.connector.execute(
            `DELETE FROM ${this.T("upload")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND sha256 = ${this.p(3)}`,
            [this.ownerId, principal, b.sha256],
          );
          throw new Refused(
            `Blob ${b.name} has secrets or identifiers in it (${[...new Set(found)].join(", ")}), so memory deleted the upload. Take them out and upload it again.`,
          );
        }
        Object.assign(b, {
          media_type: checked.media_type,
          size: checked.size,
          text: checked.text,
          uploaded: true,
          existing: Boolean(row),
          stored: "storage",
        });
      } else if (row?.public) {
        Object.assign(b, { media_type: row.media_type, size: row.size, existing: true, stored: row.stored });
      } else {
        throw new Refused(`memory has no blob ${b.sha256}. Send the file with upload_blob and PUT it before citing its sha256.`);
      }
      b.kind ??= blobKindOf(b.media_type, b.name ?? "");
    }
  }

  private async ensureNotesProject(tx: SqlConnection, e: SqlRow): Promise<void> {
    if (!e.notesProject) return;
    const s = e.source;
    const who = String(e.project).slice("notes-".length);
    const evidence = `memory made this the first time ${who} remembered a note with no project of its own.`;
    const existingSrc = await tx.query<{ id: string }>(
      `SELECT id FROM ${this.T("source")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, s.id],
    );
    if (!existingSrc.length) {
      await tx.execute(
        `INSERT INTO ${this.T("source")} (owner_id, id, kind, title, uri, date) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)})`,
        [this.ownerId, s.id, s.kind, s.title, s.uri, todayDate()],
      );
    }
    const existingProj = await tx.query<{ id: string }>(
      `SELECT id FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, e.project],
    );
    if (!existingProj.length) {
      const now = nowIso();
      const seq = await this.getClock(tx);
      const title = `Notes by ${who}`;
      const body = `Notes ${who} wrote through remember with no project of their own.`;
      const st = `${title}\n${body}\n${evidence}\n${title}`;
      await tx.execute(
        `INSERT INTO ${this.T("entry")} (owner_id, id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence, evidence_sha256, project, origin, kind, confidence, chances_left, category, context, transferability, search_text, written_seq, created_at, updated_at) VALUES (${this.p(1)}, ${this.p(2)}, 'projects', ${this.p(3)}, ${this.p(4)}, 'draft', 'global', 'normal', 'en', ${this.p(5)}, ${this.p(6)}, 'summary', ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, 'runtime', 'observation', ${this.p(10)}, 0, 'product', 'general', 'general', ${this.p(11)}, ${this.p(12)}, ${this.p(13)}, ${this.p(14)})`,
        [this.ownerId, e.project, title, body, todayDate(), s.id, evidence, await sha256Hex(evidence), e.project, START_CONFIDENCE.observation.confidence, st, seq, now, now],
      );
      await this.indexFts(tx, e.project, st);
    }
  }

  private async checkWriteTargets(tx: SqlConnection, e: SqlRow, agentScope: AgentScope): Promise<void> {
    const targets = [...new Set([e.project, ...(e.links as [string, string][]).map(([, to]) => to), ...(e.supersedes as string[])].filter(Boolean))];
    const known: Record<string, SqlRow> = {};
    if (targets.length) {
      const q = queryBuilder(this.connector.dialect)
        .raw(`SELECT id, pattern, authority, scope, category, context, transferability, project_slug, computer, title FROM ${this.T("entry")} WHERE owner_id = `)
        .val(this.ownerId)
        .raw(" AND id IN ")
        .inList(targets)
        .build();
      for (const r of await tx.query<SqlRow>(q.sql, q.params)) known[r.id as string] = r;
    }
    const errs: string[] = [];
    const proj = e.project as string | null;
    if (proj !== null && !(proj in known)) {
      errs.push(
        String(e.scope).startsWith("run:")
          ? `Project ${proj} doesn't exist. Create the run's project entry first, with pattern projects and scope ${e.scope}.`
          : `Project ${proj} doesn't exist.`,
      );
    } else if (proj !== null && known[proj].pattern !== "projects") {
      errs.push(`${proj} is a ${known[proj].pattern} entry, not a project.`);
    } else if (proj !== null && !canReadEntry(agentScope, known[proj])) {
      errs.push(`Project ${proj} is outside your permissions.`);
    }
    for (const [t, to] of e.links as [string, string][]) {
      if (!(to in known)) errs.push(`Dangling link: ${t} ${to}, which doesn't exist.`);
    }
    for (const old of e.supersedes as string[]) {
      const o = known[old];
      if (!o) {
        errs.push(`Can't supersede ${old}: it doesn't exist.`);
        continue;
      }
      if (!canReadEntry(agentScope, o)) {
        errs.push(`Can't supersede ${old}: it is outside your permissions.`);
        continue;
      }
      if (RANK[o.authority] > RANK[e.authority]) {
        errs.push(`${e.authority === "observed" ? "An" : "A"} ${e.authority} entry can't supersede ${o.authority} ${old}.`);
      }
      if (String(e.scope).startsWith("run:") && o.scope !== e.scope) {
        errs.push(`A ${e.scope} entry can only supersede entries in ${e.scope}, and ${old} is in ${o.scope}.`);
      }
    }
    const s = e.source;
    if (!(s.kind && s.title)) {
      const srcRows = await tx.query<{ id: string }>(
        `SELECT id FROM ${this.T("source")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
        [this.ownerId, s.id],
      );
      if (!srcRows.length) errs.push(`Source ${s.id} is new, so it needs a kind and a title.`);
    }
    if (errs.length) throw new Refused(errs.join("\n"));
    e._projectTitle = proj ? String(known[proj]?.title ?? "") : String(e.title);
  }

  private async insertEntryTx(tx: SqlConnection, e: SqlRow): Promise<void> {
    const now = nowIso();
    const s = e.source;
    const srcHave = await tx.query<{ id: string }>(
      `SELECT id FROM ${this.T("source")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, s.id],
    );
    if (!srcHave.length) {
      await tx.execute(
        `INSERT INTO ${this.T("source")} (owner_id, id, kind, title, uri, date) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)})`,
        [this.ownerId, s.id, s.kind, s.title, s.uri, todayDate()],
      );
    }

    for (const b of [...(e.blobs as SqlRow[])].sort((a, b2) => (a.sha256 < b2.sha256 ? -1 : 1))) {
      if (b.existing) continue;
      const blobHave = await tx.query<{ sha256: string }>(
        `SELECT sha256 FROM ${this.T("blob")} WHERE owner_id = ${this.p(1)} AND sha256 = ${this.p(2)}`,
        [this.ownerId, b.sha256],
      );
      if (!blobHave.length) {
        await tx.execute(
          `INSERT INTO ${this.T("blob")} (owner_id, sha256, media_type, size, content, stored, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
          [this.ownerId, b.sha256, b.media_type, b.size, b.stored === "db" ? b.content : null, b.stored, now],
        );
      }
    }

    const searchText = [e.title, e.body, e.evidence, e._projectTitle || e.title].filter(Boolean).join("\n");
    const seq = await this.getClock(tx);
    await tx.execute(
      `INSERT INTO ${this.T("entry")} (owner_id, id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence, evidence_sha256, project, origin, payload_sha256, kind, confidence, chances_left, miss_streak, evidence_event, verified, category, context, transferability, project_slug, computer, search_text, written_seq, created_at, updated_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, ${this.p(10)}, ${this.p(11)}, ${this.p(12)}, ${this.p(13)}, ${this.p(14)}, ${this.p(15)}, 'runtime', ${this.p(16)}, ${this.p(17)}, ${this.p(18)}, ${this.p(19)}, 0, ${this.p(20)}, ${this.p(21)}, ${this.p(22)}, ${this.p(23)}, ${this.p(24)}, ${this.p(25)}, ${this.p(26)}, ${this.p(27)}, ${this.p(28)}, ${this.p(29)}, ${this.p(30)})`,
      [
        this.ownerId, e.id, e.pattern, e.title, e.body, e.authority, e.scope, e.sensitivity, e.lang, e.valid_from,
        s.id, e.evidence_kind, e.evidence, await sha256Hex(String(e.evidence)), e.project ?? e.id, e.digest,
        e.kind, e.confidence, e.chances, e.evidence_event, toBool(e.verified),
        e.category, e.context, e.transferability, e.project_slug ?? null, e.computer ?? null,
        searchText, seq, now, now,
      ],
    );
    await this.indexFts(tx, e.id, searchText);

    const allLinks: [string, string][] = [
      ...(e.project ? [["part_of", String(e.project)] as [string, string]] : []),
      ...(e.supersedes as string[]).map((old): [string, string] => ["supersedes", old]),
      ...(e.links as [string, string][]),
    ];
    for (const [t, to] of allLinks) {
      const linkHave = await tx.query<{ src: string }>(
        `SELECT src FROM ${this.T("link")} WHERE owner_id = ${this.p(1)} AND src = ${this.p(2)} AND dst = ${this.p(3)} AND type = ${this.p(4)}`,
        [this.ownerId, e.id, to, t],
      );
      if (!linkHave.length) {
        await tx.execute(
          `INSERT INTO ${this.T("link")} (owner_id, src, dst, type, weight) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, 1.0)`,
          [this.ownerId, e.id, to, t],
        );
      }
    }

    for (const b of e.blobs as SqlRow[]) {
      await tx.execute(
        `INSERT INTO ${this.T("entry_blob")} (owner_id, entry_id, name, sha256, kind) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)})`,
        [this.ownerId, e.id, b.name, b.sha256, b.kind],
      );
    }

    if (e.prov) {
      const sess = await this.getSessionMeta(e.prov.session, tx);
      await tx.execute(
        `INSERT INTO ${this.T("entry_provenance")} (owner_id, entry_id, device, agent, agent_context, repo, cwd, session, run_scope, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, ${this.p(10)})`,
        [
          this.ownerId, e.id, e.prov.device, e.prov.agent, e.prov.context,
          sess?.repo ?? null, sess?.cwd ?? null, e.prov.session ?? null,
          String(e.scope).startsWith("run:") ? e.scope : null, now,
        ],
      );
    }

    for (const b of e.blobs as SqlRow[]) {
      if (b.uploaded && !b.existing) await this.blobs.claimIncoming(b.sha256);
    }
  }

  async blobsOf(entryId: string): Promise<SqlRow[]> {
    const rows = await this.connector.query<SqlRow>(
      `SELECT x.name, x.sha256, x.kind, b.size FROM ${this.T("entry_blob")} x JOIN ${this.T("blob")} b ON b.owner_id = x.owner_id AND b.sha256 = x.sha256 WHERE x.owner_id = ${this.p(1)} AND x.entry_id = ${this.p(2)} ORDER BY x.name`,
      [this.ownerId, entryId],
    );
    return rows.map((b) => ({ name: b.name, sha256: b.sha256, kind: b.kind, size: Number(b.size) }));
  }

  // ---- Embeddings sync ----
  async syncEmbeddings(batch = 64): Promise<number> {
    if (!this.llm.embeddingsEnabled()) return 0;
    const rows = await this.connector.query<SqlRow>(
      `SELECT e.id, e.title, e.body, e.evidence, e.search_text, e.sensitivity, x.content_sha256, x.model, x.dimensions FROM ${this.T("entry")} e LEFT JOIN ${this.T("entry_embedding")} x ON x.owner_id = e.owner_id AND x.entry_id = e.id WHERE e.owner_id = ${this.p(1)}`,
      [this.ownerId],
    );
    const model = this.llm.embedModel();
    const wantDim = this.llm.embedDimensions();
    const stale: Array<{ row: SqlRow; text: string; sha: string }> = [];

    for (const r of rows) {
      const text = (r.sensitivity === "private" || r.sensitivity === "confidential")
        ? String(r.title ?? "")
        : String(r.search_text || [r.title, r.body, r.evidence].filter(Boolean).join("\n"));
      const sha = await sha256Hex(`${model}\n${wantDim}\n${text}`);
      if (r.content_sha256 !== sha || r.model !== model || (wantDim > 0 && Number(r.dimensions) !== wantDim)) {
        stale.push({ row: r, text, sha });
      }
    }
    if (!stale.length) return 0;

    await this.vectors.ensureLoaded(this.connector, this.ownerId);
    const now = nowIso();
    for (let i = 0; i < stale.length; i += batch) {
      const chunk = stale.slice(i, i + batch);
      const vecs = await this.llm.embed(chunk.map((c) => c.text.slice(0, 8000)));
      if (!vecs) return 0;
      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j];
        const vec = vecs[j];
        const bytes = toFloat32Bytes(vec);
        const dim = vec.length;
        const sha = await sha256Hex(`${model}\n${dim}\n${item.text}`);
        await this.connector.transaction(async (tx) => {
          const have = await tx.query<{ entry_id: string }>(
            `SELECT entry_id FROM ${this.T("entry_embedding")} WHERE owner_id = ${this.p(1)} AND entry_id = ${this.p(2)}`,
            [this.ownerId, item.row.id],
          );
          if (have.length) {
            await tx.execute(
              `UPDATE ${this.T("entry_embedding")} SET model = ${this.p(1)}, dimensions = ${this.p(2)}, content_sha256 = ${this.p(3)}, embedding = ${this.p(4)}, updated_at = ${this.p(5)} WHERE owner_id = ${this.p(6)} AND entry_id = ${this.p(7)}`,
              [model, dim, sha, bytes, now, this.ownerId, item.row.id],
            );
          } else {
            await tx.execute(
              `INSERT INTO ${this.T("entry_embedding")} (owner_id, entry_id, model, dimensions, content_sha256, embedding, updated_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
              [this.ownerId, item.row.id, model, dim, sha, bytes, now],
            );
          }
        });
        this.vectors.set({ entryId: item.row.id, model, dimensions: dim, contentSha256: sha, vec: Float32Array.from(vec) });
      }
    }
    return stale.length;
  }

  // ---- Search, ranking & recall ----
  private async loadAllEntries(): Promise<SqlRow[]> {
    const rows = await this.connector.query<SqlRow>(
      `SELECT e.*, p.title AS project_title FROM ${this.T("entry")} e LEFT JOIN ${this.T("entry")} p ON p.owner_id = e.owner_id AND p.id = e.project WHERE e.owner_id = ${this.p(1)} ORDER BY e.project, e.pattern, e.id`,
      [this.ownerId],
    );
    return rows.map(parseEntryRow);
  }

  private async supersededMap(): Promise<Map<string, string[]>> {
    const links = await this.connector.query<{ src: string; dst: string }>(
      `SELECT src, dst FROM ${this.T("link")} WHERE owner_id = ${this.p(1)} AND type = 'supersedes' ORDER BY src`,
      [this.ownerId],
    );
    const out = new Map<string, string[]>();
    for (const l of links) {
      if (!out.has(l.dst)) out.set(l.dst, []);
      out.get(l.dst)!.push(l.src);
    }
    return out;
  }

  private async indexLines(entries: SqlRow[], supMap: Map<string, string[]>, agentScope: AgentScope, filter?: EntryFilter) {
    const allowedMap = new Map<string, SqlRow>(entries.filter((r) => canReadEntry(agentScope, r, filter)).map((r) => [r.id, r]));
    return entries
      .filter((r) => searchableProject(r) && allowedMap.has(r.id))
      .map((r) => {
        const supList = (supMap.get(r.id) ?? []).filter((src) => allowedMap.has(src));
        const supBy = supList.length ? supList.join(", ") : null;
        const title = supBy ? `~~${r.title}~~ → ${supBy}` : r.title;
        const lock = r.sensitivity === "private" ? " 🔒" : "";
        const line = `- \`${r.id}\` ${title} [${r.authority}, ${r.scope}]${lock} (${r.project_title ?? r.title})`;
        return {
          id: r.id as string,
          title: String(r.title),
          line,
          shown: `- \`${r.id}\` ${title} [${kindLabel(r, ", ")}, ${r.authority}${r.authority === "draft" ? ", unreviewed" : ""}, ${r.scope}]${lock} (${r.project_title ?? r.title})`,
          authority: String(r.authority),
          scope: String(r.scope),
          superseded: Boolean(supBy),
        };
      });
  }

  private async indexSearch(
    entries: SqlRow[],
    supMap: Map<string, string[]>,
    query: string,
    scope: string | null,
    p: Params,
    agentScope: AgentScope,
    filter?: EntryFilter,
    rawQuery?: string,
  ): Promise<ArmResult> {
    const q = tokens(query);
    const raw = tokens(rawQuery ?? query);
    const hasTask = rawQuery !== undefined && rawQuery !== query && raw.size > 0;
    const hits: Ranked[] = [];
    const scoped = new Set<string>();
    const info = new Map<string, Scoped>();

    for (const l of await this.indexLines(entries, supMap, agentScope, filter)) {
      const words = tokens(l.line + " " + l.id.replaceAll("-", " "));
      let hit = 0;
      for (const t of q) if (words.has(t)) hit += hasTask && raw.has(t) ? 2 : 1;
      if (hit) {
        let titleHit = 0;
        if (l.authority === "draft" && raw.size >= 2) {
          const tw = tokens(l.title);
          for (const t of raw) if (tw.has(t)) titleHit++;
        }
        const factor = l.authority === "draft" && !(!l.superseded && raw.size >= 2 && titleHit >= 2) ? p.indexDraftFactor : 1;
        hits.push([l.id, hit * factor, l.shown]);
        info.set(l.id, { scope: l.scope, authority: l.authority });
        if (scope && l.scope === scope && !l.superseded) scoped.add(l.id);
      }
    }
    const ranked = discount(boost(hits, scoped, p.scopeBoost), info, scope, p).slice(0, p.candidates);
    return [ranked, null, { index: scored(ranked) }];
  }

  private async keywordSearch(
    currentEntries: SqlRow[],
    query: string,
    limit: number,
  ): Promise<{ en: string[]; zh: string[]; keyword: string[] }> {
    const allowedIds = new Set(currentEntries.map((r) => r.id as string));
    const useFts = await this.useFts5();
    let en: string[];
    if (useFts && this.connector.ftsSearchEnglish) {
      const ftsHits = await this.connector.ftsSearchEnglish(query, limit * 4, this.T("entry_fts"));
      en = ftsHits.map((h) => h.id).filter((id) => allowedIds.has(id)).slice(0, limit);
    } else {
      en = bm25English(
        query,
        currentEntries.map((r) => ({ id: r.id, searchText: String(r.search_text || r.title) })),
        limit,
      ).map((h) => h.id);
    }

    let zh: string[] = [];
    let keyword = en;
    if (hasCjk(query)) {
      const terms = [...new Set(bigrams(query))];
      if (useFts && this.connector.ftsSearchChinese) {
        const ftsZh = await this.connector.ftsSearchChinese(terms, limit * 4, this.T("entry_fts_zh"));
        zh = ftsZh.map((h) => h.id).filter((id) => allowedIds.has(id)).slice(0, limit);
      } else {
        zh = bm25Chinese(
          query,
          currentEntries.map((r) => ({ id: r.id, searchText: String(r.search_text || r.title) })),
          limit,
        ).map((h) => h.id);
      }
      keyword = rrf([en, zh], undefined, 10).map(([id]) => id);
    }
    return { en, zh, keyword };
  }

  private async vectorRanks(currentEntries: SqlRow[], query: string, limit: number): Promise<[string[], string | null]> {
    if (!this.llm.embeddingsEnabled()) return [[], null];
    let vec: number[] | null;
    try {
      const res = await this.llm.embed([query]);
      vec = res?.[0] ?? null;
    } catch (e) {
      return [[], `embed-failed: ${(e as Error).name}`];
    }
    if (!vec) return [[], null];
    await this.vectors.ensureLoaded(this.connector, this.ownerId);
    const allowedIds = new Set(currentEntries.map((r) => r.id as string));
    const hits = this.vectors.search(vec, this.llm.embedModel(), allowedIds, limit);
    return [hits.map((h) => h.id), null];
  }

  private async titleMatches(currentEntries: SqlRow[], query: string, limit: number, p: Params): Promise<string[]> {
    const patterns = titlePatterns(query).slice(0, limit);
    if (patterns.length < 2) return [];
    const regexes = patterns.map((pat) => new RegExp(pat, "i"));
    await this.vectors.ensureLoaded(this.connector, this.ownerId);
    const matches: Array<{ id: string; n: number; unembedded: boolean; trial: boolean; created: string }> = [];

    for (const r of currentEntries) {
      if (!searchableProject(r)) continue;
      let count = 0;
      const title = String(r.title ?? "");
      for (const re of regexes) if (re.test(title)) count++;
      if (count >= 2) {
        const unembedded = !this.vectors.has(r.id, this.llm.embeddingsEnabled() ? this.llm.embedModel() : undefined);
        if ((p.trialItems ?? 0) > 0 || unembedded) {
          matches.push({
            id: r.id,
            n: count,
            unembedded,
            trial: Number(r.chances_left ?? 0) > 0,
            created: String(r.created_at ?? ""),
          });
        }
      }
    }
    matches.sort((a, b) =>
      b.n - a.n ||
      (a.n === patterns.length ? -1 : 1) - (b.n === patterns.length ? -1 : 1) ||
      Number(b.unembedded) - Number(a.unembedded) ||
      Number(b.trial) - Number(a.trial) ||
      (b.created < a.created ? -1 : b.created > a.created ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return matches.slice(0, limit).map((m) => m.id);
  }

  private async hybridSearch(
    allEntries: SqlRow[],
    supMap: Map<string, string[]>,
    query: string,
    scope: string | null,
    p: Params,
    agentScope: AgentScope,
    filter?: EntryFilter,
    rawQuery?: string,
  ): Promise<ArmResult> {
    const current = allEntries.filter((r) => !supMap.has(r.id) && canReadEntry(agentScope, r, filter));
    const kw = await this.keywordSearch(current, query, p.candidates);
    const [vec, degraded] = await this.vectorRanks(current, query, p.candidates);
    const eligibleTitle = await this.titleMatches(current, rawQuery ?? query, p.candidates, p);

    const lists = eligibleTitle.length ? [kw.keyword, vec, eligibleTitle] : [kw.keyword, vec];
    const weights = eligibleTitle.length ? [1, p.vecWeight, 1 + p.vecWeight] : [1, p.vecWeight];
    let fused = rrf(lists, weights, p.rrfK).map(([id, s]): Ranked => [id, s, null]);

    const byId = new Map(allEntries.map((r) => [r.id as string, r]));
    if (scope && fused.length) {
      const scoped = new Set(fused.map(([id]) => id).filter((id) => byId.get(id)?.scope === scope));
      fused = boost(fused, scoped, p.scopeBoost);
    }
    if (fused.length && ((p.otherRunFactor ?? 1) !== 1 || (p.globalAgentDraftFactor ?? 1) !== 1)) {
      const info = new Map<string, Scoped>(
        fused.map(([id]) => {
          const e = byId.get(id);
          return [id, { scope: String(e?.scope ?? "global"), authority: String(e?.authority ?? "draft") }];
        }),
      );
      fused = discount(fused, info, scope, p);
    }

    const ranked = fused.slice(0, p.candidates);
    const trace: Trace = {
      hybrid: scored(ranked),
      keyword: unscored(kw.keyword),
      vec: unscored(vec),
      ...(eligibleTitle.length ? { title: unscored(eligibleTitle) } : {}),
    };
    return [ranked, degraded, trace];
  }

  private async loadGraph(): Promise<GraphCache> {
    if (this.graphCache && Date.now() - this.graphCache.at < 60_000) return this.graphCache;
    const links = await this.connector.query<SqlRow>(
      `SELECT l.src, l.dst, l.type, l.weight, s.pattern AS sp, s.scope AS ss, s.category AS sc, s.context AS sctx, s.transferability AS str, s.project_slug AS sps, s.computer AS scomp, d.pattern AS dp, d.scope AS ds, d.category AS dc, d.context AS dctx, d.transferability AS dtr, d.project_slug AS dps, d.computer AS dcomp FROM ${this.T("link")} l JOIN ${this.T("entry")} s ON s.owner_id = l.owner_id AND s.id = l.src JOIN ${this.T("entry")} d ON d.owner_id = l.owner_id AND d.id = l.dst WHERE l.owner_id = ${this.p(1)}`,
      [this.ownerId],
    );
    const coUses = await this.connector.query<{ src: string; dst: string; sessions_json: string }>(
      `SELECT src, dst, sessions_json FROM ${this.T("co_use")} WHERE owner_id = ${this.p(1)}`,
      [this.ownerId],
    );
    const activeCoUse = new Set(
      coUses.filter((c) => fromJson<string[]>(c.sessions_json, []).length >= CO_USE_SESSIONS).map((c) => `${c.src}\0${c.dst}`),
    );
    const kept = links.filter((l) => l.type !== "co_used" || activeCoUse.has(`${l.src}\0${l.dst}`));
    const nodes = new Map<string, SqlRow>();
    for (const l of kept) {
      if (!nodes.has(l.src)) nodes.set(l.src, { pattern: l.sp, scope: l.ss, category: l.sc, context: l.sctx, transferability: l.str, project_slug: l.sps, computer: l.scomp });
      if (!nodes.has(l.dst)) nodes.set(l.dst, { pattern: l.dp, scope: l.ds, category: l.dc, context: l.dctx, transferability: l.dtr, project_slug: l.dps, computer: l.dcomp });
    }
    this.graphCache = {
      links: kept,
      superseded: new Set(kept.filter((l) => l.type === "supersedes").map((l) => String(l.dst))),
      nodes,
      edges: new Map(),
      at: Date.now(),
    };
    return this.graphCache;
  }

  private edgesUnder(g: GraphCache, typeWeights: Params["linkTypeWeights"], agentScope: AgentScope, filter?: EntryFilter): Edges {
    const out: Edges = new Map();
    const allowed = (id: string) => {
      if (!agentScope && !hasFilter(filter)) return true;
      const meta = g.nodes.get(id);
      return meta ? canReadEntry(agentScope, meta, filter) : true;
    };
    const add = (a: string, b: string, w: number) => {
      if (!allowed(a) || !allowed(b)) return;
      if (!out.has(a)) out.set(a, []);
      out.get(a)!.push([b, w]);
    };
    for (const l of g.links) {
      const w = linkTypeWeight(typeWeights, l.sp, l.type, l.dp) * Number(l.weight ?? 1);
      if (!(w > 0)) continue;
      if (l.type === "supersedes") add(l.dst, l.src, w);
      else {
        add(l.src, l.dst, w);
        add(l.dst, l.src, w);
      }
    }
    return out;
  }

  private async spreadingSearch(
    allEntries: SqlRow[],
    supMap: Map<string, string[]>,
    query: string,
    scope: string | null,
    p: Params,
    agentScope: AgentScope,
    filter?: EntryFilter,
    rawQuery?: string,
  ): Promise<ArmResult> {
    let [seedsRanked, degraded, seedTrace] = await this.hybridSearch(allEntries, supMap, query, scope, p, agentScope, filter, rawQuery);
    if (spreadKnobs(p).mode === "bestfirst") {
      const patterns = phrasePatterns(query, p.candidates * 2).map((pat) => new RegExp(pat, "i"));
      if (patterns.length) {
        const current = allEntries.filter((r) => !supMap.has(r.id) && canReadEntry(agentScope, r, filter));
        const phraseHits = current
          .filter((r) => patterns.some((re) => re.test(String(r.title)) || re.test(String(r.body))))
          .sort((a, b) => Number(patterns.some((re) => re.test(String(b.title)))) - Number(patterns.some((re) => re.test(String(a.title)))) || (a.id < b.id ? -1 : 1))
          .slice(0, p.candidates)
          .map((r) => r.id as string);
        if (phraseHits.length) {
          const top = seedsRanked.reduce((a, [, s]) => Math.max(a, s), 0) || 1;
          const seedMap = new Map(seedsRanked.map(([id, s]) => [id, s]));
          for (const id of phraseHits) seedMap.set(id, Math.max(seedMap.get(id) ?? 0, top));
          seedsRanked = [...seedMap].map(([id, s]): Ranked => [id, s, null]).sort(byScore);
          seedTrace = { ...seedTrace, phrase: unscored(phraseHits) };
        }
      }
    }

    const g = await this.loadGraph();
    const out = this.edgesUnder(g, p.linkTypeWeights, agentScope, filter);
    if (spreadKnobs(p).mode === "bestfirst") {
      const [ranked, frontier] = bestFirstRanked(out, seedsRanked, g.superseded, p);
      return [ranked, degraded, { ...seedTrace, spreading: scored(ranked) }, frontier];
    }
    const activation = spread(out, new Map(seedsRanked.map(([id, s]) => [id, s])), p.restart, p.iterations);
    const ranked = [...activation]
      .map(([id, a]): Ranked => [id, g.superseded.has(id) ? a * p.supersededFactor : a, null])
      .sort(byScore)
      .slice(0, p.candidates);
    return [ranked, degraded, { ...seedTrace, spreading: scored(ranked) }];
  }

  private async decorateRows(rows: Record<string, SqlRow>, ids: string[], supMap: Map<string, string[]>, viewer: { device?: string | null; context?: string | null; session?: string | null } | null) {
    if (!ids.length) return;
    const pq = queryBuilder(this.connector.dialect)
      .raw(`SELECT entry_id, device, agent, agent_context, repo FROM ${this.T("entry_provenance")} WHERE owner_id = `)
      .val(this.ownerId)
      .raw(" AND entry_id IN ")
      .inList(ids)
      .build();
    const provMap = new Map((await this.connector.query<SqlRow>(pq.sql, pq.params)).map((r) => [r.entry_id as string, r]));

    const bq = queryBuilder(this.connector.dialect)
      .raw(`SELECT x.entry_id, x.name, x.kind, b.size FROM ${this.T("entry_blob")} x JOIN ${this.T("blob")} b ON b.owner_id = x.owner_id AND b.sha256 = x.sha256 WHERE x.owner_id = `)
      .val(this.ownerId)
      .raw(" AND x.entry_id IN ")
      .inList(ids)
      .raw(" ORDER BY x.name")
      .build();
    const blobsByEntry = new Map<string, SqlRow[]>();
    for (const r of await this.connector.query<SqlRow>(bq.sql, bq.params)) {
      if (!blobsByEntry.has(r.entry_id)) blobsByEntry.set(r.entry_id, []);
      blobsByEntry.get(r.entry_id)!.push({ name: r.name, kind: r.kind, size: Number(r.size) });
    }

    for (const id of ids) {
      const row = rows[id];
      if (!row) continue;
      const sup = supMap.get(id);
      if (sup?.length) row.superseded_by = sup.join(", ");
      const prov = provMap.get(id);
      if (prov) {
        row.provenance = provenanceText({
          prov_device: prov.device,
          prov_agent: prov.agent,
          prov_agent_context: prov.agent_context,
          prov_repo: prov.repo,
        }, viewer);
      }
      row.artifacts = blobsByEntry.get(id) ?? [];
    }
  }

  async recall(args: {
    session: string | null;
    query: string;
    task?: string;
    agent: string;
    scope?: string | null;
    principal: string;
    surface?: string;
    depth?: string;
    agentIdentity?: AgentIdentity | null;
    filter?: EntryFilter;
  }): Promise<{ text: string; retrievalId: string; delivered: string[]; onTrial: string[] }> {
    const started = performance.now();
    const depth = args.depth ?? "packet";
    if (!DEPTHS.includes(depth)) throw new Refused(`depth must be packet or deep, not ${JSON.stringify(depth)}.`);
    if (args.filter?.category && !CATEGORY_RE.test(args.filter.category.trim().toLowerCase())) {
      throw new Refused("category must be 1 to 40 lowercase letters, digits or dashes.");
    }
    if (args.filter?.context && !["all", ...ENTRY_CONTEXTS].includes(args.filter.context.trim().toLowerCase())) {
      throw new Refused("context filter must be general, work, home, hobby, personal or all.");
    }
    if (args.filter?.project && !normalizeProjectSlug(args.filter.project)) {
      throw new Refused("project filter must be a valid project slug.");
    }
    if (args.filter?.transferability && !(TRANSFERABILITIES as readonly string[]).includes(args.filter.transferability.trim().toLowerCase())) {
      throw new Refused("transferability filter must be general, context, project or computer.");
    }

    const set = await this.pickArmParamSet();
    const p = set.params;
    const request = args.task ? `${args.task}\n${args.query}`.trim() : args.query;
    const allEntries = await this.loadAllEntries();
    const supMap = await this.supersededMap();
    const agentScope = agentScopeOf(args.agentIdentity);

    const [ranked, armDegraded, trace, frontier] = set.arm === "index"
      ? await this.indexSearch(allEntries, supMap, request, args.scope ?? null, p, agentScope, args.filter, args.query)
      : set.arm === "hybrid"
      ? await this.hybridSearch(allEntries, supMap, request, args.scope ?? null, p, agentScope, args.filter, args.query)
      : await this.spreadingSearch(allEntries, supMap, request, args.scope ?? null, p, agentScope, args.filter, args.query);

    const byId = new Map(allEntries.map((r) => [r.id as string, r]));
    const windowIds = ranked.slice(0, p.tiltWindow).map(([id]) => id);
    const seqNow = await this.getClock();
    const knobs = temperatureKnobsFrom(p);

    const writtenMap = new Map<string, number>();
    for (const [id] of ranked) {
      const r = byId.get(id);
      if (r) writtenMap.set(id, Number(r.written_seq ?? 0));
    }

    let feedbackRows: Array<{ retrieval_id: string; entry_id: string; source: string; verdict: string; seq: number }> = [];
    let openRows: Array<{ session_id: string; entry_id: string; seq: number }> = [];
    if (ranked.length) {
      const allIds = ranked.map(([id]) => id);
      const fq = queryBuilder(this.connector.dialect)
        .raw(`SELECT retrieval_id, entry_id, source, verdict, seq FROM ${this.T("feedback")} WHERE owner_id = `)
        .val(this.ownerId)
        .raw(" AND entry_id IN ")
        .inList(allIds)
        .build();
      feedbackRows = await this.connector.query(fq.sql, fq.params);

      const evRows = await this.connector.query<{ session_id: string; payload_json: string; seq: number }>(
        `SELECT session_id, payload_json, seq FROM ${this.T("event")} WHERE owner_id = ${this.p(1)} AND event = 'get_entry'`,
        [this.ownerId],
      );
      openRows = evRows.map((ev) => ({
        session_id: String(ev.session_id ?? ""),
        entry_id: String(fromJson<SqlRow>(ev.payload_json, {}).entry_id ?? ""),
        seq: Number(ev.seq ?? 0),
      })).filter((o) => o.entry_id && allIds.includes(o.entry_id));
    }

    const clock = computeTemperatureAndAge(writtenMap, feedbackRows, openRows, seqNow, knobs);
    const rel = relevanceOf(ranked);
    const confMap = new Map(windowIds.flatMap((id) => byId.has(id) ? [[id, Number(byId.get(id)!.confidence)]] : []));
    const chancesMap = new Map(windowIds.flatMap((id) => byId.has(id) ? [[id, Number(byId.get(id)!.chances_left)]] : []));

    const tilted = ranked
      .filter(([id]) => (confMap.get(id) ?? 1) >= p.dormant)
      .map(([id, score, line]): Ranked => [
        id,
        finalScore(
          {
            armScore: score,
            relevance: rel.get(id) ?? 0,
            confidence: confMap.get(id) ?? null,
            temperature: clock.temperature.get(id) ?? null,
            age: clock.age.get(id) ?? null,
          },
          p,
        ),
        line,
      ])
      .sort(byScore);

    const candidateRows: Record<string, SqlRow> = {};
    for (const [id] of tilted.slice(0, p.rowWindow)) {
      const r = byId.get(id);
      if (r && canReadEntry(agentScope, r, args.filter)) candidateRows[id] = { ...r };
    }
    const viewer = { device: args.principal, context: args.agentIdentity?.context ?? null, session: args.session };
    await this.decorateRows(candidateRows, Object.keys(candidateRows), supMap, viewer);

    const toJudge = tilted.slice(0, p.filterK).filter(([id]) => id in candidateRows || tilted.find(([tid]) => tid === id)?.[2] !== null);
    let kept = tilted;
    const rejected: string[] = [];
    const judgedMap = new Map<string, number>();
    let degraded = armDegraded;

    if (toJudge.length && this.config.judge.relevance_filter === "llm") {
      try {
        const items = toJudge.map(([id, , line]) => {
          const row = candidateRows[id];
          const text = line ?? (row ? `${row.title}. ${row.sensitivity === "normal" ? row.body : ""}`.trim() : id);
          return { id, text };
        });
        const probs = await this.llm.judgeRelevance(request, items);
        if (probs) {
          probs.forEach((pr, i) => judgedMap.set(items[i].id, pr));
          const pass = new Set(items.filter((_, i) => probs[i] >= p.filterThreshold).map((it) => it.id));
          kept = toJudge.filter(([id]) => pass.has(id));
          for (const [id] of toJudge) if (!pass.has(id)) rejected.push(id);
        }
      } catch (err) {
        degraded = [degraded, `filter-failed: ${(err as Error).name}`].filter(Boolean).join("; ");
      }
    }

    const trialCap = p.trialItems ?? 0;
    const trialFloor = p.trialFloor ?? 0;
    const mainList: Ranked[] = [];
    const onTrialCandidates: Ranked[] = [];
    if (trialCap > 0) {
      for (const item of kept) {
        if ((chancesMap.get(item[0]) ?? 0) > 0) {
          if (onTrialCandidates.length < trialCap && (rel.get(item[0]) ?? 0) >= trialFloor) onTrialCandidates.push(item);
        } else {
          mainList.push(item);
        }
      }
    } else {
      mainList.push(...kept);
    }

    const [delivered, chunks] = packEntries(mainList, candidateRows, p, this.ownerLabel);
    const onTrial = onTrialCandidates.map(([id]) => id).filter((id) => id in candidateRows);

    const rid = randomUUID();
    const latencyMs = Math.round(performance.now() - started);
    const candidatesIds = ranked.map(([id]) => id);
    const ctxPayload: SqlRow = {
      c_now: clock.cNow,
      candidates: features(tilted, trace, confMap, judgedMap, rel, clock),
      ...(frontier?.length ? { frontier } : {}),
    };

    const nextSeq = await this.connector.transaction(async (tx) => {
      const seq = await this.tickClock(tx);
      for (const id of onTrial) {
        await tx.execute(
          `UPDATE ${this.T("entry")} SET chances_left = CASE WHEN chances_left > 0 THEN chances_left - 1 ELSE 0 END WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
          [this.ownerId, id],
        );
      }
      await tx.execute(
        `INSERT INTO ${this.T("retrieval")} (id, owner_id, mcp_session, agent, surface, scope, query, task, arm, param_set, candidates_json, delivered_json, on_trial_json, rejected_json, context_json, frontier_json, degraded, latency_ms, llm_tokens, seq, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, ${this.p(10)}, ${this.p(11)}, ${this.p(12)}, ${this.p(13)}, ${this.p(14)}, ${this.p(15)}, ${this.p(16)}, ${this.p(17)}, ${this.p(18)}, 0, ${this.p(19)}, ${this.p(20)})`,
        [
          rid, this.ownerId, args.session, args.agent, args.surface ?? "mcp", args.scope ?? null, args.query,
          args.task ?? "", set.arm, set.id, toJson(candidatesIds), toJson(delivered), toJson(onTrial),
          toJson(rejected), toJson(ctxPayload), frontier?.length ? toJson(frontier) : null, degraded,
          latencyMs, seq, nowIso(),
        ],
      );
      return seq;
    });
    void nextSeq;

    const head = `retrieval ${rid}${degraded ? ` [degraded: ${degraded}]` : ""}\n\n`;
    let packetText: string;
    if (!chunks.length && !onTrial.length) {
      packetText = head + `Nothing in memory matches. Call recall_more with this retrieval id to dig deeper, then ask ${this.ownerLabel} rather than guessing.`;
    } else {
      const parts: string[] = [];
      if (chunks.length) parts.push(chunks.join("\n\n"));
      if (onTrial.length) {
        const trialBlocks = onTrial.map((id, i) => {
          const left = Math.max(0, (chancesMap.get(id) ?? 1) - 1);
          return renderTrialItem(i + 1, candidateRows[id], left, this.ownerLabel);
        });
        parts.push(`On trial (rate these in feedback too):\n\n${trialBlocks.join("\n\n")}`);
      }
      packetText = head + parts.join("\n\n") + `\n\n${feedbackFooter(rid)}`;
    }

    if (depth === "deep" && args.session) {
      const deeper = await this.recallMore(rid, args.session, args.agentIdentity);
      packetText = `${packetText}\n\n${deeper.text}`;
    }

    return { text: packetText, retrievalId: rid, delivered, onTrial };
  }

  async recallMore(retrievalId: string, session: string, agentIdentity?: AgentIdentity | null) {
    const rows = await this.connector.query<SqlRow>(
      `SELECT id, mcp_session, query, task, param_set, candidates_json, delivered_json, on_trial_json, frontier_json FROM ${this.T("retrieval")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, retrievalId],
    );
    const r = rows[0];
    if (!r) throw new Refused(`No retrieval ${retrievalId}.`);
    if (r.mcp_session !== session) throw new Refused("recall_more only pages recalls from this session.");

    const pSet = await this.loadParamSet(r.param_set);
    const p = pSet.params;
    const allEntries = await this.loadAllEntries();
    const supMap = await this.supersededMap();
    const byId = new Map(allEntries.map((e) => [e.id as string, e]));
    const agentScope = agentScopeOf(agentIdentity);

    const candidates = fromJson<string[]>(r.candidates_json, []);
    const frontier = fromJson<Frontier | null>(r.frontier_json, null);
    const seen = new Set<string>([
      ...fromJson<string[]>(r.delivered_json, []),
      ...fromJson<string[]>(r.on_trial_json, []),
    ]);

    // Walk prior pages chained via `scope = 'more:<root_id>'`.
    const priorPages = await this.connector.query<{ delivered_json: string }>(
      `SELECT delivered_json FROM ${this.T("retrieval")} WHERE owner_id = ${this.p(1)} AND mcp_session = ${this.p(2)} AND scope = ${this.p(3)} ORDER BY created_at`,
      [this.ownerId, session, `more:${retrievalId}`],
    );
    for (const pr of priorPages) for (const id of fromJson<string[]>(pr.delivered_json, [])) seen.add(id);

    const pool = [...candidates];
    const have = new Set(pool);
    const add = (id: string) => {
      if (!have.has(id)) {
        have.add(id);
        pool.push(id);
      }
    };

    if (frontier?.length) {
      const g = await this.loadGraph();
      const out = this.edgesUnder(g, p.linkTypeWeights, agentScope);
      const allowedFrontier = frontier.filter(([id]) => {
        const m = g.nodes.get(id);
        return m ? canReadEntry(agentScope, m) : true;
      });
      const k = spreadKnobs(p);
      const { best } = bestFirst(out, new Map(allowedFrontier), k.maxHops, k.minPath, SPREAD.frontierCap);
      [...best].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).forEach(([id]) => add(id));
    }

    const request = r.task ? `${r.task}\n${r.query}`.trim() : String(r.query);
    const hiddenDocs = allEntries.filter(
      (e) => searchableProject(e) && canReadEntry(agentScope, e) && (e.confidence < p.dormant || supMap.has(e.id)),
    );
    for (const h of bm25English(request, hiddenDocs.map((e) => ({ id: e.id, searchText: String(e.search_text || e.title) })), p.candidates)) add(h.id);
    if (hasCjk(request)) {
      for (const h of bm25Chinese(request, hiddenDocs.map((e) => ({ id: e.id, searchText: String(e.search_text || e.title) })), p.candidates)) add(h.id);
    }

    const unseen = pool.filter((id) => !seen.has(id));
    const window = unseen.slice(0, p.packetItems * 3);
    const rowMap: Record<string, SqlRow> = {};
    for (const id of window) {
      const e = byId.get(id);
      if (e && canReadEntry(agentScope, e)) rowMap[id] = { ...e };
    }
    await this.decorateRows(rowMap, Object.keys(rowMap), supMap, { device: agentIdentity?.principal ?? null, context: agentIdentity?.context ?? null, session });

    const delivered: string[] = [];
    const chunks: string[] = [];
    let used = 0;
    const startNum = seen.size + 1;
    for (const id of window) {
      if (!(id in rowMap)) continue;
      let chunk = renderDeepItem(startNum + delivered.length, rowMap[id], p, this.ownerLabel);
      let cost = estimateTokens(chunk);
      if (used + cost > p.packetTokens) {
        if (delivered.length) break;
        chunk = clip(chunk, p.packetTokens);
        cost = estimateTokens(chunk);
      }
      delivered.push(id);
      chunks.push(chunk);
      used += cost;
      if (delivered.length === p.packetItems) break;
    }

    const after = delivered.length ? unseen.slice(unseen.indexOf(delivered.at(-1)!) + 1) : [];
    const left = after.filter((id) => !window.includes(id) || id in rowMap).length;
    const page = { delivered, chunks, left: delivered.length ? left : 0, capped: candidates.length >= p.candidates };

    if (!delivered.length) {
      return { text: `Deeper in memory, past ${retrievalId}.\n\n${closingLine(page, retrievalId, p)}`, delivered: [] };
    }

    const pageId = randomUUID();
    const seq = await this.getClock();
    await this.connector.execute(
      `INSERT INTO ${this.T("retrieval")} (id, owner_id, mcp_session, agent, surface, scope, query, task, arm, param_set, candidates_json, delivered_json, on_trial_json, rejected_json, context_json, degraded, latency_ms, llm_tokens, seq, learned_at, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, 'mcp', ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, '[]', ${this.p(10)}, '[]', '[]', ${this.p(11)}, NULL, 0, 0, ${this.p(12)}, ${this.p(13)}, ${this.p(14)})`,
      [pageId, this.ownerId, session, agentIdentity?.name ?? "agent", `more:${retrievalId}`, r.query, r.task, pSet.arm, pSet.id, toJson(delivered), toJson({ parent: retrievalId }), seq, nowIso(), nowIso()],
    );

    const text = `retrieval ${pageId}\n\n${PAGE_HEAD}\n\n${chunks.join("\n\n")}\n\n${closingLine(page, retrievalId, p)}\n\n${feedbackFooter(pageId)}`;
    return { text, delivered, retrievalId: pageId };
  }

  async getEntry(id: string, agentIdentity?: AgentIdentity | null, session?: string | null, principal?: string | null): Promise<string | null> {
    const rows = await this.connector.query<SqlRow>(
      `SELECT e.*, s.title AS source_title, s.uri AS source_uri FROM ${this.T("entry")} e LEFT JOIN ${this.T("source")} s ON s.owner_id = e.owner_id AND s.id = e.source_id WHERE e.owner_id = ${this.p(1)} AND e.id = ${this.p(2)}`,
      [this.ownerId, id],
    );
    if (!rows.length) return null;
    const row = parseEntryRow(rows[0]);
    const scope = agentScopeOf(agentIdentity);
    if (!canReadEntry(scope, row)) throw new Refused(accessDeniedReason(scope, row));

    const supMap = await this.supersededMap();
    const rowMap: Record<string, SqlRow> = { [id]: row };
    await this.decorateRows(rowMap, [id], supMap, { device: principal ?? null, context: agentIdentity?.context ?? null, session: session ?? null });

    const outLinks = await this.connector.query<SqlRow>(
      `SELECT '→' AS dir, l.type, l.dst AS other, e.title, e.category, e.context, e.transferability, e.project_slug, e.computer, e.pattern, e.scope FROM ${this.T("link")} l JOIN ${this.T("entry")} e ON e.owner_id = l.owner_id AND e.id = l.dst WHERE l.owner_id = ${this.p(1)} AND l.src = ${this.p(2)}`,
      [this.ownerId, id],
    );
    const inLinks = await this.connector.query<SqlRow>(
      `SELECT '←' AS dir, l.type, l.src AS other, e.title, e.category, e.context, e.transferability, e.project_slug, e.computer, e.pattern, e.scope FROM ${this.T("link")} l JOIN ${this.T("entry")} e ON e.owner_id = l.owner_id AND e.id = l.src WHERE l.owner_id = ${this.p(1)} AND l.dst = ${this.p(2)}`,
      [this.ownerId, id],
    );
    const links = [...outLinks, ...inLinks]
      .filter((l) => canReadEntry(scope, l))
      .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : a.other < b.other ? -1 : 1));

    const blobs = await this.connector.query<SqlRow>(
      `SELECT x.name, x.sha256, x.kind, b.media_type, b.size FROM ${this.T("entry_blob")} x JOIN ${this.T("blob")} b ON b.owner_id = x.owner_id AND b.sha256 = x.sha256 WHERE x.owner_id = ${this.p(1)} AND x.entry_id = ${this.p(2)} ORDER BY x.name`,
      [this.ownerId, id],
    );

    // Record get_entry event on current recall clock so learner & temperature pick it up.
    if (session) {
      const seq = await this.getClock();
      await this.connector.execute(
        `INSERT INTO ${this.T("event")} (owner_id, event, session_id, agent, device, payload_json, seq, received_at) VALUES (${this.p(1)}, 'get_entry', ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
        [this.ownerId, session, agentIdentity?.name ?? "agent", principal ?? "local", toJson({ entry_id: id }), seq, nowIso()],
      );
    }
    return renderEntry(rowMap[id], links, blobs, this.ownerLabel);
  }

  async readBlob(sha: string, agentIdentity?: AgentIdentity | null): Promise<{ media_type: string; size: number; stored: string; content: Uint8Array | null; public: boolean } | null> {
    if (!SHA_RE.test(sha.toLowerCase())) return null;
    const clean = sha.toLowerCase();
    const rows = await this.connector.query<SqlRow>(
      `SELECT b.sha256, b.media_type, b.size, b.content, b.stored, e.sensitivity, e.category, e.context, e.transferability, e.project_slug, e.computer, e.pattern, e.scope FROM ${this.T("blob")} b LEFT JOIN ${this.T("entry_blob")} x ON x.owner_id = b.owner_id AND x.sha256 = b.sha256 LEFT JOIN ${this.T("entry")} e ON e.owner_id = x.owner_id AND e.id = x.entry_id WHERE b.owner_id = ${this.p(1)} AND b.sha256 = ${this.p(2)}`,
      [this.ownerId, clean],
    );
    if (!rows.length) return null;
    const scope = agentScopeOf(agentIdentity);
    const hasPublic = rows.some((r) => (!r.sensitivity || r.sensitivity !== "private") && (!r.pattern || canReadEntry(scope, r)));
    const first = rows[0];
    let content: Uint8Array | null = null;
    if (first.stored === "db" && first.content) {
      content = first.content instanceof Uint8Array ? first.content : new Uint8Array(first.content);
    } else if (first.stored === "storage" && this.blobs.storageOn()) {
      content = await this.blobs.get(clean, "final");
    }
    return {
      media_type: String(first.media_type),
      size: Number(first.size),
      stored: String(first.stored),
      content,
      public: hasPublic,
    };
  }

  async createUploadSlot(principal: string, sha256: string, size: number, mediaType = "application/octet-stream"): Promise<{ uploadPath: string; token: string }> {
    const clean = sha256.toLowerCase();
    if (!SHA_RE.test(clean)) throw new Refused("sha256 must be 64 hex digits.");
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.blobs.maxBlobBytes) {
      throw new Refused(`size must be 1 to ${this.blobs.maxBlobBytes} bytes.`);
    }
    const mt = mediaType.toLowerCase();
    if (!MEDIA_TYPE_RE.test(mt)) throw new Refused("Invalid media_type.");
    if (!this.blobs.storageOn()) throw new Refused("External file upload requires blobs.backend = 'fs'. Send small artifacts inline.");

    await this.connector.transaction(async (tx) => {
      const existing = await tx.query<{ sha256: string }>(
        `SELECT sha256 FROM ${this.T("upload")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND sha256 = ${this.p(3)}`,
        [this.ownerId, principal, clean],
      );
      if (existing.length) {
        await tx.execute(
          `UPDATE ${this.T("upload")} SET size = ${this.p(1)}, media_type = ${this.p(2)}, created_at = ${this.p(3)} WHERE owner_id = ${this.p(4)} AND principal = ${this.p(5)} AND sha256 = ${this.p(6)}`,
          [size, mt, nowIso(), this.ownerId, principal, clean],
        );
      } else {
        await tx.execute(
          `INSERT INTO ${this.T("upload")} (owner_id, principal, sha256, size, media_type, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)})`,
          [this.ownerId, principal, clean, size, mt, nowIso()],
        );
      }
    });
    const token = this.blobs.createUploadToken({ sha256: clean, size, media_type: mt });
    return { uploadPath: `/blobs/upload/${token}`, token };
  }

  // ---- Feedback & learning ----
  async unratedRecalls(session: string | null): Promise<string[]> {
    if (!session) return [];
    const rows = await this.connector.query<{ id: string }>(
      `SELECT r.id FROM ${this.T("retrieval")} r WHERE r.owner_id = ${this.p(1)} AND r.mcp_session = ${this.p(2)} AND NOT EXISTS (SELECT 1 FROM ${this.T("feedback")} f WHERE f.owner_id = r.owner_id AND f.retrieval_id = r.id) ORDER BY r.created_at DESC LIMIT ${this.p(3)}`,
      [this.ownerId, session, REMIND_MAX],
    );
    return rows.map((r) => r.id);
  }

  async pendingFeedbackNote(session: string | null): Promise<string> {
    const rids = await this.unratedRecalls(session);
    return rids.length ? `\n\n${reminderLine(rids)}` : "";
  }

  async recordFeedback(args: Record<string, unknown>, session: string | null, source = "agent"): Promise<string> {
    const rid = typeof args.retrieval_id === "string" ? args.retrieval_id.trim() : "";
    if (!rid) return "Not logged: retrieval_id is required.";
    const rows = await this.connector.query<{ id: string; mcp_session: string | null; delivered_json: string; on_trial_json: string }>(
      `SELECT id, mcp_session, delivered_json, on_trial_json FROM ${this.T("retrieval")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, rid],
    );
    const r = rows[0];
    if (!r) return `Not logged: no retrieval ${rid}.`;
    if (source === "agent" && session && r.mcp_session !== session) return "Not logged: another session made that recall.";

    const existing = await this.connector.query<{ id: number }>(
      `SELECT id FROM ${this.T("feedback")} WHERE owner_id = ${this.p(1)} AND retrieval_id = ${this.p(2)} AND source = ${this.p(3)} LIMIT 1`,
      [this.ownerId, rid, source],
    );
    if (existing.length) return `Not logged: feedback for ${rid} was already logged.`;

    const shown = [...fromJson<string[]>(r.delivered_json, []), ...fromJson<string[]>(r.on_trial_json, [])];
    const checked = checkFeedback(args, shown);
    if ("error" in checked) return checked.error;

    const note = typeof args.note === "string" && args.note.trim() ? redactText(args.note.trim().slice(0, NOTE_MAX))[0] : null;
    const seq = await this.getClock();
    const now = nowIso();
    await this.connector.transaction(async (tx) => {
      for (let i = 0; i < checked.rows.length; i++) {
        const item = checked.rows[i];
        await tx.execute(
          `INSERT INTO ${this.T("feedback")} (owner_id, retrieval_id, entry_id, source, verdict, note, seq, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)})`,
          [this.ownerId, rid, item.entry_id, source, item.verdict, i === 0 ? note : null, seq, now],
        );
      }
    });
    return "Logged.";
  }

  async learn(limit = 40): Promise<{ learned: number; pushback: number; helpful: number; no_reaction: number; waiting: number; failed: number }> {
    const pending = await this.connector.query<SqlRow>(
      `SELECT r.*, s.harness_session_id FROM ${this.T("retrieval")} r LEFT JOIN ${this.T("mcp_session")} s ON s.owner_id = r.owner_id AND s.id = r.mcp_session WHERE r.owner_id = ${this.p(1)} AND r.learned_at IS NULL ORDER BY r.created_at LIMIT ${this.p(2)}`,
      [this.ownerId, limit],
    );
    const done = { learned: 0, pushback: 0, helpful: 0, no_reaction: 0, waiting: 0, failed: 0 };
    let linked = false;

    for (const r of pending) {
      const delivered = fromJson<string[]>(r.delivered_json, []);
      const rejected = fromJson<string[]>(r.rejected_json, []);
      const onTrial = fromJson<string[]>(r.on_trial_json, []);
      const shown = [...delivered, ...onTrial];

      let nextPrompt: { id: number; prompt: string } | null = null;
      if (r.harness_session_id) {
        const cutoff = new Date(Date.parse(r.created_at) + WAIT_MINUTES * 60_000).toISOString();
        const evs = await this.connector.query<{ id: number; payload_json: string }>(
          `SELECT id, payload_json FROM ${this.T("event")} WHERE owner_id = ${this.p(1)} AND session_id = ${this.p(2)} AND event = 'UserPromptSubmit' AND received_at > ${this.p(3)} AND received_at < ${this.p(4)} ORDER BY received_at LIMIT 1`,
          [this.ownerId, r.harness_session_id, r.created_at, cutoff],
        );
        if (evs[0]) {
          const pr = fromJson<SqlRow>(evs[0].payload_json, {}).prompt;
          if (typeof pr === "string" && pr.trim()) nextPrompt = { id: Number(evs[0].id), prompt: pr };
        }
      }

      const ageMs = Date.now() - Date.parse(r.created_at);
      if (!nextPrompt && ageMs < WAIT_MINUTES * 60_000) {
        done.waiting++;
        continue;
      }

      let reactionRead: { pushback: boolean; p: number; cause: string | null } | null = null;
      if (nextPrompt && shown.length) {
        const eq = queryBuilder(this.connector.dialect)
          .raw(`SELECT id, title, body, sensitivity FROM ${this.T("entry")} WHERE owner_id = `)
          .val(this.ownerId)
          .raw(" AND id IN ")
          .inList(shown)
          .build();
        const entryRows = await this.connector.query<SqlRow>(eq.sql, eq.params);
        const ordered = shown.flatMap((id) => entryRows.filter((e) => e.id === id));
        reactionRead = await this.llm.classifyPushback(
          nextPrompt.prompt,
          ordered.map((e) => ({ id: e.id, text: e.sensitivity === "normal" ? `${e.title}. ${e.body ?? ""}` : String(e.title) })),
        );
      }

      const named = new Map<string, Outcome>();
      const fbRows = await this.connector.query<{ entry_id: string | null; verdict: string; source: string }>(
        `SELECT entry_id, verdict, source FROM ${this.T("feedback")} WHERE owner_id = ${this.p(1)} AND retrieval_id = ${this.p(2)} ORDER BY id`,
        [this.ownerId, r.id],
      );
      for (const f of fbRows) {
        if (f.source === "agent" && f.entry_id && shown.includes(f.entry_id) && FEEDBACK_SAYS[f.verdict]) {
          named.set(f.entry_id, FEEDBACK_SAYS[f.verdict]);
        }
      }
      const cardRow = [...fbRows].reverse().find((f) => f.source === "card");
      const cardVote: CardVote = cardRow?.verdict === "helpful" || cardRow?.verdict === "nothing_useful" ? cardRow.verdict : null;

      const opened = new Set<string>();
      if (r.mcp_session && shown.length) {
        const cutoff = new Date(Date.parse(r.created_at) + WAIT_MINUTES * 60_000).toISOString();
        const evs = await this.connector.query<{ payload_json: string }>(
          `SELECT payload_json FROM ${this.T("event")} WHERE owner_id = ${this.p(1)} AND session_id = ${this.p(2)} AND event = 'get_entry' AND received_at > ${this.p(3)} AND received_at < ${this.p(4)}`,
          [this.ownerId, r.mcp_session, r.created_at, cutoff],
        );
        for (const ev of evs) {
          const eid = fromJson<SqlRow>(ev.payload_json, {}).entry_id;
          if (typeof eid === "string" && shown.includes(eid)) opened.add(eid);
        }
      }

      const blamed = reactionRead?.pushback && reactionRead.cause && shown.includes(reactionRead.cause) ? reactionRead.cause : null;
      const outcomes = outcomesOf({ shown, named, opened, blamed, cardVote });
      const pSet = await this.loadParamSet(r.param_set);
      const sizes: Steps & { dormant: number } = {
        trialStep: pSet.params.trialStep ?? STEPS.trialStep,
        settledStep: pSet.params.settledStep ?? STEPS.settledStep,
        dormant: pSet.params.dormant ?? DORMANT,
      };
      const confirmed = new Set(
        fbRows.filter((f) => (f.source === "user" || f.source === "owner") && f.entry_id && (f.verdict === "used" || f.verdict === "helpful")).map((f) => f.entry_id!),
      );
      const used = shown.filter((id) => outcomes.get(id) === "used" || confirmed.has(id));

      await this.connector.transaction(async (tx) => {
        const now = nowIso();
        const setConf = async (id: string, nextFn: (c: number) => number, reason: string) => {
          const rows = await tx.query<{ confidence: number }>(
            `SELECT confidence FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
            [this.ownerId, id],
          );
          if (!rows.length) return;
          const before = Number(rows[0].confidence);
          const after = Math.min(1, Math.max(0, nextFn(before)));
          if (Math.abs(after - before) < 1e-6) return;
          await tx.execute(
            `UPDATE ${this.T("entry")} SET confidence = ${this.p(1)}, updated_at = ${this.p(2)} WHERE owner_id = ${this.p(3)} AND id = ${this.p(4)}`,
            [after, now, this.ownerId, id],
          );
          await tx.execute(
            `INSERT INTO ${this.T("confidence_log")} (owner_id, target, before_val, after_val, reason, retrieval_id, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
            [this.ownerId, `entry:${id}`, before, after, reason, r.id, now],
          );
        };

        const moveLinks = async (among: string[], touching: string | null, up: boolean) => {
          if (among.length < 2) return;
          const lq = queryBuilder(this.connector.dialect)
            .raw(`SELECT src, dst, type, weight FROM ${this.T("link")} WHERE owner_id = `)
            .val(this.ownerId)
            .raw(" AND src IN ")
            .inList(among)
            .raw(" AND dst IN ")
            .inList(among)
            .raw(" AND type NOT IN ('part_of', 'co_used')")
            .build();
          for (const l of await tx.query<SqlRow>(lq.sql, lq.params)) {
            if (touching !== null && l.src !== touching && l.dst !== touching) continue;
            const w = Number(l.weight ?? 1);
            const after = up ? Math.min(LINK_CAP, w + LINK_UP) : Math.max(LINK_FLOOR, w * LINK_DOWN);
            if (Math.abs(after - w) < 1e-6) continue;
            await tx.execute(
              `UPDATE ${this.T("link")} SET weight = ${this.p(1)} WHERE owner_id = ${this.p(2)} AND src = ${this.p(3)} AND dst = ${this.p(4)} AND type = ${this.p(5)}`,
              [after, this.ownerId, l.src, l.dst, l.type],
            );
            await tx.execute(
              `INSERT INTO ${this.T("confidence_log")} (owner_id, target, before_val, after_val, reason, retrieval_id, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
              [this.ownerId, `link:${l.src}|${l.type}|${l.dst}`, w, after, up ? "walked in a helpful recall" : "behind pushback", r.id, now],
            );
            linked = true;
          }
        };

        for (const id of rejected) {
          const mr = await tx.query<{ miss_streak: number }>(
            `SELECT miss_streak FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
            [this.ownerId, id],
          );
          if (!mr.length) continue;
          const streak = Number(mr[0].miss_streak ?? 0) + 1;
          await tx.execute(
            `UPDATE ${this.T("entry")} SET miss_streak = ${this.p(1)} WHERE owner_id = ${this.p(2)} AND id = ${this.p(3)}`,
            [streak, this.ownerId, id],
          );
          if (streak > MISS_FREE) await setConf(id, (c) => c * MISS_EASE, "judged irrelevant again");
        }
        if (delivered.length) {
          const rq = queryBuilder(this.connector.dialect)
            .raw(`UPDATE ${this.T("entry")} SET miss_streak = 0 WHERE owner_id = `)
            .val(this.ownerId)
            .raw(" AND id IN ")
            .inList(delivered)
            .build();
          await tx.execute(rq.sql, rq.params);
        }

        if (reactionRead?.pushback) {
          if (blamed && delivered.includes(blamed)) await moveLinks(delivered, blamed, false);
        } else if (reactionRead) {
          for (const id of delivered) {
            await setConf(id, (c) => (c < sizes.dormant ? c : Math.min(CAP, c + REINFORCE)), "served, no pushback");
          }
          await moveLinks(delivered, null, true);
        }

        for (const [id, outcome] of outcomes) {
          const trial = onTrial.includes(id);
          const fromCard = !named.has(id) && !opened.has(id) && id !== blamed && cardVote !== null;
          const why = id === blamed && outcome === "wrong"
            ? `${this.ownerLabel} pushed back on it`
            : fromCard
            ? (cardVote === "helpful" ? "the recall card was rated helpful" : "the recall card was rated not useful")
            : OUTCOME_WHY[outcome];
          await setConf(id, (c) => step({ confidence: c, trial }, outcome, sizes), `${trial ? "on trial: " : ""}${why}`);
        }

        // Co-use strengthening and fading.
        if (await this.applyCoUse(tx, r, shown, used)) linked = true;

        await tx.execute(
          `UPDATE ${this.T("retrieval")} SET learned_at = ${this.p(1)}, reaction_json = ${this.p(2)} WHERE owner_id = ${this.p(3)} AND id = ${this.p(4)}`,
          [
            now,
            toJson(reactionRead && nextPrompt ? { pushback: reactionRead.pushback, p: reactionRead.p, cause: reactionRead.cause, event_id: nextPrompt.id } : { none: true }),
            this.ownerId,
            r.id,
          ],
        );
      });

      done.learned++;
      if (!reactionRead) done.no_reaction++;
      else if (reactionRead.pushback) done.pushback++;
      else done.helpful++;
    }
    if (linked) this.forgetGraph();
    return done;
  }

  private async applyCoUse(tx: SqlConnection, r: SqlRow, shown: string[], used: string[]): Promise<boolean> {
    const pairs = coPairs(used);
    const session = String(r.mcp_session ?? r.id);
    const now = nowIso();
    let changed = pairs.length > 0;

    const strengthen = async (src: string, dst: string, why: string) => {
      const lRows = await tx.query<{ weight: number }>(
        `SELECT weight FROM ${this.T("link")} WHERE owner_id = ${this.p(1)} AND src = ${this.p(2)} AND dst = ${this.p(3)} AND type = 'co_used'`,
        [this.ownerId, src, dst],
      );
      const before = lRows[0] ? Number(lRows[0].weight ?? 0) : 0;
      const after = coUsed(before);
      if (lRows.length) {
        await tx.execute(
          `UPDATE ${this.T("link")} SET weight = ${this.p(1)} WHERE owner_id = ${this.p(2)} AND src = ${this.p(3)} AND dst = ${this.p(4)} AND type = 'co_used'`,
          [after, this.ownerId, src, dst],
        );
      } else {
        await tx.execute(
          `INSERT INTO ${this.T("link")} (owner_id, src, dst, type, weight) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, 'co_used', ${this.p(4)})`,
          [this.ownerId, src, dst, after],
        );
      }
      const cuRows = await tx.query<{ sessions_json: string; uses: number }>(
        `SELECT sessions_json, uses FROM ${this.T("co_use")} WHERE owner_id = ${this.p(1)} AND src = ${this.p(2)} AND dst = ${this.p(3)}`,
        [this.ownerId, src, dst],
      );
      if (cuRows.length) {
        const sessions = fromJson<string[]>(cuRows[0].sessions_json, []);
        if (!sessions.includes(session) && sessions.length < CO_USE.sessions) sessions.push(session);
        await tx.execute(
          `UPDATE ${this.T("co_use")} SET sessions_json = ${this.p(1)}, uses = ${this.p(2)}, misses = 0, updated_at = ${this.p(3)} WHERE owner_id = ${this.p(4)} AND src = ${this.p(5)} AND dst = ${this.p(6)}`,
          [toJson(sessions), Number(cuRows[0].uses ?? 0) + 1, now, this.ownerId, src, dst],
        );
      } else {
        await tx.execute(
          `INSERT INTO ${this.T("co_use")} (owner_id, src, dst, sessions_json, uses, misses, updated_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, 1, 0, ${this.p(5)})`,
          [this.ownerId, src, dst, toJson([session]), now],
        );
      }
      if (Math.abs(after - before) >= 1e-6) {
        await tx.execute(
          `INSERT INTO ${this.T("confidence_log")} (owner_id, target, before_val, after_val, reason, retrieval_id, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
          [this.ownerId, `link:${src}|co_used|${dst}`, lRows.length ? before : null, after, why, r.id, now],
        );
      }
    };

    for (const [a, b] of pairs) await strengthen(a, b, "used together");
    if (pairs.length) {
      const ends = [...new Set(pairs.flat())];
      const pq = queryBuilder(this.connector.dialect)
        .raw(`SELECT e.id, e.project FROM ${this.T("entry")} e WHERE e.owner_id = `)
        .val(this.ownerId)
        .raw(" AND e.id IN ")
        .inList(ends)
        .build();
      const projMap = new Map((await tx.query<{ id: string; project: string }>(pq.sql, pq.params)).map((x) => [x.id, x.project]));
      const across = new Set<string>();
      for (const [a, b] of pairs) {
        const pa = projMap.get(a), pb = projMap.get(b);
        if (pa && pb && pa !== pb) across.add(pa < pb ? `${pa}\n${pb}` : `${pb}\n${pa}`);
      }
      for (const k of across) {
        const [pa, pb] = k.split("\n");
        await strengthen(pa, pb, "their entries were used together");
      }
    }

    if (r.seq === null || r.seq === undefined || !shown.length) return changed;
    const keep = new Set(pairs.map(([a, b]) => `${a}\0${b}`));
    const cq = queryBuilder(this.connector.dialect)
      .raw(`SELECT src, dst, misses FROM ${this.T("co_use")} WHERE owner_id = `)
      .val(this.ownerId)
      .raw(" AND (src IN ")
      .inList(shown)
      .raw(" OR dst IN ")
      .inList(shown)
      .raw(")")
      .build();
    for (const c of await tx.query<{ src: string; dst: string; misses: number }>(cq.sql, cq.params)) {
      if (keep.has(`${c.src}\0${c.dst}`)) continue;
      const nextMiss = Number(c.misses ?? 0) + 1 >= CO_USE.fadeEvery ? 0 : Number(c.misses ?? 0) + 1;
      await tx.execute(
        `UPDATE ${this.T("co_use")} SET misses = ${this.p(1)}, updated_at = ${this.p(2)} WHERE owner_id = ${this.p(3)} AND src = ${this.p(4)} AND dst = ${this.p(5)}`,
        [nextMiss, now, this.ownerId, c.src, c.dst],
      );
      if (nextMiss === 0) {
        const lRows = await tx.query<{ weight: number }>(
          `SELECT weight FROM ${this.T("link")} WHERE owner_id = ${this.p(1)} AND src = ${this.p(2)} AND dst = ${this.p(3)} AND type = 'co_used'`,
          [this.ownerId, c.src, c.dst],
        );
        if (!lRows.length) continue;
        const before = Number(lRows[0].weight ?? 0);
        const after = faded(before);
        if (after <= 1e-6) {
          await tx.execute(
            `DELETE FROM ${this.T("link")} WHERE owner_id = ${this.p(1)} AND src = ${this.p(2)} AND dst = ${this.p(3)} AND type = 'co_used'`,
            [this.ownerId, c.src, c.dst],
          );
        } else {
          await tx.execute(
            `UPDATE ${this.T("link")} SET weight = ${this.p(1)} WHERE owner_id = ${this.p(2)} AND src = ${this.p(3)} AND dst = ${this.p(4)} AND type = 'co_used'`,
            [after, this.ownerId, c.src, c.dst],
          );
        }
        await tx.execute(
          `INSERT INTO ${this.T("confidence_log")} (owner_id, target, before_val, after_val, reason, retrieval_id, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
          [this.ownerId, `link:${c.src}|co_used|${c.dst}`, before, after, `shown ${CO_USE.fadeEvery} times without being used together`, r.id, now],
        );
        changed = true;
      }
    }
    return changed;
  }

  // ---- Messages ----
  async postMessage(sender: string, rawTo: unknown, rawBody: unknown, opts?: { context?: unknown; project?: unknown }) {
    const to = typeof rawTo === "string" ? rawTo.trim().toLowerCase() : "";
    const body = typeof rawBody === "string" ? rawBody.replace(CONTROL, " ").trim() : "";
    if (!to || (!AGENT_NAME.test(to) && to !== "all")) throw new Refused("to must be a lowercase agent handle or all.");
    if (!body) throw new Refused("body is required.");
    if (body.length > 2000) throw new Refused(`Message body is ${body.length} characters. The limit is 2000.`);

    const targetContext = typeof opts?.context === "string" && opts.context.trim() ? opts.context.trim().toLowerCase() : null;
    if (targetContext && !["work", "home", "hobby", "personal", "both", "all"].includes(targetContext)) {
      throw new Refused("Invalid message context filter.");
    }
    const targetProject = opts?.project !== undefined && opts?.project !== null && opts?.project !== ""
      ? normalizeProjectSlug(opts.project)
      : null;
    if (opts?.project !== undefined && opts?.project !== null && opts?.project !== "" && !targetProject) {
      throw new Refused("Invalid message project filter.");
    }

    const cleanBody = redactText(body)[0];
    if (sender !== "owner" && sender !== "memory") {
      const why = await this.llm.screenWrite(cleanBody);
      if (why) throw new Refused(`Message refused: ${why}`);
    }

    const now = nowIso();
    return await this.connector.transaction(async (tx) => {
      const res = await tx.execute(
        `INSERT INTO ${this.T("message")} (owner_id, sender, recipient, body, target_context, target_project, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)})`,
        [this.ownerId, sender, to, cleanBody, targetContext, targetProject, now],
      );
      let id = Number(res.lastInsertId ?? 0);
      if (!id) {
        const rows = await tx.query<{ id: number }>(
          `SELECT id FROM ${this.T("message")} WHERE owner_id = ${this.p(1)} ORDER BY id DESC LIMIT 1`,
          [this.ownerId],
        );
        id = Number(rows[0]?.id ?? 0);
      }

      let targets: string[] = [];
      if (to === "all") {
        const agents = await tx.query<{ name: string; context: string; projects_json: string; repos_json: string }>(
          `SELECT name, context, projects_json, repos_json FROM ${this.T("agent")} WHERE owner_id = ${this.p(1)}`,
          [this.ownerId],
        );
        targets = agents
          .filter((a) => {
            if (a.name === sender) return false;
            const projs = [...new Set([...fromJson<string[]>(a.projects_json, []), ...fromJson<string[]>(a.repos_json, [])])];
            return messageAgentMatches({ name: a.name, context: a.context, projects: projs }, targetContext, targetProject);
          })
          .map((a) => a.name);
        if (!targets.includes(sender) && targets.length === 0) targets = [];
      } else {
        targets = [to];
      }

      for (const target of targets) {
        await tx.execute(
          `INSERT INTO ${this.T("message_delivery")} (owner_id, message_id, agent_name, attempts) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, 0)`,
          [this.ownerId, id, target],
        );
      }
      return { id, to, targets, created_at: now };
    });
  }

  async checkMessages(agent: string) {
    const rows = await this.connector.query<SqlRow>(
      `SELECT m.id, m.sender, m.recipient, m.body, m.created_at, d.delivered_at, d.acked_at FROM ${this.T("message_delivery")} d JOIN ${this.T("message")} m ON m.owner_id = d.owner_id AND m.id = d.message_id WHERE d.owner_id = ${this.p(1)} AND d.agent_name = ${this.p(2)} AND d.acked_at IS NULL AND d.dismissed_at IS NULL ORDER BY m.id`,
      [this.ownerId, agent],
    );
    const now = nowIso();
    for (const r of rows) {
      await this.connector.execute(
        `UPDATE ${this.T("message_delivery")} SET delivered_at = COALESCE(delivered_at, ${this.p(1)}), attempts = attempts + 1 WHERE owner_id = ${this.p(2)} AND message_id = ${this.p(3)} AND agent_name = ${this.p(4)}`,
        [now, this.ownerId, r.id, agent],
      );
    }
    return rows.map((r) => ({ id: Number(r.id), sender: r.sender, to: r.recipient, body: r.body, created_at: r.created_at }));
  }

  async ackMessages(agent: string, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const q = queryBuilder(this.connector.dialect)
      .raw(`UPDATE ${this.T("message_delivery")} SET acked_at = `)
      .val(nowIso())
      .raw(" WHERE owner_id = ")
      .val(this.ownerId)
      .raw(" AND agent_name = ")
      .val(agent)
      .raw(" AND message_id IN ")
      .inList(ids)
      .build();
    const res = await this.connector.execute(q.sql, q.params);
    return res.rowsAffected;
  }

  async dismissMessages(agent: string, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const q = queryBuilder(this.connector.dialect)
      .raw(`UPDATE ${this.T("message_delivery")} SET dismissed_at = `)
      .val(nowIso())
      .raw(" WHERE owner_id = ")
      .val(this.ownerId)
      .raw(" AND agent_name = ")
      .val(agent)
      .raw(" AND message_id IN ")
      .inList(ids)
      .build();
    const res = await this.connector.execute(q.sql, q.params);
    return res.rowsAffected;
  }

  // ---- Quests ----
  async postQuest(who: AgentIdentity, args: Record<string, unknown>) {
    const errs: string[] = [];
    const field = (v: unknown, name: string, max: number, req = true) => {
      if (v !== undefined && v !== null && typeof v !== "string") {
        errs.push(`${name} must be text.`);
        return "";
      }
      const t = (typeof v === "string" ? v : "").replace(CONTROL, " ").trim();
      if (req && !t) errs.push(`${name} is required.`);
      if (t.length > max) errs.push(`${name} is ${t.length} characters. The most is ${max}.`);
      return t;
    };

    const title = redactText(field(args.title, "title", 120))[0];
    const brief = redactText(field(args.brief, "brief", 500))[0];
    const doneWhen = redactText(field(args.done_when, "done_when", 300))[0];
    const priority = typeof args.priority === "string" && args.priority.trim() ? args.priority.trim().toLowerCase() : "normal";
    if (!PRIORITIES.includes(priority)) errs.push(`priority must be one of ${PRIORITIES.join(", ")}.`);

    const context = typeof args.context === "string" && args.context.trim() ? args.context.trim().toLowerCase() : (who.context ?? "both");
    if (!(AGENT_CONTEXTS as readonly string[]).includes(context)) errs.push(`context must be one of ${AGENT_CONTEXTS.join(", ")}.`);

    const assignee = typeof args.for === "string" && args.for.trim() ? args.for.trim().toLowerCase() : "any";
    const tags = Array.isArray(args.tags) ? [...new Set(args.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 8) : [];
    const { target, errs: tErrs } = parseQuestTarget(args.target);
    errs.push(...tErrs);

    const project = args.project ? normalizeProjectSlug(args.project) : (target.repo ?? null);
    if (args.project && !project) errs.push("Invalid quest project slug.");
    const computer = args.computer ? normalizeComputer(args.computer) : (target.device ?? null);
    const agentType = typeof args.agent_type === "string" && args.agent_type.trim() ? args.agent_type.trim().toLowerCase() : null;
    if (agentType && !(AGENT_TYPES as readonly string[]).includes(agentType)) errs.push("Invalid agent_type.");

    const rawArts = Array.isArray(args.artifacts) ? args.artifacts : [];
    if (rawArts.length > 8) errs.push("A quest takes at most 8 artifacts.");

    if (errs.length) throw new Refused(errs.join("\n"));

    const why = await this.llm.screenWrite(`${title}\n${brief}\n${doneWhen}`);
    if (why) throw new Refused(`Not posted: ${why}`);

    const now = nowIso();
    const id = await this.connector.transaction(async (tx) => {
      const res = await tx.execute(
        `INSERT INTO ${this.T("quest")} (owner_id, title, brief, done_when, priority, context, project, computer, agent_type, assignee, target_json, tags_json, status, poster, created_at, updated_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, ${this.p(10)}, ${this.p(11)}, ${this.p(12)}, 'open', ${this.p(13)}, ${this.p(14)}, ${this.p(15)})`,
        [this.ownerId, title, brief, doneWhen, priority, context, project, computer, agentType, assignee, toJson(target), toJson(tags), who.name, now, now],
      );
      let qid = Number(res.lastInsertId ?? 0);
      if (!qid) {
        const rows = await tx.query<{ id: number }>(
          `SELECT id FROM ${this.T("quest")} WHERE owner_id = ${this.p(1)} ORDER BY id DESC LIMIT 1`,
          [this.ownerId],
        );
        qid = Number(rows[0]?.id ?? 0);
      }
      for (const art of rawArts as SqlRow[]) {
        if (typeof art?.name === "string" && typeof art?.sha256 === "string" && SHA_RE.test(art.sha256)) {
          await tx.execute(
            `INSERT INTO ${this.T("quest_blob")} (owner_id, quest_id, name, sha256) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)})`,
            [this.ownerId, qid, art.name, art.sha256.toLowerCase()],
          );
        }
      }
      return qid;
    });
    return { id, title, priority, status: "open" };
  }

  async reopenExpiredQuests(conn: SqlConnection = this.connector): Promise<number> {
    const now = nowIso();
    const res = await conn.execute(
      `UPDATE ${this.T("quest")} SET status = 'open', claimed_by = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ${this.p(1)} WHERE owner_id = ${this.p(2)} AND status = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ${this.p(3)}`,
      [now, this.ownerId, now],
    );
    return res.rowsAffected;
  }

  async listQuests(who: AgentIdentity, args: Record<string, unknown> = {}) {
    await this.reopenExpiredQuests();
    const show = typeof args.show === "string" && ["open", "mine", "done", "all"].includes(args.show) ? args.show : "open";
    const tag = typeof args.tag === "string" && args.tag.trim() ? args.tag.trim().toLowerCase() : null;
    const project = typeof args.project === "string" && args.project.trim() ? args.project.trim().toLowerCase() : null;
    const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20) || 20));

    const rows = await this.connector.query<SqlRow>(
      `SELECT * FROM ${this.T("quest")} WHERE owner_id = ${this.p(1)} ORDER BY id DESC`,
      [this.ownerId],
    );
    const qAgent = whoToQuestAgent(who);

    const parsed: SqlRow[] = rows.map((r): SqlRow => ({
      ...r,
      id: Number(r.id),
      target: fromJson<Record<string, unknown>>(r.target_json, {}),
      tags: fromJson<string[]>(r.tags_json, []),
    }));

    const filtered = parsed.filter((q) => {
      if (show === "open" && q.status !== "open") return false;
      if (show === "mine" && q.claimed_by !== who.name && q.poster !== who.name) return false;
      if (show === "done" && q.status !== "done") return false;
      if (tag && !(q.tags as string[]).includes(tag)) return false;
      const m = questMatches(qAgent, q, { project, checkAssignee: show === "open" });
      return m.ok;
    });

    filtered.sort((a, b) =>
      (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
    );
    return filtered.slice(0, limit);
  }

  async claimQuest(who: AgentIdentity, rawId: unknown, leaseMinutes?: unknown): Promise<SqlRow> {
    const id = Number(typeof rawId === "string" ? rawId.replace("#", "").trim() : rawId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Refused("Need the quest's id, like 12, from list_quests.");
    const mins = leaseMinutes === undefined || leaseMinutes === null ? LEASE_DEFAULT : Number(leaseMinutes);
    if (!Number.isSafeInteger(mins) || mins < LEASE_MIN || mins > LEASE_MAX) {
      throw new Refused(`lease_minutes must be a whole number from ${LEASE_MIN} to ${LEASE_MAX}.`);
    }

    const qAgent = whoToQuestAgent(who);
    return await this.connector.transaction(async (tx) => {
      await this.reopenExpiredQuests(tx);
      const rows = await tx.query<SqlRow>(
        `SELECT * FROM ${this.T("quest")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
        [this.ownerId, id],
      );
      if (!rows.length) throw new Refused(`No quest #${id}.`);
      const q: SqlRow = { ...rows[0], id: Number(rows[0].id), target: fromJson(rows[0].target_json, {}), tags: fromJson(rows[0].tags_json, []) };
      const match = questMatches(qAgent, q, { checkAssignee: true });
      if (!match.ok) throw new Refused(`Cannot claim quest #${id}: ${match.reason}.`);

      const now = nowIso();
      const leaseUntil = new Date(Date.now() + mins * 60_000).toISOString();
      const res = await tx.execute(
        `UPDATE ${this.T("quest")} SET status = 'claimed', claimed_by = ${this.p(1)}, claimed_at = ${this.p(2)}, lease_until = ${this.p(3)}, updated_at = ${this.p(4)} WHERE owner_id = ${this.p(5)} AND id = ${this.p(6)} AND status = 'open'`,
        [who.name, now, leaseUntil, now, this.ownerId, id],
      );
      if (res.rowsAffected !== 1) {
        throw new Refused(`Quest #${id} is already claimed by ${q.claimed_by ?? "another agent"} or no longer open.`);
      }
      const notes = await tx.query<SqlRow>(
        `SELECT author, note, created_at FROM ${this.T("quest_note")} WHERE owner_id = ${this.p(1)} AND quest_id = ${this.p(2)} ORDER BY id`,
        [this.ownerId, id],
      );
      return { ...q, status: "claimed", claimed_by: who.name, claimed_at: now, lease_until: leaseUntil, notes };
    });
  }

  async updateQuest(who: AgentIdentity, rawId: unknown, rawNote: unknown) {
    const id = Number(typeof rawId === "string" ? rawId.replace("#", "").trim() : rawId);
    const note = typeof rawNote === "string" ? redactText(rawNote.replace(CONTROL, " ").trim())[0] : "";
    if (!Number.isSafeInteger(id) || id <= 0) throw new Refused("Need the quest's id.");
    if (!note || note.length > 2000) throw new Refused("note is required (1-2000 chars).");
    const why = await this.llm.screenWrite(note);
    if (why) throw new Refused(`Update refused: ${why}`);

    const now = nowIso();
    const leaseUntil = new Date(Date.now() + LEASE_DEFAULT * 60_000).toISOString();
    await this.connector.transaction(async (tx) => {
      const rows = await tx.query<SqlRow>(
        `SELECT status, claimed_by FROM ${this.T("quest")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
        [this.ownerId, id],
      );
      if (!rows.length) throw new Refused(`No quest #${id}.`);
      if (rows[0].status !== "claimed" || rows[0].claimed_by !== who.name) {
        throw new Refused(`Only the claiming agent (${rows[0].claimed_by ?? "none"}) can update quest #${id}.`);
      }
      await tx.execute(
        `INSERT INTO ${this.T("quest_note")} (owner_id, quest_id, author, note, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)})`,
        [this.ownerId, id, who.name, note, now],
      );
      await tx.execute(
        `UPDATE ${this.T("quest")} SET lease_until = ${this.p(1)}, updated_at = ${this.p(2)} WHERE owner_id = ${this.p(3)} AND id = ${this.p(4)}`,
        [leaseUntil, now, this.ownerId, id],
      );
    });
    return { id, lease_until: leaseUntil };
  }

  async completeQuest(who: AgentIdentity, rawId: unknown, rawEvidence: unknown, entryId: unknown) {
    const id = Number(typeof rawId === "string" ? rawId.replace("#", "").trim() : rawId);
    const evidence = typeof rawEvidence === "string" ? redactText(rawEvidence.replace(CONTROL, " ").trim())[0] : "";
    const eid = typeof entryId === "string" ? entryId.trim() : "";
    if (!Number.isSafeInteger(id) || id <= 0) throw new Refused("Need the quest's id.");
    if (!evidence || evidence.length > 2000) throw new Refused("evidence is required (1-2000 chars).");
    if (!eid) throw new Refused("entry_id is required.");

    const why = await this.llm.screenWrite(evidence);
    if (why) throw new Refused(`Not completed: ${why}`);

    const entryRows = await this.connector.query<{ id: string }>(
      `SELECT id FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, eid],
    );
    if (!entryRows.length) throw new Refused(`Entry ${eid} does not exist.`);

    const questRows = await this.connector.query<SqlRow>(
      `SELECT * FROM ${this.T("quest")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, id],
    );
    const q = questRows[0];
    if (!q) throw new Refused(`No quest #${id}.`);
    if (q.status !== "claimed" || q.claimed_by !== who.name) {
      throw new Refused(`Only ${q.claimed_by ?? "its claimer"} can complete quest #${id}.`);
    }

    const now = nowIso();
    await this.connector.execute(
      `UPDATE ${this.T("quest")} SET status = 'done', evidence = ${this.p(1)}, entry_id = ${this.p(2)}, lease_until = NULL, updated_at = ${this.p(3)} WHERE owner_id = ${this.p(4)} AND id = ${this.p(5)}`,
      [evidence, eid, now, this.ownerId, id],
    );

    // Record history note linked to entry_id.
    const histBody = `Done when: ${q.done_when}\nResult: ${evidence}`.slice(0, 500);
    await this.remember(
      {
        pattern: "observations",
        title: `Quest #${id} done: ${q.title}`,
        body: histBody,
        authority: "observed",
        scope: "global",
        evidence_kind: "memory",
        evidence: evidence.slice(0, 500),
        project: q.project ?? `notes-${who.name}`,
        links: [{ type: "relates", to: eid }],
        source: { kind: "quest", title: `Quest #${id}` },
      },
      "runtime",
      who.name,
      who.principal,
      { agent: who.name, context: who.context, session: who.session },
    ).catch(() => {});

    return { id, status: "done", entry_id: eid };
  }

  async abandonQuest(who: AgentIdentity, rawId: unknown, rawReason: unknown) {
    const id = Number(typeof rawId === "string" ? rawId.replace("#", "").trim() : rawId);
    const reason = typeof rawReason === "string" ? redactText(rawReason.replace(CONTROL, " ").trim())[0] : "";
    if (!Number.isSafeInteger(id) || id <= 0) throw new Refused("Need the quest's id.");
    if (!reason || reason.length > 500) throw new Refused("reason is required (1-500 chars).");

    const now = nowIso();
    return await this.connector.transaction(async (tx) => {
      const rows = await tx.query<SqlRow>(
        `SELECT status, claimed_by, poster FROM ${this.T("quest")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
        [this.ownerId, id],
      );
      const q = rows[0];
      if (!q) throw new Refused(`No quest #${id}.`);
      if (q.status === "claimed" && q.claimed_by === who.name) {
        await tx.execute(
          `UPDATE ${this.T("quest")} SET status = 'open', claimed_by = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ${this.p(1)} WHERE owner_id = ${this.p(2)} AND id = ${this.p(3)}`,
          [now, this.ownerId, id],
        );
        await tx.execute(
          `INSERT INTO ${this.T("quest_note")} (owner_id, quest_id, author, note, created_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)})`,
          [this.ownerId, id, who.name, `Released quest: ${reason}`, now],
        );
        return { id, status: "open" };
      }
      if (q.status === "open" && q.poster === who.name) {
        await tx.execute(
          `UPDATE ${this.T("quest")} SET status = 'abandoned', close_reason = ${this.p(1)}, updated_at = ${this.p(2)} WHERE owner_id = ${this.p(3)} AND id = ${this.p(4)}`,
          [reason, now, this.ownerId, id],
        );
        return { id, status: "abandoned" };
      }
      throw new Refused(`Cannot abandon quest #${id}.`);
    });
  }

  // ---- Hooks & Board ----
  async recordHookEvent(event: string, payload: SqlRow, agent: string | null, device: string, mode: "full" | "metadata" = "full") {
    const clean = mode === "metadata"
      ? Object.fromEntries(["session_id", "cwd", "git_remote", "hook_event_name", "tool_name", "matcher", "source", "reason"].filter((k) => k in payload).map((k) => [k, payload[k]]))
      : redact(payload);
    const seq = await this.getClock();
    await this.connector.execute(
      `INSERT INTO ${this.T("event")} (owner_id, event, session_id, agent, device, cwd, git_remote, tool_name, payload_json, seq, received_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)}, ${this.p(5)}, ${this.p(6)}, ${this.p(7)}, ${this.p(8)}, ${this.p(9)}, ${this.p(10)}, ${this.p(11)})`,
      [
        this.ownerId,
        event,
        clean.session_id ? String(clean.session_id) : null,
        agent,
        device,
        clean.cwd ? String(clean.cwd) : null,
        clean.git_remote ? String(clean.git_remote) : null,
        clean.tool_name ? String(clean.tool_name) : null,
        toJson(clean),
        seq,
        nowIso(),
      ],
    );
  }

  async hasRegisteredAgent(principal: string, agentHint: string): Promise<boolean> {
    const bindings = await this.connector.query<{ agent_name: string }>(
      `SELECT agent_name FROM ${this.T("agent_binding")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)}`,
      [this.ownerId, principal],
    );
    if (bindings.length) return true;
    const direct = await this.connector.query<{ name: string }>(
      `SELECT name FROM ${this.T("agent")} WHERE owner_id = ${this.p(1)} AND name = ${this.p(2)}`,
      [this.ownerId, agentHint],
    );
    return direct.length > 0;
  }

  async boardSummary(principal: string, agent: string, when: "start" | "prompt"): Promise<string> {
    const lines: string[] = [];
    const msgs = await this.connector.query<SqlRow>(
      `SELECT m.id, m.sender, m.body FROM ${this.T("message_delivery")} d JOIN ${this.T("message")} m ON m.owner_id = d.owner_id AND m.id = d.message_id WHERE d.owner_id = ${this.p(1)} AND d.agent_name = ${this.p(2)} AND d.acked_at IS NULL AND d.dismissed_at IS NULL ORDER BY m.id LIMIT 3`,
      [this.ownerId, agent],
    );
    for (const m of msgs) {
      const line = `Message #${m.id} from ${m.sender}: ${String(m.body).replace(/\s+/g, " ").trim()}`;
      lines.push(line.length <= MAX_LINE ? line : line.slice(0, MAX_LINE - 1) + "…");
    }

    if (when === "start" || lines.length < 5) {
      await this.reopenExpiredQuests();
      const quests = await this.connector.query<SqlRow>(
        `SELECT id, title, priority FROM ${this.T("quest")} WHERE owner_id = ${this.p(1)} AND status = 'open' ORDER BY id DESC LIMIT 5`,
        [this.ownerId],
      );
      for (const q of quests) {
        if (lines.length >= 5) break;
        const line = `Quest #${q.id} [${q.priority}]: ${q.title}`;
        lines.push(line.length <= MAX_LINE ? line : line.slice(0, MAX_LINE - 1) + "…");
      }
    }

    const now = nowIso();
    const seen = await this.connector.query<{ seen_at: string }>(
      `SELECT seen_at FROM ${this.T("board_seen")} WHERE owner_id = ${this.p(1)} AND principal = ${this.p(2)} AND agent = ${this.p(3)}`,
      [this.ownerId, principal, agent],
    );
    if (seen.length) {
      await this.connector.execute(
        `UPDATE ${this.T("board_seen")} SET seen_at = ${this.p(1)} WHERE owner_id = ${this.p(2)} AND principal = ${this.p(3)} AND agent = ${this.p(4)}`,
        [now, this.ownerId, principal, agent],
      );
    } else {
      await this.connector.execute(
        `INSERT INTO ${this.T("board_seen")} (owner_id, principal, agent, seen_at) VALUES (${this.p(1)}, ${this.p(2)}, ${this.p(3)}, ${this.p(4)})`,
        [this.ownerId, principal, agent, now],
      );
    }

    return lines.length ? lines.join("\n") + "\n" : "";
  }

  async promptNudge(payload: SqlRow, agent: string | null, _device: string, mode: "full" | "metadata"): Promise<string> {
    const sid = payload.session_id ? String(payload.session_id) : null;
    let prevCwd: string | null = null;
    let idleMs: number | null = null;
    let sinceRetrievalMs: number | null = null;
    let lastRetrievalText: string | null = null;

    if (sid) {
      const evs = await this.connector.query<{ cwd: string | null; received_at: string }>(
        `SELECT cwd, received_at FROM ${this.T("event")} WHERE owner_id = ${this.p(1)} AND session_id = ${this.p(2)} AND event = 'UserPromptSubmit' ORDER BY id DESC LIMIT 2`,
        [this.ownerId, sid],
      );
      const prev = evs[1];
      if (prev) {
        prevCwd = prev.cwd ?? null;
        idleMs = Date.now() - Date.parse(prev.received_at);
      }
      const sessRows = await this.connector.query<{ id: string }>(
        `SELECT id FROM ${this.T("mcp_session")} WHERE owner_id = ${this.p(1)} AND harness_session_id = ${this.p(2)} ORDER BY created_at DESC LIMIT 1`,
        [this.ownerId, sid],
      );
      if (sessRows[0]) {
        const ret = await this.connector.query<{ query: string; task: string | null; created_at: string }>(
          `SELECT query, task, created_at FROM ${this.T("retrieval")} WHERE owner_id = ${this.p(1)} AND mcp_session = ${this.p(2)} ORDER BY created_at DESC LIMIT 1`,
          [this.ownerId, sessRows[0].id],
        );
        if (ret[0]) {
          sinceRetrievalMs = Date.now() - Date.parse(ret[0].created_at);
          lastRetrievalText = `${ret[0].query} ${ret[0].task ?? ""}`.trim();
        }
      }
    }
    void agent;
    return classifyPromptShift({
      prompt: payload.prompt,
      cwd: payload.cwd,
      hooksMode: mode,
      prevCwd,
      idleMs,
      sinceRetrievalMs,
      lastRetrievalText,
    });
  }

  // ---- Workspace & Admin Queries ----
  async listEntries(opts?: { q?: string; pattern?: string; context?: string; limit?: number; offset?: number }) {
    const all = await this.loadAllEntries();
    const supMap = await this.supersededMap();
    const qLower = opts?.q?.trim().toLowerCase() ?? "";
    const filtered = all.filter((e) => {
      if (opts?.pattern && e.pattern !== opts.pattern) return false;
      if (opts?.context && e.context !== opts.context) return false;
      if (qLower && !`${e.title} ${e.body} ${e.id}`.toLowerCase().includes(qLower)) return false;
      return true;
    }).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));

    const off = Math.max(0, Number(opts?.offset ?? 0));
    const lim = Math.min(200, Math.max(1, Number(opts?.limit ?? 50)));
    return {
      total: filtered.length,
      items: filtered.slice(off, off + lim).map((e) => ({
        id: e.id,
        pattern: e.pattern,
        title: e.title,
        body: e.body,
        authority: e.authority,
        scope: e.scope,
        kind: e.kind,
        confidence: e.confidence,
        chances_left: e.chances_left,
        category: e.category,
        context: e.context,
        transferability: e.transferability,
        project_slug: e.project_slug,
        computer: e.computer,
        superseded_by: supMap.get(e.id) ?? [],
        valid_from: e.valid_from,
        created_at: e.created_at,
        updated_at: e.updated_at,
      })),
    };
  }

  async updateEntryFields(id: string, patch: { title?: string; body?: string; authority?: string; context?: string; transferability?: string }) {
    const existing = await this.connector.query<SqlRow>(
      `SELECT * FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`,
      [this.ownerId, id],
    );
    if (!existing.length) return null;
    const cur = existing[0];
    const title = patch.title ? redactText(patch.title.trim())[0] : String(cur.title);
    const body = patch.body ? redactText(patch.body.trim())[0] : String(cur.body);
    const authority = patch.authority && AUTHORITY.has(patch.authority) ? patch.authority : String(cur.authority);
    const context = patch.context && (ENTRY_CONTEXTS as readonly string[]).includes(patch.context) ? patch.context : String(cur.context);
    const transferability = patch.transferability && (TRANSFERABILITIES as readonly string[]).includes(patch.transferability)
      ? patch.transferability
      : String(cur.transferability);
    const now = nowIso();
    const searchText = [title, body, cur.evidence].filter(Boolean).join("\n");

    await this.connector.transaction(async (tx) => {
      await tx.execute(
        `UPDATE ${this.T("entry")} SET title = ${this.p(1)}, body = ${this.p(2)}, authority = ${this.p(3)}, context = ${this.p(4)}, transferability = ${this.p(5)}, search_text = ${this.p(6)}, updated_at = ${this.p(7)} WHERE owner_id = ${this.p(8)} AND id = ${this.p(9)}`,
        [title, body, authority, context, transferability, searchText, now, this.ownerId, id],
      );
      await this.indexFts(tx, id, searchText);
    });
    return { id, title, body, authority, context, transferability, updated_at: now };
  }

  async deleteEntry(id: string): Promise<boolean> {
    let removed = false;
    await this.connector.transaction(async (tx) => {
      await tx.execute(`DELETE FROM ${this.T("link")} WHERE owner_id = ${this.p(1)} AND (src = ${this.p(2)} OR dst = ${this.p(3)})`, [this.ownerId, id, id]);
      await tx.execute(`DELETE FROM ${this.T("entry_blob")} WHERE owner_id = ${this.p(1)} AND entry_id = ${this.p(2)}`, [this.ownerId, id]);
      await tx.execute(`DELETE FROM ${this.T("entry_provenance")} WHERE owner_id = ${this.p(1)} AND entry_id = ${this.p(2)}`, [this.ownerId, id]);
      await tx.execute(`DELETE FROM ${this.T("entry_embedding")} WHERE owner_id = ${this.p(1)} AND entry_id = ${this.p(2)}`, [this.ownerId, id]);
      await this.dropFts(tx, id);
      const res = await tx.execute(`DELETE FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} AND id = ${this.p(2)}`, [this.ownerId, id]);
      removed = res.rowsAffected > 0;
    });
    if (removed) {
      this.vectors.delete(id);
      this.forgetGraph();
    }
    return removed;
  }

  async graphData() {
    const entries = await this.connector.query<SqlRow>(
      `SELECT id, title, pattern, confidence, scope, context FROM ${this.T("entry")} WHERE owner_id = ${this.p(1)} ORDER BY updated_at DESC LIMIT 200`,
      [this.ownerId],
    );
    const ids = new Set(entries.map((e) => e.id as string));
    const links = await this.connector.query<SqlRow>(
      `SELECT src, dst, type, weight FROM ${this.T("link")} WHERE owner_id = ${this.p(1)}`,
      [this.ownerId],
    );
    return {
      nodes: entries.map((e) => ({ id: e.id, title: e.title, pattern: e.pattern, confidence: Number(e.confidence), scope: e.scope, context: e.context })),
      edges: links.filter((l) => ids.has(l.src) && ids.has(l.dst)).map((l) => ({ src: l.src, dst: l.dst, type: l.type, weight: Number(l.weight) })),
    };
  }

  async listAgents() {
    return await this.connector.query<SqlRow>(
      `SELECT name, nickname, context, surface, description, projects_json, repos_json, computer, agent_type, strict_projects, updated_at FROM ${this.T("agent")} WHERE owner_id = ${this.p(1)} ORDER BY name`,
      [this.ownerId],
    );
  }

  async listAllMessages(limit = 50) {
    return await this.connector.query<SqlRow>(
      `SELECT id, sender, recipient, body, target_context, target_project, created_at FROM ${this.T("message")} WHERE owner_id = ${this.p(1)} ORDER BY id DESC LIMIT ${this.p(2)}`,
      [this.ownerId, limit],
    );
  }

  async stats() {
    const count = async (t: string) => {
      const r = await this.connector.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.T(t)} WHERE owner_id = ${this.p(1)}`, [this.ownerId]);
      return Number(r[0]?.n ?? 0);
    };
    const [entries, links, blobs, agents, messages, quests, retrievals, events, embedded] = await Promise.all([
      count("entry"),
      count("link"),
      count("blob"),
      count("agent"),
      count("message"),
      count("quest"),
      count("retrieval"),
      count("event"),
      count("entry_embedding"),
    ]);
    return {
      connector: this.connector.name,
      dialect: this.connector.dialect,
      fts5: await this.useFts5(),
      embeddings: this.llm.embeddingsEnabled() ? this.llm.embedModel() : "off",
      clock: await this.getClock(),
      counts: { entries, links, blobs, agents, messages, quests, retrievals, events, embedded },
    };
  }

  // ---- Maintenance ----
  async runMaintenance(eventRetentionDays = 180): Promise<{ reopenedQuests: number; sweptUploads: number; purgedEvents: number }> {
    const reopenedQuests = await this.reopenExpiredQuests();
    const sweptUploads = await this.blobs.sweepIncoming(7200);
    const cutoff = new Date(Date.now() - Math.max(1, eventRetentionDays) * 86_400_000).toISOString();
    const ev = await this.connector.execute(
      `DELETE FROM ${this.T("event")} WHERE owner_id = ${this.p(1)} AND received_at < ${this.p(2)}`,
      [this.ownerId, cutoff],
    );
    return { reopenedQuests, sweptUploads, purgedEvents: ev.rowsAffected };
  }

  // ---- Portable NDJSON Export & Import ----
  async exportNdjson(): Promise<string> {
    const lines: string[] = [];
    for (const table of EXPORT_TABLES) {
      const rows = await this.connector.query<SqlRow>(`SELECT * FROM ${this.T(table)}`);
      for (const row of rows) {
        if (row.content instanceof Uint8Array) {
          row.content = { base64: Buffer.from(row.content).toString("base64") };
        }
        if (row.embedding instanceof Uint8Array) {
          row.embedding = { base64: Buffer.from(row.embedding).toString("base64") };
        }
        lines.push(JSON.stringify({ table, row }));
      }
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  async importNdjson(ndjson: string): Promise<{ imported: number }> {
    let imported = 0;
    const rawLines = ndjson.split(/\r?\n/).filter((l) => l.trim());
    await this.connector.transaction(async (tx) => {
      for (const line of rawLines) {
        const parsed = JSON.parse(line) as ExportLine;
        if (!EXPORT_TABLES.includes(parsed.table)) continue;
        const row = { ...parsed.row };
        if (row.content && typeof row.content === "object" && "base64" in row.content) {
          row.content = new Uint8Array(Buffer.from(String((row.content as { base64: string }).base64), "base64"));
        }
        if (row.embedding && typeof row.embedding === "object" && "base64" in row.embedding) {
          row.embedding = new Uint8Array(Buffer.from(String((row.embedding as { base64: string }).base64), "base64"));
        }
        const cols = Object.keys(row).filter((k) => /^[a-z][a-z0-9_]*$/.test(k));
        if (!cols.length) continue;
        const vals = cols.map((c) => row[c]);
        const phs = vals.map((_, i) => this.p(i + 1)).join(", ");
        const useSavepoint = this.connector.dialect === "postgres";
        try {
          if (useSavepoint) await tx.execute("SAVEPOINT clyde_imp");
          await tx.execute(`INSERT INTO ${this.T(parsed.table)} (${cols.join(", ")}) VALUES (${phs})`, vals);
          if (useSavepoint) await tx.execute("RELEASE SAVEPOINT clyde_imp");
          if (parsed.table === "entry" && row.id && row.search_text) {
            await this.indexFts(tx, String(row.id), String(row.search_text));
          }
          imported++;
        } catch {
          if (useSavepoint) await tx.execute("ROLLBACK TO SAVEPOINT clyde_imp").catch(() => {});
          // Skip duplicate primary keys cleanly on idempotent import.
        }
      }
    });
    this.forgetGraph();
    this.vectors.invalidate();
    return { imported };
  }
}
