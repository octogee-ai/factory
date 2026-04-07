#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Pre-Helm Secrets Setup
# ═══════════════════════════════════════════════════════════════════════════
#
# Creates ALL K8s secrets required by the Helm chart before helm install.
# Safe to re-run — uses --dry-run=client -o yaml | kubectl apply (idempotent).
#
# Reads from: .env.test / .env + Secret Manager (octogee project)
#
# IMPORTANT:
# - This script owns K8s secret materialization.
# - It does NOT fully bootstrap Mattermost or Gitea app state.
# - If Mattermost admin/bot/team/PAT state is missing or stale, run
#   setup-mattermost.sh first, then re-run this script if needed.
#
# Usage:
#   ./scripts/setup-secrets.sh --env=test [--yes]
#   ./scripts/setup-secrets.sh --env=prod
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ENV=""; YES=false

for arg in "$@"; do
  case $arg in
    --env=*)  ENV="${arg#*=}" ;;
    --yes|-y) YES=true ;;
    --help|-h) echo "Usage: $0 --env=prod|test [--yes]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done
[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test [--yes]"; exit 1; }

case "$ENV" in
  prod)
    K8S_NAMESPACE="octogee"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    FIREBASE_PROJECT="octogee"
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    SM_PROJECT="octogee"
    ;;
  test)
    K8S_NAMESPACE="octogee-test"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    FIREBASE_PROJECT="octogee-test"
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    SM_PROJECT="octogee"  # Cloud SQL + shared secrets live in octogee project
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
status() {
  local label="$1" value="$2"
  if [[ -n "$value" ]]; then
    echo -e "  ${GREEN}✓${NC} $label"
  else
    echo -e "  ${RED}✗${NC} $label"
  fi
}

ksecret() {
  # idempotent: delete + create
  local name="$1"; shift
  kubectl delete secret "$name" -n "$K8S_NAMESPACE" 2>/dev/null || true
  kubectl create secret generic "$name" -n "$K8S_NAMESPACE" "$@"
  ok "Secret: $name"
}

sm_get() {
  gcloud secrets versions access latest --secret="$1" --project="${2:-$SM_PROJECT}" 2>/dev/null || echo ""
}

# Load env file
if [[ -f "$ENV_FILE" ]]; then
  set +u
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* || -z "$val" ]] && continue
    export "$key=$val"
  done < <(grep -v '^#' "$ENV_FILE" | grep -v '^[[:space:]]*$')
  set -u
fi

[[ "$ENV" == "prod" && "$YES" == "true" ]] && fail "--yes cannot be used with prod."

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Pre-Helm Secrets — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── kubectl context ───────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$K8S_CONTEXT" ]] || fail "Wrong kubectl context"
ok "kubectl context: $K8S_CONTEXT"
info "This script owns secret materialization into Kubernetes. It does not fully repair Mattermost/Gitea bootstrap state by itself."

# Ensure namespace
kubectl get namespace "$K8S_NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$K8S_NAMESPACE"
ok "Namespace: $K8S_NAMESPACE"
echo ""

# ── 0. Gitea SSH key (gateway volume mount — blocks Init if missing) ──────
info "gitea-ssh-key"
if kubectl get secret gitea-ssh-key -n "$K8S_NAMESPACE" >/dev/null 2>&1; then
  ok "gitea-ssh-key already exists"
else
  info "  Generating SSH keypair for Gitea..."
  TMPKEY=$(mktemp)
  rm -f "$TMPKEY" "${TMPKEY}.pub"
  ssh-keygen -t ed25519 -f "$TMPKEY" -N "" -C "octogee-gateway@octogee.local" -q
  ksecret gitea-ssh-key \
    --from-file=id_ed25519="$TMPKEY" \
    --from-file=id_ed25519.pub="${TMPKEY}.pub"
  info "  Register this public key in Gitea after setup-gitea.sh:"
  info "  $(cat "${TMPKEY}.pub")"
  rm -f "$TMPKEY" "${TMPKEY}.pub"
fi
echo ""

# ── 1. Mattermost DB password ─────────────────────────────────────────────
info "mattermost-cloud-sql"
MM_DB_PASSWORD=$(sm_get MM_DB_PASSWORD octogee)
[[ -n "$MM_DB_PASSWORD" ]] || fail "MM_DB_PASSWORD not in Secret Manager (octogee project)"
ksecret mattermost-cloud-sql --from-literal=password="$MM_DB_PASSWORD"

# ── 2. Mattermost gateway creds ───────────────────────────────────────────
info "mattermost-gateway"
set +u
MM_BOT_TOKEN="${MM_BOT_TOKEN:-}"
MM_ADMIN_USER="${MM_ADMIN_USER:-octogee-admin}"
MM_ADMIN_PASS="${MM_ADMIN_PASS:-}"
MM_TEAM_ID="${MM_TEAM_ID:-}"
MM_BOT_USER_ID="${MM_BOT_USER_ID:-}"
MM_ADMIN_USER_ID="${MM_ADMIN_USER_ID:-}"
set -u
# Create even if empty — but operationally, empty values are usually a smell.
# chat-proxy/workspace-api may partially work and then fail in confusing ways.
# If bot/admin/team fields are blank, run setup-mattermost.sh to repair app/bootstrap state.
ksecret mattermost-gateway \
  --from-literal=bot_token="$MM_BOT_TOKEN" \
  --from-literal=admin_user="$MM_ADMIN_USER" \
  --from-literal=admin_pass="$MM_ADMIN_PASS" \
  --from-literal=team_id="$MM_TEAM_ID" \
  --from-literal=bot_user_id="$MM_BOT_USER_ID" \
  --from-literal=admin_user_id="$MM_ADMIN_USER_ID"

if [[ -z "$MM_BOT_TOKEN" || -z "$MM_TEAM_ID" || -z "$MM_BOT_USER_ID" || -z "$MM_ADMIN_USER_ID" ]]; then
  warn "mattermost-gateway contains blank bootstrap values. Run ./scripts/setup-mattermost.sh --env=$ENV before trusting this environment."
fi

# ── 3. Gitea admin ────────────────────────────────────────────────────────
info "gitea-admin"
GITEA_ADMIN_PASS=$(sm_get "gitea-admin-password-${ENV}" octogee 2>/dev/null || echo "")
if [[ -z "$GITEA_ADMIN_PASS" ]]; then
  GITEA_ADMIN_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
  info "  Generated new Gitea admin password — saving to Secret Manager..."
  echo -n "$GITEA_ADMIN_PASS" | gcloud secrets create "gitea-admin-password-${ENV}" \
    --data-file=- --project=octogee \
    --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
  echo -n "$GITEA_ADMIN_PASS" | gcloud secrets versions add "gitea-admin-password-${ENV}" \
    --data-file=- --project=octogee 2>/dev/null || true
fi
ksecret gitea-admin \
  --from-literal=username="octogee-admin" \
  --from-literal=password="$GITEA_ADMIN_PASS"

# ── 4. Gitea credentials (internal tokens) ───────────────────────────────
info "gitea-credentials"
GITEA_DB_PASS=$(sm_get gitea-db-password octogee)
[[ -n "$GITEA_DB_PASS" ]] || fail "gitea-db-password not in Secret Manager"
GITEA_SECRET_KEY=$(openssl rand -hex 32)
GITEA_INTERNAL_TOKEN=$(openssl rand -hex 64)
ksecret gitea-credentials \
  --from-literal=admin-password="$GITEA_ADMIN_PASS" \
  --from-literal=db-password="$GITEA_DB_PASS" \
  --from-literal=secret-key="$GITEA_SECRET_KEY" \
  --from-literal=internal-token="$GITEA_INTERNAL_TOKEN"

# ── 5. Gitea API token (may not exist yet — created by setup-gitea.sh) ────
info "gitea-token"
GIT_API_TOKEN=$(sm_get "gitea-api-token-${ENV}" octogee 2>/dev/null || echo "")
if [[ -n "$GIT_API_TOKEN" ]]; then
  ksecret gitea-token --from-literal=token="$GIT_API_TOKEN"
else
  warn "gitea-api-token-${ENV} not in Secret Manager yet — run setup-gitea.sh after Helm to create it"
  ksecret gitea-token --from-literal=token=""
fi

# ── 6. Anthropic API key ──────────────────────────────────────────────────
info "octogee-anthropic"
set +u; ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"; set -u
[[ -z "$ANTHROPIC_API_KEY" ]] && ANTHROPIC_API_KEY=$(sm_get ANTHROPIC_API_KEY octogee 2>/dev/null || echo "")
[[ -n "$ANTHROPIC_API_KEY" ]] || fail "ANTHROPIC_API_KEY not found in .env or Secret Manager"
ksecret octogee-anthropic --from-literal=api_key="$ANTHROPIC_API_KEY"

# ── 7. Brave API key ──────────────────────────────────────────────────────
info "octogee-brave"
set +u; BRAVE_API_KEY="${BRAVE_API_KEY:-}"; set -u
[[ -z "$BRAVE_API_KEY" ]] && BRAVE_API_KEY=$(sm_get BRAVE_API_KEY octogee 2>/dev/null || echo "")
if [[ -n "$BRAVE_API_KEY" ]]; then
  ksecret octogee-brave --from-literal=key="$BRAVE_API_KEY"
else
  warn "BRAVE_API_KEY not found — creating empty secret (optional)"
  ksecret octogee-brave --from-literal=key=""
fi

# ── 8. GitHub token ───────────────────────────────────────────────────────
info "octogee-github"
GITHUB_TOKEN=$(sm_get GITHUB_TOKEN octogee 2>/dev/null || echo "")
if [[ -n "$GITHUB_TOKEN" ]]; then
  ksecret octogee-github --from-literal=token="$GITHUB_TOKEN"
else
  warn "GITHUB_TOKEN not found — creating empty secret (optional)"
  ksecret octogee-github --from-literal=token=""
fi

# ── 9. Internal service key (workspace-api ↔ gateway ↔ CronJob) ─────────
# Used by requireInternalServiceAuth() on /internal/billing/* routes.
# One shared secret across workspace-api, gateway, and the trial-expiry CronJob.
info "internal-service-key"
INTERNAL_SERVICE_KEY=$(sm_get "INTERNAL_SERVICE_KEY" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
if [[ -z "$INTERNAL_SERVICE_KEY" ]]; then
  INTERNAL_SERVICE_KEY=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 40)
  info "  Generating new INTERNAL_SERVICE_KEY — saving to Secret Manager ($FIREBASE_PROJECT)..."
  if echo -n "$INTERNAL_SERVICE_KEY" | gcloud secrets create "INTERNAL_SERVICE_KEY" \
       --data-file=- --project="$FIREBASE_PROJECT" \
       --replication-policy=automatic --quiet 2>/dev/null; then
    ok "  Created SM secret: INTERNAL_SERVICE_KEY"
  elif echo -n "$INTERNAL_SERVICE_KEY" | gcloud secrets versions add "INTERNAL_SERVICE_KEY" \
       --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null; then
    ok "  Updated SM secret: INTERNAL_SERVICE_KEY"
  else
    warn "  Could not persist to SM — key only in K8s this run; re-run to persist"
  fi
fi
ksecret internal-service-key --from-literal=key="$INTERNAL_SERVICE_KEY"

# ── 10. Stripe secrets ────────────────────────────────────────────────────
# Required by workspace-api at startup (not optional). Use placeholder if not
# configured yet — billing is sandbox mode until real keys are set.
info "stripe-secrets"
set +u
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}"
set -u
[[ -z "$STRIPE_SECRET_KEY" ]]    && STRIPE_SECRET_KEY=$(sm_get STRIPE_SECRET_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$STRIPE_WEBHOOK_SECRET" ]] && STRIPE_WEBHOOK_SECRET=$(sm_get STRIPE_WEBHOOK_SECRET "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$STRIPE_SECRET_KEY" ]]    && warn "STRIPE_SECRET_KEY not found — using placeholder (billing disabled)"
[[ -z "$STRIPE_WEBHOOK_SECRET" ]] && warn "STRIPE_WEBHOOK_SECRET not found — using placeholder"
ksecret stripe-secrets \
  --from-literal=secret_key="${STRIPE_SECRET_KEY:-placeholder}" \
  --from-literal=webhook_secret="${STRIPE_WEBHOOK_SECRET:-placeholder}"

# ── 11. Resend secrets (email digest delivery — P6) ──────────────────────
# Used by workspace-api for email digest delivery via Resend.
# Required env vars: RESEND_API_KEY, RESEND_FROM_EMAIL
# Optional: RESEND_FROM_NAME (defaults to "Octogee" in code)
#
# K8s Secret: resend-secrets
#   api_key    → RESEND_API_KEY
#   from_email → RESEND_FROM_EMAIL
#   from_name  → RESEND_FROM_NAME
info "resend-secrets"
set +u
RESEND_API_KEY="${RESEND_API_KEY:-}"
RESEND_FROM_EMAIL="${RESEND_FROM_EMAIL:-}"
RESEND_FROM_NAME="${RESEND_FROM_NAME:-Octogee}"
set -u
[[ -z "$RESEND_API_KEY" ]]   && RESEND_API_KEY=$(sm_get RESEND_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$RESEND_FROM_EMAIL" ]] && RESEND_FROM_EMAIL=$(sm_get RESEND_FROM_EMAIL "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$RESEND_API_KEY" ]]   && warn "RESEND_API_KEY not found — digest emails will fail until configured"
[[ -z "$RESEND_FROM_EMAIL" ]] && warn "RESEND_FROM_EMAIL not found — using placeholder"
ksecret resend-secrets \
  --from-literal=api_key="${RESEND_API_KEY:-placeholder}" \
  --from-literal=from_email="${RESEND_FROM_EMAIL:-notifications@octogee.com}" \
  --from-literal=from_name="${RESEND_FROM_NAME}"

# ── 12. GCP Service Account key ───────────────────────────────────────────
# Used by workspace-api and gateway for GCP API access (Workload Identity
# preferred on prod; SA key is a fallback for services that need it directly).
info "octogee-sa-key"
case "$ENV" in
  prod) SA_KEY_PATH="$HOME/.openclaw/secrets/octogee-sa-key.json" ;;
  test) SA_KEY_PATH="$HOME/.openclaw/secrets/octogee-test-sa-key.json" ;;
esac
if [[ -f "$SA_KEY_PATH" ]]; then
  ksecret octogee-sa-key --from-file=key.json="$SA_KEY_PATH"
else
  warn "SA key not found at $SA_KEY_PATH — skipping octogee-sa-key (Workload Identity must be configured)"
fi

# ── Firebase / Cloud Functions secrets (must exist before firebase deploy) ───
# Firebase prompts interactively if these secrets don't exist in Secret Manager.
# Pre-create them with placeholder values — the real values are set at runtime:
#   MM_ADMIN_TOKEN: overwritten by provisioner on every gateway startup
#   GITHUB_TOKEN:   optional, set manually if GitHub org integration is needed
info "Pre-creating Firebase function secrets in Secret Manager (suppress deploy prompts)..."
SM_PROJECT_CF="$FIREBASE_PROJECT"  # Functions run in the Firebase project (octogee-test for test, octogee for prod)

# Full list of all defineSecret() references in Cloud Functions — must exist before firebase deploy
for sm_secret in \
  MM_ADMIN_TOKEN \
  GITEA_TOKEN \
  GITHUB_TOKEN \
  STRIPE_SECRET_KEY \
  STRIPE_WEBHOOK_SECRET \
  GOOGLE_CLIENT_ID \
  GOOGLE_CLIENT_SECRET \
  MICROSOFT_CLIENT_ID \
  MICROSOFT_CLIENT_SECRET \
  DISCORD_MAC_TOKEN \
  DISCORD_COACH_TOKEN \
  DISCORD_BOT_APP_ID \
  DISCORD_CLIENT_SECRET \
  ANTHROPIC_API_KEY \
  OCTOGEE_GUILD_ID \
  RESEND_API_KEY \
  RESEND_FROM_EMAIL; do
  if gcloud secrets describe "$sm_secret" --project="$SM_PROJECT_CF" >/dev/null 2>&1; then
    info "  $sm_secret already exists in SM ($SM_PROJECT_CF)"
  else
    echo -n "placeholder" | gcloud secrets create "$sm_secret" \
      --data-file=- \
      --project="$SM_PROJECT_CF" \
      --replication-policy=automatic \
      --quiet 2>/dev/null && ok "  Created SM secret: $sm_secret" || warn "  Could not create $sm_secret"
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}Secret completeness summary${NC}"
status "mattermost-gateway / admin_user" "${MM_ADMIN_USER:-}"
status "mattermost-gateway / admin_pass" "${MM_ADMIN_PASS:-}"
status "mattermost-gateway / admin_user_id" "${MM_ADMIN_USER_ID:-}"
status "mattermost-gateway / bot_token" "${MM_BOT_TOKEN:-}"
status "mattermost-gateway / bot_user_id" "${MM_BOT_USER_ID:-}"
status "mattermost-gateway / team_id" "${MM_TEAM_ID:-}"
status "internal-service-key" "${INTERNAL_SERVICE_KEY:-}"
status "octogee-anthropic" "${ANTHROPIC_API_KEY:-}"
status "resend-secrets / api_key" "${RESEND_API_KEY:-}"
status "resend-secrets / from_email" "${RESEND_FROM_EMAIL:-}"

echo ""
if [[ -z "${MM_BOT_TOKEN:-}" || -z "${MM_BOT_USER_ID:-}" || -z "${MM_TEAM_ID:-}" || -z "${MM_ADMIN_USER_ID:-}" ]]; then
  warn "Mattermost-related secret state is incomplete"
  echo ""
  echo "  Next steps:"
  echo "    1. Run ./scripts/setup-mattermost.sh --env=$ENV"
  echo "    2. Re-run ./scripts/setup-secrets.sh --env=$ENV $(if [[ "$YES" == "true" ]]; then echo "--yes"; fi) if you want a clean re-materialization"
  echo "    3. Do not trust admin chat / chat-proxy until those values are present"
else
  ok "Required Mattermost secret inputs are present"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  All secrets created — ${ENV_LABEL}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Next: helm upgrade --install octogee helm/octogee \\"
echo "          -f helm/octogee/values.${ENV}.yaml \\"
echo "          -n $K8S_NAMESPACE --create-namespace \\"
echo "          --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
echo "          --kube-context $K8S_CONTEXT \\"
echo "          --wait --timeout=10m"
echo ""
