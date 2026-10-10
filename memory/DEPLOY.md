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

`.env` is gitignored. Never commit it.

## Ship

```bash
cd /path/to/pkg-seed && PKG_SEED_DIR=$PWD python /path/to/like-vincent/memory/seed/build.py compile
/path/to/like-vincent/memory/deploy/deploy.sh /path/to/pkg-seed/out
```

`deploy.sh` copies the code and the compiled seed to `/opt/kb`, builds and starts the stack, loads `seed.sql`, applies `db/schema.sql`, restarts the API and installs the nightly backup cron. On start the API pulls bge-m3 into Ollama and embeds every entry. That takes about a minute on CPU, and A1 answers keyword-only until it finishes.

Check it:

```bash
curl https://$KB_DOMAIN/healthz
```

## Connect the clients

Claude Code, user scope so it fires in every repo:

```bash
claude mcp add --transport http kb https://$KB_DOMAIN/mcp --header "Authorization: Bearer $KB_TOKEN" --scope user
cp memory/hooks/kb-hook ~/.claude/kb-hook
```

Then merge `memory/hooks/claude-settings.json` into `~/.claude/settings.json` with the real `KB_URL` and `KB_TOKEN`.

Codex: append `memory/hooks/codex-config.toml` to `~/.codex/config.toml` and export `KB_TOKEN`.

## Run the decider run-off

```bash
PKG_SEED_DIR=/path/to/pkg-seed OPEN_AI=... python memory/eval/decider_eval.py --out /tmp/decider.json
```

The keyword baseline on the seed: 21 of 31 pushbacks caught, 12 of 129 other turns flagged. OpenAI Decisions with `gpt-6-luna` has to beat that to earn the filter and audit jobs.

## Back up and restore

`deploy/backup.sh` runs nightly at 08:17 UTC. It dumps Postgres and the seed directory into restic on Spaces and keeps 7 daily and 4 weekly snapshots. Run `deploy/restore-test.sh` on the Droplet monthly. It restores the latest dump into a throwaway container and checks the entries came back.

## Phase 0 status

| Deliverable | State |
|---|---|
| Postgres 17 with pgvector and pg_jieba, seed loaded | Built and tested locally with the real seed |
| A0 and A1 behind `recall`, English and 中文 | Built and tested. Practice queries, test split: A0 5 of 6 gold hits, A1 5 of 6 |
| Claude Code hooks landing events in Postgres | Built and tested end to end |
| Decider run-off on the seeded reactions | Keyword baseline done. OpenAI run needs `OPEN_AI` |
| Nightly restic backup and one restore test | Scripts written, untested until Spaces keys exist |
| Droplet running | Waits on `DO` |

## Open questions for Wen

- How many Claude Code and Codex sessions do you run a week? It sets how long the live test runs.
- Should private entries reach the agent unredacted? Today they don't, per the plan.
- Should links to approved decisions be exempt from weakening in A2?
- Which two arms join A2 live: A0, A1 or A3?
