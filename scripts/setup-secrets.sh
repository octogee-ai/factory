#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee K8s Secrets Materialization
# ═══════════════════════════════════════════════════════════════════════════
#
# Idempotent — safe to re-run any time (uses kubectl apply, not delete+create).
# Run TWICE in the canonical install sequence:
#
#   Phase 1 (pre-helm):  creates the secrets MM/Gitea/gateway pods need to
#                        BOOT (gitea-ssh-key, mattermost-cloud-sql DB pass,
#                        gitea-credentials with stable SECRET_KEY/INTERNAL_TOKEN,
#                        empty mattermost-gateway + gitea-token shells, etc.).
#                        Helm install can now schedule pods that mount these.
#
#   Phase 2 (post-bootstrap): re-reads .env after setup-mattermost.sh +
#                        setup-gitea.sh have populated MM_BOT_TOKEN,
#                        MM_TEAM_ID, GIT_API_TOKEN, etc., and re-materializes
#                        mattermost-gateway + gitea-token with REAL values.
#                        kubectl rollout restart afterwards picks them up.
#
# Reads from: .env.test / .env + Secret Manager (octogee project).
#
# Canonical sequence printed by ./scripts/teardown-env.sh.
#
# Usage:
#   ./scripts/setup-secrets.sh --env=test [--yes]
#   ./scripts/setup-secrets.sh --env=prod
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ENV=""; YES=false; CUSTOM_NS=""

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --yes|-y)      YES=true ;;
    --help|-h) echo "Usage: $0 --env=prod|test|custom [--namespace=NAME] [--yes]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done
[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|custom [--namespace=NAME] [--yes]"; exit 1; }

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
    NS_SLUG="prod"
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
    NS_SLUG="test"
    ;;
  custom)
    # Ephemeral/feature namespaces sharing the octogee-test Firebase project.
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    [[ ${#CUSTOM_NS} -le 63 ]] || { echo "Namespace too long (max 63)"; exit 1; }
    K8S_NAMESPACE="$CUSTOM_NS"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    FIREBASE_PROJECT="octogee-test"  # custom namespaces share test Firebase
    ENV_FILE="$REPO_DIR/.env.$CUSTOM_NS"
    ENV_LABEL="🟣 CUSTOM ($CUSTOM_NS)"
    SM_PROJECT="octogee"
    NS_SLUG="${CUSTOM_NS//-/_}"
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
  # Atomic idempotent apply — no delete + create window, no pod-mount failure
  # if a volume-mounting pod gets scheduled mid-update.
  local name="$1"; shift
  kubectl create secret generic "$name" -n "$K8S_NAMESPACE" \
    --dry-run=client -o yaml "$@" | kubectl apply -f - >/dev/null
  ok "Secret: $name"
}

ksecret_exists() {
  kubectl get secret "$1" -n "$K8S_NAMESPACE" >/dev/null 2>&1
}

ksecret_key() {
  # Read a key from an existing K8s secret. Empty string if missing.
  kubectl get secret "$1" -n "$K8S_NAMESPACE" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || echo ""
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
MM_ADMIN_TOKEN="${MM_ADMIN_TOKEN:-}"
MM_TEAM_ID="${MM_TEAM_ID:-}"
MM_BOT_USER_ID="${MM_BOT_USER_ID:-}"
MM_ADMIN_USER_ID="${MM_ADMIN_USER_ID:-}"
set -u
# Create even if empty — but operationally, empty values are usually a smell.
# chat-proxy/gateway-edge may partially work and then fail in confusing ways.
# If bot/admin/team fields are blank, run setup-mattermost.sh to repair app/bootstrap state.
ksecret mattermost-gateway \
  --from-literal=bot_token="$MM_BOT_TOKEN" \
  --from-literal=admin_user="$MM_ADMIN_USER" \
  --from-literal=admin_pass="$MM_ADMIN_PASS" \
  --from-literal=admin_token="$MM_ADMIN_TOKEN" \
  --from-literal=team_id="$MM_TEAM_ID" \
  --from-literal=bot_user_id="$MM_BOT_USER_ID" \
  --from-literal=admin_user_id="$MM_ADMIN_USER_ID"

if [[ -z "$MM_BOT_TOKEN" || -z "$MM_TEAM_ID" || -z "$MM_BOT_USER_ID" || -z "$MM_ADMIN_USER_ID" ]]; then
  warn "mattermost-gateway contains blank bootstrap values. Run ./scripts/setup-mattermost.sh --env=$ENV before trusting this environment."
fi

# ── 2b. OpenClaw approval signing secret ─────────────────────────────────
# HMAC secret for approval-button context binding. Must NOT rotate during
# the lifetime of any pending approval (5min TTL) — rotating mid-flight
# invalidates the buttons users haven't clicked yet. First install:
# generate. Re-run: reuse what's already in Secret Manager.
info "approval-signing"
APPROVAL_SIGNING_SM_KEY="approval-signing-${ENV}"
[[ "$ENV" == "custom" ]] && APPROVAL_SIGNING_SM_KEY="approval-signing-custom-${CUSTOM_NS}"
APPROVAL_SIGNING_SECRET=$(sm_get "$APPROVAL_SIGNING_SM_KEY" octogee 2>/dev/null || echo "")
if [[ -z "$APPROVAL_SIGNING_SECRET" ]]; then
  APPROVAL_SIGNING_SECRET=$(openssl rand -hex 32)
  info "  Generated new approval-signing secret — saving to Secret Manager..."
  if echo -n "$APPROVAL_SIGNING_SECRET" | gcloud secrets create "$APPROVAL_SIGNING_SM_KEY" \
       --data-file=- --project=octogee \
       --replication-policy=user-managed --locations=us-central1 2>/dev/null; then
    :
  else
    # Already exists — add a new version so we can read it back next run.
    echo -n "$APPROVAL_SIGNING_SECRET" | gcloud secrets versions add "$APPROVAL_SIGNING_SM_KEY" \
      --data-file=- --project=octogee \
      || fail "Could not persist approval-signing secret to Secret Manager (key=${APPROVAL_SIGNING_SM_KEY}). Refusing to materialize a K8s secret that exists nowhere else."
  fi
fi
ksecret approval-signing --from-literal=secret="$APPROVAL_SIGNING_SECRET"

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
# SECRET_KEY and INTERNAL_TOKEN are Gitea's internal crypto. They must NOT
# rotate across rebuilds — Gitea encrypts persisted data with them. First
# install: generate. Re-run: reuse what's already in the K8s secret.
info "gitea-credentials"
GITEA_DB_PASS=$(sm_get gitea-db-password octogee)
[[ -n "$GITEA_DB_PASS" ]] || fail "gitea-db-password not in Secret Manager"

EXISTING_SECRET_KEY=$(ksecret_key gitea-credentials secret-key)
EXISTING_INTERNAL_TOKEN=$(ksecret_key gitea-credentials internal-token)

if [[ -n "$EXISTING_SECRET_KEY" && -n "$EXISTING_INTERNAL_TOKEN" ]]; then
  info "  Reusing existing Gitea SECRET_KEY + INTERNAL_TOKEN (do not rotate — encrypts persisted data)"
  GITEA_SECRET_KEY="$EXISTING_SECRET_KEY"
  GITEA_INTERNAL_TOKEN="$EXISTING_INTERNAL_TOKEN"
else
  info "  First install — generating Gitea SECRET_KEY + INTERNAL_TOKEN"
  GITEA_SECRET_KEY=$(openssl rand -hex 32)
  GITEA_INTERNAL_TOKEN=$(openssl rand -hex 64)
fi

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

# ── 8. (removed) GitHub token ─────────────────────────────────────────────
# GitHub integration retired 2026-05-14: Gitea is the canonical git host
# for customer workspaces, and scripts/lib/collaboration.ts (GitHub org
# add/remove) was the only deployed consumer — dead in current surfaces.
# Matching removals: helm/octogee-gateway/values.yaml + deployment.yaml,
# helm/octogee/charts/gateway-edge/values.yaml, and this script's
# Firebase-function pre-create list.

# ── 9. Internal service key (gateway-edge ↔ gateway ↔ CronJob) ─────────
# Used by requireInternalServiceAuth() on /internal/billing/* routes.
# One shared secret across gateway-edge, gateway, and the trial-expiry CronJob.
# Precedence: Secret Manager > existing K8s secret > newly-generated.
# Rotating this value breaks cron jobs until pods restart, so we only
# generate a new one on first install (both SM and K8s empty).
info "internal-service-key"
INTERNAL_SERVICE_KEY=$(sm_get "INTERNAL_SERVICE_KEY" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
if [[ -z "$INTERNAL_SERVICE_KEY" ]]; then
  # Not in SM — try to recover from existing K8s cache
  EXISTING_ISK=$(ksecret_key internal-service-key key)
  if [[ -n "$EXISTING_ISK" ]]; then
    info "  Reusing existing INTERNAL_SERVICE_KEY from K8s, back-filling Secret Manager"
    INTERNAL_SERVICE_KEY="$EXISTING_ISK"
    echo -n "$INTERNAL_SERVICE_KEY" | gcloud secrets create "INTERNAL_SERVICE_KEY" \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=automatic --quiet 2>/dev/null || \
    echo -n "$INTERNAL_SERVICE_KEY" | gcloud secrets versions add "INTERNAL_SERVICE_KEY" \
      --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null || true
  else
    # First install — generate and persist to SM
    INTERNAL_SERVICE_KEY=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 40)
    info "  First install — generating INTERNAL_SERVICE_KEY, saving to Secret Manager ($FIREBASE_PROJECT)"
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
fi
ksecret internal-service-key --from-literal=key="$INTERNAL_SERVICE_KEY"

# ── 9b. Fleet controller HMAC secret (gateway ↔ Cloud Functions) ─────────
# The controller Cloud Functions (onUserUpdatedForFleet etc.) sign Cloud
# Tasks push payloads with this key; the gateway verifies on receipt.
# Stored once in Secret Manager in the Firebase project:
#   - Firebase Functions binds it via `defineSecret("FLEET_CONTROLLER_SECRET")`
#     → becomes `process.env.FLEET_CONTROLLER_SECRET` at function runtime.
#   - K8s Secret `octogee-fleet-controller/secret` feeds the gateway pod.
# If the two diverge the gateway silently 401s every restore task, so
# both sides must pull the same SM value. Rotating = new SM version +
# re-run this script + redeploy functions + rollout gateway pod.
info "octogee-fleet-controller (fleet controller HMAC)"
# Detect + repair trailing-whitespace drift in SM.
#
# `firebase functions:secrets:set` and manual stdin input can persist a
# trailing newline into the stored value, which `process.env.X` in Cloud
# Functions surfaces as-is — the controller signs with 65 bytes, the gateway
# verifies with 64 (bash command substitution strips the newline on the
# gateway side), HMAC mismatch, every restore 401s. Observed on TEST and
# again on PROD 2026-04-24.
#
# IMPORTANT: bash $(...) command substitution ALWAYS strips trailing
# newlines. The old detection did `FLEET_RAW_BYTES=$(gcloud ...)` and
# compared against the stripped value — both sides were pre-stripped, so
# the comparison was always equal and no clean version was ever written.
# To actually see the raw bytes we must write them to a file.
FLEET_RAW_TMP=$(mktemp)
gcloud secrets versions access latest --secret=FLEET_CONTROLLER_SECRET \
  --project="$FIREBASE_PROJECT" > "$FLEET_RAW_TMP" 2>/dev/null || true
FLEET_RAW_LEN=$(wc -c < "$FLEET_RAW_TMP" | tr -d ' ')
FLEET_CONTROLLER_SECRET=$(tr -d '[:space:]' < "$FLEET_RAW_TMP")
FLEET_CLEAN_LEN=${#FLEET_CONTROLLER_SECRET}
rm -f "$FLEET_RAW_TMP"

if [[ "$FLEET_CLEAN_LEN" -gt 0 && "$FLEET_RAW_LEN" != "$FLEET_CLEAN_LEN" ]]; then
  info "  SM FLEET_CONTROLLER_SECRET had trailing whitespace (${FLEET_RAW_LEN}→${FLEET_CLEAN_LEN} bytes) — rewriting clean version"
  echo -n "$FLEET_CONTROLLER_SECRET" | gcloud secrets versions add FLEET_CONTROLLER_SECRET \
    --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>&1 | tail -1 | sed 's/^/    /'
fi
if [[ -z "$FLEET_CONTROLLER_SECRET" ]]; then
  # Not in SM — try to recover from existing K8s cache
  EXISTING_FCS=$(ksecret_key octogee-fleet-controller secret)
  if [[ -n "$EXISTING_FCS" ]]; then
    info "  Reusing existing FLEET_CONTROLLER_SECRET from K8s, back-filling Secret Manager"
    FLEET_CONTROLLER_SECRET="$EXISTING_FCS"
    echo -n "$FLEET_CONTROLLER_SECRET" | gcloud secrets create "FLEET_CONTROLLER_SECRET" \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=automatic --quiet 2>/dev/null || \
    echo -n "$FLEET_CONTROLLER_SECRET" | gcloud secrets versions add "FLEET_CONTROLLER_SECRET" \
      --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null || true
  else
    # First install — generate and persist to SM
    FLEET_CONTROLLER_SECRET=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9+/' | head -c 64)
    info "  First install — generating FLEET_CONTROLLER_SECRET, saving to Secret Manager ($FIREBASE_PROJECT)"
    if echo -n "$FLEET_CONTROLLER_SECRET" | gcloud secrets create "FLEET_CONTROLLER_SECRET" \
         --data-file=- --project="$FIREBASE_PROJECT" \
         --replication-policy=automatic --quiet 2>/dev/null; then
      ok "  Created SM secret: FLEET_CONTROLLER_SECRET"
    elif echo -n "$FLEET_CONTROLLER_SECRET" | gcloud secrets versions add "FLEET_CONTROLLER_SECRET" \
         --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null; then
      ok "  Updated SM secret: FLEET_CONTROLLER_SECRET"
    else
      warn "  Could not persist to SM — key only in K8s this run; re-run to persist"
    fi
  fi
fi
# Two service accounts need access on FLEET_CONTROLLER_SECRET, with
# DIFFERENT roles because Firebase deploy + runtime need different perms:
#
#   1. RUNTIME  — functions compute SA (`{projectNumber}-compute@…`) reads
#      the secret VALUE at invocation time via defineSecret. Needs
#      `roles/secretmanager.secretAccessor` (covers `versions.access`).
#      Without it: every function invocation 500s.
#
#   2. DEPLOY   — GitHub Actions CI SA (`github-actions@octogee.iam.…`)
#      reads secret METADATA at `firebase deploy` time to configure the
#      function's secret binding. Needs `secretmanager.secrets.get`,
#      which is NOT in `secretAccessor` — only in `roles/secretmanager.viewer`
#      and above. We grant `roles/secretmanager.admin` (scoped to this
#      single secret) so the deploy SA can also manage versions if we
#      ever wire up rotation. Without it: firebase deploy 403s on
#      "secretmanager.secrets.get denied".
FN_SA_NUM=$(gcloud projects describe "$FIREBASE_PROJECT" --format='value(projectNumber)' 2>/dev/null)
FN_SA=""
[[ -n "$FN_SA_NUM" ]] && FN_SA="${FN_SA_NUM}-compute@developer.gserviceaccount.com"
CI_DEPLOY_SA="github-actions@octogee.iam.gserviceaccount.com"

if [[ -n "$FN_SA" ]]; then
  gcloud secrets add-iam-policy-binding FLEET_CONTROLLER_SECRET \
    --member="serviceAccount:$FN_SA" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
    && ok "  IAM runtime: $FN_SA → secretAccessor" \
    || warn "  Could not grant $FN_SA secretAccessor"
fi
gcloud secrets add-iam-policy-binding FLEET_CONTROLLER_SECRET \
  --member="serviceAccount:$CI_DEPLOY_SA" \
  --role="roles/secretmanager.admin" \
  --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
  && ok "  IAM deploy:  $CI_DEPLOY_SA → admin (scoped to this secret)" \
  || warn "  Could not grant $CI_DEPLOY_SA admin"
ksecret octogee-fleet-controller --from-literal=secret="$FLEET_CONTROLLER_SECRET"

# ── 9c. Gateway auth token secret shell + IAM ────────────────────────────
# The gateway pod PUBLISHES a fresh auth token to
# `gateway-auth-token-{gatewayId}` on every boot (see
# scripts/publish-gateway-token.mjs). chat-proxy READS the latest version
# at upstream-WS-connect time. We pre-create the secret SHELL here with
# proper IAM so the first gateway boot can successfully addVersion, and
# chat-proxy can successfully access.
#
# Why NOT pre-populate the value here: rotation-on-every-boot means any
# value we'd seed gets overwritten within seconds. A shell with IAM is
# the actual contract; the value arrives at boot.
#
# Per-gatewayId naming future-proofs multi-pod fleets — a second gateway
# pod (`gw-a`, `gw-b`) gets its own secret so chat-proxy can route users
# to their assigned pod without mixing tokens.
#
# Gateway IDs by env (match helm/octogee/values.{test,prod}.yaml):
info "gateway-auth-token (Secret Manager, per-gatewayId)"
case "$ENV" in
  prod)      GATEWAY_IDS=("gw-prod") ;;
  test)      GATEWAY_IDS=("gw-test") ;;
  custom)    GATEWAY_IDS=("gw-$CUSTOM_NS") ;;
esac

# Gateway + chat-proxy both run on this SA via Workload Identity (see
# helm/octogee/charts/{gateway,chat-proxy}/values.yaml serviceAccountName).
# One SA, two roles per secret: versionAdder (gateway publishes) +
# secretAccessor (chat-proxy reads).
GATEWAY_SA="octogee-gateway@${FIREBASE_PROJECT}.iam.gserviceaccount.com"

for gw_id in "${GATEWAY_IDS[@]}"; do
  SECRET_NAME="gateway-auth-token-${gw_id}"
  if gcloud secrets describe "$SECRET_NAME" --project="$FIREBASE_PROJECT" >/dev/null 2>&1; then
    info "  $SECRET_NAME already exists in SM ($FIREBASE_PROJECT)"
  else
    # Seed with a placeholder ONLY so the secret has a version — the first
    # gateway boot overwrites this within seconds. Required because
    # accessSecretVersion on a version-less secret throws NOT_FOUND, which
    # would blackhole chat-proxy if it happened to boot first.
    #
    # The literal MUST match GATEWAY_TOKEN_PLACEHOLDER in
    # chat-proxy/src/openclaw/gateway-token-constants.ts — the fetcher
    # detects this exact string and rejects it with `empty-token` so the
    # bootstrap window surfaces as a clean 503 instead of a doomed
    # auth-failed dance.
    if echo -n "placeholder-awaiting-gateway-boot" | gcloud secrets create "$SECRET_NAME" \
         --data-file=- \
         --project="$FIREBASE_PROJECT" \
         --replication-policy=automatic \
         --quiet 2>/dev/null; then
      ok "  Created SM secret: $SECRET_NAME (placeholder)"
    else
      warn "  Could not create $SECRET_NAME"
      continue
    fi
  fi

  # IAM: gateway SA needs BOTH roles — add versions on boot, access to
  # verify its own publish round-tripped. Scoped to this single secret.
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:$GATEWAY_SA" \
    --role="roles/secretmanager.secretVersionAdder" \
    --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
    && ok "  IAM: $GATEWAY_SA → secretVersionAdder on $SECRET_NAME" \
    || warn "  Could not grant secretVersionAdder on $SECRET_NAME"
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:$GATEWAY_SA" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
    && ok "  IAM: $GATEWAY_SA → secretAccessor on $SECRET_NAME" \
    || warn "  Could not grant secretAccessor on $SECRET_NAME"
  # Version destroyer for publish-gateway-token.mjs's prune step.
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:$GATEWAY_SA" \
    --role="roles/secretmanager.secretVersionManager" \
    --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
    && ok "  IAM: $GATEWAY_SA → secretVersionManager on $SECRET_NAME" \
    || warn "  Could not grant secretVersionManager on $SECRET_NAME"
done

# ── 9d. Cloud Tasks enqueuer for functions runtime SA ─────────────────────
# The fleet controller Cloud Functions call CloudTasksClient.createTask() to
# push restore jobs onto the `restore-customer` queue. Firebase Functions v2
# runs under the project compute SA ($FN_SA) — which does NOT get Cloud
# Tasks permissions by default, so every enqueue fails with a
# "cloudtasks.tasks.create denied" 403 until this binding exists. Scoped
# to the one queue, not project-wide.
if [[ -n "$FN_SA" ]]; then
  gcloud tasks queues add-iam-policy-binding restore-customer \
    --location=us-central1 \
    --project="$FIREBASE_PROJECT" \
    --member="serviceAccount:$FN_SA" \
    --role="roles/cloudtasks.enqueuer" --quiet >/dev/null 2>&1 \
    && ok "  IAM tasks:   $FN_SA → cloudtasks.enqueuer (restore-customer)" \
    || warn "  Could not grant $FN_SA cloudtasks.enqueuer on restore-customer — fleet controller will 403 every enqueue"
fi

# ── 10. Stripe secrets ────────────────────────────────────────────────────
# Required by gateway-edge at startup (not optional). Use placeholder if not
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
# Used by gateway-edge for email digest delivery via Resend.
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
RESEND_FROM_NAME="${RESEND_FROM_NAME:-Octo}"
set -u
[[ -z "$RESEND_API_KEY" ]]   && RESEND_API_KEY=$(sm_get RESEND_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$RESEND_FROM_EMAIL" ]] && RESEND_FROM_EMAIL=$(sm_get RESEND_FROM_EMAIL "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$RESEND_API_KEY" ]]   && warn "RESEND_API_KEY not found — emails will fail until configured"
[[ -z "$RESEND_FROM_EMAIL" ]] && warn "RESEND_FROM_EMAIL not found — using placeholder"
ksecret resend-secrets \
  --from-literal=api_key="${RESEND_API_KEY:-placeholder}" \
  --from-literal=from_email="${RESEND_FROM_EMAIL:-octo@octogee.com}" \
  --from-literal=from_name="${RESEND_FROM_NAME}"

# ── 11c. Invite token signing secret ─────────────────────────────────────
# HMAC key for signed invite tokens (gateway-edge/octogee-api inviteTokens.ts).
# Required for Builder invites; the route 500s without it. K8s Secret:
# invite-secret { secret → INVITE_SECRET }.
info "invite-secret"
set +u
INVITE_SECRET="${INVITE_SECRET:-}"
set -u
[[ -z "$INVITE_SECRET" ]] && INVITE_SECRET=$(sm_get INVITE_SECRET "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$INVITE_SECRET" ]] && warn "INVITE_SECRET not found — invite links will fail until configured"
ksecret invite-secret --from-literal=secret="${INVITE_SECRET:-placeholder}"

# ── 11b. Discord ops webhook (optional) ──────────────────────────────────
# Used by gateway to post operational events (agent provisioning, errors,
# deploy notifications) to a single Discord channel. Optional: if unset,
# the helm chart mounts the K8s Secret as optional=true and the gateway
# silently no-ops Discord posts.
#
# K8s Secret: discord-ops-webhook
#   url → DISCORD_OPS_WEBHOOK_URL (full https://discord.com/api/webhooks/... URL)
#
# Rotate: delete + recreate the webhook in Discord server settings, then
# `rotate-secret.sh --env=ENV discord-ops-webhook`. See docs/RUNBOOK.md.
info "discord-ops-webhook"
set +u
DISCORD_OPS_WEBHOOK_URL="${DISCORD_OPS_WEBHOOK_URL:-}"
set -u
[[ -z "$DISCORD_OPS_WEBHOOK_URL" ]] && DISCORD_OPS_WEBHOOK_URL=$(sm_get DISCORD_OPS_WEBHOOK_URL "$FIREBASE_PROJECT" 2>/dev/null || echo "")
# The SM secret is pre-created with the literal "placeholder" (so firebase
# deploy doesn't prompt). Only materialize the K8s secrets when it's a REAL
# Discord webhook — otherwise onSignup + Alertmanager would consume junk.
if [[ "$DISCORD_OPS_WEBHOOK_URL" == https://discord*/api/webhooks/* ]]; then
  ksecret discord-ops-webhook --from-literal=url="$DISCORD_OPS_WEBHOOK_URL"
  # Alertmanager runs in the shared `monitoring` namespace and reads the same
  # webhook (mounted via alertmanagerSpec.secrets). Mirror it there. Idempotent.
  kubectl create secret generic discord-ops-webhook -n monitoring \
    --from-literal=url="$DISCORD_OPS_WEBHOOK_URL" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null \
    && info "  mirrored discord-ops-webhook → monitoring ns (Alertmanager)" \
    || info "  WARN: failed to mirror discord-ops-webhook to monitoring ns"
else
  info "  DISCORD_OPS_WEBHOOK_URL unset/placeholder — skipping (signup + Alertmanager no-op until a real webhook is set)"
fi

# ── 12. GCP Service Account key ───────────────────────────────────────────
# Used by gateway-edge and gateway for GCP API access (Workload Identity
# preferred on prod; SA key is a fallback for services that need it directly).
info "octogee-sa-key"
case "$ENV" in
  prod)   SA_KEY_PATH="$HOME/.openclaw/secrets/octogee-sa-key.json" ;;
  test)   SA_KEY_PATH="$HOME/.openclaw/secrets/octogee-test-sa-key.json" ;;
  custom) SA_KEY_PATH="$HOME/.openclaw/secrets/octogee-test-sa-key.json" ;;  # reuse test SA
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
info "Pre-creating Firebase function secrets in Secret Manager (suppress deploy prompts)..."
SM_PROJECT_CF="$FIREBASE_PROJECT"  # Functions run in the Firebase project (octogee-test for test, octogee for prod)

# Full list of all defineSecret() references in Cloud Functions — must exist before firebase deploy
for sm_secret in \
  MM_ADMIN_TOKEN \
  GITEA_TOKEN \
  STRIPE_SECRET_KEY \
  STRIPE_WEBHOOK_SECRET \
  DISCORD_OPS_WEBHOOK_URL \
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
VALUES_FILE="values.${ENV}.yaml"
[[ "$ENV" == "custom" ]] && VALUES_FILE="values.$CUSTOM_NS.yaml (rendered from template)"
echo "  Canonical sequence (run teardown-env.sh --env=$ENV to see all 9 steps)."
echo ""
echo "  Next (Phase 1 → Helm):"
echo "    GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=gitea-db-password --project=octogee)"
echo "    helm upgrade --install octogee helm/octogee \\"
echo "      --server-side=true --force-conflicts \\"
echo "      -f helm/octogee/$VALUES_FILE \\"
echo "      -n $K8S_NAMESPACE \\"
echo "      --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
echo "      --kube-context $K8S_CONTEXT \\"
echo "      --wait --timeout=10m"
echo ""
echo "  Phase 2 callers should run after setup-mattermost + setup-gitea, then"
echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE."
echo ""
