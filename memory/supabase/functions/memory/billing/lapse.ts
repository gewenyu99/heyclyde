// R65 (#70): complete account deletion (DELETE /me) and 90-day lapsed-account lifecycle (day 60 + day 83 emails, day 90+ delete).
import { forgetOwners } from "../auth.ts";
import { removeOwner as removeOwnerBlobs } from "../blobs.ts";
import { root, secret, sql, wen } from "../db.ts";
import { sha256 } from "../embed.ts";
import { forgetGraph } from "../search.ts";
import { forget } from "./entitlement.ts";
import { paddle } from "./paddle.ts";
import { polar } from "./polar.ts";
import type { Provider } from "./provider.ts";

const PROVIDERS: Record<string, Provider> = { polar, paddle };

const RESEND_URL = () => (Deno.env.get("RESEND_API_URL") || "https://api.resend.com").replace(/\/+$/, "");
const AUTH_BASE = () => `${(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "")}/auth/v1`;
const FROM = "Clyde <clyde@send.heyclyde.me>";

/** Owned tables ordered child-to-parent across FKs so deleting an owner leaves zero rows anywhere. */
export const OWNED_DELETE_ORDER = [
  "agent_binding",
  "board_seen",
  "burst",
  "co_use",
  "link",
  "confidence_log",
  "entry_blob",
  "entry_embedding",
  "entry_provenance",
  "quest_note",
  "quest_blob",
  "quest",
  "feedback",
  "shadow_retrieval",
  "retrieval",
  "mcp_client",
  "mcp_session",
  "message_delivery",
  "message",
  "judge_cache",
  "upload",
  "event",
  "entry",
  "source",
  "blob",
  "agent",
  "device",
  "usage",
  "entitlement",
  "admin_audit",
  "account",
] as const;

export class OwnerProtectedError extends Error {}

async function deleteAuthUser(owner: string) {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && Deno.env.get("SUPABASE_URL")) {
    const r = await fetch(`${AUTH_BASE()}/admin/users/${encodeURIComponent(owner)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    await r?.body?.cancel().catch(() => {});
  }
  const [{ hasUsers }] = await root`select to_regclass('auth.users') is not null as "hasUsers"`;
  if (hasUsers) {
    await root`delete from auth.users where id = ${owner}::uuid`.catch((e) => console.error("delete auth.users:", e));
  }
}

/** Permanently deletes an owner's Storage objects, all 31 owned tables, Auth user, and logs an anonymized audit row. */
export async function deleteOwnerAccount(owner: string, actor = "owner"): Promise<void> {
  const systemOwner = await wen();
  if (systemOwner && owner.toLowerCase() === systemOwner.toLowerCase()) {
    throw new OwnerProtectedError("The primary system owner account cannot be deleted.");
  }

  // End an active subscription at the merchant before wiping local account and entitlement rows.
  const [liveEnt] = await root`select provider, subscription_id, state, cancel_at_period_end
    from memory.entitlement where owner_id = ${owner}::uuid`;
  const liveSub = typeof liveEnt?.subscription_id === "string" ? liveEnt.subscription_id.trim() : "";
  if (liveSub && (liveEnt.state === "paid" || liveEnt.state === "past_due") && !liveEnt.cancel_at_period_end) {
    const p = PROVIDERS[String(liveEnt.provider ?? "")];
    if (p && await p.configured()) {
      await p.cancel(liveSub);
    }
  }

  await removeOwnerBlobs(owner);
  const hashPrefix = (await sha256(owner)).slice(0, 12);

  await root.begin(async (tx) => {
    const [acct] = await tx`select email from memory.account where owner_id = ${owner}::uuid`;
    const [ent] = await tx`select subscription_id from memory.entitlement where owner_id = ${owner}::uuid`;
    const email = typeof acct?.email === "string" && acct.email.trim() ? acct.email.trim().toLowerCase() : null;
    const subId = typeof ent?.subscription_id === "string" && ent.subscription_id.trim() ? ent.subscription_id.trim() : null;
    for (const table of OWNED_DELETE_ORDER) {
      await tx`delete from ${tx("memory." + table)} where owner_id = ${owner}::uuid`;
    }
    await tx`delete from memory.billing_event where owner_id = ${owner}::uuid`;
    await tx`delete from memory.billing_action where target = ${owner} or target like ${owner + ":%"} or (${subId}::text is not null and target = ${subId})`;
    if (email) {
      // Scrub PII while keeping hourly IP rate-limit rows intact until their 24h TTL expires.
      await tx`update memory.signup_attempt set email = ${"deleted:" + hashPrefix} where lower(email) = ${email}`;
    }
    await tx`delete from memory.oauth_consent
      where lower(pending_user->>'id') = lower(${owner})
         or (${email}::text is not null and lower(pending_user->>'email') = ${email})`;
    if (systemOwner) {
      await tx`insert into memory.admin_audit (owner_id, action, target, before, after, actor)
        values (${systemOwner}::uuid, 'account_delete', ${"account:" + hashPrefix}, null, null, ${actor})`;
    }
  });

  await deleteAuthUser(owner);
  forget(owner);
  forgetOwners();
  forgetGraph(owner);
}

async function sendLapseNotice(apiKey: string, email: string, day: 60 | 83) {
  const subject = day === 60
    ? "Your Clyde data will be removed in 30 days"
    : "Final notice: your Clyde data will be removed in 7 days";
  const body = day === 60
    ? [
      "Your Clyde subscription lapsed 60 days ago.",
      "Your notes and files are still safe to read and export at https://heyclyde.me/settings, or you can resubscribe at https://heyclyde.me/usage.",
      "If nothing changes, Clyde will delete your account and stored data 90 days after lapse.",
    ].join("\n\n")
    : [
      "Final reminder: your Clyde subscription lapsed 83 days ago.",
      "In 7 days, your Clyde account, notes, files, and sign-in record will be permanently deleted.",
      "Export your data now at https://heyclyde.me/settings or renew at https://heyclyde.me/usage.",
    ].join("\n\n");
  const r = await fetch(`${RESEND_URL()}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [email], subject, text: body }),
    signal: AbortSignal.timeout(15_000),
  });
  await r.body?.cancel().catch(() => {});
  if (!r.ok) throw new Error(`Resend answered ${r.status}`);
}

/** Daily job (POST /billing/lapse): sends day-60 and day-83 emails for lapsed accounts, and deletes after 90 days. */
export async function runLapseCleanup(): Promise<{ warned_60: number; warned_83: number; deleted: number; errors: number }> {
  const resendKey = await secret("resend_api_key");
  const rows = await root`select e.owner_id, a.email, e.lapsed_at,
      coalesce(e.lapse_emails_sent, '{}'::int[]) as sent,
      extract(epoch from (now() - e.lapsed_at)) / 86400.0 as age_days
    from memory.entitlement e
    join memory.account a on a.owner_id = e.owner_id
    where e.state = 'lapsed' and e.lapsed_at is not null
    order by e.lapsed_at asc`;

  let warned_60 = 0, warned_83 = 0, deleted = 0, errors = 0;
  for (const r of rows) {
    const owner = String(r.owner_id);
    const email = String(r.email ?? "");
    const sent = Array.isArray(r.sent) ? r.sent.map(Number) : [];
    const ageDays = Number(r.age_days ?? 0);
    try {
      if (ageDays >= 90 && sent.includes(60) && sent.includes(83)) {
        await deleteOwnerAccount(owner, "lapse_cron");
        deleted++;
      } else if (ageDays >= 83 && !sent.includes(83)) {
        if (!resendKey || !email) continue;
        await sendLapseNotice(resendKey, email, 83);
        await root`update memory.entitlement
          set lapse_emails_sent = array(select distinct x from unnest(coalesce(lapse_emails_sent, '{}'::int[]) || array[83]) x order by x),
              updated_at = now()
          where owner_id = ${owner}::uuid`;
        warned_83++;
      } else if (ageDays >= 60 && !sent.includes(60)) {
        if (!resendKey || !email) continue;
        await sendLapseNotice(resendKey, email, 60);
        await root`update memory.entitlement
          set lapse_emails_sent = array(select distinct x from unnest(coalesce(lapse_emails_sent, '{}'::int[]) || array[60]) x order by x),
              updated_at = now()
          where owner_id = ${owner}::uuid`;
        warned_60++;
      }
    } catch (e) {
      console.error(`lapse cleanup failed for ${owner}:`, e);
      errors++;
    }
  }
  return { warned_60, warned_83, deleted, errors };
}
