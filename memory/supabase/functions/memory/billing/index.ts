// Billing's routes and the providers behind them (R38). /billing/<provider> takes that provider's signed webhooks, and
// /billing/checkout sends a signed-in owner to the provider's checkout. Everything provider-specific lives in this folder;
// the rest of the function knows only entitlement.ts and limits.ts.
import * as guard from "./guard.ts";
import { DOMAIN } from "../auth.ts";
import { setting, sql } from "../db.ts";
import { chargeFor, includedCostMicroUsd, METERED_KINDS, type Plan as PlanCost } from "./cost.ts";
import { geoBlocked, geoOf, refusal451 } from "./entitlement.ts";
import { runLapseCleanup } from "./lapse.ts";
import { paddle } from "./paddle.ts";
import { polar } from "./polar.ts";
import type { Provider } from "./provider.ts";
import { receive } from "./webhooks.ts";

export const PROVIDERS: Record<string, Provider> = { polar, paddle };

/** The provider checkout uses: the setting billing_provider, else the first one. */
async function active(): Promise<Provider> {
  return PROVIDERS[await setting("billing_provider")] ?? polar;
}

/** The Vault secrets the console may set for billing. */
export const SECRETS = Object.values(PROVIDERS).flatMap((p) => p.secrets);

/** Whether a path is a webhook: it takes no bearer token, only the provider's signature. */
export const isWebhook = (path: string) => (/^\/billing\/([a-z]+)(\/webhook)?$/.exec(path)?.[1] ?? "") in PROVIDERS;

const text = (body: string, status: number) => new Response(`Clyde: ${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** GET /billing/checkout?owner=<auth uid>[&plan=<id>]: 302 to the provider's checkout for that owner. 451 from a blocked
 * country, 404 for an owner memory doesn't know, 503 while billing isn't set up. */
async function checkout(req: Request, url: URL, proxied: boolean) {
  if (geoBlocked(geoOf(req, proxied))) return refusal451();
  const owner = (url.searchParams.get("owner") ?? "").toLowerCase();
  const [account] = /^[0-9a-f-]{36}$/.test(owner) ? await sql`select email from memory.account where owner_id = ${owner}` : [];
  if (!account) return text("that checkout link doesn't name an account. Sign in from your app and use the link it gives.", 404);
  const p = await active();
  const planId = url.searchParams.get("plan") || await setting("checkout_plan") || "clyde";
  const [plan] = await sql`select product_ids ->> ${p.name} as product from memory.plan where id = ${planId} and price_micro_usd_month > 0`;
  if (!plan?.product || !(await p.configured())) return text("checkout isn't open yet.", 503);
  const target = await p.checkout(owner, plan.product, account.email, `${DOMAIN}/billing/thanks`);
  return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store" } });
}

/** POST /billing/usage/report, hourly from pg_cron: sample Storage and DB sizes, send each active paid owner's
 * unbilled overage per kind (idempotent on owner, period, kind and UTC hour), and record what was reported. */
async function report(req: Request) {
  const p = await active();
  if (!(await p.configured())) return Response.json({ reported: 0, configured: false });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const hour = typeof body?.hour === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(body.hour)
    ? body.hour
    : new Date().toISOString().slice(0, 13);
  await sql`select memory.sample_usage()`.catch((e) => console.error(e));

  const subs = await sql`
    select e.owner_id, pl.price_micro_usd_month, pl.openai_tokens_month, pl.blob_bytes_total
    from memory.entitlement e
    join memory.plan pl on pl.id = e.plan
    where e.provider = ${p.name}
      and e.state = 'paid'
      and pl.overage = true
      and (not e.cancel_at_period_end or e.current_period_end is null or e.current_period_end > now())`;
  const plans = new Map<string, PlanCost>(subs.map((s) => [String(s.owner_id), {
    price_micro_usd_month: Number(s.price_micro_usd_month ?? 0),
    openai_tokens_month: s.openai_tokens_month === null || s.openai_tokens_month === undefined ? null : Number(s.openai_tokens_month),
    blob_bytes_total: s.blob_bytes_total === null || s.blob_bytes_total === undefined ? null : Number(s.blob_bytes_total),
  }]));
  if (!plans.size) return Response.json({ reported: 0, failed: 0 });

  const usageRows = await sql`
    select owner_id, period::text as period, kind, amount, cost_micro_usd, reported_cost_micro_usd
    from memory.usage
    where owner_id = any(${[...plans.keys()]}::uuid[])
      and period >= (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date
      and kind in ('ai', 'storage_gb_hours', 'egress_bytes', 'requests', 'db_bytes', 'overage_micro_usd_month', 'overage_reported_micro_usd_month')`;

  const grouped = new Map<string, { owner: string; period: string; rows: Map<string, Record<string, any>> }>();
  for (const r of usageRows) {
    const owner = String(r.owner_id), period = String(r.period);
    const key = `${owner}\0${period}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { owner, period, rows: new Map() };
      grouped.set(key, entry);
    }
    entry.rows.set(String(r.kind), r);
  }

  let reported = 0;
  const failed = new Set<string>();
  const sentTargets = new Set((await sql`select target from memory.billing_action where provider = ${p.name} and action = 'usage'`)
    .map((r) => String(r.target)));

  for (const { owner, period, rows } of grouped.values()) {
    const plan = plans.get(owner)!;
    let newlyReported = 0;
    let perKindOverageTotal = 0;
    for (const kind of METERED_KINDS) {
      const r = rows.get(kind);
      if (!r) continue;
      const overageCost = Math.max(0, Number(r.cost_micro_usd ?? 0) - includedCostMicroUsd(plan, kind));
      perKindOverageTotal += overageCost;
      const delta = overageCost - Number(r.reported_cost_micro_usd ?? 0);
      if (delta <= 0) continue;
      const target = `${owner}:${period}:${kind}:${hour}`;
      if (sentTargets.has(target)) continue;
      try {
        await p.reportUsage(owner, chargeFor(delta), delta, period, kind, hour);
      } catch (e) {
        console.error(e);
        failed.add(owner);
        continue;
      }
      sentTargets.add(target);
      await sql.begin(async (tx) => {
        await tx`insert into memory.billing_action (provider, action, target) values (${p.name}, 'usage', ${target}) on conflict do nothing`;
        await tx`update memory.usage set reported_cost_micro_usd = reported_cost_micro_usd + ${delta}
          where owner_id = ${owner} and period = ${period}::date and kind = ${kind}`;
        await tx`insert into memory.usage as u (owner_id, period, kind, amount)
          values (${owner}, ${period}::date, 'overage_reported_micro_usd_month', ${delta})
          on conflict (owner_id, period, kind) do update set amount = u.amount + excluded.amount`;
      });
      newlyReported += delta;
      reported++;
    }

    // Legacy / direct overage_micro_usd_month fallback (e.g. seeded overage or storage fallback delta).
    const legacyTotal = Number(rows.get("overage_micro_usd_month")?.amount ?? 0);
    const legacyReported = Number(rows.get("overage_reported_micro_usd_month")?.amount ?? 0) + newlyReported;
    const legacyDelta = Math.max(0, legacyTotal - Math.max(legacyReported, perKindOverageTotal));
    if (legacyDelta > 0) {
      const target = `${owner}:${period}:overage:${hour}`;
      if (!sentTargets.has(target)) {
        try {
          await p.reportUsage(owner, chargeFor(legacyDelta), legacyDelta, period, "requests", hour);
          sentTargets.add(target);
          await sql.begin(async (tx) => {
            await tx`insert into memory.billing_action (provider, action, target) values (${p.name}, 'usage', ${target}) on conflict do nothing`;
            await tx`insert into memory.usage as u (owner_id, period, kind, amount)
              values (${owner}, ${period}::date, 'overage_reported_micro_usd_month', ${legacyDelta})
              on conflict (owner_id, period, kind) do update set amount = u.amount + excluded.amount`;
          });
          reported++;
        } catch (e) {
          console.error(e);
          failed.add(owner);
        }
      }
    }
  }
  return Response.json({ reported, failed: failed.size }, { status: failed.size ? 502 : 200 });
}

export async function handle(req: Request, path: string, url: URL, proxied: boolean): Promise<Response> {
  if (path === "/billing/usage/report") return req.method === "POST" ? report(req) : new Response(null, { status: 405, headers: { allow: "POST" } });
  if (path === "/billing/guard") return req.method === "POST" ? Response.json(await guard.run()) : new Response(null, { status: 405, headers: { allow: "POST" } });
  if (path === "/billing/lapse") {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const out = await runLapseCleanup();
    return Response.json(out, { status: out.errors ? 502 : 200 });
  }
  if (path === "/billing/checkout") return req.method === "GET" ? checkout(req, url, proxied) : new Response(null, { status: 405, headers: { allow: "GET" } });
  if (path === "/billing/thanks") return text("thanks. Your Clyde subscription starts within a minute. Go back to your app.", 200);
  const m = /^\/billing\/([a-z]+)(\/webhook)?$/.exec(path);
  const p = m && PROVIDERS[m[1]];
  if (!p) return Response.json({ error: "No such endpoint." }, { status: 404 });
  return receive(req, p);
}
