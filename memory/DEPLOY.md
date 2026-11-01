# Deploy

Memory runs on one Supabase project, `memory` (ref `wlhlncmgjqyidosunugv`, Canada, Free plan). Postgres holds the store in schema `memory`, which Supabase's public API can't reach. One Edge Function, also named `memory`, serves everything at:

```
https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory
```

## Connect a computer

Run this from a checkout of this repo. It connects Claude Code and Codex, and it's safe to rerun.

```bash
memory/hooks/install.sh
```

A computer with no token asks for the admin token once, mints a token of its own named after the computer, and saves only that. The admin token is never written to disk. Pass `--device <name>` to pick the name.

- **Claude Code.** The MCP server `memory` at user scope, and the hooks merged into `~/.claude/settings.json`.
- **Codex.** `[mcp_servers.memory]` in `~/.codex/config.toml` and the hooks in `~/.codex/hooks.json`. Run `/hooks` in the Codex CLI once to trust them.
- **Old entries go.** A rerun replaces earlier `memory` and `kb` entries. Your own hooks stay.

Cloud sessions on this repo read `.mcp.json` and `.claude/settings.json`. Give the cloud environment a `MEMORY_TOKEN`, minted the same way as a computer's.

## The tokens

Supabase stores every token as SHA-256 only, so a database read never yields one.

| Token | Held by | Opens |
|---|---|---|
| Device token | One computer, in `~/.config/memory/token` | MCP, the hooks, the inbox, clyde-flow's routes. Writes are drafts in a run scope |
| Runtime token | clyde-flow's daemon only | The same paths, and alone writes above draft |
| Admin token | You, in `~/.config/memory/admin-token` on the first Mac | `/api/v1`, the console's API |
| Backup token | The nightly GitHub Action | `/export` only |

Revoke a lost computer with `DELETE /api/v1/devices/<name>`. After 10 wrong tokens from one address, it's locked out, twice as long with each further miss, up to 15 minutes.

## Ship a change

```bash
cd memory && supabase functions deploy memory --project-ref wlhlncmgjqyidosunugv --no-verify-jwt --use-api
```

The CLI needs one `supabase login` per computer. `--no-verify-jwt` is right: the function checks its own tokens in [auth.ts](supabase/functions/memory/auth.ts).

Schema changes go in [supabase/migrations](supabase/migrations) and apply with `supabase db push`. Every migration so far is safe to rerun.

## Embeddings

OpenAI's `text-embedding-3-large`, cut to 1024 dimensions. The key sits in Supabase Vault. Set or rotate it with:

```bash
memory/hooks/set-openai-key.sh
```

pg_cron calls `/embeddings/sync` every 5 minutes, which embeds any entry whose text changed. A write answers before it's embedded, and keyword search finds it at once.

Spending stops at 38 million tokens a month, which is $5. Past that, recall serves keyword ranks until the month turns and the console says so. Raise the cap with a row in `memory.setting` named `embed_budget_tokens`.

## Back up and restore

[memory-backup.yml](../.github/workflows/memory-backup.yml) runs nightly at 08:17 UTC. It pulls `/export`, compresses and encrypts it, and keeps it as an artifact for 30 days. It needs two repository secrets, `MEMORY_BACKUP_TOKEN` and `MEMORY_BACKUP_KEY`. The key is also in `~/.config/memory/backup-key`.

To restore, download an artifact and post it back through the console API's import, which skips rows that already exist:

```bash
gh run download <run-id> -n memory-<run-id>
python memory/backup/restore.py memory.ndjson.gz.enc
```

Embeddings aren't backed up. The next sync rebuilds them, for about $0.03.

## Free plan limits

- **500 MB database.** It's 93 MB today, mostly hook events.
- **No platform backups.** The nightly export covers that.
- **Pauses after a week idle.** Hooks write every session, so it won't idle while you work.

## Open the console

Supabase serves HTML only on a custom domain, so the console isn't hosted yet. Its API is live at `/api/v1` behind the admin token. See [api/API.md](api/API.md).
