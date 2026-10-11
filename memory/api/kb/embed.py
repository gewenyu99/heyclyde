"""bge-m3 embeddings from the Ollama container on the Droplet. Nothing leaves the server."""
import hashlib

import httpx

from .config import config

DIM = 1024
UPSERT = ("insert into entry_embedding (entry_id, model, content_sha256, embedding) values (%s, %s, %s, %s::vector) "
          "on conflict (entry_id) do update set model = excluded.model, content_sha256 = excluded.content_sha256, "
          "embedding = excluded.embedding, updated_at = now()")


def entry_text(row):
    """The same text keyword search reads: the entry plus its project's title (see search_text in db/schema.sql)."""
    return row["search_text"] or "\n".join(s for s in (row["title"], row["body"], row["evidence"]) if s)


def content_sha(text):
    return hashlib.sha256(f"{config.embed_model}\n{text}".encode()).hexdigest()


async def embed(texts, client=None):
    own = client is None
    client = client or httpx.AsyncClient(timeout=120)
    try:
        r = await client.post(f"{config.ollama_url}/api/embed", json={"model": config.embed_model, "input": texts})
        r.raise_for_status()
        vecs = r.json()["embeddings"]
    finally:
        if own:
            await client.aclose()
    if len(vecs) != len(texts) or any(len(v) != DIM for v in vecs):
        raise ValueError(f"{config.embed_model} returned {len(vecs)} vectors, expected {len(texts)} of {DIM}")
    return vecs


def to_pgvector(vec):
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


async def has_vector(conn):
    cur = await conn.execute("select to_regclass('entry_embedding') is not null as ok")
    return (await cur.fetchone())["ok"]


async def sync_embeddings(pool, batch=16):
    """Embed every entry whose text changed since its last embedding. Returns the count embedded.

    It checks out a connection to read and one per batch to store, never one while Ollama works. The pool holds 4."""
    async with pool.connection() as conn:
        if not await has_vector(conn):
            return 0
        cur = await conn.execute(
            "select e.id, e.title, e.body, e.evidence, e.search_text, x.content_sha256 from entry e "
            "left join entry_embedding x on x.entry_id = e.id")
        rows = await cur.fetchall()
    stale = [(r, entry_text(r)) for r in rows]
    stale = [(r, t) for r, t in stale if r["content_sha256"] != content_sha(t)]
    async with httpx.AsyncClient(timeout=300) as client:
        for i in range(0, len(stale), batch):
            chunk = stale[i:i + batch]
            vecs = await embed([t for _, t in chunk], client)
            async with pool.connection() as conn:
                for (r, t), v in zip(chunk, vecs):
                    await conn.execute(UPSERT, (r["id"], config.embed_model, content_sha(t), to_pgvector(v)))
    return len(stale)


async def embed_entry(pool, entry_id):
    """Embed one fresh entry now, so vector search sees it before the next sync. False when there's no vector table.

    Like sync_embeddings, it holds no connection while Ollama works, so a slow embedding never starves recall."""
    async with pool.connection() as conn:
        if not await has_vector(conn):
            return False
        cur = await conn.execute("select title, body, evidence, search_text from entry where id = %s", (entry_id,))
        text = entry_text(await cur.fetchone())
    # A write waits on this, so give up sooner than the bulk sync does.
    async with httpx.AsyncClient(timeout=30) as client:
        [vec] = await embed([text], client)
    async with pool.connection() as conn:
        await conn.execute(UPSERT, (entry_id, config.embed_model, content_sha(text), to_pgvector(vec)))
    return True


async def pull_model():
    """Ask Ollama to pull the embedding model. A no-op when it is already present."""
    async with httpx.AsyncClient(timeout=None) as client:
        r = await client.post(f"{config.ollama_url}/api/pull", json={"model": config.embed_model, "stream": False})
        r.raise_for_status()
