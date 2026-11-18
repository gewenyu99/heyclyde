// R47: the quest board. An agent posts a quest, another claims it under a lease, reports progress, and completes it with
// evidence and the entry its work produced. A completed quest becomes a history note, so recall answers "what did agents do
// about X". board() is the at-most-5-line summary the SessionStart hook and the hook inbox print.
import { OverBudget } from "./budget.ts";
import { SHA_RE } from "./blobs.ts";
import { type Row, type Sql, sql } from "./db.ts";
import { screen } from "./judge.ts";
import { redactText } from "./redact.ts";
import { agentName, claimMessages, messageLine } from "./service.ts";
import { Refused, remember } from "./write.ts";
import {
  AGENT_CONTEXTS,
  AGENT_TYPES,
  type AgentScope,
  allowedRealms,
  canReadEntry,
  normalizeComputer,
  normalizeProjectSlug,
  questPermitted,
  questWhereSql,
} from "./permissions.ts";

/** The agent calling: the name it writes under, its client family (claude, codex or its own client name), its credential, its
 * MCP session, and its registered context and permission scope, if it has one. */
export type Who = {
  name: string;
  family: string;
  principal: string;
  session: string | null;
  context: string | null;
  profile: string | null;
  computer?: string | null;
  projects?: string[];
  agentType?: string | null;
  strictProjects?: boolean;
  sessionRepo?: string | null;
};

const whoToScope = (who: Who): AgentScope =>
  who.context === null ? null : {
    name: who.name,
    context: who.context,
    computer: who.computer ?? null,
    projects: who.projects ?? [],
    agentType: who.agentType ?? "other",
    strictProjects: Boolean(who.strictProjects),
    sessionRepo: who.sessionRepo ?? null,
    principal: who.principal,
  };

export const LEASE_MINUTES = 120;
const LEASE_MIN = 15, LEASE_MAX = 480;
const PRIORITIES = ["high", "normal", "low"];
const CONTEXTS: string[] = [...AGENT_CONTEXTS];
const SHOWS = ["open", "mine", "done", "all"];
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// Control characters but newline and tab, NUL included, which Postgres refuses.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g;
export const BOARD_LINES = 5;

const s = (v: unknown) => typeof v === "string" ? v : "";
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const clip = (t: string, n: number) => t.length > n ? t.slice(0, n - 1) + "…" : t;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const hhmm = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** A text field, trimmed, or an error line. */
function field(errs: string[], v: unknown, name: string, max: number, required = true): string {
  if (v !== undefined && v !== null && typeof v !== "string") {
    errs.push(`${name} must be text.`);
    return "";
  }
  const t = s(v).replace(CONTROL, " ").trim();
  if (required && !t) errs.push(`${name} is required.`);
  if (t.length > max) errs.push(`${name} is ${t.length} characters. The most is ${max}.`);
  return t;
}

/** A quest id from a tool argument: 12, "12" or "#12". */
function questId(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^#?\d{1,15}$/.test(v.trim()) ? Number(v.trim().replace("#", "")) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Refused("Need the quest's id, like 12, from list_quests.");
  return n;
}

/** The judge reads what other agents will be shown. Its refusal and its silence both stop the write. */
async function judged(text: string, verb: string) {
  let why: string | null;
  try {
    why = await screen(text);
  } catch (err) {
    if (err instanceof OverBudget) throw new Refused(`Not ${verb}: memory is over its budget this month (${err.message}).`);
    throw new Refused(`Not ${verb}: memory couldn't screen this right now, so it changed nothing. Try again later.`);
  }
  if (why) throw new Refused(`Not ${verb}: ${why}`);
}

/** Artifacts a quest links: [{name, sha256}] of blobs memory already holds on some entry that isn't private. */
async function artifacts(errs: string[], raw: unknown, agentScope: AgentScope = null): Promise<{ name: string; sha256: string }[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 8) {
    errs.push("artifacts must be a list of at most 8 {name, sha256}.");
    return [];
  }
  const out: { name: string; sha256: string }[] = [];
  for (const a of raw) {
    const name = s(a?.name).replace(CONTROL, " ").trim(), sha = s(a?.sha256).trim().toLowerCase();
    if (!name || name.length > 200 || !SHA_RE.test(sha)) {
      errs.push("Each artifact needs a name of up to 200 characters and the sha256 of a blob memory holds.");
      return [];
    }
    if (out.some((o) => o.name === name)) {
      errs.push(`Two artifacts are named ${name}.`);
      return [];
    }
    out.push({ name, sha256: sha });
  }
  // A private entry's blob can't be cited by hash: that would tell anyone who guessed the file that memory has it.
  const rows = await sql`select x.sha256, e.sensitivity, e.category, e.context, e.transferability, e.project_slug, e.computer, e.pattern, e.scope
    from memory.entry_blob x join memory.entry e on e.owner_id = x.owner_id and e.id = x.entry_id
    where x.owner_id = memory.owner_default() and x.sha256 = any(${out.map((o) => o.sha256)}::text[]) and e.sensitivity <> 'private'`;
  const held = new Set(rows.filter((r) => canReadEntry(agentScope, r)).map((r) => r.sha256 as string));
  for (const o of out) if (!held.has(o.sha256)) errs.push(`memory holds no artifact ${o.sha256}. Attach the file to a note with remember first.`);
  return out;
}

/** Quest contexts an agent of this context works in. null is every context. */
const contextsFor = (ctx: string | null) => {
  const realms = allowedRealms(ctx);
  return realms === null ? CONTEXTS : [...realms, "both"];
};
/** Who may claim a quest: anyone, the agent's family, or the agent by name. */
const claimants = (who: Pick<Who, "name" | "family">) => [...new Set(["any", who.name, who.family])];
const mayClaim = (q: Row, who: Who) => claimants(who).includes(q.assignee);

export async function reopenExpired(db: Sql = sql) {
  await db`select memory.reopen_expired_quests()`;
}

/** post_quest */
export async function postQuest(who: Who, args: Record<string, unknown>) {
  const errs: string[] = [];
  const title = oneLine(field(errs, args.title, "title", 120));
  const brief = field(errs, args.brief, "brief", 500);
  const doneWhen = field(errs, args.done_when, "done_when", 300);
  const priority = s(args.priority).trim().toLowerCase() || "normal";
  if (!PRIORITIES.includes(priority)) errs.push("priority must be high, normal or low.");
  const context = s(args.context).trim().toLowerCase() || (who.context ?? "both");
  if (!CONTEXTS.includes(context)) errs.push("context must be work, home, hobby, personal or both.");
  const assignee = s(args.for ?? args.assignee).trim().toLowerCase() || "any";
  if (!NAME.test(assignee)) errs.push("for must be any, claude, codex or an agent's name.");
  let project: string | null = null;
  if (args.project !== undefined && args.project !== null && args.project !== "") {
    project = normalizeProjectSlug(args.project);
    if (!project) errs.push("project must be a valid project slug like clyde or owner/repo.");
  }
  let computer: string | null = null;
  if (args.computer !== undefined && args.computer !== null && args.computer !== "") {
    computer = normalizeComputer(args.computer);
    if (!computer) errs.push("computer must be 1 to 64 characters.");
  }
  let agentType: string | null = null;
  if (args.agent_type !== undefined && args.agent_type !== null && args.agent_type !== "") {
    const t = s(args.agent_type).trim().toLowerCase();
    if (!(AGENT_TYPES as readonly string[]).includes(t)) {
      errs.push(`agent_type must be one of ${AGENT_TYPES.join(", ")}.`);
    } else {
      agentType = t;
    }
  }
  let tags: string[] = [];
  if (args.tags !== undefined && args.tags !== null) {
    const raw = Array.isArray(args.tags) ? args.tags : [args.tags];
    tags = [...new Set(raw.map((t) => s(t).trim().toLowerCase()))];
    if (tags.length > 8 || !tags.every((t) => NAME.test(t))) errs.push("tags: at most 8, each lowercase letters, digits, - and _, up to 40 characters.");
  }
  const files = await artifacts(errs, args.artifacts, whoToScope(who));
  if (errs.length) throw new Refused(errs.join("\n"));
  const [t, b, d] = [title, brief, doneWhen].map((x) => redactText(x)[0]);
  await judged([t, b, d].join("\n\n"), "posted");
  const id = await sql.begin(async (tx) => {
    const [q] = await tx`insert into memory.quest (title, brief, done_when, tags, priority, context, assignee, project, computer, agent_type,
        posted_by, posted_device, posted_session)
      values (${t}, ${b}, ${d}, ${tags}::text[], ${priority}, ${context}, ${assignee}, ${project}, ${computer}, ${agentType},
        ${who.name}, ${who.principal}, ${who.session})
      returning id`;
    await tx`insert into memory.quest_note (quest_id, author, device, kind) values (${q.id}, ${who.name}, ${who.principal}, 'post')`;
    for (const f of files) await tx`insert into memory.quest_blob (quest_id, name, sha256, role) values (${q.id}, ${f.name}, ${f.sha256}, 'brief')`;
    return Number(q.id);
  });
  return `Posted quest #${id}: ${t}. It's open on the board for ${assignee === "any" ? "any agent" : assignee} (${context}, ${priority}). ` +
    "Agents see it when their session starts and in list_quests. You'll find its progress there too.";
}

/** One quest as a list line. */
function questLine(q: Row) {
  const proj = q.project ? `, ${q.project}` : "";
  const head = `- #${q.id} [${q.priority}, ${q.context}${proj}] ${oneLine(q.title)} (from ${q.posted_by}${q.assignee !== "any" ? `, for ${q.assignee}` : ""})`;
  if (q.state === "claimed") return `${head}. Claimed by ${q.claimed_by} until ${hhmm(q.lease_until)}.`;
  if (q.state === "done") {
    return `${head}. Done by ${q.claimed_by} on ${hhmm(q.closed_at).slice(0, 10)}: ${clip(oneLine(q.evidence ?? ""), 300)} ` +
      `(entry ${q.result_entry ?? "gone"}${q.history_entry ? `, history ${q.history_entry}` : ""}).`;
  }
  if (q.state === "abandoned") return `${head}. Abandoned.`;
  const tags = q.tags?.length ? ` Tags: ${q.tags.join(", ")}.` : "";
  return `${head}. Done when: ${clip(oneLine(q.done_when), 160)}${tags}`;
}

/** list_quests */
export async function listQuests(who: Who, args: Record<string, unknown>) {
  const show = s(args.show).trim().toLowerCase() || "open";
  if (!SHOWS.includes(show)) throw new Refused("show must be open, mine, done or all.");
  const ctxArg = s(args.context).trim().toLowerCase();
  if (ctxArg && ![...CONTEXTS, "all"].includes(ctxArg)) throw new Refused("context must be work, home, hobby, personal, both or all.");
  let projectFilter: string | null = null;
  if (args.project !== undefined && args.project !== null && args.project !== "") {
    projectFilter = normalizeProjectSlug(args.project);
    if (!projectFilter) throw new Refused("project must be a valid project slug like clyde or owner/repo.");
  }
  const scope = whoToScope(who);
  const ctx = ctxArg === "all" ? null : ctxArg || who.context;
  const requested = ctxArg === "all" ? CONTEXTS : ctxArg === "both" ? CONTEXTS : contextsFor(ctx);
  const contexts = show === "mine"
    ? CONTEXTS
    : scope && scope.context !== "both"
    ? requested.filter((c) => contextsFor(scope.context).includes(c))
    : requested;
  const tag = s(args.tag).trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
  await reopenExpired();
  const states = show === "open" ? ["open"] : show === "done" ? ["done"] : ["open", "claimed", "done", "abandoned"];
  const rows = await sql`select q.*, count(*) over () as total from memory.quest q
    where q.state = any(${states}::text[]) and q.context = any(${contexts}::text[])
      and (${tag}::text = '' or q.tags @> array[${tag}::text])
      and (${show}::text <> 'open' or q.assignee = any(${claimants(who)}::text[]))
      and (${show}::text <> 'mine' or q.claimed_by = ${who.name}::text or q.posted_by = ${who.name}::text)
      ${questWhereSql(sql, "q", scope, projectFilter)}
    order by case when ${show}::text = 'open' then array_position(array['high', 'normal', 'low'], q.priority) else 0 end,
      coalesce(q.closed_at, q.updated_at) desc, q.id desc
    limit ${limit}`;
  if (!rows.length) return show === "open" ? "No open quests for you. post_quest puts one on the board." : "No quests match.";
  const total = Number(rows[0].total);
  const where = show === "mine" ? "" : ` (${ctx ?? "every"} context${tag ? `, tag ${tag}` : ""})`;
  const head = `${plural(total, show === "open" ? "open quest" : show === "done" ? "done quest" : "quest")}${show === "mine" ? " you posted or claimed" : ""}${where}` +
    (total > rows.length ? `, newest ${rows.length} shown` : "") + ".";
  const next = show === "open" ? " claim_quest {id} takes one. Its done_when says when it's finished." : "";
  return [head + next, ...rows.map(questLine)].join("\n");
}

/** A claimed quest in full: what to do, how to tell it's done, its artifacts and its last notes. */
async function briefing(db: Sql, q: Row) {
  const files = await db`select x.name, x.sha256, x.role, b.size from memory.quest_blob x
    join memory.blob b on b.owner_id = x.owner_id and b.sha256 = x.sha256
    where x.quest_id = ${q.id} order by x.role, x.name`;
  const notes = await db`select author, kind, body, created_at from memory.quest_note where quest_id = ${q.id} order by id desc limit 5`;
  return [
    `Brief: ${q.brief}`,
    `Done when: ${q.done_when}`,
    ...(files.length ? ["Artifacts (open with get_blob):", ...files.map((f) => `- ${f.name}: ${f.sha256} (${f.size} bytes)`)] : []),
    ...(notes.length ? ["Latest notes:", ...notes.reverse().map((n) => `- ${hhmm(n.created_at)} ${n.author} ${n.kind}${n.body ? `: ${clip(oneLine(n.body), 300)}` : ""}`)] : []),
  ].join("\n");
}

/** claim_quest. The row is taken with skip locked: a quest another claim holds right now is refused, never waited on. */
export async function claimQuest(who: Who, args: Record<string, unknown>) {
  const id = questId(args.id);
  const minutes = args.lease_minutes === undefined ? LEASE_MINUTES : Number(args.lease_minutes);
  if (!Number.isInteger(minutes) || minutes < LEASE_MIN || minutes > LEASE_MAX) {
    throw new Refused(`lease_minutes must be a whole number from ${LEASE_MIN} to ${LEASE_MAX}.`);
  }
  await reopenExpired();
  return await sql.begin(async (tx) => {
    const [q] = await tx`select * from memory.quest where id = ${id} for update skip locked`;
    if (!q) {
      const [there] = await tx`select id from memory.quest where id = ${id}`;
      throw new Refused(there ? `Quest #${id} is being claimed by another agent right now.` : `No quest #${id}.`);
    }
    if (q.state === "done" || q.state === "abandoned") throw new Refused(`Quest #${id} is ${q.state}, so it can't be claimed.`);
    const mine = q.state === "claimed" && q.claimed_by === who.name && q.claimed_device === who.principal;
    if (q.state === "claimed" && !mine) throw new Refused(`Quest #${id} is already claimed by ${q.claimed_by} until ${hhmm(q.lease_until)}.`);
    if (!mayClaim(q, who)) throw new Refused(`Quest #${id} is for ${q.assignee}, so ${who.name} can't claim it.`);
    const perm = questPermitted(whoToScope(who), q);
    if (!perm.ok) throw new Refused(`Quest #${id} is outside ${who.name}'s permissions: ${perm.reason}.`);
    const [c] = await tx`update memory.quest set state = 'claimed', claimed_by = ${who.name}, claimed_device = ${who.principal},
        claimed_session = ${who.session}, claimed_at = coalesce(case when ${mine} then claimed_at end, now()),
        lease_minutes = ${minutes}, lease_until = now() + make_interval(mins => ${minutes}::int), updated_at = now()
      where id = ${id} returning lease_until`;
    await tx`insert into memory.quest_note (quest_id, author, device, kind) values (${id}, ${who.name}, ${who.principal}, 'claim')`;
    return `Claimed quest #${id}: ${q.title}. Your lease runs until ${hhmm(c.lease_until)} (${minutes} minutes).\n` +
      `${await briefing(tx, q)}\n` +
      "Next: update_quest {id, note} reports progress and renews the lease. complete_quest {id, evidence, entry_id} once done_when " +
      "holds: remember what the work produced first and pass that entry's id. abandon_quest {id, reason} puts it back on the board.";
  });
}

/** The quest, locked, when this agent holds its claim. Otherwise a refusal that says who does. */
async function held(tx: Sql, id: number, who: Who) {
  const [q] = await tx`select * from memory.quest where id = ${id} for update`;
  if (!q) throw new Refused(`No quest #${id}.`);
  if (q.state === "claimed" && q.claimed_by === who.name && q.claimed_device === who.principal) return q;
  if (q.state === "claimed") throw new Refused(`Quest #${id} is claimed by ${q.claimed_by}, not you.`);
  if (q.state === "open") throw new Refused(`Quest #${id} is open, not claimed by you. If your lease ran out, claim_quest it again.`);
  throw new Refused(`Quest #${id} is ${q.state}.`);
}

/** update_quest: a progress note, which renews the lease. */
export async function updateQuest(who: Who, args: Record<string, unknown>) {
  const id = questId(args.id);
  const errs: string[] = [];
  const note = redactText(field(errs, args.note, "note", 1000))[0];
  if (errs.length) throw new Refused(errs.join("\n"));
  await reopenExpired();
  await sql.begin(async (tx) => await held(tx, id, who));
  await judged(note, "added");
  return await sql.begin(async (tx) => {
    await held(tx, id, who);
    const [q] = await tx`update memory.quest set lease_until = now() + make_interval(mins => lease_minutes), updated_at = now()
      where id = ${id} returning lease_until`;
    await tx`insert into memory.quest_note (quest_id, author, device, kind, body) values (${id}, ${who.name}, ${who.principal}, 'progress', ${note})`;
    return `Noted on quest #${id}. Your lease now runs until ${hhmm(q.lease_until)}.`;
  });
}

/** complete_quest: evidence, the entry the work produced, and a history note memory writes, linked to that entry. */
export async function completeQuest(who: Who, args: Record<string, unknown>) {
  const id = questId(args.id);
  const errs: string[] = [];
  const evidence = redactText(field(errs, args.evidence, "evidence", 2000))[0];
  const entry = field(errs, args.entry_id, "entry_id", 200);
  const scope = whoToScope(who);
  const files = await artifacts(errs, args.artifacts, scope);
  if (entry) {
    const [entryRow] = await sql`select sensitivity, category, context, transferability, project_slug, computer, pattern, scope
      from memory.entry where owner_id = memory.owner_default() and id = ${entry}`;
    if (!entryRow) {
      errs.push(`No entry ${entry}. Remember what the work produced, then pass that entry's id.`);
    } else if (!canReadEntry(scope, entryRow)) {
      errs.push(`Entry ${entry} is outside your permissions.`);
    }
  }
  if (errs.length) throw new Refused(errs.join("\n"));
  await reopenExpired();
  const q = await sql.begin(async (tx) => await held(tx, id, who));
  // The history note goes through remember, so it's judged, redacted, embedded and carries this agent's provenance.
  let history: string;
  try {
    const body = clip(oneLine(`${q.brief} Done when: ${q.done_when} ${who.name} did it: ${evidence}`), 500);
    const qCtx = q.context === "both" ? "general" : q.context;
    const qTr = q.project ? "project" : q.context === "both" ? "general" : "context";
    const wrote = await remember({
      pattern: "observations", title: `Quest #${id} done: ${q.title}`, body, evidence, kind: "observation", evidence_kind: "summary",
      authority: "draft", sensitivity: "normal", lang: "en", scope: null, project: null, valid_from: null, evidence_event: null,
      links: [{ type: "relates", to: entry }], supersedes: [], blobs: [],
      context: qCtx, transferability: qTr, ...(q.project ? { project_slug: q.project } : {}),
    }, "agent", who.name, who.principal, {
      agent: who.name, context: who.context, session: who.session, profile: who.profile,
      computer: who.computer, projects: who.projects, repo: who.sessionRepo, agentScope: scope,
    });
    history = wrote.id;
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    throw new Refused(`Not completed: ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}`);
  }
  return await sql.begin(async (tx) => {
    await held(tx, id, who);
    await tx`update memory.quest set state = 'done', evidence = ${evidence}, result_entry = ${entry}, history_entry = ${history},
      lease_until = null, closed_at = now(), updated_at = now() where id = ${id}`;
    await tx`insert into memory.quest_note (quest_id, author, device, kind, body) values (${id}, ${who.name}, ${who.principal}, 'done', ${evidence})`;
    for (const f of files) {
      await tx`insert into memory.quest_blob (quest_id, name, sha256, role) values (${id}, ${f.name}, ${f.sha256}, 'evidence')
        on conflict (quest_id, name) do nothing`;
    }
    return `Completed quest #${id}: ${q.title}. memory keeps it as history note ${history}, linked to ${entry}, and list_quests ` +
      `{show: "done"} shows it to every agent.`;
  });
}

/** abandon_quest: the claimer puts it back on the board, the poster withdraws it for good. */
export async function abandonQuest(who: Who, args: Record<string, unknown>) {
  const id = questId(args.id);
  const errs: string[] = [];
  const reason = redactText(field(errs, args.reason, "reason", 500))[0];
  if (errs.length) throw new Refused(errs.join("\n"));
  await reopenExpired();
  const role = async (tx: Sql) => {
    const [q] = await tx`select * from memory.quest where id = ${id} for update`;
    if (!q) throw new Refused(`No quest #${id}.`);
    if (q.state === "done" || q.state === "abandoned") throw new Refused(`Quest #${id} is already ${q.state}.`);
    if (q.state === "claimed" && q.claimed_by === who.name && q.claimed_device === who.principal) return { q, release: true };
    if (q.posted_by === who.name && q.posted_device === who.principal) return { q, release: false };
    throw new Refused(`Only quest #${id}'s claimer${q.claimed_by ? ` (${q.claimed_by})` : ""} or its poster (${q.posted_by}) can abandon it.`);
  };
  await sql.begin(role);
  await judged(reason, "abandoned");
  return await sql.begin(async (tx) => {
    const { q, release } = await role(tx);
    if (release) {
      await tx`update memory.quest set state = 'open', claimed_by = null, claimed_device = null, claimed_session = null, claimed_at = null,
        lease_until = null, updated_at = now() where id = ${id}`;
      await tx`insert into memory.quest_note (quest_id, author, device, kind, body) values (${id}, ${who.name}, ${who.principal}, 'release', ${reason})`;
      return `Released quest #${id}: ${q.title}. It's open on the board again, with your reason in its notes.`;
    }
    await tx`update memory.quest set state = 'abandoned', lease_until = null, closed_at = now(), updated_at = now() where id = ${id}`;
    await tx`insert into memory.quest_note (quest_id, author, device, kind, body) values (${id}, ${who.name}, ${who.principal}, 'abandon', ${reason})`;
    return `Withdrew quest #${id}: ${q.title}. It's abandoned and no one can claim it.`;
  });
}

/** The scope of the agent a hook speaks for: the registered agent of that name, or the one this credential's client of
 * that family registered as. null when there is none, or more than one distinct agent. */
async function hookAgent(principal: string, agent: string): Promise<AgentScope> {
  const rows = await sql`select distinct a.name, a.context, a.computer, a.projects, a.agent_type, a.strict_projects
    from memory.agent a
    where a.owner_id = memory.owner_default()
      and (a.name = ${agent} or exists (select 1 from memory.agent_binding b
        where b.owner_id = a.owner_id and b.principal = ${principal} and b.agent = a.name and memory.agent_name(b.client) = ${agent}))`;
  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    name: r.name,
    context: r.context,
    computer: r.computer ?? null,
    projects: r.projects ?? [],
    agentType: r.agent_type ?? "other",
    strictProjects: Boolean(r.strict_projects),
    principal,
  };
}

/** Whether the agent a hook speaks for has registered (R78): one registered agent by that name, or one this credential's
 * client of that family registered as. */
export async function registered(principal: string, agent: string): Promise<boolean> {
  const [row] = await sql`select 1 from memory.agent a
    where a.owner_id = memory.owner_default()
      and (a.name = ${agent} or exists (select 1 from memory.agent_binding b
        where b.owner_id = a.owner_id and b.principal = ${principal} and b.agent = a.name and memory.agent_name(b.client) = ${agent}))
    limit 1`;
  return Boolean(row);
}

/** The board a hook prints, in at most 5 lines: unread messages, acknowledged as they print, then open quests this agent may
 * claim in its context. "start" (SessionStart) shows every open quest under a one-line summary. "prompt" (the hook inbox) shows
 * only quests posted since this computer's agent last saw the board, in the inbox's own format. "" when there is nothing. */
export async function board(principal: string, agent: string, mode: "start" | "prompt"): Promise<string> {
  const scope = await hookAgent(principal, agent);
  const ctx = scope?.context ?? null;
  await reopenExpired();
  const [seen] = await sql`select last_quest from memory.board_seen where principal = ${principal} and agent = ${agent}`;
  const after = mode === "prompt" ? Number(seen?.last_quest ?? 0) : 0;
  const who = { name: agent, family: agentName(agent) };
  const quests = await sql`select q.*, count(*) over () as total from memory.quest q
    where q.state = 'open' and q.id > ${after} and q.context = any(${contextsFor(ctx)}::text[]) and q.assignee = any(${claimants(who)}::text[])
      ${questWhereSql(sql, "q", scope)}
    order by array_position(array['high', 'normal', 'low'], q.priority), q.id desc limit ${BOARD_LINES}`;
  const [{ n }] = await sql`select count(*)::int as n from memory.message_delivery d
    join memory.message m on m.owner_id = d.owner_id and m.id = d.message_id
    where d.recipient = ${agent} and d.acked_at is null and d.dropped_at is null and d.visible_after <= now() and m.expires_at > now()`;
  const M = Number(n), Q = quests.length ? Number(quests[0].total) : 0;
  const [{ top }] = await sql`select coalesce(max(id), 0) as top from memory.quest`;
  await sql`insert into memory.board_seen (principal, agent, last_quest) values (${principal}, ${agent}, ${top})
    on conflict (owner_id, principal, agent) do update set last_quest = greatest(memory.board_seen.last_quest, excluded.last_quest), seen_at = now()`;
  if (!M && !Q) return "";
  // Headers first, then items, messages before quests, and a last line for what didn't fit.
  const headers = mode === "start" ? 1 : (M ? 1 : 0) + (Q ? 1 : 0);
  let slots = BOARD_LINES - headers, sm = M, sq = Q;
  if (M + Q > slots) {
    slots -= 1;
    sm = Math.min(M, Q ? slots - 1 : slots);
    sq = Math.min(Q, slots - sm);
  }
  const msgs = sm ? await claimMessages(agent, true, sm) : [];
  const more = M - msgs.length + Q - sq;
  const mLines = msgs.map((r: Row) => messageLine({ ...r, body: oneLine(r.body) }, r.message_id));
  const qLines = quests.slice(0, sq).map((q) =>
    `- quest #${q.id} [${q.priority}, ${q.context}] ${oneLine(q.title)} (from ${q.posted_by}${q.assignee !== "any" ? `, for ${q.assignee}` : ""}). ` +
    `Done when: ${clip(oneLine(q.done_when), 120)}`
  );
  const tail = more > 0 ? [`- and ${more} more: check_messages reads your messages, list_quests shows the board.`] : [];
  if (mode === "start") {
    return [`memory board: ${plural(M, "unread message")}, ${plural(Q, "open quest")} for you${ctx ? ` (${ctx})` : ""}. ` +
      "claim_quest takes a quest.", ...mLines, ...qLines, ...tail].join("\n") + "\n";
  }
  return [
    ...(mLines.length || M ? ["Messages from your other agents (reply with post_message):", ...mLines] : []),
    ...(Q ? ["New on memory's quest board (claim_quest takes one):", ...qLines] : []),
    ...tail,
  ].join("\n") + "\n";
}
