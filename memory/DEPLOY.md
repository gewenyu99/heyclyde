# Deploy

Phase 0 on one DigitalOcean Droplet in TOR1. Every step below is idempotent, so rerun any of them.

## What you need

- `DO`, a DigitalOcean token. `provision.py` also reads `DIGITALOCEAN_TOKEN`.
- `OPEN_AI`, an OpenAI key for the Decisions API.
- The private seed, `pkg-seed.zip`. Unzip it outside the repo.
- Network access to `api.digitalocean.com`, `api.openai.com` and the Droplet's IP on ports 22 and 443.

## Provision

```bash
python memory/deploy/provision.py
```

It creates a `s-2vcpu-4gb` Ubuntu 24.04 Droplet tagged `kb`, an SSH key at `~/.ssh/kb_ed25519`, and a cloud firewall that admits 22 and 443 only. Cloud-init installs Docker, restic and ufw and adds 2 GB of swap.

It then writes `memory/deploy/.env` with a fresh `KB_TOKEN`, `KB_ADMIN_TOKEN`, Postgres password and restic password. The domain is `kb.<ip-with-dashes>.sslip.io`, so Caddy gets a real certificate without a domain purchase. It tries to mint a Spaces key for backups. If the account refuses, fill `SPACES_KEY` and `SPACES_SECRET` by hand.

`.env` is gitignored. Never commit it. It holds two tokens, and they must differ.

- **`KB_TOKEN` is the agents'.** MCP, the hooks and the inbox take it. Every agent can read it, so it opens nothing that writes as you.
- **`KB_ADMIN_TOKEN` is the console's.** Only `/api/v1` takes it. That keeps an agent with Bash from editing your memory, approving its own drafts or reading private entries in full.

Both are 43 random characters from `secrets.token_urlsafe(32)`. Keep them random, never a password you'd remember. The server refuses an admin token under 32 characters, and after 10 wrong tokens from one address it locks that address out, twice as long with each miss.

To keep a token off the box, set `KB_TOKEN_SHA256` or `KB_ADMIN_TOKEN_SHA256` to its SHA-256 hex instead, and the server checks that. This prints a fresh token and its hash:

```bash
python3 -c 'import hashlib, secrets; t = secrets.token_urlsafe(32); print(t); print(hashlib.sha256(t.encode()).hexdigest())'
```

## Ship

```bash
cd /path/to/pkg-seed && PKG_SEED_DIR=$PWD python /path/to/like-vincent/memory/seed/build.py compile
/path/to/like-vincent/memory/deploy/deploy.sh /path/to/pkg-seed/out
```

`deploy.sh` copies the code and the compiled seed to `/opt/kb`, builds and starts the stack, loads `seed.sql` into an empty store, applies `db/schema.sql`, restarts the API and installs the nightly backup cron. On start the API pulls bge-m3 into Ollama and embeds every entry. That takes about a minute on CPU, and the hybrid arm answers keyword-only until it finishes.

The database is the store of record, so a redeploy skips the seed once the store has entries. Loading it again would bring back every seed entry and link the console deleted. To import new vault entries anyway, run `KB_SEED=1 deploy.sh`. That also brings back the seed rows you deleted.

Check it:

```bash
curl https://$KB_DOMAIN/healthz
```

### Ship without SSH

Use this when your machine reaches HTTPS but not port 22, as in a Claude Code cloud session.

```bash
python memory/deploy/cloud-deploy.py /path/to/pkg-seed/out --recreate
```

It encrypts the code, `.env` and the seed with a one-off key and uploads them to the backup bucket. It then destroys the kb Droplet and creates a new one. Cloud-init on the new box fetches the bundle, runs `deploy/install.sh` and `deploy/selftest.sh`, and uploads the encrypted log back. The script prints the log and deletes both files from Spaces. The self-test waits for every embedding, runs the retrieval eval on both splits, backs up once and runs the restore test.

`--recreate` loses the database. Back up first if the box holds anything the seed doesn't. The new Droplet gets a new IP, so `KB_DOMAIN` changes, and the script rewrites `.env` to match.

## Connect the clients

One command connects this machine's Claude Code and Codex. Rerun it after a redeploy or a token change.

```bash
mem_pass=<the agents' token> memory/hooks/install.sh <droplet-ip>
```

The token is `KB_TOKEN`, never the admin token. It comes from `KB_INSTALL_TOKEN` or `mem_pass`. With neither set, it reads `KB_TOKEN` off the Droplet over SSH. The script checks the token against the server and never prints it.

- **Claude Code.** It adds the MCP server at user scope, so it fires in every repo, and merges `claude-settings.json` into `~/.claude/settings.json`. It runs `claude` from PATH, else the newest CLI the Claude desktop app bundles. With neither, it skips Claude Code.
- **Codex.** It writes the MCP server into `~/.codex/config.toml` and merges `codex-hooks.json` under `hooks` in `~/.codex/hooks.json`. Codex runs the hooks once you trust them with `/hooks` in the Codex CLI.
- **Your own hooks stay.** A rerun replaces earlier kb entries only. That covers kb groups an older installer left at the top level of `hooks.json`, where Codex never looks, and hand-written curls to `/messages/codex`.

`KB_TOKEN` lives in `/opt/kb/deploy/.env` on the Droplet. Without SSH, open the Droplet in the DigitalOcean dashboard, pick Access, then Launch Droplet Console, and run `grep KB_TOKEN /opt/kb/deploy/.env`. To SSH from your own machine, add your public key in that console with `echo '<your key>' >> /root/.ssh/authorized_keys`. Also register it with `doctl compute ssh-key import mac --public-key-file ~/.ssh/id_ed25519.pub` so you can find it again later.

## Open the console

The console lives at `https://$KB_DOMAIN/console/`. Sign in with `KB_ADMIN_TOKEN`. The agents' token gets 401 there. Its API is in [api/API.md](api/API.md).

A box provisioned before the console has no admin token, so the console says it is off and the log says why. MCP and the hooks keep serving. Add `KB_ADMIN_TOKEN=<43 random characters>` to `memory/deploy/.env` and deploy again. `deploy.sh` copies that file over the box's own, so an edit made only on the box is lost on the next deploy.

## Message your other agents

The server has a small message board, so your Claude Code and Codex agents can leave each other notes. Each agent is named after its client: `claude` or `codex`.

- **`post_message(to, body)`.** MCP tool. `to` is `claude`, `codex` or `all`.
- **`check_messages()`.** MCP tool. Returns unread messages and marks them read for that agent only.
- **`kb-hook`.** On session start and on every prompt, it prints the agent's unread messages into its context. Claude Code and Codex both run it, so neither has to ask.

The server's MCP instructions also tell every agent to call `check_messages` when it starts a task. An agent without the hooks still sees its messages.

## Run the decider run-off

```bash
PKG_SEED_DIR=/path/to/pkg-seed OPEN_AI=... python memory/eval/decider_eval.py --out /tmp/decider.json
```

The keyword baseline on the seed: 21 of 31 pushbacks caught, 12 of 129 other turns flagged. OpenAI Decisions with `gpt-6-luna` beat it on recall, and Wen picked it for the filter and audit jobs.

## Back up and restore

`deploy/backup.sh` runs nightly at 08:17 UTC. It dumps Postgres and the seed directory into restic on Spaces and keeps 7 daily and 4 weekly snapshots. Run `deploy/restore-test.sh` on the Droplet monthly. It restores the latest dump into a throwaway container and checks the entries came back.

## Phase 0 status

| Deliverable | State |
|---|---|
| Postgres 17 with pgvector and pg_jieba, seed loaded | Done on the Droplet, 2026-10-10. Every entry embedded with bge-m3 |
| Index and hybrid arms behind `recall`, English and 中文 | Done. `recall` over MCP with the bearer token returns a packet, and without it gets 401. On the Droplet, held-out: hybrid 6 of 6 with no leaks, index 5 of 6 with leaks on 2 of 7. Train: hybrid 90%, index 81%. After 6 deploy-context entries joined the seed, hybrid's held-out score fell to 5 of 6. q25 "where does the PKG run" ranked its gold out at 12, behind the new `pkg-server-where`, which answers it better than the stale gold does. The fault in that packet is a draft at rank 1, `docs-draft-measure-yourself`, which matched on "runs". Index demotes drafts and hybrid doesn't. Both are left for Wen, since the fix would tune on the test split |
| Claude Code hooks landing events in Postgres | Built and tested end to end locally. Live once a client is connected |
| Decider run-off on the seeded reactions | Done. Keywords caught 21 of 31 with 12 of 129 false alarms. `gpt-6-luna` caught 26 of 31 with 24 of 129, p50 158 ms, p95 288 ms. Its misses need the previous assistant turn, and some false alarms are real pushback the weak labels miss. Wen picked `gpt-6-luna`. It costs about $0.00002 a call, at 232 input tokens median and $0.10 per million input tokens. Tuned on half the turns and tested on the other half, neither a tighter wording nor a 0.7 threshold held up, so both stay as they were. Next: send the previous assistant turn when the decider gets wired into the hooks |
| Nightly restic backup and one restore test | Done. `backup.sh` saved to Spaces and `restore-test.sh` restored every entry. Fixed on the way: the restore raced the image's init server, and a destroyed Droplet left a stale lock |
| Droplet running | Done, through `cloud-deploy.py`, since the cloud session that deployed it can't reach port 22. `provision.py` and the Spaces key endpoint worked first try |

## Open questions for Wen

- How many Claude Code and Codex sessions do you run a week? It sets how long the live test runs.
- Should private entries reach the agent unredacted? Today they don't, per the plan.
- Should links to approved decisions be exempt from weakening in the spreading arm?
- Which two arms join spreading in the live test: index, hybrid or hindsight?
