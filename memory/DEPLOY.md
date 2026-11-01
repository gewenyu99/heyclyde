# Deploy

Memory runs on one Supabase project, `memory` (ref `wlhlncmgjqyidosunugv`, Canada, Free plan). Postgres holds the store in schema `memory`, which Supabase's public API can't reach. One Edge Function, also named `memory`, serves everything at:

```
https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory
```

## Connect a computer

Run this on the computer. No checkout and no token to copy:

```bash
curl -fsSL https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/install | sh
```

It asks for your email and sends a sign-in link there. Click it from any device, your phone included, and the installer finishes on its own. The function mints this computer a token of its own, named after its hostname or `MEMORY_DEVICE`.

memory is allowlist only. An email outside `memory.allowed_email` stops at the first step, before any email is sent, and minting a token checks the list again. Supabase Auth takes no sign-ups, so no one else can even make an account. Add someone with `insert into memory.allowed_email (email) values ('…')` and create their user in the Supabase dashboard under Authentication. The link alone signs nobody in, since the installer holds the PKCE verifier. Rerunning on a computer that's already connected reuses its token. Reinstalling one that lost it rotates the token.

- **Claude Code.** The MCP server `memory` at user scope, and the hooks merged into `~/.claude/settings.json`.
- **Codex.** `[mcp_servers.memory]` in `~/.codex/config.toml` and the hooks in `~/.codex/hooks.json`. Run `/hooks` in the Codex CLI once to trust them.
- **Old entries go.** A rerun replaces earlier `memory` and `kb` entries. Your own hooks stay.

It needs `curl`, `python3` and Claude Code, on macOS or Linux. Supabase's built-in email only sends to members of the Supabase organization, and about two an hour.

Cloud sessions on this repo read `.mcp.json` and `.claude/settings.json`. Give the cloud environment a `MEMORY_TOKEN`.

## The tokens

Supabase stores every token as SHA-256 only, so a database read never yields one.

## What gets in

Every write is screened before it's stored:

- **Redaction.** API keys, tokens, private keys, password values, credentials inside URLs, card numbers, SSNs and SINs become `[redacted:<kind>]` in hook payloads, entries, blobs, messages, recall queries, console edits and imports.
- **The judge.** `gpt-6-luna`, through OpenAI's Decisions API, refuses a note or message that holds sensitive personal information, tries to steer the assistants that read it, or carries harmful code, links or commands. If the judge can't answer, nothing is written.
- **Sensitivity.** `private` entries reach agents and OpenAI by title only. `confidential` entries, for work material, reach your agents in full and OpenAI by title only.

Every recall's top 12 candidates also go through the judge, and only the ones it calls relevant reach the agent. It costs about $2 per 10,000 recalls.

| Token | Held by | Opens |
|---|---|---|
| Device token | One computer, in `~/.config/memory/token`. Minted by the installer after your email sign-in | MCP, the hooks, the inbox, clyde-flow's routes. Writes are drafts in a run scope |
| Runtime token | clyde-flow's daemon only | The same paths, and alone writes above draft |
| Admin token | You, in `~/.config/memory/admin-token` on the first Mac | `/api/v1`, the console's API |
| Backup token | The nightly GitHub Action | `/export` only |

Revoke a lost computer with `DELETE /api/v1/devices/<name>`. A computer's token stops working after 90 days unused, and rerunning the installer signs it in again. Every new computer posts a board message that your agents relay at your next prompt, so one you didn't add shows up fast.

On a work computer, install with `MEMORY_HOOKS=metadata` in front of `sh`. memory then keeps only the event, session, folder and tool name from its hooks, never prompts or tool output. Switch an existing computer with `PATCH /api/v1/devices/<name>` and `{"hooks": "metadata"}`. After 10 wrong tokens from one address, it's locked out, twice as long with each further miss, up to 15 minutes.

## How memory learns

memory learns from how you react, with no approval step and nothing moving by calendar time. An entry nobody recalls for a year stays exactly as it was.

| Event | Effect |
|---|---|
| New entry | Confidence starts at approved 0.95, observed 0.7, draft 0.4. A groomer draft quoting you starts at 0.6 |
| Served, and your next prompt doesn't push back | +0.03, capped at 0.99. Links between the served entries +0.2, capped at 5 |
| Your next prompt pushes back and blames a served entry | That entry ×0.8. Its links among the served entries ×0.9, floor 0.2 |
| You say it again in a new session | +0.15, through the daily groom |
| The filter judges it irrelevant more than 5 recalls in a row | ×0.98 per further miss |
| Below 0.15 | Dormant: recall skips it, nothing deletes it |

The learner ([learn.ts](supabase/functions/memory/learn.ts)) runs every 5 minutes through pg_cron. `gpt-6-luna` reads the prompt you sent after each recall to spot pushback and which item caused it. Recall ranks by score × (0.9 + 0.1 × confidence), tuned on train. Every change lands in `memory.confidence_log`, so any of it can be traced and undone.

The daily groom drafts new entries from your own words. It's a Claude Code scheduled task, "Groom memory daily", at 9 pm, following [skills/groom-memory](../skills/groom-memory/SKILL.md) through [groom/groom.py](groom/groom.py). Every draft names the hook event its quote came from, and memory refuses any quote that isn't in that prompt word for word. Scheduled tasks run while the Claude app is open, and a missed one runs at next launch.

## Ship a change

```bash
memory/deploy.sh
```

It bakes the installer's files from `supabase/functions/memory/client/` into `client/files.ts`, then deploys with the Supabase CLI, which needs one `supabase login` per computer. `--no-verify-jwt` is right: the function checks its own tokens in [auth.ts](supabase/functions/memory/auth.ts).

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

## See your memory

The Supabase dashboard is the console: [Table Editor, schema `memory`](https://supabase.com/dashboard/project/wlhlncmgjqyidosunugv/editor?schema=memory). Four views read like the old console:

| View | Shows |
|---|---|
| `entries_overview` | Every entry with its project, link count, how often recall delivered it, and what replaced it |
| `links_readable` | Every binding, with the titles on both ends |
| `recalls_recent` | Recalls, newest first, with the titles each one delivered |
| `events_recent` | Hook events, newest first, with the prompt or tool name |

Supabase serves no HTML on its own domains, so the old console page isn't hosted. Its API still runs at `/api/v1` behind the admin token. See [API.md](API.md).
