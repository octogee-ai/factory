# Octogee Gateway

Container image for the OpenClaw gateway + Firestore provisioner. Deployed to GKE Autopilot via Helm.

> **Architecture docs:** [docs/architecture/GATEWAY-PLATFORM-SPEC.md](../../docs/architecture/GATEWAY-PLATFORM-SPEC.md) · [docs/operations/RUNBOOK.md](../../docs/operations/RUNBOOK.md)

---

## What it does

- Runs the OpenClaw gateway hosting all customer AI agents
- Connects to Mattermost for customer chat (via chat-proxy)
- Watches Firestore — auto-provisions workspaces when customers sign up
- No manual steps, no container restart needed for new customers

## Build

The gateway image is built via Cloud Build:

```bash
# Build gateway image (uses pre-built OpenClaw base from Artifact Registry)
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_IMAGE_TAG=$(git rev-parse --short HEAD) \
  --project=octogee

# Rebuild base image (only when upgrading OpenClaw)
# See infra/gateway/openclaw-tarball/README.md for the full patch routine.
gcloud builds submit --config cloudbuild-base.yaml \
  --substitutions=_OPENCLAW_VERSION=2026.5.4,_OPENCLAW_FORK_SHA=20479cf6 \
  --project=octogee
```

## Deploy

Deployed as part of the Helm umbrella chart:

```bash
# Test
helm upgrade --install octogee helm/octogee \
  -f helm/octogee/values.test.yaml \
  -n octogee-test --create-namespace

# Prod
helm upgrade --install octogee helm/octogee \
  -f helm/octogee/values.prod.yaml \
  -n octogee
```

## Local development

For local Docker testing (not typical — prefer GKE):

```bash
cp .env.example .env
# Edit: fill in ANTHROPIC_API_KEY and required vars
cd infra/gateway && ./setup.sh
```

## Key files

| File | Purpose |
|------|---------|
| `Dockerfile` | Gateway image (layers on OpenClaw base) |
| `Dockerfile.base` | OpenClaw base image |
| `entrypoint.sh` | Container entrypoint (provisioner + gateway) |
| `openclaw.template.json` | Template for gateway config |
| `.env.example` | Local dev env vars |
| `docker-compose.yml` | Local dev compose (not used in prod) |

## See also

- [docs/architecture/GATEWAY-PLATFORM-SPEC.md](../../docs/architecture/GATEWAY-PLATFORM-SPEC.md) — gateway platform model
- [docs/operations/RUNBOOK.md](../../docs/operations/RUNBOOK.md) — operations runbook (cluster map, deploy, troubleshooting)
- [docs/operations/MATTERMOST.md](../../docs/operations/MATTERMOST.md) — chat-proxy + Mattermost architecture
