# memory

Requirements and their acceptance criteria are GitHub issues labelled `requirement`. Start at the index, issue #31.

Wen's personal knowledge graph, served to Claude Code and Codex through one MCP endpoint. It runs the PKG v1 experiment: several retrieval arms read the same store, and the arm your agents follow most consistently wins. clyde-flow hands work between stages through it, over HTTP.

Phase 0 is built. The index and hybrid arms serve live, hooks log every session, and the decider run-off has its keyword baseline. The spreading and hindsight arms and the idle audit come in Phase 1.

## The parts

The site, sign-in pages, and chat cards share the [Clyde design system](../design/README.md).

| Path | Does |
|---|---|
| `seed/build.py` | Validates a Markdown vault and compiles it to `seed.sql` and `INDEX.md` |
| `seed/import_chats.py` | Turns Grok, Codex and claude.ai exports into inbox lines |
| `supabase/functions/memory/` | The server, one Supabase Edge Function: MCP tools, hook endpoint, HTTP routes for clyde-flow, write path, the console's API, arms, embeddings, export and import |
| `supabase/migrations/` | The schema, in Postgres schema `memory`, and the 5-minute embed sync |
| `hooks/` | `install.sh`, which connects a computer's Claude Code and Codex, plus `memory-hook`, both clients' config snippets and `set-openai-key.sh` |
| `backup/` | `export.py` and `restore.py` for the nightly backup |
| `console/` | Wen's console. It reads and edits the store through the API in [API.md](API.md), behind an admin token the agents never hold. Not hosted yet |
| `eval/` | Retrieval eval on the practice queries, decider run-off on the reactions |

## Where the data lives

The Postgres database on Supabase is the store of record. The vault is a seed and import format, and it never enters this repo. Point `PKG_SEED_DIR` at a private copy.

Private entries never reach an agent unredacted. The agent and the decider see their title and id only.

## The arms

| Arm | Status | What `recall` returns |
|---|---|---|
| `no-memory` | offline only | Nothing. The floor that shows whether memory helps at all |
| `index` | live | Index lines matching the query's words, replaced entries struck through. The agent opens them with `get_entry`. The CLAUDE.md-style status quo |
| `hybrid` | live | English and 中文 keyword search plus `text-embedding-3-large` vectors, merged by reciprocal rank. Current entries only |
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

- **`recall(query, task, scope, depth)`.** Searches memory. The packet starts with a retrieval id. Every note an agent wrote is a candidate, whatever its run. A `run:<id>` scope boosts that run's notes. `depth: "deep"` adds the page `recall_more` would give next, in the same reply and on the same retrieval row (depth `deep`). `POST /recall` takes no depth.
- **`recall_more(retrieval_id)`.** Digs deeper when a recall missed (R29). It returns the next page past what the recall and the pages before it showed: the recall's own ranking in order, then the nodes best-first spreading reaches past the frontier it logged, then the dormant and superseded entries that match the query's words. Every item is `[n] <id>: <title>` with a line `kind <kind> · strength <0.00> · <state>`, the state superseded by its replacement, dormant, on trial with its chances, or settled. A page is up to the packet's 8 items and 1,500 tokens, has its own retrieval id (a child row: `parent_id` the id it was called with, depth `deep`, the recall's arm, query, task and scope), asks no judge, embeds nothing and spends no trial chance. The last page says `Nothing more in memory matches.`, or that memory ranks only the top 50 matches. Only the session that made the recall can call it. Feedback on a page moves what it showed like a packet's, so a dormant entry marked used climbs back, while being shown alone never revives one. The overview's recall count leaves pages out.
- **`get_entry(id)`.** Opens one entry with its evidence, source, links and blobs.
- **`get_blob(sha256, offset, limit)`.** Reads a blob as text, 20,000 characters a page. Each page says how to get the next.
- **`remember(...)`.** Writes one note. It needs only `pattern`, `title`, `body` and `evidence`. The scope defaults to `global` and the project to the agent's own notes project, made the first time. An agent's writes are labelled drafts, under its own session as the source, with an id memory generates, and every recall serves them at once.
- **`feedback(retrieval_id, entries, nothing_useful)`.** The agent's report on a recall, after every recall: a verdict (`used`, `irrelevant` or `wrong`) for each entry it was shown, or `nothing_useful`, once per recall. The older `verdict` and `entry_id` form still works. Every MCP packet ends with a line asking for it, and while one is missing the session's tool replies end with a reminder naming the retrieval. The learner reads it with the recall's other signals, and `/api/v1/overview` reports the share of recalls that got it.

## Cards in chat apps

Chat apps show Clyde as interactive cards inside the chat (R67, #72), on the MCP Apps extension (`io.modelcontextprotocol/ui`, spec 2026-01-26) that claude.ai, Claude Desktop and mobile, and ChatGPT render. Coding apps (Claude Code, Codex, Gemini CLI, Antigravity) never see any of it: their initialize, tools/list and tool results are byte for byte the same.

- **Who gets cards.** A client that declares the extension in initialize (or per request, protocol 2026-07-28), or whose clientInfo.name starts `claude-ai`, `anthropic`, `openai-mcp` or `chatgpt`. The choice is stored on `memory.mcp_client.ui`.
- **What they get.** `capabilities.resources` and the extension in initialize; `_meta.ui.resourceUri` (with the `ui/resourceUri` and `openai/outputTemplate` aliases) on the 12 tools that have a card; `resources/list` and `resources/read` for `ui://clyde/{recall,entry,remembered,artifact,quests,agent}.html`; and each result's card data in `_meta["clyde/card"]`, which hosts give the card and never the model. The text is unchanged.
- **The cards** are in [supabase/functions/memory/ui/](supabase/functions/memory/ui/): one self-contained HTML page each, tokens, CSS and script inline. The recall card marks each memory Used or Wrong and sends one feedback call; Open calls get_entry, an artifact chip calls get_blob, and the quest board claims and completes. Everything from memory enters the page as text, never HTML. `harness/test/memory/ui.test.ts` renders them in headless Chrome, light and dark, at 640 and 360 px.
- **claude.ai.** Settings → Connectors → Add custom connector → `https://memory.heyclyde.me/mcp`, then sign in with the email link.
- **ChatGPT.** Custom MCP servers need developer mode, on the plans OpenAI allows it (Business, Enterprise and Edu for full MCP; check [OpenAI's help page](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)). In ChatGPT: Plugins (Apps) → + → Add custom MCP server → name Clyde, URL `https://memory.heyclyde.me/mcp`, authentication OAuth → create, install, then ask it to recall something. Its OAuth callbacks on `chatgpt.com` are allowed. A listing in ChatGPT's directory is R57 (#62).

## Runs and blobs

Each clyde-flow run gets its own scope, `run:<id>`. Its stages leave notes there, and the next stage recalls them.

- **No run is hidden.** A recall without a scope serves `run:` notes like any other. With `scope="run:abc"`, that run's entries have their scores multiplied by the parameter set's `scopeBoost`, 3 in the v1 sets. Every arm boosts the same way and filters by nothing.
- **A run's project comes first.** To file notes under a run, write a `projects` entry in scope `run:<id>`, then point every note at it with `project`. Left out, a note files under its agent's notes project.
- **A set can have a trial lane.** With `trialItems` above 0 (hybrid.v3 and spreading.v3), a recall lists up to that many entries with chances left under a line that says `On trial`, apart from the settled main list, each labelled new with its kind, confidence and chance. Showing one spends a chance. After the third it's settled in the main list at the confidence it earned, or dormant under 0.15. Used moves an entry by 1 step, irrelevant by -0.3, wrong by -1 and a get_entry open by 0.2, and a step is `trialStep` (0.12) in trial and `settledStep` (0.02) once settled. A shown entry the feedback never names loses 0.05 in trial and 0.01 settled.
- **A note has a kind.** `fact`, `wen`, `observation` or `plan`. A fact is stored as one only when its `evidence` is word for word in the tool output of the hook event named by `evidence_event` (the quote check the groom API uses). Otherwise it's an observation marked unverified. A fact starts at confidence 0.9 and settled, `wen` at 0.7, and an observation or plan at 0.5, each with 3 chances to prove itself. The packet shows each item's kind and confidence, and marks a draft unreviewed.
- **Writes keep the seed's rules.** `remember` checks each entry against the `seed/build.py` invariants and writes it in one transaction. Title, body and evidence stop at 300, 4,000 and 20,000 characters.
- **Memories used together get linked together (R43).** When one recall's feedback marks two or more entries used (or Wen confirms them from the console), the learner adds or strengthens a `co_used` link between each pair of the top 4, so at most 6 pairs a recall: +0.1 a co-use, capped at 1. Entries in different projects also link their projects. A link spreads only once 2 different sessions have co-used the pair. Every 200 recalls on the recall clock that show one end without the pair being co-used take 0.05 off it, and it goes at 0. It never fades by calendar time. Only a set whose `linkTypeWeights` names `co_used` spreads along them (`"*|co_used|*"` weighs a type between any patterns): spreading.v6, a child of spreading.v4 at weight 1, not allocated until it beats v3 on the train eval. Agents can't write a `co_used` link with `remember`.
- **A replacement reaches every recall the old entry did.** An entry supersedes only entries at or below its own authority, and a `run:` entry only entries in its run. Hybrid stops serving a superseded entry. The index arm lists it struck through and never boosts it.
- **A resend lands on its entry.** The same payload sent again returns the entry it made, with or without an `id`. A different payload under a taken id is refused.
- **Blobs hold long evidence.** Attach them as `{name, media_type, text}`, or `base64` for binary content. An entry takes 16 blobs at most, 4 MiB each and 8 MiB in all. memory stores each one once per sha256, however many entries attach it. A blob only private entries reach comes back as `[private blob: ask Wen]`, and a private entry lists its blobs by count only.

The payload is in the [memory contract](../harness/PLAN.md#memory-contract).

## The HTTP routes

Each route takes a computer's device token or clyde-flow's runtime token. Only clyde-flow holds the runtime token, so keep it out of every agent's environment. Bad input gets a 400 with the reason, and a body over 12 MiB gets a 413.

| Route | Body | Returns |
|---|---|---|
| `POST /entries` | One entry, as `remember` takes it | `{id, blobs, embedded}`. With the runtime token it may write up to `approved`. With a device token it writes as `remember` does |
| `GET /entries/{id}` | | The rendered entry, or a 404 |
| `GET /blobs/{sha}` | | The raw bytes with their media type. A private blob gets a 403 |
| `POST /recall` | `{query, task, scope}` | The packet text |

## Run the tests

The function type-checks with `deno check supabase/functions/memory/index.ts`. Harness tier 3 boots it under deno against a `supabase/postgres` database with the migrations applied, and drives it through clyde. CI runs it in the harness workflow. See [harness/README.md](../harness/README.md#run-the-tests).

## Run the evals

```bash
python eval/retrieval_eval.py --split train --misses   # against the live function, with your admin token
PKG_SEED_DIR=~/pkg-seed OPEN_AI=... python eval/decider_eval.py --out /tmp/decider.json
```

`decider_eval.py` writes Wen's words to `--out`, so keep that file out of git.

## Deploy

See [DEPLOY.md](DEPLOY.md). Sign-in, including Google and GitHub, is in [SIGN-IN.md](SIGN-IN.md).
