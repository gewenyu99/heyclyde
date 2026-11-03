# memory management API

The console's API. It shows everything memory holds and changes entries, links and the message board, over JSON at `/api/v1`.

It is Wen's own console behind its own admin token, so private entries show in full here. The MCP tools still redact them.

```bash
curl -H "Authorization: Bearer $(cat ~/.config/memory/admin-token)" https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/api/v1/overview
```

## Auth

Every `/api/v1` path needs `Authorization: Bearer <admin token>`. The function stores only its SHA-256, as `admin_token_sha256` in `memory.setting`, and answers 503 while none is set. A missing or wrong token gets 401 `{"error": "unauthorized"}`, and ten wrong tokens from one address start a lockout.

A device token never opens it. Every agent holds its computer's device token, for MCP, the hooks and its inbox, and an agent with Bash could otherwise read private entries in full and write as Wen. Each token works on its own paths only.

| Path | Takes |
|---|---|
| `/api/v1`, `/api/v1/*`, `/` | The admin token |
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
               "packet": "Index lines that match. ..."},
 "client": "claude-code",
 "candidates": [{"rank": 1, "id": "tea-oolong-temp", "score": 0.09, "title": "...", "authority": "approved",
                 "superseded_by": [], "current": true, "delivered": true, "exists": true}],
 "feedback": [{"id": 1, "source": "wen", "verdict": "helpful", "entry_id": null, "note": null, "created_at": "..."}]}
```

`packet` is the exact text the agent read under the retrieval id. Recalls made before it was stored have null.

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

Body `{"to": "claude", "body": "..."}`. `to` is `claude`, `codex`, `all` or another agent name memory has seen in the last 30 days, in any case. One delivery goes to the recipient, or for `all` to every agent seen in the last 30 days. The sender is `wen`. Returns 201 `{"id", "to"}`, or 422, which includes `all` when no agent has been seen.

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

Every set, by arm then id. Each item has `id`, `arm`, `params`, `parent`, `note`, `created_by` and `created_at`. `params` holds every knob: `candidates`, `packetItems`, `packetTokens`, `filterK`, `filterThreshold`, `tiltBase`, `tiltUnknownConfidence`, `tiltWindow`, `rowWindow`, `dormant`, `rrfK`, `vecWeight`, `indexDraftFactor`, `scopeBoost`, the optional `otherRunFactor` and `globalAgentDraftFactor` (each in (0, 1], 1 when a set leaves them out, so the v1 sets rank as before), `restart`, `iterations`, `supersededFactor`, `linkTypeWeights` (keyed `src_pattern|link_type|dst_pattern`) and the features' weights `wTemperature`, `wAge` and `wKind`, which stay 0 until the features exist. `index.v1`, `hybrid.v1` and `spreading.v1` hold the constants memory ranked by before parameter sets existed.

### `GET /param-sets/{id}`

One set, or 404.

### `POST /param-sets`

Body `{"id": "hybrid.v2", "parent"?: "hybrid.v1", "arm"?: "hybrid", "params": {...}, "note"?: "...", "by"?: "..."}`. With a `parent`, `params` names only the knobs that differ and the set stores all of them, and `arm` defaults to the parent's. Without one, `params` must name every knob. Returns 201 with the row. A set is never changed or deleted, and the database refuses it, so there is no PUT. An id that exists gets 409. An unknown knob, a value out of range or an unknown parent gets 422 with what to fix. Audited as `param_set.create`.

### `GET /allocation`

`{"rows": [{"param_set", "arm", "role", "weight", "share"}]}`. `role` is `off`, `shadow`, `live` or `default`. Only `live` and `default` rows with a weight above 0 serve, in proportion to their weights, and `share` is that proportion (null for the rest). A unit (a run scope's id, or else device, client and UTC day) is hashed with a salt into one of 1000 buckets laid along those shares, so it always gets the same set, and each recall logs the set and the share it was served with. While no row serves, the function's `MEMORY_ARMS` stands in: each arm on its v1, an equal share each, and `rows` is empty.

### `PUT /allocation`

Body `{"rows": [{"param_set", "role", "weight"}], "by"?: "..."}`. `by` is text of 1 to 64 characters and defaults to `admin`; the audit row records it. The rows named are set and the others stay, so one PUT can turn one variant off: `{"param_set": "hybrid.v2", "role": "off", "weight": 0}`. `weight` is a whole number, 0 or more. 422 if a set doesn't exist, a role is wrong, or the result would leave nothing serving, and then nothing changes. A session that a set served stops being served by it as soon as the set's role is off or its weight 0. Audited as `allocation.put`: `before` is `{"rows": [...]}`, the whole table before, and `after` is `{"by": "...", "rows": [...]}`.

## Eval

### `GET /eval/questions?split=train`

The practice queries with their gold and must_not entries, for `eval/retrieval_eval.py`.

### `POST /eval/rank`

Body `{"query", "arm", "filter"?: true, "param_set"?: "hybrid.v1", "parent"?: "hybrid.v1", "params"?: {...}}`. Ranks and packs one query and returns `{"param_set", "candidates", "delivered", "rejected", "degraded", "parts"}`. With `param_set` it runs that stored set (and `arm` may be left out). With `params` it lays those knobs over `parent`, or the arm's v1, without storing anything. With neither it runs the arm's v1. It writes no retrieval, so it never ticks the recall clock.

## Embeddings

### `POST /embeddings/sync`

Pulls the model and embeds every entry whose text changed, in the background on a connection of its own. Returns 202 `{"started": true}`, or 409 while a sync runs. The sync the server runs at startup counts, so the two never run at once.

A failure never surfaces as an error. It is logged, `/overview` shows it under `health.sync`, and the audit row says what happened. `after` is `{"embedded": N}` or `{"error": "ConnectError: ..."}`. The startup sync isn't an API write, so it has no audit row.

## Audit

### `GET /audit`

Newest first. Each item has `id`, `at`, `action`, `target`, `before` and `after`.

| action | target | before | after |
|---|---|---|---|
| `entry.create` | `entry:<id>` | null | The row, plus the links it got |
| `entry.update` | `entry:<id>` | Changed fields | Changed fields |
| `entry.delete` | `entry:<id>` | The row | null |
| `entry.supersede` | `entry:<id>`, the replaced one | null | The new link, from `/supersede` or a `supersedes` link |
| `link.create` | `entry:<src>` | null | The link |
| `link.delete` | `entry:<src>` | The link | null |
| `feedback.create` | `retrieval:<id>` | null | `verdict`, `entry_id`, `note` |
| `message.create` | `message:<id>` | null | `to` and `body` as sent |
| `embeddings.sync` | `embeddings` | null | `embedded` or `error` |
| `param_set.create` | `param_set:<id>` | null | `arm`, `parent`, `note`, `by` |
| `allocation.put` | `allocation` | `{rows}`, the table before | `{by, rows}`, the table after |

## Code

[supabase/functions/memory/admin.ts](supabase/functions/memory/admin.ts) holds the routes, the input parsing and the SQL, one function per endpoint. The function type-checks with `deno check supabase/functions/memory/index.ts`.
