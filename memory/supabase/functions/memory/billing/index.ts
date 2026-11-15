// Billing's routes and the providers behind them (R38). /billing/<provider> takes that provider's signed webhooks, and
// /billing/checkout sends a signed-in owner to the provider's checkout. Everything provider-specific lives in this folder;
// the rest of the function knows only entitlement.ts and limits.ts.
import { DOMAIN } from "../auth.ts";
import { setting, sql } from "../db.ts";
import { chargeFor } from "./cost.ts";
import { geoBlocked, geoOf, refusal451 } from "./entitlement.ts";
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

/** POST /billing/usage/report, hourly from pg_cron: send each owner's overage that the provider hasn't heard, this month's
 * and last month's, and record it as reported once the provider has it. Nothing happens until billing is set up. */
async function report() {
  const p = await active();
  if (!(await p.configured())) return Response.json({ reported: 0, configured: false });
  const due = await sql`select o.owner_id, o.period::text as period, o.amount - coalesce(r.amount, 0) as delta
    from memory.usage o
    join memory.entitlement e on e.owner_id = o.owner_id and e.provider = ${p.name}
    left join memory.usage r on r.owner_id = o.owner_id and r.period = o.period and r.kind = 'overage_reported_micro_usd_month'
    where o.kind = 'overage_micro_usd_month' and o.amount > coalesce(r.amount, 0)
      and o.period >= (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date`;
  let reported = 0;
  const failed: string[] = [];
  for (const d of due) {
    try {
      await p.reportUsage(d.owner_id, chargeFor(Number(d.delta)), Number(d.delta), d.period);
    } catch (e) {
      console.error(e);
      failed.push(d.owner_id);
      continue;
    }
    await sql`insert into memory.usage as u (owner_id, period, kind, amount)
      values (${d.owner_id}, ${d.period}::date, 'overage_reported_micro_usd_month', ${d.delta})
      on conflict (owner_id, period, kind) do update set amount = u.amount + excluded.amount`;
    reported++;
  }
  return Response.json({ reported, failed: failed.length }, { status: failed.length ? 502 : 200 });
}

export async function handle(req: Request, path: string, url: URL, proxied: boolean): Promise<Response> {
  if (path === "/billing/usage/report") return req.method === "POST" ? report() : new Response(null, { status: 405, headers: { allow: "POST" } });
  if (path === "/billing/checkout") return req.method === "GET" ? checkout(req, url, proxied) : new Response(null, { status: 405, headers: { allow: "GET" } });
  if (path === "/billing/thanks") return text("thanks. Your Clyde subscription starts within a minute. Go back to your app.", 200);
  const m = /^\/billing\/([a-z]+)(\/webhook)?$/.exec(path);
  const p = m && PROVIDERS[m[1]];
  if (!p) return Response.json({ error: "No such endpoint." }, { status: 404 });
  return receive(req, p);
}
