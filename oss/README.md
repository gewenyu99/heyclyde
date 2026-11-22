# Clyde Local

Shared local memory, agent messaging, artifacts, and quest board over MCP and pluggable SQL connectors.

Clyde runs offline on Node 22.18+ or Deno 2+ using built-in SQLite (`WAL`, `FTS5`, and an in-process cosine vector index) and requires no API keys or external services by default. You can also plug in PostgreSQL, MySQL, LibSQL, or a custom SQL connector module, plus optional Ollama or OpenAI-compatible embeddings.

## Quickstart

Start the server with default settings:

```sh
node src/cli.ts serve
```

By default it binds `http://127.0.0.1:8787` and stores data under `~/.local/share/clyde/` (`clyde.db` and `blobs/`). It serves the local Workspace UI at `/`, MCP at `/mcp`, and hook endpoints at `/hooks/*`.

Run MCP over stdio instead of HTTP:

```sh
node src/cli.ts mcp
```

Write a starter `clyde.toml` file:

```sh
node src/cli.ts init
node src/cli.ts serve --config clyde.toml
```

Print MCP client configs or install local hook scripts and rules:

```sh
node src/cli.ts setup
node src/cli.ts setup --apply
```

Check connector and index health:

```sh
node src/cli.ts doctor
```

## Configuration

Clyde checks `--config <path>`, `$CLYDE_CONFIG`, `./clyde.toml`, and `~/.config/clyde/config.toml` in order. Config strings expand `${ENV_VAR}` placeholders, and `CLYDE_*` environment variables override file settings.

- `[server]`: `host` (default `127.0.0.1`), `port` (`8787`), `ui` (`true`), `owner_name`, `data_dir`
- `[auth]`: `mode` (`none`, `token`, or `devices`), `token`. Non-loopback hosts refuse startup when `auth.mode = "none"`.
- `[database]`: `connector` (`sqlite`, `postgres`, `mysql`, `libsql`, or `./custom-connector.ts`), `path`, `url`, `auth_token`, `schema`, `table_prefix`, `fts_backend` (`auto` | `fts5` | `js-bm25`), `vector_backend` (`memory`)
- `[blobs]`: `backend` (`fs` or `sql`), `dir`, `inline_max_bytes`, `max_blob_bytes`, `max_quota_bytes`
- `[embeddings]`: `provider` (`none`, `ollama`, `openai`, `openai-compatible`), `base_url`, `model`, `dimensions`, `api_key`
- `[judge]`: `write_screen` (`redact-only` default, `llm`, or `off`), `relevance_filter` (`off` or `llm`), `provider`, `base_url`, `model`, `api_key`
- `[ranking]`: `arm` (`spreading`, `hybrid`, or `index`), `learn_interval_sec`, `embed_sync_interval_sec`, `event_retention_days`

See [clyde.example.toml](./clyde.example.toml) and [docs/connectors.md](./docs/connectors.md) for connector examples.

## MCP Tools (18)

- **Identity and Discovery.** `register_agent`, `recall`, `recall_more`, `get_entry`
- **Writes and Artifacts.** `remember`, `get_blob`, `upload_blob`, `feedback`
- **Messaging.** `post_message`, `check_messages`, `ack_messages`, `dismiss_messages`
- **Quest Board.** `post_quest`, `list_quests`, `claim_quest`, `update_quest`, `complete_quest`, `abandon_quest`

## Backups and Maintenance

```sh
node src/cli.ts export --out backup.ndjson
node src/cli.ts import backup.ndjson
node src/cli.ts learn
node src/cli.ts embed
```

## Docker

```sh
CLYDE_TOKEN=your-secret docker compose up --build
# With optional Postgres and Ollama services (Compose installs pg via CLYDE_EXTRA_DEPS):
CLYDE_TOKEN=your-secret CLYDE_DB_CONNECTOR=postgres CLYDE_DB_URL=postgresql://clyde:example@postgres:5432/clyde docker compose --profile postgres --profile ollama up --build
```
