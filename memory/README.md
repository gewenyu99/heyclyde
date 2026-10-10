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

## Fair arms

Every arm gets its best implementation before any comparison counts. A bad number is a question, not a verdict.

- **Place every miss in the funnel.** `retrieval_eval.py --misses` says whether the gold entry was never retrieved, ranked out of the packet, or cut by the token budget. For A1 it also gives the rank in each ranker.
- **Name the cause.** A loss is implementation (tokenizer, query construction, fusion, embedding text) until it's shown to be the design's limit. Fix implementation causes in every arm they touch.
- **Tune on train, report test once.** Knobs move only on the train split. The test split is read after the knobs are frozen.
- **Keep what earns its place.** Each change is ablated alone. Stemming and IDF were tried in A0 and dropped, since they cost hits or changed nothing.

The first pass found an implementation bug, not a design limit. A1's fusion counted keyword evidence twice and buried entries both rankers had first. With that fixed, A1 went from 74% to 90% on train and 6 of 6 on test. Its remaining misses need a link from a task to Wen's preferences, which is A2's job.

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
