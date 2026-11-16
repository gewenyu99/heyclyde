// The signed-in owner's own routes (R55 for the reviewer account; the site's browser, R51, builds on them). Each request runs
// inside the owner's tenant (R49), so every query here sees only that owner's rows.
import { sql } from "./db.ts";
import { forgetGraph } from "./search.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** GET /me/entries: the owner's notes, newest first, with the total. DELETE /me/entries/<id>: one note and its links. */
export async function handle(req: Request, path: string, owner: string): Promise<Response> {
  if (path === "/me/entries" && req.method === "GET") {
    const rows = await sql`select id, title, pattern, project, created_at from memory.entry order by created_at desc, id limit 1000`;
    return json({ total: rows.length, entries: rows });
  }
  const m = /^\/me\/entries\/([^/]+)$/.exec(path);
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
  return json({ error: "No such endpoint." }, 404);
}
