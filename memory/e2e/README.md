# End-to-end tests on a Supabase branch

R30, item 1. memory's e2e suite runs on a short-lived preview branch of the memory project (a Pro feature), with real Auth, Postgres, pg_cron, Vault and Edge Functions. No Docker, and production data is never touched.

```bash
memory/e2e/run.sh
```

It needs the Supabase CLI, logged in (`supabase login`), plus `python3`, `curl` and Claude Code's CLI (on PATH or in the Claude desktop app, the same places the installer looks). It takes about 10 minutes, most of it the R15 test's 6-minute wait. It exits 0 when every test passes, counting an expected failure as passing.

## What it does

1. **Creates a branch** of `wlhlncmgjqyidosunugv`, named `e2e-<UTC time>`, in `ca-central-1`. It waits until the branch's database answers.
2. **Repoints pg_cron.** The migrations schedule `memory-embed-sync` and `memory-learn` against production's function URL. On the branch, `cron.alter_job` points them at the branch's own function.
3. **Applies migrations.** A new branch already has production's migration history. Production recorded it under other version numbers than the files here, so `supabase db push` refuses it, and some files can't be rerun on a database that has the later ones. So run.sh applies each file whose name isn't in the branch's history yet, and records it there.
4. **Pushes the auth config** from `supabase/config.toml`: no sign-ups, the OAuth server, the redirect URLs and the sign-in email template.
5. **Deploys** `memory`, and `fake-openai` beside it, with `--use-api --no-verify-jwt`, and sets the branch's secrets `MEMORY_OPENAI_URL` and `MEMORY_ARMS`. Supabase gives the branch its own `SUPABASE_URL`, `SUPABASE_DB_URL` and keys.
6. **Seeds** what the tests need, stored the way production stores it: `e2e@example.com` as the only allowlisted email (so the branch can never email Wen), three device tokens in `memory.device` and the admin token in `memory.setting` as SHA-256, and a `cron_secret` in Vault.
7. **Runs [suite.py](suite.py)** against `https://<branch ref>.supabase.co/functions/v1/memory`.
8. **Deletes the branch**, from a trap, so a failure or Ctrl-C still deletes it. It checks the branch list and retries until the branch is gone.

Every command after creating the branch targets the branch's ref, from a scratch copy of `memory/supabase` that's linked to no project, and run.sh stops if that ref is production's. The tokens it makes live in a mode-700 temp dir that's removed at the end, and anything that looks like a credential is masked in what it prints.

## OpenAI

Not called. `fake-openai` ([fake-openai/index.ts](fake-openai/index.ts)) stands in for the two endpoints memory uses, and `MEMORY_OPENAI_URL` points at it:

- `/embeddings` hashes words into 1024 dimensions, so texts that share words land near each other.
- `/decisions` answers every screening question and pushback with 0, every relevance question with 0.9 and every choice with `none`. So writes are never refused, recall's filter keeps every candidate, and the learner sees no pushback.

The judge's own behavior isn't tested here. The suite tests the paths around it.

## The tests

| Test | Checks |
|---|---|
| R7, /mcp challenge | `/mcp` with no token answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"` on the branch |
| R7, /oauth/wait | With a seeded `memory.oauth_consent` row, `/oauth/wait` answers 200 with a `Refresh` header while waiting, a 302 to the client once `redirect_url` is set, then 410 |
| Admin token | The seeded admin token opens `/api/v1/devices` and lists the seeded devices, and a wrong token gets 401 |
| R5, installer | `/install`, run with `HOME` set to a temp dir, `MEMORY_URL` set to the branch and `MEMORY_TOKEN` set to a seeded device token, so it skips the email step. `~/.claude.json` then has a `memory` MCP server pointing at the branch with that token, and an MCP initialize with it answers 200 |
| R15, cross-session recall | Session A (device token A) remembers a canary note through MCP. Session B (device token B) recalls it with no scope, retrying every 30 s for up to 6 minutes |

R15 is expected to fail until R15 lands: an agent's notes live in a run scope, and recall without a scope leaves run scopes out. The suite reports it as `XFAIL`, and as `XPASS` once it starts passing, which is the sign to mark it as expected to pass in `suite.py`.

## Options

| Variable | Effect |
|---|---|
| `E2E_BRANCH=<name>` | Use an existing branch instead of creating one. run.sh leaves it running, so delete it yourself: `supabase branches delete <name> --project-ref wlhlncmgjqyidosunugv` |
| `E2E_R15_WAIT=<seconds>` | How long R15 waits. Default 360 |
| `E2E_STRICT=1` | Count expected failures as failures |
| `E2E_ARMS=<arms>` | The branch's `MEMORY_ARMS`. Default `index,hybrid` |
| `E2E_REGION=<region>` | Where the branch's database runs. Default `ca-central-1` |

## Cost

A branch bills $0.01344 an hour, so a 10-minute run costs about $0.002. If a run is killed hard (`kill -9`, a closed laptop), check that nothing is left with `supabase branches list --project-ref wlhlncmgjqyidosunugv`.
