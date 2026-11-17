# memory management API

The console's API. It shows everything memory holds and changes entries, links and the message board, over JSON at `/api/v1`.

It is Wen's own console behind its own admin token, so private entries show in full here. The MCP tools still redact them.

```bash
curl -H "Authorization: Bearer $(cat ~/.config/memory/admin-token)" https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/api/v1/overview
```

## Auth

Every `/api/v1` path needs `Authorization: Bearer <admin token>`. The function stores only its SHA-256, as `admin_token_sha256` in `memory.setting`, and answers 503 while none is set. A missing or wrong token gets 401 `{"error": "unauthorized"}`, and ten wrong tokens from one address start a lockout.

A device token never opens it. Every agent holds its computer's device token, for MCP, the hooks and its inbox, and an agent with Bash could otherwise read private entries in full and write as Wen. Each token works on its own paths only.

The research token, held by the weekly research-memory task and stored as `research_token_sha256`, opens only these `/api/v1` routes (R35). Any other gets 403 `{"error": "The research token opens only the research routes (API.md, Research)."}`, and every path outside `/api/v1` a 401.

| Route | What research may do there |
|---|---|
| `GET /param-sets`, `GET /param-sets/{id}` | Read every set |
| `POST /param-sets` | Make a set with a `parent` and a `note` (its hypothesis) of 20 characters or more. `created_by` is `research` whatever `by` says. At most 3 a UTC week (Monday 00:00 UTC on), else 429. A research set starts with an allocation row `off`, weight 0 |
| `GET /allocation`, `PUT /allocation` | Move only sets it made, only to `off` or `shadow`, else 403. The audit row's `by` and actor are `research` |
| `GET /eval/questions?split=train` | Train only. `test` and `all` are 403, with or without `freeze` |
| `POST /eval/rank`, `POST /eval/replay`, `GET /eval/recalls` | Rank and replay, writing no retrieval |
| `GET /variants/compare`, `GET /variants/guard` | Read the comparison and the guardrails' rollup. `POST /variants/guard` is 403 |

| Path | Takes |
|---|---|
| `/api/v1`, `/api/v1/*`, `/` | The admin token, or the research token on the research routes only |
| `/mcp`, `/hooks/*`, `/messages/*`, `/entries`, `/entries/*`, `/blobs/*`, `/recall` | A device token, or clyde's runtime token |
| `/export` | The backup token, or the admin token |
| `/embeddings/sync` | pg_cron's secret from Vault |
| `/healthz` | Nothing |
| Anything else | Nothing works. 401 |

The console, in [console/](console/), is static files with no data in them. It asks for the admin token and sends it to `/api/v1`. Supabase serves HTML only on a custom domain, so it isn't hosted yet.

- **The console can be off.** With no admin token set, every `/api/v1` path answers 503 with the reason. MCP and the hooks keep serving.
- **Wrong tokens lock an address out.** The first 10 wrong tokens from one address cost nothing. Each one after that locks the address out of that credential's paths for twice as long as the last, up to 15 minutes. A locked address gets 429 with `Retry-After`, and its token isn't checked. A request with no token isn't a guess and never counts. Misses are forgotten after an hour without one. The admin and agent tokens count apart, so a stale agent token never locks Wen out of the console.

## Conventions

- **JSON in and out.** Times are ISO 8601 with their offset. Dates are `YYYY-MM-DD`.
- **Lists** come back as `{"items": [...], "total": N, "limit": L, "offset": O}`. `limit` defaults to 50. A limit over 200 is cut to 200, and the response says so in `limit`. `offset` runs 0 to 1,000,000,000.
- **Errors** come back as `{"error": "<short sentence>"}`.
- **Bodies stop at 1 MiB.** A bigger one gets 413 before it is parsed, chunked or not. Caddy stops anything over 2 MB first.
- **Text fields have a length.** `title` takes 500 characters, `body` and `evidence` 50,000, `note`, `query` and `task` 4,000. Every other string takes 200. A longer one gets 422.
- **Text must fit in Postgres.** A NUL character or a lone UTF-16 surrogate gets 400 in a query string or path, 422 in a body.

| Status | When |
|---|---|
| 400 | A query string or path that doesn't parse. A bad `limit`, an unknown `sort`, an unknown `tz`, a body that isn't a JSON object |
| 401 | No token, or the wrong one for the path |
| 404 | No such entry, session, event or retrieval. Also an unknown endpoint |
| 405 | A known path with the wrong method |
| 409 | A conflict. The id is taken, the link exists, the entry is still in use, the supersession would loop |
| 413 | A body over 1 MiB |
| 422 | A body that parses but fails a rule. A missing field, an unknown field, a project that doesn't exist, a field too long |
| 429 | Too many wrong tokens from this address. `Retry-After` says when to try again |
| 500 | A bug. The server log has the traceback |
| 503 | The console is off. The error says why |

- **Every write is audited.** It adds an `admin_audit` row in the same transaction as the change. `target` is `entry:<id>`, `message:<id>`, `retrieval:<id>` or `embeddings`.

## Artifacts and blobs (MCP and the agent routes)

An agent's memory is short, and its details are **artifacts**: documents, logs, transcripts, images, skills, code. Every artifact is a blob, and recall lists a memory's artifacts as `name (kind, size)` with no content.

- **remember** takes `artifacts: [{name, kind, text | base64 | sha256}]`. `blobs` is the same field under its old name. `kind` is one of image, video, audio, document, skill, artifact, data, other; memory derives it from the media type and name when it is left out, and refuses any other value ("Use one of image, video, audio, document, skill, artifact, data, other").
- **500 characters.** A remember body over 500 characters is refused unless the call passes `long: true`; the message says to move the detail into an artifact. 4000 characters stays the hard cap. The parameter sets hybrid.v4 and spreading.v4 (children of v3) set the knob `itemChars` to 500, which cuts each packet item's body to that many characters plus "… more in get_entry".
- **upload_blob** takes `sha256`, `size` (1 to 524288000 bytes) and `media_type`, and answers with a signed URL. The agent PUTs the file there within two hours and cites the sha256 in remember. memory reads the size from Storage's object info before it reads a byte, then checks the hash, and deletes a file that is the wrong size or hash, has a secret in its text, or is text too long to scan. One entry may cite up to 1073741824 bytes of new uploads. A device may have 10 uploads waiting.
- **Where bytes live.** Text up to 262144 bytes stays in Postgres. Binary and bigger text go to the private Storage bucket `memory-blobs`, under their sha256. With Storage off (no `SUPABASE_SERVICE_ROLE_KEY`), everything stays in Postgres under the old 4 MiB limit, and upload_blob says so.
- **blob_quota_bytes.** A row in `memory.setting` caps every blob together, Postgres and Storage. The default is 10 GiB (10737418240 bytes). A value that isn't a whole number of 0 or more is the default, and `0` freezes new blobs. Citing a blob memory already has costs no quota.
- **get_blob** pages a text blob. For an image, video, audio file or any other non-text blob in Storage it answers with a link that downloads it for 10 minutes. `GET /blobs/{sha256}` redirects (302) to the same kind of link. A blob only private entries reach gets neither.
- **/export and /import.** `/export?table=blob` carries Storage blobs of 4 MiB or less as base64, up to MEMORY_EXPORT_STORED_TOTAL bytes (2 GiB) per export, in sha256 order. Bigger blobs and missing objects go out with `content: null`, counted in `x-missing-blobs`. A blob page is cut by size too, and `x-truncated: 1` says so. `/api/v1/import` puts Storage blobs back (or into Postgres when Storage is off) and fills a missing `kind`; get_blob on a blob that wasn't in the backup answers "Blob <sha256> wasn't in the backup."
- **POST /blobs/sweep** takes the cron secret and deletes uploads under `incoming/` older than 7200 seconds.
- /mcp refuses a body over 12582912 bytes with 413.

## Agent profiles and provenance (R19, R41)

- **register_agent** takes `name` (2 to 40 lowercase letters, digits and dashes), `context` (work, personal or both), `surface` (up to 40 characters) and `description` (up to 500). It makes or updates the profile in `memory.agent` and binds it to the credential and the MCP client name in `memory.agent_binding`, so the next session with the same token and client starts registered. A name belongs to the credential that registered it; another credential's attempt is refused. claude, codex, all, wen and memory are reserved.
- **Registration is gentle.** An unregistered session works. Every tool reply except register_agent's carries one more content block, `memory: you haven't registered yet. Call register_agent ...`, so the tool's own text is never changed. A session registered under one credential is no one under another. Deleting an agent unbinds it, and its sessions hear the block again.
- **Names.** A registered agent's notes have the source `<name>, a <context> agent on <surface>, through remember`, its messages are sent as `<name>`, and it reads messages to its name, plus to claude or codex when its client is one of those.
- **Provenance.** Every write records, in `memory.entry_provenance`, the device (the token's), the agent (its profile, else its client name; `http` over HTTP), the agent's context, the repo and folder the session's hook reported, the MCP session and the run scope. Nothing in the payload sets any of it, and an unknown field is refused. Recall packets, the On trial list, index lines and get_entry show one line, `from codex on mac-mini in repo:posthog (work)`, at most 60 characters, with `(you wrote this)` on the reader's own notes. Nothing is filtered by it.
- **/export and /import** carry `entry_provenance`, `agent` and `agent_binding`. `/overview` counts unread messages for registered agents too.

## Dashboard

### `GET /overview`

```json
{"health": {"db": true, "arms": ["index", "hybrid"], "embedding_model": "bge-m3", "vector": true,
            "sync": {"running": false, "trigger": "startup", "started_at": "...", "finished_at": "...",
                     "embedded": 5, "error": null},
            "feedback_coverage_7d": {"recalls": 7, "with_feedback": 3, "share": 0.43,
                                     "by_client": {"claude-code": {"recalls": 4, "with_feedback": 2, "share": 0.5}}}},
 "counts": {"entries": 5, "superseded": 1, "private": 1, "links": 7, "sources": 2, "projects": 1,
            "events": 0, "client_sessions": 0, "mcp_sessions": 0, "recalls": 0, "feedback": 0, "messages": 0,
            "unread": {"claude": 0, "codex": 0}, "unread_messages": 0},
 "embeddings": {"embedded": 0, "stale_or_missing": 5},
 "last": {"event": null, "hook": null, "recall": null, "message": null, "feedback": null}}
```

- `arms` are the arms live sessions draw from. `vector` says whether pgvector is installed.
- `feedback_coverage_7d` is the share of the last 7 days' MCP recalls that got at least one `agent` feedback row (Wen's rows and recalls over HTTP don't count). `by_client` is keyed by the client's own name, `unknown` for none, and a `share` is null with no recalls.
- `sync` is the latest embedding sync, running or done, or null before the first. `trigger` is `startup` for the server's own sync at start, or `console`. A finished sync has `embedded` or `error`. The server keeps it in memory, so a restart starts over with the startup sync.
- `entries` counts current entries. `superseded` and `private` count every entry.
- `events` counts every event row, `get_entry` opens included. `client_sessions` counts distinct client session ids among the hook events only, since a `get_entry` row carries the MCP session id.
- `unread` counts each agent's waiting deliveries: messages to it, or to all, that it hasn't acknowledged, dismissed or had dropped, and that haven't expired. A message to all counts once for each agent. `unread_messages` counts each message once, while any agent it's for still has a delivery waiting.
- `embeddings` covers current entries. An entry counts as embedded when its stored hash matches its text now, the same check `sync_embeddings` makes.
- `last.event` is the newest event row, `get_entry` opens included. `last.hook` leaves those out, so it says when a hook last fired.

### `GET /activity?days=14&tz=America/New_York`

`days` runs 1 to 90. Days are oldest first, and every day is present. They are calendar days in `tz`, an IANA time zone that defaults to UTC. The console sends the browser's own zone, so an evening's work lands on today's bar. A zone Postgres doesn't list gets 400. So does a POSIX string like `UTC+14`, which Postgres reads as 14 hours west. Its IANA name is `Etc/GMT-14`.

```json
{"days": [{"day": "2026-10-09", "events": 0, "recalls": 0, "feedback": 0, "messages": 0}],
 "events_by_type": [{"event": "UserPromptSubmit", "count": 12, "last": "..."}],
 "clients": [{"client": "claude-code", "sessions": 3, "recalls": 9, "last": "..."}],
 "agents": [{"agent": "codex", "events": 40, "sessions": 2, "last": "..."}]}
```

`events_by_type`, `clients` and `agents` cover the same window. A client counts when a session started in the window or recalled in it. A session with no client name shows as `unknown`.

`agents` counts hook events by the agent memory-hook named, `claude` or `codex`, so it says whether each one's hooks are firing. `get_entry` opens aren't hooks and stay out. Events from a memory-hook older than this field show as `unknown`.

### `GET /meta`

The choices a form needs.

```json
{"authorities": ["approved", "observed", "draft"], "sensitivities": ["normal", "private"],
 "patterns": ["decisions", "..."], "link_types": ["part_of", "relates", "supersedes", "..."],
 "projects": [{"id": "proj-tea", "title": "Tea brewing"}],
 "sources": [{"id": "src-a", "kind": "claude_chat", "title": "Test chat", "date": "2026-09-01"}],
 "arms": ["index", "hybrid"], "live_arms": ["index", "hybrid"]}
```

`patterns` and `link_types` come from the data. `link_types` always has `part_of`, `relates` and `supersedes`. Sources are newest first.

## Entries

### `GET /entries`

| Param | Does |
|---|---|
| `q` | Substring match on id, title and body, plus English and 中文 full-text search over the title and body. The project's title stays out, so a word from it doesn't match every entry in the project |
| `project`, `pattern` | Exact match. A project's own entry is in its project |
| `authority` | `approved`, `observed` or `draft` |
| `sensitivity` | `normal` or `private` |
| `superseded` | `current` (default), `superseded` or `all` |
| `sort` | `id` (default, A to Z), `title` (the database's collation), `valid_from` (newest first), `updated` (latest API write first, never-edited entries last) |
| `limit`, `offset` | Paging |

Each item:

```json
{"id": "tea-oolong-temp", "title": "Brew oolong at 90C", "pattern": "decisions", "authority": "approved",
 "scope": "domain:tea", "sensitivity": "normal", "lang": "en", "valid_from": "2026-09-01",
 "project": "proj-tea", "project_title": "Tea brewing", "superseded_by": [], "links": 3, "delivered": 2,
 "updated": null}
```

`links` counts links on both sides. `delivered` counts the recalls that put the entry in a packet. `updated` is the time of the latest API write to the entry, or null.

### `GET /entries/{id}`

```json
{"entry": {"id": "...", "pattern": "...", "title": "...", "body": "...", "authority": "...", "scope": "...",
           "sensitivity": "...", "lang": "...", "valid_from": "...", "source_id": "...", "evidence_kind": "...",
           "evidence": "...", "evidence_sha256": "...", "project": "...", "project_title": "..."},
 "source": {"id": "src-a", "kind": "...", "title": "...", "uri": "...", "date": "..."},
 "links_out": [{"type": "part_of", "dst": "proj-tea", "title": "Tea brewing", "authority": "approved"}],
 "links_in": [{"type": "relates", "src": "tea-zh", "title": "喜欢乌龙茶", "authority": "approved"}],
 "superseded_by": [], "supersedes": ["tea-oolong-old"], "current": true,
 "embedding": {"model": "bge-m3", "updated_at": "...", "fresh": true},
 "usage": {"delivered": 2, "candidate": 5, "last_delivered": "...",
           "feedback": [{"verdict": "helpful", "source": "wen", "note": null, "created_at": "...", "retrieval_id": "..."}]}}
```

- `source` is null without a source. `embedding` is null until the entry is embedded, or without pgvector.
- `fresh` is false when the text changed after the last embedding.
- `candidate` counts the recalls that ranked the entry at all. `feedback` is the newest 100 verdicts that name this entry.

### `POST /entries`

```json
{"id": "tea-gaiwan", "title": "Brew in a gaiwan", "body": "...", "pattern": "decisions", "authority": "approved",
 "scope": "domain:tea", "sensitivity": "normal", "lang": "en", "valid_from": "2026-10-10", "source_id": "src-a",
 "evidence_kind": "quote", "evidence": "gaiwan from now on", "project": "proj-tea",
 "links": [{"dst": "tea-oolong-temp", "type": "relates"}]}
```

Returns 201 with the entry in the `GET /entries/{id}` shape.

- **Required.** `id`, `title`, `body`, `pattern`, `authority`, `scope`.
- **Defaults.** `sensitivity` is `normal`, `lang` is `en`, `valid_from` is today in UTC.
- **id** matches `^[a-z0-9][a-z0-9-]{1,100}$`. A taken id gets 409.
- **scope** is `global`, `domain:<name>` or `repo:<path>`, the vault's own rule.
- **evidence_kind** is `quote`, `assistant`, `summary` or `memory`. The server computes `evidence_sha256`.
- **project** must be an entry with pattern `projects`. The entry also gets a `part_of` link to it, the vault's rule that an entry in a project is part of it. A `projects` entry without a project is its own project.
- **links** each need an existing `dst` and a `type` matching `^[a-z_]{2,40}$`. A `supersedes` link follows the rules of `/supersede`.
- **Unknown fields** get 422, so a typo like `source` for `source_id` never drops silently.

### `PATCH /entries/{id}`

Any of `title`, `body`, `pattern`, `authority`, `scope`, `sensitivity`, `lang`, `valid_from`, `source_id`, `evidence_kind`, `evidence`, `project`. Returns 200 with the full entry.

- Unknown fields and an empty body get 422. The id never changes.
- null or `""` clears `valid_from`, `source_id`, `evidence_kind`, `evidence` or `project`. The other fields can't be cleared.
- A new `evidence` gets a new `evidence_sha256`.
- A new `project` moves the `part_of` link with it.
- A new `authority` keeps the draft rule of `/supersede`. An entry that supersedes an approved one can't become a draft, and an entry a draft supersedes can't become approved. Either gets 422.
- A new title on a project refreshes the search text of the entries in it, since theirs carries its title.
- The audit row holds the changed fields only, before and after.

### `DELETE /entries/{id}`

Returns 200 `{"deleted": id}`. The embedding goes with it. It refuses with 409 while the entry is still in use.

- It has a link on either side. Remove the links first, `part_of` included.
- A recall ever delivered it. It stays as a record of what an agent saw. Supersede it instead.
- Another entry names it as its project.
- The retrieval eval grades it.

### `POST /entries/{id}/links`

Body `{"dst": "tea-zh", "type": "relates"}`. Returns 201 `{"src", "dst", "type"}`. 404 when `{id}` is missing. 422 when `dst` is missing, is `{id}` itself, or `type` breaks `^[a-z_]{2,40}$`. 409 when the link exists.

A `supersedes` link means `{id}` supersedes `dst`. It takes the checks of `/supersede` and lands in the audit as `entry.supersede`, the same as there.

### `DELETE /entries/{id}/links/{type}/{dst}`

Returns 200 `{"deleted": {"src", "dst", "type"}}`, or 404.

### `POST /entries/{id}/supersede`

Body `{"by": "tea-oolong-temp"}`. Adds the link `by` supersedes `{id}`. The default entry list and the hybrid arm then hide `{id}`, and the index arm strikes it through. Returns 201 with the full entry of `{id}`.

It keeps `seed/build.py`'s two rules.

- **Supersession never loops.** `entry_current` hides every entry a loop touches, so recall could never serve them. 409 when `{id}` already leads to `by` through supersedes links, the direct reverse link included.
- **A draft never supersedes an approved entry.** 422. Approve the draft first.

422 when `by` is missing, unknown or `{id}` itself. 409 when the link exists.

### `POST /entries/{id}/artifacts`

Body `{"name": "tea-oolong-temp-detail.md", "kind": "document", "media_type": "text/markdown", "text": "..."}`, or `base64` in place of `text`. Attaches one artifact to an entry that exists, so a long entry keeps its full text in an artifact while `PATCH` shortens its body (R42). Returns 201 `{"entry_id", "name", "sha256", "kind", "media_type", "size", "stored"}`; `stored` is `db`, `storage` or `existing` (memory already had those bytes).

- The bytes are stored exactly as sent. Text with a secret or identifier in it gets 422 instead of being redacted, so the artifact is always an exact copy. A `[redacted:<kind>]` placeholder from an earlier redaction doesn't count.
- `kind` is one of image, video, audio, document, skill, artifact, data, other, or derived from the media type and name. `media_type` defaults to text/plain for text and application/octet-stream for base64.
- 768 KiB at most. Text up to 262144 bytes stays in Postgres, the rest goes to Storage, and `blob_quota_bytes` caps it, the same as remember. A full quota gets 422.
- 404 for no such entry, 409 when the entry already has an artifact of that name. Audited as `entry.artifact`.

### `POST /entries/{id}/confidence`

Body `{"confidence": 0.3, "note": "stale: memory moved to Supabase"}`. Sets the entry's confidence (0 to 1) by hand, for a groom that marks a stale fact without deleting it (R17). Returns 200 `{"id", "confidence"}`. The move goes into `confidence_log` with the note as its reason, and into the audit as `entry.confidence`. 422 for a value outside 0 to 1 or no note, 404 for no such entry.

### `GET /graph?project=&include_superseded=false`

```json
{"nodes": [{"id": "tea-zh", "title": "喜欢乌龙茶", "authority": "approved", "pattern": "preferences",
            "project": "proj-tea", "project_title": "Tea brewing", "private": false, "current": true}],
 "links": [{"src": "tea-zh", "dst": "proj-tea", "type": "part_of"}]}
```

Links only join nodes in the response. `include_superseded` takes `true`, `false`, `1` or `0`.

## Sessions and events

### `GET /sessions?client=&arm=`

MCP sessions, newest first. Each item has `id`, `arm`, `client`, `claude_session_id`, `created_at`, `recalls`, `last_recall` and `events`. `events` counts the hook events of the client session the MCP session is tied to.

### `GET /sessions/{id}`

`{"session": {...row}, "timeline": [...]}`. The timeline is oldest first. Every item has `kind`, `at`, `id` and `summary`, plus fields for its kind.

| kind | summary | Also |
|---|---|---|
| `recall` | The query | `arm`, `task`, `delivered`, `latency_ms`, `degraded`. `id` is the retrieval id |
| `get_entry` | The entry id | `event`, `tool_name`, `entry_id` |
| `event` | As in `/events` | `event`, `tool_name`, `entry_id` |
| `feedback` | The verdict, its entry and its note | `verdict`, `source`, `retrieval_id`, `entry_id`, `note` |

### `GET /events?event=&session_id=&since=`

Hook events and `get_entry` opens, newest first. Each item has `id`, `event`, `session_id`, `agent`, `received_at`, `cwd`, `tool_name` and `summary`. `summary` is the first 160 characters of the prompt for `UserPromptSubmit`, the tool name for `PostToolUse`, and empty otherwise.

`agent` is the agent memory-hook named with `?agent=`, `claude` or `codex`. It is null for `get_entry` opens and for events from an older memory-hook. `?agent=codex` lists one agent's events.

`since` is ISO 8601. A time without an offset is UTC.

### `GET /events/{id}`

`{"event": {"id", "event", "session_id", "agent", "received_at", "payload"}}`, with the full payload. An id that isn't a whole number gets 404 `No event <id>.`, like a missing one.

## Retrievals and feedback

### `GET /retrievals?arm=&client=&q=`

Recalls, newest first. `q` is a substring of the query or the task. Each item has `id`, `created_at`, `arm`, `client`, `mcp_session`, `query`, `task`, `delivered_count`, `latency_ms`, `degraded` and `feedback`, the count of verdicts on it.

### `GET /retrievals/{id}`

```json
{"retrieval": {"id": "...", "mcp_session": "...", "arm": "hybrid", "query": "...", "task": null,
               "candidates": [...], "delivered": [...], "rejected": [], "latency_ms": 12, "degraded": null, "created_at": "...",
               "packet": "Index lines that match. ...", "parent_id": null, "depth": "packet"},
 "client": "claude-code",
 "candidates": [{"rank": 1, "id": "tea-oolong-temp", "score": 0.09, "title": "...", "authority": "approved",
                 "superseded_by": [], "current": true, "delivered": true, "exists": true}],
 "feedback": [{"id": 1, "source": "wen", "verdict": "helpful", "entry_id": null, "note": null, "created_at": "..."}]}
```

`packet` is the exact text the agent read under the retrieval id. Recalls made before it was stored have null.

`parent_id` is set on a `recall_more` page (R29): the retrieval id it was called with, a recall or the page before it. A page has `depth` `deep`, the recall's arm, query, task and scope, no candidates, no rejected entries and no seq, since it doesn't tick the recall clock. A recall with depth `deep` has `depth` `deep` and no parent, and its `delivered` is the packet followed by the page. Every other recall has `depth` `packet`. The overview's `recalls` count leaves pages out.

`exists` is false for an entry deleted since the recall. `superseded_by` and `current` are the entry's state now. The store keeps no history of it, so an entry superseded after the recall shows as superseded here.

### `GET /feedback?verdict=&source=`

Newest first. Each item has `id`, `retrieval_id`, `source`, `verdict`, `entry_id`, `note`, `created_at` and the recall's `query`.

### `POST /feedback`

Body `{"retrieval_id", "verdict", "entry_id"?, "note"?}`, with a verdict of helpful, used, irrelevant, wrong or nothing_useful. It goes through the same path as the agent's one-verdict call, with source `wen`. Returns 201 `{"ok": true}`, or 422 with the tool's own message, like `Not logged: verdict must be helpful, used, irrelevant, wrong or nothing_useful.`

The agent's `feedback` tool takes `retrieval_id` and then `entries: [{"entry_id", "verdict": "used"|"irrelevant"|"wrong"}]` (`items` is the same list), or `nothing_useful: true`, plus an optional overall `verdict` and a `note` of up to 4,000 characters. A call is all or nothing, comes only from the MCP session that made the recall, and each recall takes one. Every MCP packet ends with the line asking for it, and the next tool reply in the session carries a reminder while it's missing.

## Messages

### `GET /messages`

The whole board, newest first. Each item has `id`, `created_at`, `expires_at`, `sender`, `recipient`, `body`, and three lists of agent names from its deliveries: `read_by` (acknowledged or dismissed), `pending` (still waiting) and `dropped` (never acknowledged after 3 deliveries, or pushed out by the 100-message cap). Reading here touches no delivery, so the agents still get their mail. A message expires 14 days after it's posted, and the daily `memory-message-purge` job deletes it then, or sooner once nothing is waiting for it.

### `POST /messages`

Body `{"to": "claude", "body": "..."}`. `to` is `claude`, `codex`, `all` or another agent name memory has seen in the last 30 days, in any case. One delivery goes to the recipient, or for `all` to every registered agent seen in the last 30 days and to `claude` and `codex` when seen in the last 30 days (R47). An unregistered client name never gets a broadcast. The sender is `wen`. Returns 201 `{"id", "to"}`, or 422, which includes `all` when no agent has been seen.

## Quest board (R47)

Agents hand each other work through six MCP tools. `post_quest` takes `title` (up to 120 characters), `brief` (500), `done_when` (300), and optionally `tags` (up to 8), `priority` (high, normal, low), `context` (work, personal, both; default the poster's), `for` (any, claude, codex or an agent name) and `artifacts` (`[{name, sha256}]` of blobs memory already holds on a non-private entry). `list_quests` takes `show` (open, mine, done, all), `tag`, `context` (default the caller's) and `limit`. `claim_quest {id, lease_minutes?}` takes the quest under a lease, 120 minutes by default (15 to 480), with `for update skip locked`, so one agent holds it. `update_quest {id, note}` appends a progress note and renews the lease. A lease that runs out reopens the quest. `complete_quest {id, evidence, entry_id, artifacts?}` needs evidence (up to 2,000 characters) and the entry the work produced, and memory writes a history note, `Quest #N done: <title>`, linked to that entry with `relates`, so recall finds it. `abandon_quest {id, reason}` puts a claimed quest back on the board for its claimer, and withdraws it for good for its poster. Every quest text passes the write judge.

The tables are `memory.quest`, `memory.quest_note` (post, claim, progress, release, reopen, done, abandon) and `memory.quest_blob`, and `/export` carries all three. `GET /groom/sessions` adds `stale_quests`: quests open or claimed for more than 30 days.

The SessionStart hook's answer (`POST /hooks/SessionStart?agent=<name>`) is the board, in at most 5 lines: `memory board: <n> unread messages, <q> open quests for you`, then the messages (acknowledged as they print) and the open quests that agent may claim in its context. `GET /messages/<name>` keeps its format and adds the quests posted since that computer's agent last saw the board, in the same 5 lines.

## Recall preview

### `POST /recall/preview`

Body `{"query": "...", "task"?: "...", "param_sets"?: ["hybrid.v1", "hybrid.v2"]}`. `param_sets` defaults to the sets now serving, from the allocation (or `MEMORY_ARMS`' v1 sets while it has no serving row). An older caller's `"arms": ["index", "hybrid"]` still works and means each arm's v1. An unknown set id is a 422. Each item in `arms` in the reply names its `param_set`.

```json
{"arms": [{"arm": "hybrid", "param_set": "hybrid.v1", "degraded": null, "latency_ms": 40, "packet": ["tea-oolong-temp"],
           "text": "[1] tea-oolong-temp: Brew oolong at 90C\n    approved · ...",
           "ranked": [{"rank": 1, "id": "tea-oolong-temp", "score": 0.09, "title": "...", "authority": "approved",
                       "superseded_by": [], "current": true, "in_packet": true}]}]}
```

It ranks and packs through recall's own code, so `packet` is what an agent on that arm would get and `text` is what it would read under the retrieval id. `ranked` is the top 25. A superseded entry has its replacements in `superseded_by` and `current` false. The index arm delivers those struck through, and `text` shows how. It never writes a retrieval or a session.

## Parameter sets and allocation

Every ranking knob lives in a parameter set, and an allocation says which sets serve. Changing either takes effect on the next recall, with no deploy.

### `GET /param-sets?arm=`

Every set, by arm then id. Each item has `id`, `arm`, `params`, `parent`, `note`, `created_by` and `created_at`. `params` holds every knob: `candidates`, `packetItems`, `packetTokens`, `filterK`, `filterThreshold`, `tiltBase`, `tiltUnknownConfidence`, `tiltWindow`, `rowWindow`, `dormant`, `rrfK`, `vecWeight`, `indexDraftFactor`, `scopeBoost`, the optional `otherRunFactor` and `globalAgentDraftFactor` (each in (0, 1], 1 when a set leaves them out, so the v1 sets rank as before), `restart`, `iterations`, `supersededFactor`, `linkTypeWeights` (keyed `src_pattern|link_type|dst_pattern`) and the features' weights `wTemperature`, `wAge` and `wKind`, which are 0 in every set from before R32. `index.v1`, `hybrid.v1` and `spreading.v1` hold the constants memory ranked by before parameter sets existed.

The R32 knobs are optional, and a set without them ranks as before. `scoreForm` is `tilt` (the default: the arm's score × (tiltBase + (1 − tiltBase) × confidence)) or `logodds`: `wRelevance`·r + `wTemperature`·h + `wAge`·ln(1 + age) + `wConfidence`·logit(confidence clamped to [0.01, 0.99]), with r the arm's score over the recall's top score. Under `tilt` the weights and temperature knobs change nothing. Temperature h is ACT-R's base level on the recall clock, ln Σ w·(c_now − seq + 1)^−`tempDecay` over the events of the last `tempWindow` recalls, floored at `tempFloor` and shifted up by it, so it is 0 or more: an agent's used or helpful (`tempAgentUsed`), Wen's confirmation from the console (`tempWenConfirm`) and a `get_entry` open (`tempOpened`), each counted once per (retrieval, entry, source) or (session, entry, seq). Age is recalls since the entry was written. Defaults: decay 0.5 (above 0, at most 5), floor −3 (−10 to 0), window 1000 (1 to 10000), weights 3, 3 and 1 (0 to 100), `wRelevance` and `wConfidence` 1 (−10 to 10). `logodds.v1` is `spreading.v6` with `scoreForm` logodds, 4·r + 0.15·h + 0.25·logit(c) and age at 0, made in shadow with no share.

### `GET /param-sets/{id}`

One set, or 404.

### `POST /param-sets`

Body `{"id": "hybrid.v2", "parent"?: "hybrid.v1", "arm"?: "hybrid", "params": {...}, "note"?: "...", "by"?: "..."}`. With a `parent`, `params` names only the knobs that differ and the set stores all of them, and `arm` defaults to the parent's. Without one, `params` must name every knob. Returns 201 with the row. A set is never changed or deleted, and the database refuses it, so there is no PUT. An id that exists gets 409. An unknown knob, a value out of range or an unknown parent gets 422 with what to fix. Audited as `param_set.create`.

### `GET /allocation`

`{"rows": [{"param_set", "arm", "role", "weight", "share"}]}`. `role` is `off`, `shadow`, `live` or `default`. Only `live` and `default` rows with a weight above 0 serve, in proportion to their weights, and `share` is that proportion (null for the rest). A unit (a run scope's id, or else device, client and UTC day) is hashed with a salt into one of 1000 buckets laid along those shares, so it always gets the same set, and each recall logs the set and the share it was served with. While no row serves, the function's `MEMORY_ARMS` stands in: each arm on its v1, an equal share each, and `rows` is empty.

### `PUT /allocation`

Body `{"rows": [{"param_set", "role", "weight"}], "by"?: "..."}`. `by` is text of 1 to 64 characters and defaults to `admin`; the audit row records it. Making a set the default is Wen's call: unless the set already is the default or is its arm's v1, the PUT takes `"by": "wen"`, else 403 and nothing changes. The rows named are set and the others stay, so one PUT can turn one variant off: `{"param_set": "hybrid.v2", "role": "off", "weight": 0}`. `weight` is a whole number, 0 or more. 422 if a set doesn't exist, a role is wrong, the result would leave nothing serving, or it would make more than 2 shadow sets, and then nothing changes. A session that a set served stops being served by it as soon as the set's role is off or its weight 0. Audited as `allocation.put`: `before` is `{"rows": [...]}`, the whole table before, and `after` is `{"by": "...", "rows": [...]}`.

## Eval

### `GET /eval/questions?split=train`

The practice queries with their gold and must_not entries, for `eval/retrieval_eval.py`. `split` is `train` (the default), `test` or `all`. The test split is read once, after the knobs are frozen: `test` and `all` take `freeze=1`, else 403, and each read writes an `eval.test_read` audit row. The research token gets 403 on them always. `retrieval_eval.py --split test` sends `freeze=1` only under `MEMORY_EVAL_FREEZE=1`, and exits 2 before any request without it.

### `GET /eval/recalls?limit=50`

The latest real recalls, newest first, as `[{"id", "created_at", "param_set"}]`, for the as-of replay to walk. `limit` is 1 to 200. No query text.

### `POST /eval/rank`

Body `{"query", "arm", "filter"?: true, "param_set"?: "hybrid.v1", "parent"?: "hybrid.v1", "params"?: {...}}`. Ranks and packs one query and returns `{"param_set", "candidates", "delivered", "rejected", "degraded", "parts"}`. With `param_set` it runs that stored set (and `arm` may be left out). With `params` it lays those knobs over `parent`, or the arm's v1, without storing anything. With neither it runs the arm's v1. It writes no retrieval, so it never ticks the recall clock. It also gives `c_now`, the clock reading the features are as of, and `scored`: every candidate's `id`, `final_score` and, for the top 50, its `features` (`arms`, `relevance`, `confidence`, `kind`, `judge`, `temperature`, `age`).

### `POST /eval/replay`

Body `{"retrieval_id", "param_set"?: "hybrid.v1", "parent"?, "params"?: {...}}`. The as-of replay: a logged recall's candidates re-scored under the set it was served by, or the one named, with temperature and age rebuilt from events as of the recall's own `context.c_now`, never today's. Relevance, the arm's score and confidence are the logged ones. Returns `{"retrieval_id", "c_now", "param_set", "logged_param_set", "delivered", "candidates": [{"id", "relevance", "confidence", "temperature", "age", "final_score", "logged_score"}], "outcomes": {entry_id: verdict}}`, best first. 404 for no such recall, 422 for one logged before the clock reading. Writes nothing. `eval/retrieval_eval.py --replay [--params <id|file>] [--limit 50]` runs it over the recalls `GET /eval/recalls` lists.

## Variants

### `GET /variants/compare?days=30`

Each set's outcomes over the last `days` (1 to 365): `{"days", "sets": [{"param_set", "source", "role", "recalls", "delivered", "judged", "used_rate", "irrelevant_rate", "wrong_rate", "leaks"}]}`. A `served` row counts the recalls the set served and the entries they delivered. A `shadow` row counts the recalls the shadow ranked (and `skipped`, the ones it couldn't), and since nobody saw what it would have delivered, its rates come only from the entries it shares with what was served: `overlap` is that share of its deliveries. `judged` is the entries with an outcome, the rates' denominator: used (or helpful), irrelevant and wrong from feedback. `leaks` counts entries marked wrong or blamed for Wen's pushback.

Up to 2 sets with role `shadow` rank every real recall after its response is out, as of the same clock reading, and log one `memory.shadow_retrieval` row each: their top 12 ids and scores and what they would have delivered, with status `ranked`, `skipped:error` or `skipped:budget`. They judge only pairs missing from `memory.judge_cache` (keyed by the request's hash, entry, judged text's hash and judge version), which the served recall fills first. Their judge calls carry `x-memory-purpose: shadow` and are metered as kind `shadow`, which stops at the setting `research_budget_tokens` when set. A shadow never ticks the clock, never changes the packet and never reaches the learner. Rows older than 180 days go daily (`memory.variant_retention()`).

### `GET /variants/guard`, `POST /variants/guard`

The guardrails (R34). `POST` runs `memory.variant_guard()`, which pg_cron's `memory-variant-guard` also runs daily at 05:23 UTC. `GET` reports the same without acting. Returns:

```json
{"days": 7, "acted": true, "rolled_back": ["hybrid.t1"],
 "checked": [{"param_set": "hybrid.t1", "against": "hybrid.v1", "recalls": 1000, "against_recalls": 1000, "reasons": ["leak: ..."]}],
 "srm": {"since": "...", "units": {"hybrid.v1": 600, "hybrid.t1": 400}, "chi2": 40, "df": 1, "p": 2.5e-10, "mismatch": true},
 "sets": [{"param_set", "arm", "role", "weight", "recalls", "used_rate", "wrong_rate", "leaks", "leak_rate", "empty_rate",
           "p95_latency_ms", "costed", "cost_per_recall"}]}
```

`sets` rolls up every live and default set's real recalls (recall_more pages left out) over the last `guard_days` (7): `used_rate` is the share with a used or helpful verdict, `wrong_rate` with a wrong verdict, `leaks` and `leak_rate` count a wrong verdict or Wen's pushback, `empty_rate` is the share that delivered nothing, `p95_latency_ms` is the 95th percentile of `latency_ms`, and `cost_per_recall` the mean `openai_tokens` over the `costed` recalls that logged them.

Each live set with a weight above 0 is checked against the default with the most recalls on its arm. It rolls back when it's over the default by more than `guard_leak_points` (2) points of leak rate, `guard_empty_points` (5) points of empty packets, or `guard_cost_pct` (50) percent of cost, once both sides have `guard_min_recalls` (50) recalls, or by `guard_latency_pct` (30) percent of p95 latency, once both have `guard_min_latency_recalls` (200). All are rows of `memory.setting`. A rollback sets the weight to 0, writes an `allocation.rollback` audit row and messages `all`. A set already at 0 isn't checked, so a second run rolls nothing back twice.

`srm` tests the serving sets' distinct units (`retrieval.unit_hash`) since the last allocation change, within the window, against their shares with a chi-square test. It runs when 2 or more sets serve and each expects at least 5 units. `mismatch` is p below `guard_srm_alpha` (0.001), and with `POST` it writes an `allocation.srm` audit row and messages `all`. It never rolls back.

Each recall's row logs `openai_tokens`, what its own embedding and judge calls spent (shadows' spend is theirs), and `unit_hash`, the SHA-256 of the unit the allocation hashed.

## Embeddings

### `POST /embeddings/sync`

Pulls the model and embeds every entry whose text changed, in the background on a connection of its own. Returns 202 `{"started": true}`, or 409 while a sync runs. The sync the server runs at startup counts, so the two never run at once.

A failure never surfaces as an error. It is logged, `/overview` shows it under `health.sync`, and the audit row says what happened. `after` is `{"embedded": N}` or `{"error": "ConnectError: ..."}`. The startup sync isn't an API write, so it has no audit row.

## Audit

### `GET /audit`

Newest first. Each item has `id`, `at`, `action`, `target`, `before` and `after`. The table's `actor` column says who acted: `admin`, `research`, or `guardrail` for `memory.variant_guard()`.

| action | target | before | after |
|---|---|---|---|
| `entry.create` | `entry:<id>` | null | The row, plus the links it got |
| `entry.update` | `entry:<id>` | Changed fields | Changed fields |
| `entry.delete` | `entry:<id>` | The row | null |
| `entry.supersede` | `entry:<id>`, the replaced one | null | The new link, from `/supersede` or a `supersedes` link |
| `entry.artifact` | `entry:<id>` | null | `name`, `sha256`, `kind`, `media_type`, `size`, `stored` |
| `entry.confidence` | `entry:<id>` | `confidence` | `confidence`, `note` |
| `link.create` | `entry:<src>` | null | The link |
| `link.delete` | `entry:<src>` | The link | null |
| `feedback.create` | `retrieval:<id>` | null | `verdict`, `entry_id`, `note` |
| `message.create` | `message:<id>` | null | `to` and `body` as sent |
| `embeddings.sync` | `embeddings` | null | `embedded` or `error` |
| `param_set.create` | `param_set:<id>` | null | `arm`, `parent`, `note`, `by` |
| `allocation.put` | `allocation` | `{rows}`, the table before | `{by, rows}`, the table after |
| `allocation.rollback` | `param_set:<id>` | `{role, weight}` before | `{role, weight: 0, reason, days, recalls, against, against_recalls}` |
| `allocation.srm` | `allocation` | null | The `srm` result that found the mismatch |
| `eval.test_read` | `eval:test` or `eval:all` | null | `split`, `questions` |

## Code

[supabase/functions/memory/admin.ts](supabase/functions/memory/admin.ts) holds the routes, the input parsing and the SQL, one function per endpoint. The function type-checks with `deno check supabase/functions/memory/index.ts`.

## Billing (R38)

Plans, entitlements and usage. memory/BILLING.md has the access rule, the webhooks and the setup.

### `GET /billing/plans`

Every row of `memory.plan`: its price, its limits (null is no limit), `open`, `listed`, `artifacts` and `product_ids`.

### `PUT /billing/plans/{id}`

Creates or updates a plan. The body can set any of these: `name`, the limit columns (whole numbers ≥ 0, or null), `open`, `listed`, `artifacts`, `margin_floor` (0 to 1) and `product_ids`. The change lands with an audit row, and every instance applies it within a minute.

### `GET /billing/entitlements?state=`

Every signed-in account, newest first, with:

- its email and country
- its allowlist plan
- its subscription: provider, plan, state, period end, cancel-at-period-end and billing country

`state` filters to one state: `pending`, `paid`, `lapsed`, `refunded` or `blocked`.

### `GET /billing/usage/{owner}`

That owner's counters. Each row is `{period, kind, amount}`, where kind is one of `recalls_month`, `remembers_month`, `openai_tokens_month` or `blob_bytes_total`.
