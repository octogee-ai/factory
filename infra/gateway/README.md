# Octogee Gateway

Docker container hosting the OpenClaw gateway + Firestore provisioner for all Octogee customers.

> **Full documentation:** [DOCS.md](./DOCS.md)

---

## What it does

- Runs 5 Discord bots (Coach, Alex, Morgan, Riley, Robert) for every customer
- Watches Firestore — auto-provisions workspace + wires Discord when customers sign up
- No manual steps, no container restart needed for new customers

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit: fill in ANTHROPIC_API_KEY and OPENCLAW_REPO

# 2. Firebase SA key (local only — not needed on GCP)
mkdir -p ~/octogee-gateway/.openclaw/secrets
cp ~/Downloads/octogee-*.json ~/octogee-gateway/.openclaw/secrets/octogee-test-sa-key.json

# 3. Build and start (run from project root)
cd infra/gateway && ./setup.sh
```

## Day-to-day

```bash
COMPOSE="docker compose -f infra/gateway/docker-compose.yml"

$COMPOSE logs -f octogee-gateway     # tail logs
$COMPOSE restart octogee-gateway     # restart (config survives)
$COMPOSE down                       # stop

./infra/gateway/setup.sh --rebuild  # rebuild image after code changes
./infra/gateway/setup.sh --reset    # nuclear reset (wipes all data)
```

## Key facts

| Thing | Value |
|-------|-------|
| Host port | `18791` |
| Container port | `18789` |
| Data dir | `~/octogee-gateway/.openclaw/` (bind-mounted) |
| Discord bots | 5 (Coach, Alex, Morgan, Riley, Robert) |
| Firebase project | `octogee` |
| Gateway token | see `infra/gateway/.env` |

## See also

- [DOCS.md](./DOCS.md) — full architecture, Dockerfile walkthrough, security, GCP migration, limitations, runbook
