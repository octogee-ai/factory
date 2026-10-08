# Octogee Gateway

Container image for the OpenClaw gateway + Firestore provisioner. Deployed to GKE Autopilot via Helm.

> **Architecture docs:** [docs/architecture/GATEWAY-PLATFORM-SPEC.md](../../docs/architecture/GATEWAY-PLATFORM-SPEC.md) · [docs/operations/RUNBOOK.md](../../docs/operations/RUNBOOK.md)

---

## What it does

- Runs the OpenClaw gateway hosting all customer AI agents
- Connects to Mattermost for customer chat through gateway-edge
- Watches Firestore — auto-provisions workspaces when customers sign up
- No manual steps, no container restart needed for new customers

## Default configuration

Shared and Builder seeds, class policy, and generated agent entries must use the
current native OpenClaw config schema. During a runtime recut, validate the
materialized defaults against that exact built source; update their writers
instead of relying on Doctor to translate them at every boot. Pre-boot supplies
runtime bindings and reconciles platform-owned policy. Native startup validation,
the bounded Builder failed-boot Doctor recovery, and CUA driver-artifact lint
remain enabled.
Older or hand-edited Builder configuration may still need native Doctor repair;
the no-transformation requirement applies to freshly authored platform defaults.

## Build

The gateway image is built via Cloud Build:

```bash
# Build gateway image (uses pre-built OpenClaw base from Artifact Registry)
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_IMAGE_TAG=$(git rev-parse --short HEAD) \
  --project=octogee

# Ensure the current OpenClaw base exists in the shared registry.
# This reuses the immutable input-keyed image when the artifacts are unchanged.
gh workflow run gateway-base-rebuild.yml --ref main -f environment=test
```

## Deploy

Deployed as part of the Helm umbrella chart:

```bash
# Test
helm upgrade --install octogee helm/octogee \
  --server-side=true --force-conflicts \
  -f helm/octogee/values.test.yaml \
  -n octogee-test --create-namespace

# Prod
helm upgrade --install octogee helm/octogee \
  --server-side=true --force-conflicts \
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
- [docs/operations/MATTERMOST.md](../../docs/operations/MATTERMOST.md) — gateway-edge + Mattermost architecture
