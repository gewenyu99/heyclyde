# Deploy

Memory runs on one Supabase project, `memory` (ref `wlhlncmgjqyidosunugv`, Canada, Pro plan). Postgres holds the store in schema `memory`, which Supabase's public API can't reach. One Edge Function, also named `memory`, serves everything at:

```
https://memory.heyclyde.me
```

That's a Cloudflare Worker (`memory/proxy`) in front of the function's own address, `https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory`, which keeps working. The Worker sends a shared secret (its SHA-256 is the setting `proxy_secret_sha256`), so the function trusts the caller's IP for lockouts and answers with the domain in its URLs. Deploy it with `npx wrangler@4 deploy` from `memory/proxy`.

## Connect a computer

Run this on the computer. No checkout and no token to copy:

```bash
curl -fsSL https://memory.heyclyde.me/install | sh
```

It asks for your email and sends a sign-in link there. Click it from any device, your phone included, and the installer finishes on its own. The function mints this computer a token of its own, named after its hostname or `MEMORY_DEVICE`.

memory is allowlist only. An email outside `memory.allowed_email` stops at the first step, before any email is sent, and minting a token checks the list again. Supabase Auth takes no sign-ups, so no one else can even make an account. Add someone with `insert into memory.allowed_email (email) values ('…')` and create their user in the Supabase dashboard under Authentication. The link alone signs nobody in, since the installer holds the PKCE verifier. Rerunning on a computer that's already connected reuses its token. Reinstalling one that lost it rotates the token.

- **Claude Code.** The MCP server `memory` at user scope, and the hooks merged into `~/.claude/settings.json`.
- **Codex.** `[mcp_servers.memory]` in `~/.codex/config.toml` and the hooks in `~/.codex/hooks.json`. Run `/hooks` in the Codex CLI once to trust them.
- **Gemini CLI and Antigravity**, when they're here. See [Connect your apps](#connect-your-apps).
- **Old entries go.** A rerun replaces earlier `memory` and `kb` entries. Your own hooks stay.

It needs `curl`, `python3` and Claude Code, on macOS or Linux. Supabase's built-in email only sends to members of the Supabase organization, and about two an hour.

Cloud sessions on this repo read `.mcp.json` and `.claude/settings.json`. Give the cloud environment a `MEMORY_TOKEN`.

## Connect Claude chats, Cowork and the phone

claude.ai takes memory as a custom connector. Add it once and it's in every chat, in Cowork, in the desktop app and on the phone, since connectors follow the account:

1. In claude.ai, open Settings, then Connectors, then **Add custom connector**.
2. Name it `memory` and give it `https://memory.heyclyde.me/mcp`. Leave the OAuth fields empty.
3. Click **Connect**. The window that opens says it emailed you a sign-in link. Click the link from any device, and the window moves on to claude.ai by itself.

Chats get recall, remember, feedback and messages. They have no hooks, so nothing logs a chat's events or puts the inbox in front of it unasked.

How it works: Supabase Auth's OAuth 2.1 server runs the protocol, and claude.ai registers itself there. Supabase sends the sign-in to `/oauth/consent` on the function, which stands in for the consent page because Supabase serves no HTML on its own domain. It emails the one allowlisted address and keeps the PKCE verifier. The window reloads `/oauth/wait` every few seconds. The click lands on `/oauth/approve`, which signs the owner in on the server and approves the request, but only when its callback is https on claude.ai, claude.com, antigravity.google, grok.com, x.ai or gemini.google.com (those hosts exactly), or on this computer. Anything else is refused and logged to `admin_audit` as `oauth_deny`, with the `redirect_uri` it asked for, and to the function's log. `/mcp` takes the access token the client gets for an allowlisted email and treats it as a device with metadata-only hooks. Such a token can't mint device tokens. At most three sign-in emails go out in 15 minutes. If a link arrives that you didn't ask for, don't click it: the click is what grants access.

## Connect your apps

Every app reaches the same server, `https://memory.heyclyde.me/mcp`, and what memory does stays on the server. The apps that sign in through OAuth get no token: the sign-in is the email link described above. Hooks need this computer's device token, which only the installer gets.

### Claude Code, with the plugin

The plugin brings the MCP server (signed in through OAuth) and the hooks.

1. In Claude Code, run `/plugin marketplace add gewenyu99/like-vincent`, then `/plugin install memory@like-vincent`.
2. Run `/memory:connect`. It asks for your email if this computer has no token yet, and runs the installer with `MEMORY_CLAUDE=plugin`, so the installer gives the hooks a token and `memory-hook` and leaves Claude Code to the plugin. If the installer set up Claude Code here before, its `memory` MCP server and its hooks in `~/.claude/settings.json` come out, so nothing is there twice. Codex, Gemini CLI and Antigravity are set up too when they're here.
3. Start a new session. The first time it uses memory's tools, Claude Code opens the OAuth sign-in. Click the link in your email.

Until `/memory:connect` has run, the plugin's hooks print one line at the start of each session saying to run it, and do nothing else. A computer whose `settings.json` still has the installer's own hooks forwards through those, and the plugin's stay quiet.

### Claude Code, with the installer

```bash
curl -fsSL https://memory.heyclyde.me/install | sh
```

This adds the `memory` MCP server at user scope with this computer's token in its header, and merges the hooks into `~/.claude/settings.json`. Use the plugin or the installer, not both.

### claude.ai

A custom connector. See [Connect Claude chats, Cowork and the phone](#connect-claude-chats-cowork-and-the-phone).

### Gemini CLI

1. Run the installer, or `/memory:connect` in Claude Code. It sets Gemini CLI up when `gemini` is on PATH or `~/.gemini` exists.
2. It writes the extension `~/.gemini/extensions/memory`: `gemini-extension.json` with `mcpServers.memory.httpUrl` and no token, and `hooks/hooks.json`, which runs `~/.config/memory/gemini-hook` on SessionStart, BeforeAgent, AfterTool (memory's tools) and AfterAgent.
3. Start Gemini CLI. It finds memory's OAuth server by discovery and opens the sign-in. If it doesn't, run `/mcp auth memory`. Click the link in your email.
4. Check with `/mcp`, which lists memory's tools, and `/extensions`, which lists `memory`. If memory's hooks don't run, update Gemini CLI to a version with hooks.

`gemini-hook` maps Gemini's events onto memory's: SessionStart to SessionStart, BeforeAgent to UserPromptSubmit, AfterTool to PostToolUse, AfterAgent to Stop (its `prompt_response` also goes as `last_assistant_message`). It forwards through `memory-hook` as the agent `gemini`, so Gemini has its own inbox. It prints JSON only, since Gemini CLI turns plain stdout into a message the model never sees: what memory says at SessionStart and BeforeAgent goes in `hookSpecificOutput.additionalContext`, and every other answer is `{}`.

### Antigravity

1. Run the installer, or `/memory:connect` in Claude Code. It sets Antigravity up when `~/.gemini/config` exists or an `antigravity` or `agy` binary is on PATH.
2. It merges one entry into `~/.gemini/config/mcp_config.json`, beside your other servers, which stay as they are:

   ```json
   { "mcpServers": { "memory": { "serverUrl": "https://memory.heyclyde.me/mcp" } } }
   ```

   To add it by hand, put that `memory` entry in the file yourself. A rerun of the installer writes nothing when the entry is already there.
3. Restart Antigravity, or refresh its MCP servers. It registers itself with memory's OAuth server and opens the sign-in, with the callback `https://antigravity.google/oauth-callback`. Click the link in your email.
4. Check that memory's tools are listed in Antigravity's MCP servers. Antigravity has no hooks, so like claude.ai it gets the tools only.

### The Gemini app

The Gemini app at gemini.google.com takes remote MCP servers as custom apps. It may need a Google AI Ultra plan, or an account in the US, before the option shows.

1. In gemini.google.com, open Settings, then **Connected Apps**, and add a custom app.
2. Give it the URL `https://memory.heyclyde.me/mcp`.
3. Connect. Gemini opens memory's sign-in in the browser. Click the link in your email.
4. Ask Gemini to recall "memory's domain". The answer names heyclyde.me.

Google doesn't document the app's OAuth callback, so memory approves https callbacks on gemini.google.com only. If the window says memory refused it, the refused callback is in `admin_audit`, found with the query under Grok below. Add that host to `CLIENT_HOSTS` and deploy.

### Grok

1. Open [grok.com/connectors](https://grok.com/connectors), choose **Custom**, and give it the URL `https://memory.heyclyde.me/mcp`.
2. Connect. Grok opens memory's sign-in. Click the link in your email.
3. Ask Grok to recall "memory's domain". The answer names heyclyde.me.

Grok doesn't document its OAuth callback, so memory approves https callbacks on grok.com and x.ai. If the window says memory refused Grok, the refused callback is in `admin_audit`:

```sql
select created_at, after->>'name' as client, after->>'redirect_uri' as redirect_uri
from memory.admin_audit where action = 'oauth_deny' order by created_at desc limit 5;
```

Add that host to `CLIENT_HOSTS` in [oauth.ts](supabase/functions/memory/oauth.ts) and deploy.

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
| Research token | The weekly research-memory task, in `~/.config/memory/research-token` | The research routes of `/api/v1` only: read variants, allocation and the train split, make sets, move its own between off and shadow |
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

## The arms

| Arm | Live | How it ranks | Train gold hit |
|---|---|---|---|
| `index` | yes | Index lines matching the query's words | 81% |
| `hybrid` | yes | English and 中文 keywords plus vectors, fused | 95% |
| `spreading` | yes, since 2026-11-02 | Hybrid's top 50 as seeds, then personalized PageRank over typed links (`link_type_weight` × each link's learned weight), replaced entries ×0.3 | 95% |

Every arm passes the same relevance filter and confidence tilt. Which arms serve, and with what share, is the allocation (`GET` and `PUT /api/v1/allocation`, [API.md](API.md#parameter-sets-and-allocation)), changed with no deploy. Until the allocation has a serving row, the function's `MEMORY_ARMS` secret decides, each arm on its v1 set with an equal share, for example `supabase secrets set MEMORY_ARMS=index,hybrid,spreading`. **Right after applying the learning-loop migration, PUT the allocation to match `MEMORY_ARMS`** if you want the table, not the secret, in charge:

```bash
curl -X PUT "$MEMORY_URL/api/v1/allocation" -H "Authorization: Bearer $MEMORY_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"rows": [{"param_set": "index.v1", "role": "default", "weight": 333}, {"param_set": "hybrid.v1", "role": "default", "weight": 333}, {"param_set": "spreading.v1", "role": "default", "weight": 334}]}'
```

Every knob each arm ranks by (candidates, packet size, the filter, the tilt, the fusion and PageRank constants, the link type weights) is a row of `memory.param_set`, and a set never changes. `eval/retrieval_eval.py --params <id|file.json>` runs any set offline. Link type weights have one owner: the `linkTypeWeights` of the set a recall is served. `eval/ants.py` saves its result as a new spreading set (parent `spreading.v1`, id `spreading.ants-<time>`) and writes nothing else, so trying it is `retrieval_eval.py --params <id>`, and serving it is an allocation row. `PUT /link-type-weights` answers 410 and points at `POST /param-sets`. The `link_type_weight` table stays for the record, and nothing ranks by it.

[eval/ants.py](eval/ants.py) trains the per-link-type weights with an ant colony on the train questions. On today's 21 train questions it didn't beat neutral weights, so they're back at 1.0. Rerun it as the probe set grows.

## Guardrails and promotion

A live set that does worse than its arm's default loses its share by itself, daily. The pg_cron job `memory-variant-guard` runs `memory.variant_guard()` at 05:23 UTC, pure SQL with no function call. `POST /api/v1/variants/guard` runs the same thing now, and `GET` shows the rollup without acting.

Over the last 7 days it compares each live set with a weight above 0 against its arm's default and rolls it back past any of these bounds:

| Bound | Setting | Default | Acts from |
|---|---|---|---|
| Leak rate (recalls with a wrong verdict or your pushback) | `guard_leak_points` | +2 points | 50 recalls a side (`guard_min_recalls`) |
| Empty packets | `guard_empty_points` | +5 points | 50 recalls a side |
| OpenAI tokens per recall | `guard_cost_pct` | +50% | 50 recalls a side that logged tokens |
| p95 latency | `guard_latency_pct` | +30% | 200 recalls a side (`guard_min_latency_recalls`) |

A rollback sets the set's weight to 0, so it serves no one and stays registered. It writes one `allocation.rollback` audit row with actor `guardrail` and the bound in `after.reason`, and posts a message to `all`, so your agents relay it at your next prompt. Change a bound with `update memory.setting set value = '3' where name = 'guard_leak_points'`, and the next run reads it.

The same run tests the serving sets' units since the last allocation change against their shares. A chi-square p below `guard_srm_alpha` (0.001) means assignment or logging is broken: it writes an `allocation.srm` audit row and messages `all`, and rolls nothing back.

Promotion stays yours. `PUT /api/v1/allocation` refuses to make a set the default unless it already is, or it is its arm's v1, or the body carries `"by": "wen"`. Send that only once you've approved the change.

## The researcher

A weekly Claude Code scheduled task, "Research memory weekly", on Mondays at 09:00, follows [skills/research-memory](../skills/research-memory/SKILL.md) through [research/research.py](research/research.py). It reads the week's variant comparison, the guardrails' rollup and the train split's misses, proposes up to 3 child sets with written hypotheses, runs them on train, moves up to 2 winners to shadow and comments on the "memory research log" issue (label `research-log`), which it opens when it's missing.

It holds the research token only, never the admin token. Mint one on the Mac that runs the task:

```bash
umask 077 && openssl rand -hex 32 | tr -d '\n' > ~/.config/memory/research-token
shasum -a 256 ~/.config/memory/research-token | cut -d' ' -f1
```

Then store that hash, through the Supabase SQL editor or `execute_sql`:

```sql
insert into memory.setting (name, value) values ('research_token_sha256', '<the hash>')
  on conflict (name) do update set value = excluded.value;
```

The server holds the researcher to its limits whatever the skill says. It makes at most 3 sets a UTC week, each with a parent and a hypothesis of 20 characters or more, and it moves only the sets it made, only to off or shadow. It reads the train split only. `eval/retrieval_eval.py --split test` (or `all`) exits 2 unless `MEMORY_EVAL_FREEZE=1`, and the server answers a test read only with `freeze=1` and the admin token, and audits it as `eval.test_read`. Read test once, after the knobs are frozen.

## Versions and self-update

Two versions, each a date and a serial like `20261102.1`, both in [version.ts](supabase/functions/memory/version.ts):

- **`CLIENT_VERSION`** covers the client files computers update themselves from: `client/memory-hook`, `install.sh`, both hook configs, `signing-pub.pem`, and the Gemini CLI and Antigravity files (`gemini-hook`, `gemini-hooks.json`, `gemini-extension.json`, `antigravity-mcp.json`). It drives self-update. Every response carries it as `x-memory-client-latest`, and `/healthz` reports it as `client_version`.
- **`SERVER_VERSION`** covers the MCP tools and the server instructions. `/healthz` and the MCP `initialize` report it, and every response carries it as `x-memory-version`. Editing a tool description bumps only this one, and no computer updates itself for it: MCP clients read tools and instructions fresh at each `initialize`.

**Every change to a surface bumps its version.** Each version is pinned to the hash of its surface: `CLIENT_SURFACE_HASHES` and `SERVER_SURFACE_HASHES` are maps of `{ version: hash }`. After a change, bump the version (a new serial the same day, a new date otherwise), add the new entry with the hash `harness/test/memory/version.test.ts` prints, and for a client change add the release to `CLIENT_RELEASES` with today's date. The test fails unless the surface on disk hashes to the entry for the current version, fails if two versions share a hash, and fails if an entry that `origin/main` already has changed or went missing. `deploy.sh` runs it before it deploys, with deno required.

### Signed client files

A computer installs only files of a release signed by an offline key. When `deploy.sh` bakes `client/files.ts` it stamps `CLIENT_VERSION` into memory-hook, writes a `manifest` (a `version=<CLIENT_VERSION>` line, then one `<name> <sha256>` line for every client file, `signing-pub.pem` included, hashed as served), and signs only that manifest with RSA-3072 and SHA-256 (`openssl dgst -sha256 -sign`, which LibreSSL on macOS and OpenSSL on Linux both have; ed25519 is not used because LibreSSL may lack it). The server serves `/install/files/manifest` and `/install/files/manifest.sig` (base64), and no signature per file: one signature per release means files from different releases, or two files swapped, can't be mixed.

- **The private key** lives at `~/.config/memory/signing-key.pem` (mode 0600) on Wen's Mac and nowhere else. `deploy.sh` never prints it and refuses to deploy if it is missing or is not the key `signing-pub.pem` names. To make one: `(umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out ~/.config/memory/signing-key.pem)`, then `openssl pkey -in ~/.config/memory/signing-key.pem -pubout -out memory/supabase/functions/memory/client/signing-pub.pem`.
- **The public key** is committed as [client/signing-pub.pem](supabase/functions/memory/client/signing-pub.pem), and `install.sh` saves it to `~/.config/memory/signing-pub.pem`. That saved key is the only thing the update trusts.
- **`deploy.sh` refuses** to deploy a manifest without a signature that verifies.
- **Rotation.** A key change can only arrive through a file signed by the old key, since a computer trusts nothing else. To rotate: (1) make the new key as `~/.config/memory/signing-key.new.pem`; (2) copy the current `client/signing-pub.pem` to `client/signing-pub.previous.pem` (never served) and put the new public key in `client/signing-pub.pem`; (3) bump `CLIENT_VERSION` and deploy with `MEMORY_SIGNING_KEY=~/.config/memory/signing-key.pem memory/deploy.sh`, so the old key signs this release, which carries the new public key, and computers install it; (4) once every computer reports that version (`client_version` in `GET /api/v1/devices`), move the new key to `signing-key.pem`, delete `signing-pub.previous.pem`, bump and deploy again, signed by the new key. A computer that missed step 3 rejects the new key's signatures. It recovers by rerunning the installer, which saves the key from the server again.

### How each client picks a change up

- **MCP clients** (Claude Code, Codex, claude.ai, Cowork) read the tools and instructions at each `initialize`, so a deploy reaches them at their next session.
- **Hooks.** Every hook call sends `x-memory-client-version`. When the answer's `x-memory-client-latest` is newer, an installed hook runs `memory-hook --update` detached, which costs the hook a few milliseconds. The update:
  - starts only when the server that answered is the one in `~/.config/memory/url` (a `MEMORY_URL` in the environment, which a project's settings could set, doesn't count), reads only that server, and refuses any URL that isn't `https` and any redirect to one that isn't;
  - fetches the manifest and `manifest.sig` and verifies the signature against `~/.config/memory/signing-pub.pem`. A missing or bad signature aborts the update and writes `update-failed`. A manifest whose version isn't newer than the running hook's is a no-op (nothing installed, no failure noted), which also stops a replayed old release;
  - fetches every client file (memory-hook, install.sh, the hook configs, the Gemini and Antigravity files and the public key) into a temp dir and checks each one's sha256 against its own name's line in the manifest. Because the key is one of those files, a rollback to an older key fails with the manifest. It also requires the manifest's version to equal the fetched memory-hook's `VERSION`;
  - refuses anything empty, unparseable or without a shebang, then runs `install.sh --update` from that verified directory (it never fetches anything itself). That merges each hook config on its own (one that won't parse stops only that client, and its file stays as it was), refreshes `gemini-hook` and the Gemini extension's files on a computer that has the extension, then moves memory-hook into place atomically and, only if that worked, the new key. It asks nothing and keeps `~/.config/memory/token` and `url`.

  The update counts as done when the installed memory-hook carries the manifest's `VERSION`, whatever one client's config did on the way. `update-failed` is cleared when that is so, and also whenever the hook is at or past the version the pinned server announces.

  A lock directory stops two updates at once (a lock older than 10 minutes is a dead run's), and a failed try leaves the old client as it was and isn't repeated for 10 minutes. A checkout's memory-hook (a cloud session's) carries no stamp, reports `dev` and never updates.
- **Hook configs are rewritten only when they change.** A script-only update replaces memory-hook and leaves both configs alone, so Codex, which trusts hooks by their content, has nothing to trust again. When Codex's `hooks.json` does change, the update leaves a note and Codex's own hook prints one line once: `Codex: run /hooks to trust memory's updated hooks.`
- **What a hook says and hears.** For SessionStart, UserPromptSubmit and Stop, memory-hook prints the `/hooks` response body when the status is 2xx (read with `-w '%{http_code}'`; a 3xx body never prints), at most 8 KB of it. Claude Code adds a SessionStart or UserPromptSubmit body to the agent's context. It adds no plain stdout from Stop: Stop takes only a JSON decision like `{"decision":"block","reason":"..."}`, which Claude Code acts on. A body that starts with `{` prints alone, with no installer note and no inbox after it, so the JSON stays valid and the inbox stays unread for the next call. The `/hooks` routes answer with an empty body today, so nothing prints until the server has something to say. No header names a computer: the device token already does.
- **Old clients.** The server keeps answering every version. The cutoff, `MEMORY_CLIENT_CUTOFF_DAYS` (default 30), counts from `CLIENT_RELEASES`: a client is `expired` (`x-memory-client-status`) only when it is behind a client version released more than that many days ago, never because its own stamp is old. The line "Rerun `curl -fsSL https://memory.heyclyde.me/install | sh`" goes only to a client that is expired AND says its update failed (the hook sends `x-memory-update-failed: 1` while `update-failed` exists; its hook prints the line on SessionStart and UserPromptSubmit), or that sends no client version at all (a hook from before self-update, which can't fix itself, so the server adds the line to its inbox). `check_messages` shows the same note, but only for a computer that has called a hook or reported a version, never for one that only uses MCP and never for an `oauth:` connector. The rerun keeps the token and asks for no sign-in.
- **Who has updated.** Each device row keeps the version its hook last reported, `client_version` in `GET /api/v1/devices`, next to `last_seen`, with whether its last update failed and whether a hook has ever called.

## Ship a change

```bash
memory/deploy.sh
```

In order, it: runs the version guard; bakes the installer's files from `supabase/functions/memory/client/` into `client/files.ts` with a signed manifest (`memory/deploy.sh --bake` does only that); stops if any migration is still pending (`supabase migration list --linked --output-format json`, so `supabase login` and `supabase link --project-ref wlhlncmgjqyidosunugv` once per computer); then deploys with the Supabase CLI. `--no-verify-jwt` is right: the function checks its own tokens in [auth.ts](supabase/functions/memory/auth.ts).

**Migrations go before the function.** Apply them with `supabase db push --linked` first. `deploy.sh` parses the CLI's JSON (`{"migrations":[{"local":"...","remote":"..."}]}`) and stops, listing them, if any entry has a `local` version and no `remote`. It also stops if the output isn't that JSON, or lists nothing while `supabase/migrations/` holds files, since then it can't tell. The function also tolerates a database that lacks the R31 device columns (auth catches Postgres error 42703 and falls back to the plain `last_seen` update), so a deploy that races its migration can't lock a computer out.

Bump the version first when the change is client-visible, as above. Not every migration is safe to rerun on a database that has the later ones: `dashboard_views` fails once `dashboard_confidence` has added its columns.

Test a change end to end first with `memory/e2e/run.sh`. It brings a throwaway preview branch up to this checkout, runs [the e2e suite](e2e/README.md) against it, and deletes it.

## Embeddings

OpenAI's `text-embedding-3-large`, cut to 1024 dimensions. The key sits in Supabase Vault. Set or rotate it with:

```bash
memory/hooks/set-openai-key.sh
```

pg_cron calls `/embeddings/sync` every 5 minutes, which embeds any entry whose text changed. A write answers before it's embedded, and keyword search finds it at once.

Spending is metered by kind in `memory.openai_usage` (embed, judge_write, judge_recall, shadow, research). Embeds, recall's judge, shadows and research share 38 million tokens a month, which is $5. Past that, recall serves keyword ranks until the month turns and the console says so. Raise the cap with a row in `memory.setting` named `embed_budget_tokens`. The judge that screens writes has a reserve of its own, 5 million tokens a month, that nothing else spends, so remember keeps screening when the general budget is gone. Past the reserve, remember refuses with a message that says so. Raise it with `judge_write_reserve_tokens`. The two don't add up to one cap: the most a month can spend is both.

## The message queue

Messages between agents are a queue (R39). `post_message` writes one message and one delivery per recipient, and `all` goes to every agent seen in the last 30 days. `check_messages` hides what it returns for 30 minutes and brings it back until `ack_messages` acknowledges it, three deliveries at most, then drops it and tells the sender. The hook inbox acknowledges what it prints. `dismiss_messages` clears a recipient's deliveries unread.

pg_cron runs `memory-message-purge` daily at 04:17 UTC, in plain SQL (`memory.purge_messages()`). It deletes deliveries acked or dropped over 7 days ago and messages past their 14 days or with nothing waiting, and holds each recipient to its newest 100 waiting deliveries, with a note naming what it dropped. Run it by hand with `select memory.purge_messages()`.

An agent's name comes from its MCP client name: `claude` or `codex` when the client says so, else the name lowercased, with anything outside a-z, 0-9, `_` and `-` turned into `-`, cut to 40 characters. `memory.agent_name()` applies the same rule in sql, and `all` fans out by it. A message to `all` that no other agent could receive is refused.

Ids are message ids everywhere. The hook inbox and `check_messages` print the same `#N`, and `ack_messages` and `dismiss_messages` take it. A message and a recipient have one delivery, so the id picks out that recipient's delivery and no one else's.

The queue lands in three steps, since the function live now reads `message.read_by` and the new one doesn't.

1. `supabase db push` applies `message_queue`. It adds the tables, converts `read_by` into deliveries and schedules the purge, and it leaves `read_by` alone, so the old function keeps working. The purge keeps a message that has no delivery yet, which is what the old function posts until the new one deploys.
2. `memory/deploy.sh` deploys the new function.
3. Once it serves traffic, move [contract/message_queue_contract.sql](supabase/contract/message_queue_contract.sql) into `supabase/migrations` under a fresh timestamp and `supabase db push`. It gives a delivery to what the old function posted in between, then drops `read_by`. Do not push it in step 1: the old function's inbox fails on a missing column, and a message it posts after that never gets a delivery.

Restoring a backup from before the queue works either side of step 3. `/import` gives each message in it the deliveries `message_queue` would.

## Artifacts and Storage

Artifacts (R42) are blobs. Text up to 256 KB stays in `memory.blob.content`. Binary and bigger text go to the private Storage bucket `memory-blobs`, which migration `20261103030000_artifacts_storage.sql` creates with a 500 MB file limit and no policy on `storage.objects`, so only the function's service role reaches it. Two settings outside the migration:

- **Raise the project's global upload limit to 500 MB.** Storage settings in the dashboard cap every bucket (50 MB by default), and the bucket's own limit can't go above it.
- **`blob_quota_bytes`** is a row in `memory.setting` (bytes). Unset, the cap is 10 GiB, inside Pro's 100 GB. `0` freezes new blobs. `select coalesce(sum(size), 0) from memory.blob` is what memory holds now.

pg_cron runs `memory-blob-sweep` hourly at :17. It calls `/blobs/sweep` with the cron secret, which deletes files in `incoming/` that nobody cited within two hours, and the `memory.upload` rows that expected them.

Storage objects are not in the platform database backups. The nightly export carries Storage blobs of 4 MiB or less, up to 2 GiB a run (MEMORY_EXPORT_STORED_TOTAL). Bigger files have no copy off Supabase.

## Back up and restore

[memory-backup.yml](../.github/workflows/memory-backup.yml) runs nightly at 08:17 UTC. It pulls `/export`, compresses and encrypts it, and keeps it as an artifact for 30 days. It needs two repository secrets, `MEMORY_BACKUP_TOKEN` and `MEMORY_BACKUP_KEY`. The key is also in `~/.config/memory/backup-key`.

To restore, download an artifact and post it back through the console API's import, which skips rows that already exist:

```bash
gh run download <run-id> -n memory-<run-id>
python memory/backup/restore.py memory.ndjson.gz.enc
```

Embeddings aren't backed up. The next sync rebuilds them, for about $0.03.

## Pro plan

Wen keeps the org on Pro ($25 a month, decided 2026-11-02).

- **8 GB of database disk included.** memory used 93 MB on 2026-11-01, mostly hook events.
- **Daily platform backups, kept 7 days.** The nightly encrypted export to GitHub stays as the copy that lives off Supabase.
- **No pausing when idle.**
- **100 GB of Storage included**, which is room for blobs (R20).

## See your memory

The Supabase dashboard is the console: [Table Editor, schema `memory`](https://supabase.com/dashboard/project/wlhlncmgjqyidosunugv/editor?schema=memory). Four views read like the old console:

| View | Shows |
|---|---|
| `entries_overview` | Every entry with its project, link count, how often recall delivered it, and what replaced it |
| `links_readable` | Every binding, with the titles on both ends |
| `recalls_recent` | Recalls, newest first, with the titles each one delivered |
| `events_recent` | Hook events, newest first, with the prompt or tool name |

Supabase serves no HTML on its own domains, so the old console page isn't hosted. Its API still runs at `/api/v1` behind the admin token. See [API.md](API.md).
