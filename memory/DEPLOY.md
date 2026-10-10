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

It then writes `memory/deploy/.env` with a fresh `KB_TOKEN`, Postgres password and restic password. The domain is `kb.<ip-with-dashes>.sslip.io`, so Caddy gets a real certificate without a domain purchase. It tries to mint a Spaces key for backups. If the account refuses, fill `SPACES_KEY` and `SPACES_SECRET` by hand.

`.env` is gitignored. Never commit it. Set `KB_TOKEN_SHA256` to the SHA-256 hex of a password you pick, and the server checks that instead of `KB_TOKEN`. Then you install clients with your own password and never read it off the box.

## Ship

```bash
cd /path/to/pkg-seed && PKG_SEED_DIR=$PWD python /path/to/like-vincent/memory/seed/build.py compile
/path/to/like-vincent/memory/deploy/deploy.sh /path/to/pkg-seed/out
```

`deploy.sh` copies the code and the compiled seed to `/opt/kb`, builds and starts the stack, loads `seed.sql`, applies `db/schema.sql`, restarts the API and installs the nightly backup cron. On start the API pulls bge-m3 into Ollama and embeds every entry. That takes about a minute on CPU, and the hybrid arm answers keyword-only until it finishes.

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

Claude Code, user scope so it fires in every repo:

```bash
claude mcp add --transport http kb https://$KB_DOMAIN/mcp --header "Authorization: Bearer $KB_TOKEN" --scope user
cp memory/hooks/kb-hook ~/.claude/kb-hook
```

Then merge `memory/hooks/claude-settings.json` into `~/.claude/settings.json` with the real `KB_URL` and `KB_TOKEN`.

`KB_TOKEN` lives in `/opt/kb/deploy/.env` on the Droplet. Without SSH, open the Droplet in the DigitalOcean dashboard, pick Access, then Launch Droplet Console, and run `grep KB_TOKEN /opt/kb/deploy/.env`. To SSH from your own machine, add your public key in that console with `echo '<your key>' >> /root/.ssh/authorized_keys`. Also register it with `doctl compute ssh-key import mac --public-key-file ~/.ssh/id_ed25519.pub` so you can find it again later.

Codex: append `memory/hooks/codex-config.toml` to `~/.codex/config.toml` and export `KB_TOKEN`.

## Message your other agents

The server has a small message board, so your Claude Code and Codex agents can leave each other notes. Each agent is named after its client: `claude` or `codex`.

- **`post_message(to, body)`.** MCP tool. `to` is `claude`, `codex` or `all`.
- **`check_messages()`.** MCP tool. Returns unread messages and marks them read for that agent only.
- **`kb-hook`.** On session start and on every prompt, it prints Claude's unread messages, so Claude Code sees them without asking.

Codex has no hooks, so the server's MCP instructions tell it to call `check_messages` when it starts a task.

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
