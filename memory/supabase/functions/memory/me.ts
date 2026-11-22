// The signed-in owner's own routes (R55 reviewer account, R51/R52 entries, R60 billing/usage, R61 agents/devices,
// R62-R64 quests/graph). Every request runs inside the owner's tenant (R49), except PATCH /me/billing which updates
// spend_limit_cents through rootSql scoped to owner_id (memory_tenant has SELECT-only on entitlement).
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { entitlementOf, forgetOwners } from "./auth.ts";
import { OverBudget } from "./budget.ts";
import { chargeFor, includedCostMicroUsd, METERED_KINDS, PLANNED, SUPABASE_PRO } from "./billing/cost.ts";
import { forget, type Plan } from "./billing/entitlement.ts";
import { PROVIDERS } from "./billing/index.ts";
import { deleteOwnerAccount, OwnerProtectedError } from "./billing/lapse.ts";
import { ProviderError } from "./billing/provider.ts";
import { EXPORT_BLOB_MAX, EXPORT_STORED_TOTAL, get as getBlob, storageOn } from "./blobs.ts";
import { asTenant, root as rootSql, sql } from "./db.ts";
import { screen } from "./judge.ts";
import {
  AGENT_CONTEXTS,
  AGENT_TYPES,
  CATEGORY_RE,
  ENTRY_CONTEXTS,
  normalizeComputer,
  normalizeProjectSlug,
  TRANSFERABILITIES,
} from "./permissions.ts";
import { parseQuestTarget, questMatches } from "./quest.ts";
import { reopenExpired } from "./quests.ts";
import { redactText } from "./redact.ts";
import { forgetGraph } from "./search.ts";
import { agentName } from "./service.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NICKNAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const QUEST_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const RESERVED_NAMES = new Set(["claude", "codex", "all", "wen", "memory"]);
const KINDS = new Set(["fact", "wen", "observation", "plan"]);
const PATTERNS = new Set(["projects", "decisions", "observations", "preferences", "recommendations", "references", "reactions"]);
const SENSITIVITIES = new Set(["normal", "private", "confidential"]);
const PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const MAX_JSON_BODY = 64 * 1024;
const DORMANT_CUTOFF = 0.15;

async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_JSON_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_JSON_BODY) return null;
  try {
    const data = text.trim() ? JSON.parse(text) : null;
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const cleanLine = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : "";

const likePattern = (q: string) =>
  `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

function includedQuotaFor(plan: Plan, kind: typeof METERED_KINDS[number]): number | null {
  switch (kind) {
    case "ai":
      return plan.openai_tokens_month;
    case "storage_gb_hours":
      return plan.blob_bytes_total === null ? null : Math.round((plan.blob_bytes_total / 1e9) * 730);
    case "egress_bytes":
      return plan.price_micro_usd_month > 0 ? Math.round(SUPABASE_PRO.egress_bytes.included / PLANNED.supabaseUsers) : 0;
    case "requests":
      return plan.price_micro_usd_month > 0 && plan.overage
        ? Math.round(SUPABASE_PRO.invocations.included / PLANNED.supabaseUsers)
        : (plan.recalls_month ?? 0) + (plan.remembers_month ?? 0);
    case "db_bytes":
      return plan.price_micro_usd_month > 0 ? Math.round(SUPABASE_PRO.db_bytes.included / PLANNED.supabaseUsers) : 0;
  }
}

/** Owner-scoped /me endpoints. */
export async function handle(req: Request, path: string, owner: string): Promise<Response> {
  const url = new URL(req.url);

  // ---------------------------------------------------------------- usage & billing (R60 #65)
  if (path === "/me/usage" && req.method === "GET") {
    const v = await entitlementOf(owner);
    const [{ period }] = await sql`select date_trunc('month', now() at time zone 'utc')::date::text as period`;
    const rows = await sql`select kind, coalesce(sum(amount), 0)::bigint as amount,
        coalesce(sum(quantity), 0)::bigint as quantity,
        coalesce(sum(cost_micro_usd), 0)::bigint as cost_micro_usd
      from memory.usage
      where owner_id = ${owner}::uuid and period = ${period}::date and kind = any(${[...METERED_KINDS]}::text[])
      group by kind`;
    const byKind = new Map(rows.map((r) => [String(r.kind), r]));
    const meters = METERED_KINDS.map((kind) => {
      const r = byKind.get(kind);
      const qty = Number(r?.quantity ?? 0);
      const amt = Number(r?.amount ?? 0);
      const used = qty > 0 ? qty : amt;
      const costMicro = Number(r?.cost_micro_usd ?? 0);
      const includedCost = includedCostMicroUsd(v.plan, kind);
      const overageMicro = Number.isFinite(includedCost) ? Math.max(0, costMicro - includedCost) : 0;
      const overageCents = v.metered && v.plan.overage && overageMicro > 0 ? Math.ceil(chargeFor(overageMicro) / 10_000) : 0;
      return {
        kind,
        included: includedQuotaFor(v.plan, kind),
        used,
        overage_cents: overageCents,
      };
    });
    const [ent] = await rootSql`select (to_jsonb(e)->>'spend_limit_cents')::int as spend_limit_cents,
        cancel_at_period_end
      from memory.entitlement e where e.owner_id = ${owner}::uuid`;
    const spendLimitCents = ent?.spend_limit_cents === null || ent?.spend_limit_cents === undefined
      ? v.spendLimitCents
      : Number(ent.spend_limit_cents);
    return json({
      plan: v.plan.id,
      state: v.state,
      overage: Boolean(v.plan.overage),
      cancel_at_period_end: Boolean(ent?.cancel_at_period_end),
      spend_limit_cents: spendLimitCents,
      period,
      meters,
    });
  }

  if (path === "/me/billing" && req.method === "PATCH") {
    const body = await readJsonObject(req);
    if (!body || typeof body.spend_limit_cents !== "number" || !Number.isInteger(body.spend_limit_cents) ||
      body.spend_limit_cents < 0 || body.spend_limit_cents > 50_000) {
      return json({ error: "spend_limit_cents must be a whole number between 0 and 50000." }, 400);
    }
    const cents = body.spend_limit_cents;
    const [updated] = await rootSql`update memory.entitlement
      set spend_limit_cents = ${cents}, updated_at = now()
      where owner_id = ${owner}::uuid
      returning spend_limit_cents`;
    if (!updated) return json({ error: "No subscription entitlement found." }, 404);
    forget(owner);
    await sql`insert into memory.admin_audit (action, target, before, after)
      values ('billing.spend_limit', ${"owner:" + owner}, null, ${sql.json({ spend_limit_cents: cents })})`;
    return json({ spend_limit_cents: Number(updated.spend_limit_cents) });
  }

  if (path === "/me/billing/upgrade" && req.method === "POST") {
    const body = await readJsonObject(req);
    const targetPlanId = typeof body?.plan === "string" && body.plan.trim() ? body.plan.trim().toLowerCase() : "clyde";
    const [ent] = await rootSql`select provider, subscription_id, plan, state, cancel_at_period_end, current_period_end
      from memory.entitlement where owner_id = ${owner}::uuid`;
    const activeSub = ent && ent.state === "paid" && ent.subscription_id &&
      (!ent.cancel_at_period_end || !ent.current_period_end || new Date(ent.current_period_end).getTime() > Date.now());
    if (!activeSub) return json({ error: "No active paid subscription to upgrade." }, 409);

    const [currentPlan] = await rootSql`select price_micro_usd_month from memory.plan where id = ${String(ent.plan)}`;
    const [targetPlan] = await rootSql`select id, price_micro_usd_month, product_ids
      from memory.plan where id = ${targetPlanId} and open and listed`;
    if (!targetPlan || !currentPlan || Number(targetPlan.price_micro_usd_month) <= Number(currentPlan.price_micro_usd_month)) {
      return json({ error: "Choose a higher-tier listed plan to upgrade." }, 400);
    }

    const p = PROVIDERS[String(ent.provider)];
    if (!p) return json({ error: "Upgrade isn't supported for this billing provider." }, 400);
    const productId = (targetPlan.product_ids as Record<string, unknown> | null)?.[p.name];
    if (typeof productId !== "string" || !productId || !(await p.configured())) {
      return json({ error: "Upgrade isn't available right now." }, 503);
    }

    try {
      await p.upgrade(String(ent.subscription_id), productId);
    } catch (e) {
      if (e instanceof ProviderError) {
        return json({ error: "Couldn't upgrade your subscription right now. Check your payment method or try again." }, 502);
      }
      throw e;
    }
    await rootSql`update memory.entitlement
      set plan = ${targetPlanId}, cancel_at_period_end = false, updated_at = now()
      where owner_id = ${owner}::uuid`;
    forget(owner);
    await sql`insert into memory.admin_audit (action, target, before, after)
      values ('billing.upgrade', ${"owner:" + owner}, ${sql.json({ plan: ent.plan })},
        ${sql.json({ from: ent.plan, to: targetPlanId, subscription_id: ent.subscription_id })})`;
    return json({ plan: targetPlanId, upgraded: true });
  }

  // ---------------------------------------------------------------- entries (R51 #56, R52 #57)
  if (path === "/me/entries" && req.method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const kindParam = (url.searchParams.get("kind") ?? "").trim().toLowerCase();
    const agentParam = (url.searchParams.get("agent") ?? "").trim().toLowerCase();
    const deviceParam = (url.searchParams.get("device") ?? "").trim().toLowerCase();
    const projectParam = (url.searchParams.get("project") ?? "").trim().toLowerCase();
    const contextParam = (url.searchParams.get("context") ?? "").trim().toLowerCase();
    const stateParam = (url.searchParams.get("state") ?? "active").trim().toLowerCase() || "active";
    if (!["active", "pruned", "superseded", "all"].includes(stateParam)) {
      return json({ error: "state must be active, pruned, superseded, or all." }, 400);
    }

    const clauses: any[] = [];
    if (q) {
      const lp = likePattern(q);
      clauses.push(sql`(e.title ilike ${lp} or e.body ilike ${lp} or coalesce(e.search_text, '') ilike ${lp})`);
    }
    if (kindParam && kindParam !== "all") {
      clauses.push(sql`(lower(e.kind) = ${kindParam} or lower(e.pattern) = ${kindParam} or lower(e.pattern) = ${kindParam + "s"})`);
    }
    if (projectParam) {
      clauses.push(sql`(lower(coalesce(e.project, '')) = ${projectParam} or lower(coalesce(e.project_slug, '')) = ${projectParam})`);
    }
    if (contextParam && contextParam !== "all") {
      clauses.push(sql`lower(e.context) = ${contextParam}`);
    }
    if (agentParam) {
      clauses.push(sql`exists (select 1 from memory.entry_provenance ep
        where ep.owner_id = e.owner_id and ep.entry_id = e.id and lower(coalesce(ep.agent, '')) = ${agentParam})`);
    }
    if (deviceParam) {
      clauses.push(sql`exists (select 1 from memory.entry_provenance ep
        where ep.owner_id = e.owner_id and ep.entry_id = e.id and lower(coalesce(ep.device, '')) = ${deviceParam})`);
    }
    if (stateParam === "pruned") {
      clauses.push(sql`e.confidence < ${DORMANT_CUTOFF}`);
    } else if (stateParam === "superseded") {
      clauses.push(sql`exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes')`);
    } else if (stateParam === "active") {
      clauses.push(sql`e.confidence >= ${DORMANT_CUTOFF}
        and not exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes')`);
    }

    const whereSql = clauses.length
      ? clauses.slice(1).reduce((acc, c) => sql`${acc} and ${c}`, sql`where ${clauses[0]}`)
      : sql``;

    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 1000;
    const rawOffset = Number(url.searchParams.get("offset"));
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const [{ total }] = await sql`select count(*)::int as total from memory.entry e ${whereSql}`;
    const rows = await sql`select e.id, e.title, e.body, e.pattern, e.kind, e.project, e.project_slug,
        e.category, e.context, e.transferability, e.sensitivity, e.authority, e.confidence, e.created_at, e.valid_from,
        (select l.src from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'
          order by l.src limit 1) as superseded_by
      from memory.entry e
      ${whereSql}
      order by e.created_at desc, e.id
      limit ${limit} offset ${offset}`;
    const totalCount = Number(total ?? rows.length);
    return json({ total: totalCount, limit, offset, has_more: offset + rows.length < totalCount, entries: rows });
  }

  let m = /^\/me\/entries\/([^/]+)\/prune$/.exec(path);
  if (m && req.method === "POST") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return json({ error: "That isn't an entry id." }, 400);
    const [existing] = await sql`select id, confidence from memory.entry where id = ${id}`;
    if (!existing) return json({ error: `No entry ${id}.` }, 404);

    await sql.begin(async (tx) => {
      await tx`update memory.entry set confidence = 0 where id = ${id}`;
      await tx`insert into memory.confidence_log (target, before, after, reason)
        values (${"entry:" + id}, ${existing.confidence}, 0, 'pruned by owner')`;
      await tx`insert into memory.admin_audit (action, target, before, after)
        values ('entry_prune', ${"entry:" + id}, ${tx.json({ confidence: existing.confidence })}, ${tx.json({ confidence: 0, entry_id: id })})`;
    });
    forgetGraph(owner);
    return json({ pruned: id, confidence: 0 });
  }

  if ((m = /^\/me\/entries\/([^/]+)\/supersede$/.exec(path)) && req.method === "POST") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return json({ error: "That isn't an entry id." }, 400);
    const body = await readJsonObject(req);
    const [existing] = await sql`select id from memory.entry where id = ${id}`;
    if (!existing) return json({ error: `No entry ${id}.` }, 404);

    const rawRepl = body?.replacement ?? body?.by ?? body?.superseded_by;
    const replacement = typeof rawRepl === "string" ? rawRepl.trim() : "";
    if (!replacement || !ID.test(replacement) || replacement === id) {
      return json({ error: "replacement must be another valid entry id." }, 400);
    }
    const [replRow] = await sql`select id from memory.entry where id = ${replacement}`;
    if (!replRow) return json({ error: `No replacement entry ${replacement}.` }, 404);

    await sql.begin(async (tx) => {
      await tx`insert into memory.link (src, dst, type) values (${replacement}, ${id}, 'supersedes') on conflict do nothing`;
      await tx`insert into memory.admin_audit (action, target, before, after)
        values ('entry_supersede', ${"entry:" + id}, null, ${tx.json({ src: replacement, dst: id, type: "supersedes", entry_id: id })})`;
    });
    forgetGraph(owner);
    return json({ id, superseded_by: replacement });
  }

  m = /^\/me\/entries\/([^/]+)$/.exec(path);
  if (m && req.method === "GET") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return json({ error: "That isn't an entry id." }, 400);
    const [entry] = await sql`select e.*, s.kind as source_kind, s.title as source_title, s.uri as source_uri
      from memory.entry e
      left join memory.source s on s.owner_id = e.owner_id and s.id = e.source_id
      where e.id = ${id}`;
    if (!entry) return json({ error: `No entry ${id}.` }, 404);

    const artifacts = await sql`select x.name, x.sha256, x.kind, b.media_type, b.size
      from memory.entry_blob x join memory.blob b on b.owner_id = x.owner_id and b.sha256 = x.sha256
      where x.entry_id = ${id} order by x.name`;
    const linksOut = await sql`select src, dst, type, weight from memory.link where src = ${id} order by type, dst`;
    const linksIn = await sql`select src, dst, type, weight from memory.link where dst = ${id} order by type, src`;
    const [provenance] = await sql`select device, agent, agent_context, session, cwd, repo, created_at
      from memory.entry_provenance where entry_id = ${id}`;
    const confidenceHistory = await sql`select id, at, before, after, reason, retrieval_id, event_id
      from memory.confidence_log where target = ${"entry:" + id} order by at desc, id desc limit 100`;
    const sup = linksIn.find((l) => l.type === "supersedes")?.src ?? null;
    const { tsv_en: _tsv, ...cleanEntry } = entry;
    return json({
      ...cleanEntry,
      entry: cleanEntry,
      artifacts,
      links: [...linksOut, ...linksIn],
      links_out: linksOut,
      links_in: linksIn,
      provenance: provenance ?? null,
      confidence_history: confidenceHistory,
      superseded_by: sup,
    });
  }

  if (m && req.method === "PATCH") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return json({ error: "That isn't an entry id." }, 400);
    const body = await readJsonObject(req);
    if (!body) return json({ error: "Body must be a JSON object." }, 400);
    const [existing] = await sql`select * from memory.entry where id = ${id}`;
    if (!existing) return json({ error: `No entry ${id}.` }, 404);

    let title: string = existing.title;
    if ("title" in body) {
      const t = cleanLine(body.title, 300);
      if (!t) return json({ error: "title must be 1 to 300 characters." }, 400);
      title = t;
    }

    let nextBody: string = existing.body ?? "";
    if ("body" in body) {
      if (typeof body.body !== "string") return json({ error: "body must be text." }, 400);
      const b = body.body.replace(CONTROL, (ch) => ch === "\n" || ch === "\t" ? ch : " ").trim();
      if (!b || b.length > 4000) return json({ error: "body must be 1 to 4000 characters." }, 400);
      nextBody = b;
    }

    let evidence: string = existing.evidence ?? "";
    if ("evidence" in body) {
      if (typeof body.evidence !== "string") return json({ error: "evidence must be text." }, 400);
      const ev = body.evidence.replace(CONTROL, " ").trim();
      if (!ev || ev.length > 20000) return json({ error: "evidence must be 1 to 20000 characters." }, 400);
      evidence = ev;
    }

    let pattern: string = existing.pattern;
    if ("pattern" in body) {
      const p = typeof body.pattern === "string" ? body.pattern.trim().toLowerCase() : "";
      if (!PATTERNS.has(p)) return json({ error: "pattern is not valid." }, 400);
      pattern = p;
    }

    let kind: string = existing.kind;
    if ("kind" in body) {
      const k = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
      if (!KINDS.has(k)) return json({ error: "kind must be fact, wen, observation, or plan." }, 400);
      kind = k;
    }

    let project: string | null = existing.project ?? null;
    if ("project" in body) {
      if (body.project === null || body.project === "") project = null;
      else if (typeof body.project === "string" && ID.test(body.project.trim())) project = body.project.trim();
      else return json({ error: "project must be a valid id or null." }, 400);
    }

    let projectSlug: string | null = existing.project_slug ?? null;
    if ("project_slug" in body) {
      if (body.project_slug === null || body.project_slug === "") projectSlug = null;
      else {
        const slug = normalizeProjectSlug(body.project_slug);
        if (!slug) return json({ error: "project_slug is not valid." }, 400);
        projectSlug = slug;
      }
    }

    let category: string = existing.category ?? "general";
    if ("category" in body) {
      const c = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
      if (!CATEGORY_RE.test(c)) return json({ error: "category must be 1 to 40 lowercase letters, digits, or dashes." }, 400);
      category = c;
    }

    let context: string = existing.context ?? "general";
    if ("context" in body) {
      const ctx = typeof body.context === "string" ? body.context.trim().toLowerCase() : "";
      if (!(ENTRY_CONTEXTS as readonly string[]).includes(ctx)) return json({ error: "context is not valid." }, 400);
      context = ctx;
    }

    let transferability: string = existing.transferability ?? "general";
    if ("transferability" in body) {
      const tr = typeof body.transferability === "string" ? body.transferability.trim().toLowerCase() : "";
      if (!(TRANSFERABILITIES as readonly string[]).includes(tr)) return json({ error: "transferability is not valid." }, 400);
      transferability = tr;
    }

    let sensitivity: string = existing.sensitivity ?? "normal";
    if ("sensitivity" in body) {
      const s = typeof body.sensitivity === "string" ? body.sensitivity.trim().toLowerCase() : "";
      if (!SENSITIVITIES.has(s)) return json({ error: "sensitivity must be normal, private, or confidential." }, 400);
      sensitivity = s;
    }

    const textChanged = title !== existing.title || nextBody !== existing.body || evidence !== existing.evidence;
    if (textChanged) {
      const [, foundT] = redactText(title);
      const [, foundB] = redactText(nextBody);
      const [, foundE] = redactText(evidence);
      if (foundT.length || foundB.length || foundE.length) {
        return json({ error: "Entry contains sensitive credentials and was refused." }, 422);
      }
      const probe = sensitivity === "normal" ? `${title}\n\n${nextBody}\n\n${evidence}` : title;
      try {
        const why = await screen(probe);
        if (why) return json({ error: `Not saved: ${why}` }, 422);
      } catch (e) {
        if (e instanceof OverBudget) return json({ error: `Not saved: over monthly budget (${e.message}).` }, 429);
        return json({ error: "Couldn't screen this edit right now; try again later." }, 503);
      }
    }

    const updated = await sql.begin(async (tx) => {
      const [row] = await tx`update memory.entry set
          title = ${title},
          body = ${nextBody},
          evidence = ${evidence},
          pattern = ${pattern},
          kind = ${kind},
          project = ${project},
          project_slug = ${projectSlug},
          category = ${category},
          context = ${context},
          transferability = ${transferability},
          sensitivity = ${sensitivity}
        where id = ${id}
        returning *`;
      if (textChanged) {
        await tx`delete from memory.entry_embedding where entry_id = ${id}`;
      }
      await tx`insert into memory.admin_audit (action, target, before, after)
        values ('entry_edit', ${"entry:" + id}, ${tx.json({ title: existing.title, body: existing.body })},
          ${tx.json({ entry_id: id, title, body: nextBody })})`;
      return row;
    });
    forgetGraph(owner);
    const { tsv_en: _tsv, ...clean } = updated;
    return json({ ...clean, entry: clean });
  }

  if (m && req.method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return json({ error: "That isn't an entry id." }, 400);
    const gone = await sql.begin(async (tx) => {
      await tx`delete from memory.co_use where src = ${id} or dst = ${id}`;
      await tx`delete from memory.link where src = ${id} or dst = ${id}`;
      await tx`update memory.entry set project = null where project = ${id} and id <> ${id}`;
      const del = await tx`delete from memory.entry where id = ${id} returning id`;
      if (del.length) {
        await tx`insert into memory.admin_audit (action, target, before, after)
          values ('entry_delete', ${"entry:" + id}, null, ${tx.json({ entry_id: id })})`;
      }
      return del;
    });
    if (!gone.length) return json({ error: `No entry ${id}.` }, 404);
    forgetGraph(owner);
    return json({ deleted: id });
  }

  // ---------------------------------------------------------------- graph (R63 #68)
  if (path === "/me/graph" && req.method === "GET") {
    const depthRaw = Number(url.searchParams.get("depth") ?? 2);
    const depth = Number.isInteger(depthRaw) ? Math.min(Math.max(depthRaw, 1), 3) : 2;
    let center = (url.searchParams.get("center") ?? "").trim();

    if (center) {
      if (!ID.test(center)) return json({ error: "That isn't an entry id." }, 400);
      const [hit] = await sql`select id from memory.entry where id = ${center}`;
      if (!hit) return json({ error: `No entry ${center}.` }, 404);
    } else {
      const [top] = await sql`select e.id from memory.entry e
        order by (select count(*) from memory.link l where l.src = e.id or l.dst = e.id) desc, e.created_at desc, e.id
        limit 1`;
      if (!top) return json({ center: null, depth, nodes: [], edges: [] });
      center = top.id;
    }

    const links = await sql`select src, dst, type, weight from memory.link order by weight desc nulls last, type, src, dst`;
    const adj = new Map<string, string[]>();
    for (const l of links) {
      const s = String(l.src), d = String(l.dst);
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(d)) adj.set(d, []);
      adj.get(s)!.push(d);
      adj.get(d)!.push(s);
    }

    const MAX_NODES = 300;
    const visited = new Set<string>([center]);
    let frontier: string[] = [center];
    for (let d = 0; d < depth && frontier.length && visited.size < MAX_NODES; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const nb of adj.get(cur) ?? []) {
          if (visited.has(nb)) continue;
          visited.add(nb);
          next.push(nb);
          if (visited.size >= MAX_NODES) break;
        }
        if (visited.size >= MAX_NODES) break;
      }
      frontier = next;
    }

    const nodeIds = [...visited];
    const entries = nodeIds.length
      ? await sql`select id, title, pattern, kind, project, confidence from memory.entry where id = any(${nodeIds}::text[])`
      : [];
    const present = new Set(entries.map((e) => String(e.id)));
    const edges = links.filter((l) => present.has(String(l.src)) && present.has(String(l.dst)));
    return json({ center, depth, nodes: entries, edges });
  }

  // ---------------------------------------------------------------- agents & devices (R61 #66)
  if (path === "/me/agents" && req.method === "GET") {
    const rows = await sql`select a.name, a.nickname, a.type, a.harness, a.device_id, d.name as device,
        a.repos, a.projects, a.context, a.surface, a.description, a.computer, a.strict_projects,
        a.last_seen, a.created_at
      from memory.agent a
      left join memory.device d on d.owner_id = a.owner_id and d.id = a.device_id
      order by a.last_seen desc nulls last, a.name`;
    return json({ agents: rows });
  }

  if ((m = /^\/me\/agents\/([^/]+)$/.exec(path)) && req.method === "PATCH") {
    const key = decodeURIComponent(m[1]).trim().toLowerCase();
    if (!key || key.length > 100) return json({ error: "That isn't an agent name or nickname." }, 400);
    const body = await readJsonObject(req);
    if (!body) return json({ error: "Body must be a JSON object." }, 400);

    const [existing] = await sql`select * from memory.agent where name = ${key} or lower(nickname) = ${key} limit 1`;
    if (!existing) return json({ error: `No agent ${key}.` }, 404);

    let nickname: string | null = existing.nickname;
    if ("nickname" in body) {
      if (body.nickname === null || body.nickname === "") {
        nickname = null;
      } else if (typeof body.nickname === "string") {
        const n = body.nickname.trim().toLowerCase();
        if (!NICKNAME.test(n) || RESERVED_NAMES.has(n)) {
          return json({ error: "nickname must be 1 to 40 lowercase letters, digits, dashes and underscores." }, 400);
        }
        nickname = n;
      } else {
        return json({ error: "nickname must be text or null." }, 400);
      }
    }

    let type: string = existing.type ?? existing.agent_type ?? "other";
    if ("type" in body) {
      const t = typeof body.type === "string" ? body.type.trim().toLowerCase() : "";
      if (!(AGENT_TYPES as readonly string[]).includes(t)) {
        return json({ error: `type must be one of ${AGENT_TYPES.join(", ")}.` }, 400);
      }
      type = t;
    }

    let harness: string | null = existing.harness;
    if ("harness" in body) {
      if (body.harness === null || body.harness === "") {
        harness = null;
      } else if (typeof body.harness === "string") {
        const h = body.harness.replace(CONTROL, " ").trim().slice(0, 64).trim();
        if (!h) return json({ error: "harness must be 1 to 64 characters." }, 400);
        harness = h;
      } else {
        return json({ error: "harness must be text or null." }, 400);
      }
    }

    let context: string = existing.context;
    if ("context" in body) {
      const c = typeof body.context === "string" ? body.context.trim().toLowerCase() : "";
      if (!(AGENT_CONTEXTS as readonly string[]).includes(c)) {
        return json({ error: `context must be one of ${AGENT_CONTEXTS.join(", ")}.` }, 400);
      }
      context = c;
    }

    let computer: string | null = existing.computer;
    if ("computer" in body) {
      if (body.computer === null || body.computer === "") {
        computer = null;
      } else {
        computer = normalizeComputer(body.computer);
        if (!computer) return json({ error: "computer must be 1 to 64 characters." }, 400);
      }
    }

    let repos: string[] = existing.repos ?? existing.projects ?? [];
    const repoField = "repos" in body ? body.repos : ("projects" in body ? body.projects : undefined);
    if (repoField !== undefined) {
      if (!Array.isArray(repoField) || repoField.length > 50) {
        return json({ error: "repos must be a list of up to 50 project slugs." }, 400);
      }
      const next: string[] = [];
      for (const raw of repoField) {
        const slug = normalizeProjectSlug(raw);
        if (!slug) return json({ error: "each repo must be a valid slug or owner/repo name." }, 400);
        if (!next.includes(slug)) next.push(slug);
      }
      repos = next;
    }

    let strictProjects = Boolean(existing.strict_projects);
    if ("strict_projects" in body) {
      if (typeof body.strict_projects !== "boolean") return json({ error: "strict_projects must be true or false." }, 400);
      strictProjects = body.strict_projects;
    }

    let surface: string = existing.surface;
    if ("surface" in body) {
      const sf = typeof body.surface === "string" ? body.surface.replace(CONTROL, " ").trim().slice(0, 40).trim() : "";
      if (!sf) return json({ error: "surface must be non-empty text." }, 400);
      surface = sf;
    }

    let description: string = existing.description;
    if ("description" in body) {
      const d = typeof body.description === "string" ? body.description.replace(CONTROL, " ").trim().slice(0, 500).trim() : "";
      if (!d) return json({ error: "description must be non-empty text." }, 400);
      description = d;
    }

    try {
      const [updated] = await sql.begin(async (tx) => {
        const rows = await tx`update memory.agent set
            nickname = ${nickname},
            type = ${type},
            agent_type = ${type},
            harness = ${harness},
            context = ${context},
            computer = ${computer},
            repos = ${repos}::text[],
            projects = ${repos}::text[],
            strict_projects = ${strictProjects},
            surface = ${surface},
            description = ${description}
          where name = ${existing.name}
          returning name, nickname, type, harness, device_id, repos, projects, context, surface, description, computer, strict_projects, last_seen, created_at`;
        await tx`update memory.mcp_client set
            session_context = ${context},
            session_projects = ${repos}::text[],
            session_computer = ${computer},
            session_strict_projects = ${strictProjects}
          where agent = ${existing.name}`;
        await tx`insert into memory.admin_audit (action, target, before, after)
          values ('agent.update', ${"agent:" + existing.name}, ${tx.json(existing)}, ${tx.json(rows[0])})`;
        return rows;
      });
      return json({ agent: updated });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        return json({ error: `Nickname ${nickname} is already taken.` }, 409);
      }
      throw e;
    }
  }

  if (path === "/me/devices" && req.method === "GET") {
    const rows = await sql`select id, name, hooks, client_version, created_at, last_seen, revoked_at
      from memory.device order by revoked_at nulls first, name`;
    return json({ devices: rows });
  }

  if ((m = /^\/me\/devices\/([^/]+)$/.exec(path)) && req.method === "DELETE") {
    const rawId = decodeURIComponent(m[1]).trim();
    if (!rawId || rawId.length > 100) return json({ error: "That isn't a device id." }, 400);
    const byNumericId = /^\d{1,15}$/.test(rawId);
    const gone = await sql.begin(async (tx) => {
      const rows = byNumericId
        ? await tx`update memory.device set revoked_at = now()
            where id = ${Number(rawId)} and revoked_at is null returning id, name, revoked_at`
        : await tx`update memory.device set revoked_at = now()
            where name = ${rawId} and revoked_at is null returning id, name, revoked_at`;
      if (rows.length) {
        await tx`insert into memory.admin_audit (action, target, before, after)
          values ('device.revoke', ${"device:" + rows[0].name}, null, ${tx.json(rows[0])})`;
      }
      return rows;
    });
    if (!gone.length) return json({ error: `No active device ${rawId}.` }, 404);
    return json({ revoked: gone[0].id, name: gone[0].name, revoked_at: gone[0].revoked_at });
  }

  // ---------------------------------------------------------------- quests (R62 #67, R64 #69)
  if (path === "/me/quests" && req.method === "GET") {
    await reopenExpired();
    const rawQuests = await sql`select * from memory.quest order by created_at desc, id desc limit 500`;
    const agents = await sql`select a.name, a.type, a.agent_type, a.harness, a.device_id, a.computer, a.registered_by,
        a.repos, a.projects, a.strict_projects, a.context, a.surface, d.name as device_name
      from memory.agent a
      left join memory.device d on d.owner_id = a.owner_id and d.id = a.device_id`;
    const agentScopes = agents.map((a) => ({
      name: a.name,
      family: agentName(a.harness ?? a.surface ?? a.name),
      context: a.context,
      type: a.type ?? a.agent_type ?? "other",
      agentType: a.agent_type ?? a.type ?? "other",
      harness: a.harness ?? null,
      deviceId: a.device_id !== null && a.device_id !== undefined ? Number(a.device_id) : null,
      device: a.device_name ?? a.computer ?? a.registered_by ?? null,
      principal: a.registered_by ?? null,
      computer: a.computer ?? null,
      repos: a.repos ?? [],
      projects: a.projects ?? [],
      strictProjects: Boolean(a.strict_projects),
    }));
    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;
    const quests = rawQuests.map((q) => {
      const matched = agentScopes.some((a) => questMatches(a, q, { checkAssignee: true }).ok);
      const createdAt = q.created_at instanceof Date ? q.created_at.getTime() : new Date(String(q.created_at)).getTime();
      const unmatched = q.state === "open" && !matched && Number.isFinite(createdAt) && (now - createdAt >= dayMs);
      return { ...q, unmatched };
    });
    return json({ quests });
  }

  if (path === "/me/quests" && req.method === "POST") {
    const ent = await entitlementOf(owner);
    if (!ent.plan.open || !ent.plan.quests) return json({ error: "Quests require the Clyde plan ($12.99/mo)." }, 402);
    const body = await readJsonObject(req);
    if (!body) return json({ error: "Body must be a JSON object." }, 400);

    const errs: string[] = [];
    const title = cleanLine(body.title, 120).replace(/\s+/g, " ");
    const brief = cleanLine(body.brief, 500);
    const doneWhen = cleanLine(body.done_when, 300);
    if (!title) errs.push("title is required (1 to 120 characters).");
    if (!brief) errs.push("brief is required (1 to 500 characters).");
    if (!doneWhen) errs.push("done_when is required (1 to 300 characters).");

    const priority = typeof body.priority === "string" && body.priority.trim() ? body.priority.trim().toLowerCase() : "normal";
    if (!PRIORITIES.has(priority)) errs.push("priority must be urgent, high, normal, or low.");

    const { target, errs: targetErrs } = parseQuestTarget(body.target);
    errs.push(...targetErrs);

    const context = typeof body.context === "string" && body.context.trim()
      ? body.context.trim().toLowerCase()
      : (target.context ?? "both");
    if (!(AGENT_CONTEXTS as readonly string[]).includes(context)) errs.push(`context must be one of ${AGENT_CONTEXTS.join(", ")}.`);

    const assignee = typeof (body.for ?? body.assignee) === "string" && String(body.for ?? body.assignee).trim()
      ? String(body.for ?? body.assignee).trim().toLowerCase()
      : "any";
    if (!QUEST_NAME.test(assignee)) errs.push("assignee must be any or an agent name.");

    let project: string | null = target.repo ?? null;
    if (body.project !== undefined && body.project !== null && body.project !== "") {
      project = normalizeProjectSlug(body.project);
      if (!project) errs.push("project must be a valid project slug.");
    }
    let computer: string | null = target.device ?? null;
    if (body.computer !== undefined && body.computer !== null && body.computer !== "") {
      computer = normalizeComputer(body.computer);
      if (!computer) errs.push("computer must be 1 to 64 characters.");
    }
    const agentType = target.types?.length === 1 ? target.types[0] : null;
    let tags: string[] = [];
    if (body.tags !== undefined && body.tags !== null) {
      const rawTags = Array.isArray(body.tags) ? body.tags : [body.tags];
      tags = [...new Set(rawTags.map((t) => typeof t === "string" ? t.trim().toLowerCase() : ""))];
      if (tags.length > 8 || !tags.every((t) => QUEST_NAME.test(t))) errs.push("tags must be up to 8 valid slugs.");
    }
    if (errs.length) return json({ error: errs.join(" ") }, 400);

    const [, fT] = redactText(title);
    const [, fB] = redactText(brief);
    const [, fD] = redactText(doneWhen);
    if (fT.length || fB.length || fD.length) {
      return json({ error: "Quest contains sensitive credentials and was refused." }, 422);
    }

    try {
      const why = await screen([title, brief, doneWhen].join("\n\n"));
      if (why) return json({ error: `Not posted: ${why}` }, 422);
    } catch (e) {
      if (e instanceof OverBudget) return json({ error: `Not posted: monthly budget reached (${e.message}).` }, 422);
      return json({ error: "Not posted: Clyde couldn't screen this quest right now." }, 422);
    }

    const [created] = await sql.begin(async (tx) => {
      const rows = await tx`insert into memory.quest (title, brief, done_when, tags, priority, context, assignee,
          project, computer, agent_type, target, posted_by, posted_device)
        values (${title}, ${brief}, ${doneWhen}, ${tags}::text[], ${priority}, ${context}, ${assignee},
          ${project}, ${computer}, ${agentType}, ${tx.json(target)}, 'owner', 'site')
        returning *`;
      await tx`insert into memory.quest_note (quest_id, author, device, kind) values (${rows[0].id}, 'owner', 'site', 'post')`;
      await tx`insert into memory.admin_audit (action, target, before, after)
        values ('quest_post', ${"quest:" + rows[0].id}, null, ${tx.json({ quest_id: rows[0].id, title })})`;
      return rows;
    });
    return json({ quest: created }, 201);
  }

  // ---------------------------------------------------------------- connected apps, export, account deletion (R65 #70)
  if (path === "/me/apps" && req.method === "GET") {
    const [acc] = await sql`select to_jsonb(a)->'oauth_apps' as apps from memory.account a where a.owner_id = ${owner}::uuid`;
    const stored = (acc?.apps ?? {}) as Record<string, { id?: string; name?: string; granted_at?: string; revoked_at?: string | null }>;
    const byId = new Map<string, { id: string; name: string; granted_at: string | null }>();
    for (const [k, v] of Object.entries(stored)) {
      if (v && !v.revoked_at) {
        const id = String(v.id ?? k);
        byId.set(id, { id, name: String(v.name ?? id), granted_at: v.granted_at ? String(v.granted_at) : null });
      }
    }
    const [{ hasConsents }] = await rootSql`select to_regclass('auth.oauth_consents') is not null as "hasConsents"`;
    if (hasConsents) {
      const rows = await rootSql`select c.client_id::text as id,
          coalesce(cl.client_name, c.client_id::text) as name,
          c.granted_at
        from auth.oauth_consents c
        left join auth.oauth_clients cl on cl.id = c.client_id
        where c.user_id = ${owner}::uuid and c.revoked_at is null
        order by c.granted_at desc nulls last`.catch(() => []);
      for (const r of rows) {
        const id = String(r.id);
        if (stored[id]?.revoked_at) continue;
        byId.set(id, {
          id,
          name: String(r.name ?? id),
          granted_at: r.granted_at ? new Date(r.granted_at).toISOString() : null,
        });
      }
    }
    return json({ apps: [...byId.values()] });
  }

  if ((m = /^\/me\/apps\/([^/]+)$/.exec(path)) && req.method === "DELETE") {
    const appId = decodeURIComponent(m[1]).replace(CONTROL, "").trim();
    if (!appId || appId.length > 200) return json({ error: "That isn't an app id." }, 400);
    const [acc] = await sql`select to_jsonb(a)->'oauth_apps' as apps from memory.account a where a.owner_id = ${owner}::uuid`;
    const stored = (acc?.apps ?? {}) as Record<string, { id?: string; name?: string; granted_at?: string; revoked_at?: string | null }>;
    const cur = stored[appId];
    let foundInAuth = false;
    const [{ hasConsents }] = await rootSql`select to_regclass('auth.oauth_consents') is not null as "hasConsents"`;
    if (hasConsents) {
      const revoked = await rootSql`update auth.oauth_consents set revoked_at = now()
        where user_id = ${owner}::uuid and client_id::text = ${appId} and revoked_at is null
        returning client_id`.catch(() => []);
      foundInAuth = revoked.length > 0;
    }
    if ((!cur || cur.revoked_at) && !foundInAuth) return json({ error: `No active app ${appId}.` }, 404);
    const nowIso = new Date().toISOString();
    const updated = { id: appId, name: cur?.name ?? appId, granted_at: cur?.granted_at ?? nowIso, revoked_at: nowIso };
    await sql.begin(async (tx) => {
      await tx`update memory.account
        set oauth_apps = coalesce(oauth_apps, '{}'::jsonb) || ${tx.json({ [appId]: updated })}
        where owner_id = ${owner}::uuid`;
      await tx`delete from memory.mcp_client where principal = ${"oauth:" + appId}`;
      await tx`insert into memory.admin_audit (action, target, before, after)
        values ('app_revoke', ${"app:" + appId}, null, ${tx.json({ app_id: appId })})`;
    });
    forgetOwners();
    return json({ revoked: appId, revoked_at: nowIso });
  }

  if (path === "/me/export" && req.method === "GET") {
    const tables = [
      "source", "device", "account", "entitlement", "agent", "agent_binding",
      "blob", "entry", "entry_blob", "entry_provenance", "entry_embedding", "link", "co_use",
      "confidence_log", "mcp_session", "mcp_client", "retrieval", "shadow_retrieval", "feedback",
      "message", "message_delivery", "board_seen", "quest", "quest_note", "quest_blob",
      "judge_cache", "upload", "event", "burst", "usage", "admin_audit",
    ] as const;
    const enc = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      async start(controller) {
        try {
          await asTenant(owner, async () => {
            let storedBytes = 0;
            for (const table of tables) {
              if (cancelled) return;
              const batchSize = table === "blob" ? 16 : 250;
              for (let offset = 0; !cancelled; offset += batchSize) {
                const rows = await sql`select * from ${sql("memory." + table)}
                  where owner_id = ${owner}::uuid order by ctid limit ${batchSize} offset ${offset}`;
                for (const r of rows) {
                  if (cancelled) return;
                  if (table === "blob") {
                    let bytes: Uint8Array | null = r.content instanceof Uint8Array ? r.content : null;
                    const sz = Number(r.size ?? 0);
                    if (!bytes && r.stored === "storage" && sz <= EXPORT_BLOB_MAX && storedBytes + sz <= EXPORT_STORED_TOTAL && storageOn()) {
                      bytes = await getBlob(String(r.sha256), owner);
                      if (bytes) storedBytes += bytes.byteLength;
                    }
                    if (cancelled) return;
                    controller.enqueue(enc.encode(JSON.stringify({
                      table,
                      row: { ...r, content: bytes ? { base64: encodeBase64(new Uint8Array(bytes)) } : null },
                    }) + "\n"));
                  } else {
                    const clean: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(r)) {
                      clean[k] = v instanceof Uint8Array ? { base64: encodeBase64(v) } : v;
                    }
                    controller.enqueue(enc.encode(JSON.stringify({ table, row: clean }) + "\n"));
                  }
                }
                if (rows.length < batchSize) break;
              }
            }
          });
          if (!cancelled) controller.close();
        } catch (err) {
          if (!cancelled) controller.error(err);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="clyde-export.ndjson"',
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/me" && req.method === "DELETE") {
    try {
      await deleteOwnerAccount(owner, "owner");
      return json({ deleted: owner });
    } catch (e) {
      if (e instanceof OwnerProtectedError) return json({ error: e.message }, 403);
      throw e;
    }
  }

  return json({ error: "No such endpoint." }, 404);
}
