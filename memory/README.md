# memory

Wen's personal knowledge graph, served to Claude Code and Codex through one MCP endpoint. It runs the PKG v1 experiment: several retrieval arms read the same store, and the arm your agents follow most consistently wins. clyde-flow hands work between stages through it, over HTTP.

Phase 0 is built. The index and hybrid arms serve live, hooks log every session, and the decider run-off has its keyword baseline. The spreading and hindsight arms and the idle audit come in Phase 1.

## The parts

| Path | Does |
|---|---|
| `seed/build.py` | Validates a Markdown vault and compiles it to `seed.sql` and `INDEX.md` |
| `seed/import_chats.py` | Turns Grok, Codex and claude.ai exports into inbox lines |
| `db/` | Postgres 17 image with pgvector and pg_jieba, plus the runtime schema |
| `api/kb/` | The server: MCP tools, hook endpoint, HTTP routes for clyde-flow, write path, the console's API, arms, embeddings, decider |
| `api/kb/console/` | Wen's console at `/console/`. It reads and edits the store through the API in [api/API.md](api/API.md), behind an admin token the agents never hold |
| `hooks/` | `install.sh`, which connects Claude Code and Codex, plus `kb-hook` and both clients' config snippets |
| `deploy/` | Droplet provisioning, compose stack, Caddy, restic backups |
| `eval/` | Retrieval eval on the practice queries, decider run-off on the reactions |
| `tests/` | Unit and database tests on a made-up vault |

## Where the data lives

The Postgres database on the Droplet is the store of record. The vault is a seed and import format, and it never enters this repo. Point `PKG_SEED_DIR` at a private copy.

Private entries never leave the Droplet unredacted. The agent and the decider see their title and id only.

## The arms

| Arm | Status | What `recall` returns |
|---|---|---|
| `no-memory` | offline only | Nothing. The floor that shows whether memory helps at all |
| `index` | live | Index lines matching the query's words, replaced entries struck through. The agent opens them with `get_entry`. The CLAUDE.md-style status quo |
| `hybrid` | live | English and 中文 keyword search plus bge-m3 vectors, merged by reciprocal rank. Current entries only |
| `spreading` | Phase 1 | Wen's design. Hybrid's top 50, spreading recall over typed links, a filter that prunes irrelevant items, learned link-type weights |
| `hindsight` | Phase 1 | Hindsight, the off-the-shelf memory system, loaded from the same store |

Each MCP session draws an arm at random on its first call and keeps it. The tools, their descriptions and the packet shape are identical across arms, so the agent can't tell which one it got. Every packet is capped at 8 items and 1,500 tokens.

## Fair arms

Every arm gets its best implementation before any comparison counts. A bad number is a question, not a verdict.

- **Place every miss in the funnel.** `retrieval_eval.py --misses` says whether the gold entry was never retrieved, ranked out of the packet, or cut by the token budget. For hybrid it also gives the rank in each ranker.
- **Name the cause.** A loss is implementation (tokenizer, query construction, fusion, embedding text) until it's shown to be the design's limit. Fix implementation causes in every arm they touch.
- **Tune on train, report test once.** Knobs move only on the train split. The test split is read after the knobs are frozen.
- **Keep what earns its place.** Each change is ablated alone. Stemming and IDF were tried in the index arm and dropped, since they cost hits or changed nothing.

The first pass found an implementation bug, not a design limit. Hybrid's fusion counted keyword evidence twice and buried entries both rankers had first. With that fixed, hybrid went from 74% to 90% on train and 6 of 6 on test. Its remaining misses need a link from a task to Wen's preferences, which is the spreading arm's job.

## The tools

- **`recall(query, task, scope)`.** Searches memory. The packet starts with a retrieval id. A `run:<id>` scope adds that run's entries.
- **`get_entry(id)`.** Opens one entry with its evidence, source, links and blobs.
- **`get_blob(sha256, offset, limit)`.** Reads a blob as text, 20,000 characters a page. Each page says how to get the next.
- **`remember(...)`.** Writes one note in a `run:<id>` scope. An agent's writes are always drafts, under its own session as the source, with an id kb generates.
- **`feedback(retrieval_id, verdict)`.** The agent's own report. Logged, never moves weights alone.

## Runs and blobs

Each clyde-flow run gets its own scope, `run:<id>`. Its stages leave notes there, and the next stage recalls them.

- **Runs stay out of normal recalls.** A recall without a scope never sees `run:` entries. With `scope="run:abc"`, that run's entries join the candidates and their scores are multiplied by `KB_SCOPE_BOOST`, default 3. Other runs stay hidden. Both arms filter and boost the same way.
- **A run's project comes first.** Write a `projects` entry in scope `run:<id>`, then point every note at it with `project`.
- **Writes keep the seed's rules.** `remember` checks each entry against the `seed/build.py` invariants and writes it in one transaction. Title, body and evidence stop at 300, 4,000 and 20,000 characters.
- **A replacement reaches every recall the old entry did.** An entry supersedes only entries at or below its own authority, and a `run:` entry only entries in its run. Hybrid stops serving a superseded entry. The index arm lists it struck through and never boosts it.
- **A resend lands on its entry.** The same payload sent again returns the entry it made, with or without an `id`. A different payload under a taken id is refused.
- **Blobs hold long evidence.** Attach them as `{name, media_type, text}`, or `base64` for binary content. An entry takes 16 blobs at most, 4 MiB each and 8 MiB in all. kb stores each one once per sha256, however many entries attach it. A blob only private entries reach comes back as `[private blob: ask Wen]`, and a private entry lists its blobs by count only.

The payload is in the [memory contract](../harness/PLAN.md#memory-contract).

## The HTTP routes

Each route takes one of two bearer tokens. Every agent session holds `KB_TOKEN`. Only clyde-flow holds `KB_RUNTIME_TOKEN`, so keep it out of every agent's environment. Bad input gets a 400 with the reason, and a body over 12 MiB gets a 413.

| Route | Body | Returns |
|---|---|---|
| `POST /entries` | One entry, as `remember` takes it | `{id, blobs, embedded}`. With `KB_RUNTIME_TOKEN` it may write up to `approved`. With `KB_TOKEN` it writes as `remember` does |
| `GET /entries/{id}` | | The rendered entry, or a 404 |
| `GET /blobs/{sha}` | | The raw bytes with their media type. A private blob gets a 403 |
| `POST /recall` | `{query, task, scope}` | The packet text |

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
