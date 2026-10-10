# memory

Wen's personal knowledge graph, served to Claude Code and Codex through one MCP endpoint. It runs the PKG v1 experiment: several retrieval arms read the same store, and the arm your agents follow most consistently wins.

Phase 0 is built. A0 and A1 serve live, hooks log every session, and the decider run-off has its keyword baseline. A2, A3 Hindsight and the idle audit come in Phase 1.

## The parts

| Path | Does |
|---|---|
| `seed/build.py` | Validates a Markdown vault and compiles it to `seed.sql` and `INDEX.md` |
| `seed/import_chats.py` | Turns Grok, Codex and claude.ai exports into inbox lines |
| `db/` | Postgres 17 image with pgvector and pg_jieba, plus the runtime schema |
| `api/kb/` | The server: MCP tools, hook endpoint, arms, embeddings, decider |
| `hooks/` | `kb-hook` and the Claude Code and Codex config snippets |
| `deploy/` | Droplet provisioning, compose stack, Caddy, restic backups |
| `eval/` | Retrieval eval on the practice queries, decider run-off on the reactions |
| `tests/` | Unit and database tests on a made-up vault |

## Where the data lives

The Postgres database on the Droplet is the store of record. The vault is a seed and import format, and it never enters this repo. Point `PKG_SEED_DIR` at a private copy.

Private entries never leave the Droplet unredacted. The agent and the decider see their title and id only.

## The arms

| Arm | Status | What `recall` returns |
|---|---|---|
| A0 | live | Index lines matching the query's words, replaced entries struck through. The agent opens them with `get_entry` |
| A1 | live | English and 中文 keyword search plus bge-m3 vectors, merged by reciprocal rank. Current entries only |
| A2 | Phase 1 | A1's top 50, spreading recall over typed links, filter, learned link-type weights |
| A3 | Phase 1 | Hindsight, loaded from the same store |

Each MCP session draws an arm at random on its first call and keeps it. The tools, their descriptions and the packet shape are identical across arms, so the agent can't tell which one it got. Every packet is capped at 8 items and 1,500 tokens.

## The tools

- **`recall(query, task)`.** Searches memory. The packet starts with a retrieval id.
- **`get_entry(id)`.** Opens one entry with its evidence, source and links.
- **`feedback(retrieval_id, verdict)`.** The agent's own report. Logged, never moves weights alone.

## Run the tests

```bash
pip install -r api/requirements.txt pytest pytest-asyncio
pytest                                               # unit tests, database tests skip
KB_TEST_DATABASE_URL=postgresql://... pytest         # adds the database tests on a scratch kb_pytest database
```

## Run the evals

```bash
DATABASE_URL=postgresql://... python eval/retrieval_eval.py --split test
PKG_SEED_DIR=~/pkg-seed OPEN_AI=... python eval/decider_eval.py --out /tmp/decider.json
```

`decider_eval.py` writes Wen's words to `--out`, so keep that file out of git.

## Deploy

See [DEPLOY.md](DEPLOY.md).
