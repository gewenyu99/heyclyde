// The signed-in owner's own routes (R55 for the reviewer account; the site's browser, R51, and R60-R65 pages build on them).
// Each request runs inside the owner's tenant (R49), so every query here sees only that owner's rows.
import { sql } from "./db.ts";
import { AGENT_CONTEXTS, AGENT_TYPES, normalizeComputer, normalizeProjectSlug } from "./permissions.ts";
import { forgetGraph } from "./search.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NICKNAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const RESERVED_NAMES = new Set(["claude", "codex", "all", "wen", "memory"]);
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const MAX_JSON_BODY = 64 * 1024;

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

/** Owner-scoped /me endpoints: entries, agents, and devices (more /me routes arrive with R60, R62-R65). */
export async function handle(req: Request, path: string, owner: string): Promise<Response> {
  if (path === "/me/entries" && req.method === "GET") {
    const rows = await sql`select id, title, pattern, project, created_at from memory.entry order by created_at desc, id limit 1000`;
    return json({ total: rows.length, entries: rows });
  }
  let m = /^\/me\/entries\/([^/]+)$/.exec(path);
  if (m && req.method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return json({ error: "That isn't an entry id." }, 400);
    const gone = await sql.begin(async (tx) => {
      await tx`delete from memory.co_use where src = ${id} or dst = ${id}`;
      await tx`delete from memory.link where src = ${id} or dst = ${id}`;
      await tx`update memory.entry set project = null where project = ${id} and id <> ${id}`;
      return await tx`delete from memory.entry where id = ${id} returning id`;
    });
    if (!gone.length) return json({ error: `No entry ${id}.` }, 404);
    forgetGraph(owner);
    return json({ deleted: id });
  }

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

  return json({ error: "No such endpoint." }, 404);
}
