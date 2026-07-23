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
#                        setup-gitea.sh have populated MM_TEAM_ID,
#                        MM_ADMIN_PAT, GIT_API_TOKEN, etc., and re-materializes
#                        mattermost-gateway + gitea-token with REAL values.
#                        kubectl rollout restart afterwards picks them up.
#
# Reads from: .env.test / .env + Secret Manager (octogee project).
#
# Canonical sequence printed by ./scripts/teardown-env.sh.
#
# Usage:
#   ./scripts/setup-secrets.sh --env=test [--deployment-target=test-west] [--yes]
#   ./scripts/setup-secrets.sh --env=prod
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/lib/shell-env.sh
source "$SCRIPT_DIR/lib/shell-env.sh"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ENV=""; YES=false; CUSTOM_NS=""; DEPLOYMENT_TARGET=""

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --yes|-y)      YES=true ;;
    --help|-h) echo "Usage: $0 --env=prod|test|build-week|custom [--deployment-target=TARGET] [--namespace=NAME] [--yes]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done
[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|build-week|custom [--deployment-target=TARGET] [--namespace=NAME] [--yes]"; exit 1; }

TARGET_ENV="$ENV"
[[ "$TARGET_ENV" == "custom" ]] && TARGET_ENV="test"
if [[ -n "$DEPLOYMENT_TARGET" ]]; then
  octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
  [[ "$TARGET_ENVIRONMENT" != "$TARGET_ENV" ]] && {
    echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment '$TARGET_ENV'"
    exit 1
  }
else
  octogee_load_deployment_target "--environment=$TARGET_ENV"
fi
K8S_NAMESPACE="$TARGET_NAMESPACE"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
FIREBASE_PROJECT="$TARGET_FIREBASE_PROJECT"
SM_PROJECT="$TARGET_CLOUD_SQL_PROJECT"
INTERNAL_SECRET_SUFFIX="$TARGET_SECRET_NAME_SUFFIX"
TARGET_ARG=" --deployment-target=$TARGET_ID"

case "$ENV" in
  prod)
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    NS_SLUG="prod"
    ;;
  test)
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    NS_SLUG="test"
    ;;
  build-week)
    ENV_FILE="$REPO_DIR/.env.build-week"
    ENV_LABEL="🟣 BUILD WEEK"
    NS_SLUG="build_week"
    ;;
  custom)
    # Ephemeral/feature namespaces sharing the octogee-test Firebase project.
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    [[ ${#CUSTOM_NS} -le 63 ]] || { echo "Namespace too long (max 63)"; exit 1; }
    K8S_NAMESPACE="$CUSTOM_NS"
    ENV_FILE="$REPO_DIR/.env.$CUSTOM_NS"
    ENV_LABEL="🟣 CUSTOM ($CUSTOM_NS)"
    NS_SLUG="${CUSTOM_NS//-/_}"
    INTERNAL_SECRET_SUFFIX="custom"
    TARGET_ARG=""
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac
if [[ "$ENV" != "custom" ]]; then
  case "$TARGET_ID" in
    prod-central|test-central|build-week-central) ;;
    *) ENV_FILE="$REPO_DIR/.env.$TARGET_ID" ;;
  esac
fi

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

sync_secret_manager_value() {
  local name="$1"
  local value="$2"
  local project="${3:-$SM_PROJECT}"
  local normalizer="${4:-configured_secret_value}"
  [[ -n "$value" ]] || fail "Refusing to persist empty Secret Manager value: $name"

  local state current normalized_current normalized_value
  state="$(secret_manager_secret_state "$name" "$project")"
  case "$state" in
    present)
      current="$(gcloud secrets versions access latest \
        --secret="$name" --project="$project" 2>/dev/null)" \
        || fail "Could not read existing Secret Manager value: $name"
      normalized_current="$("$normalizer" "$current")" \
        || fail "Existing Secret Manager value is invalid: $name"
      normalized_value="$("$normalizer" "$value")" \
        || fail "Proposed Secret Manager value is invalid: $name"
      [[ "$normalized_current" == "$normalized_value" ]] \
        || fail "Secret Manager is authoritative for $name; rotate it there before running setup-secrets.sh"
      ok "Secret Manager: $name"
      ;;
    absent)
      printf '%s' "$value" | gcloud secrets create "$name" \
        --data-file=- --project="$project" \
        --replication-policy=user-managed --locations="$TARGET_REGION" --quiet >/dev/null \
        || fail "Could not create absent Secret Manager value: $name"
      ok "Secret Manager: $name"
      ;;
    *) fail "Could not establish Secret Manager state: $name" ;;
  esac
}

read_authoritative_secret_manager_value() {
  local name="$1"
  local project="$2"
  local normalizer="$3"
  local state raw
  state="$(secret_manager_secret_state "$name" "$project")"
  case "$state" in
    present)
      raw="$(gcloud secrets versions access latest \
        --secret="$name" --project="$project" 2>/dev/null)" \
        || { echo "Could not read authoritative Secret Manager value: $name" >&2; return 1; }
      "$normalizer" "$raw"
      ;;
    absent) return 0 ;;
    *) echo "Could not establish authoritative Secret Manager state: $name" >&2; return 1 ;;
  esac
}

resolve_environment_secret_value() {
  local initial="$1"
  local sm_name="$2"
  local k8s_secret="$3"
  local k8s_key="$4"
  local normalizer="$5"
  local env_value secret_manager_value kubernetes_value
  env_value="$("$normalizer" "$initial")"
  kubernetes_value="$("$normalizer" "$(ksecret_key "$k8s_secret" "$k8s_key")")"
  if [[ "$ENV" == "custom" ]]; then
    if [[ -n "$kubernetes_value" ]]; then
      printf '%s' "$kubernetes_value"
      return 0
    fi
    secret_manager_value="$("$normalizer" "$(sm_get "$sm_name" "$FIREBASE_PROJECT")")"
    select_environment_secret_value \
      "$ENV" "$secret_manager_value" "$env_value" "$kubernetes_value"
    return 0
  fi
  secret_manager_value="$(read_authoritative_secret_manager_value \
    "$sm_name" "$FIREBASE_PROJECT" "$normalizer")" || return 1
  select_environment_secret_value \
    "$ENV" "$secret_manager_value" "$env_value" "$kubernetes_value"
}

# Load env file
set +u
load_env_file "$ENV_FILE"
set -u

[[ "$ENV" == "prod" && "$YES" == "true" ]] && fail "--yes cannot be used with prod."

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Pre-Helm Secrets — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── kubectl context ───────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$TARGET_REGION" --project "$CLUSTER_PROJECT" 2>/dev/null || true
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
MM_DB_PASSWORD=$(sm_get "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET" "$SM_PROJECT")
[[ -n "$MM_DB_PASSWORD" ]] || fail "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET not in Secret Manager ($SM_PROJECT project)"
ksecret mattermost-cloud-sql --from-literal=password="$MM_DB_PASSWORD"

# ── 2. Mattermost gateway creds ───────────────────────────────────────────
info "mattermost-gateway"
set +u
MM_ADMIN_USER="${MM_ADMIN_USER:-$(ksecret_key mattermost-gateway admin_user)}"
MM_ADMIN_USER="${MM_ADMIN_USER:-octogee-admin}"
MM_ADMIN_PASS="${MM_ADMIN_PASS:-$(ksecret_key mattermost-gateway admin_pass)}"
MM_ADMIN_PAT="${MM_ADMIN_PAT:-$(ksecret_key mattermost-gateway admin_token)}"
MM_TEAM_ID="${MM_TEAM_ID:-$(ksecret_key mattermost-gateway team_id)}"
MM_ADMIN_USER_ID="${MM_ADMIN_USER_ID:-$(ksecret_key mattermost-gateway admin_user_id)}"
set -u
ksecret mattermost-gateway \
  --from-literal=admin_user="$MM_ADMIN_USER" \
  --from-literal=admin_pass="$MM_ADMIN_PASS" \
  --from-literal=admin_token="$MM_ADMIN_PAT" \
  --from-literal=team_id="$MM_TEAM_ID" \
  --from-literal=admin_user_id="$MM_ADMIN_USER_ID"

if [[ -z "$MM_ADMIN_PAT" || -z "$MM_TEAM_ID" || -z "$MM_ADMIN_USER_ID" ]]; then
  warn "mattermost-gateway contains blank bootstrap values. Run ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG before trusting this environment."
fi

info "approval-signing"
APPROVAL_SIGNING_SECRET=$(ksecret_key approval-signing secret)
if [[ -z "$APPROVAL_SIGNING_SECRET" ]]; then
  APPROVAL_SIGNING_SECRET=$(openssl rand -hex 32)
fi
ksecret approval-signing --from-literal=secret="$APPROVAL_SIGNING_SECRET"

# ── 2b. OpenClaw agent-control signing secret ────────────────────────────
# HMAC secret for durable control context binding. Must NOT rotate during
# the lifetime of any pending control — rotating mid-flight invalidates
# buttons users haven't clicked yet. First install:
# generate. Re-run: reuse what's already in Secret Manager.
info "agent-control-signing"
AGENT_CONTROL_SIGNING_SM_KEY="agent-control-signing-${INTERNAL_SECRET_SUFFIX}"
[[ "$ENV" == "custom" ]] && AGENT_CONTROL_SIGNING_SM_KEY="agent-control-signing-custom-${CUSTOM_NS}"
AGENT_CONTROL_SIGNING_SECRET=$(sm_get "$AGENT_CONTROL_SIGNING_SM_KEY" octogee 2>/dev/null || echo "")
if [[ -z "$AGENT_CONTROL_SIGNING_SECRET" ]]; then
  AGENT_CONTROL_SIGNING_SECRET=$(openssl rand -hex 32)
  info "  Generated new agent-control-signing secret — saving to Secret Manager..."
  if echo -n "$AGENT_CONTROL_SIGNING_SECRET" | gcloud secrets create "$AGENT_CONTROL_SIGNING_SM_KEY" \
       --data-file=- --project=octogee \
       --replication-policy=user-managed --locations="$TARGET_REGION" 2>/dev/null; then
    :
  else
    # Already exists — add a new version so we can read it back next run.
    echo -n "$AGENT_CONTROL_SIGNING_SECRET" | gcloud secrets versions add "$AGENT_CONTROL_SIGNING_SM_KEY" \
      --data-file=- --project=octogee \
      || fail "Could not persist agent-control-signing secret to Secret Manager (key=${AGENT_CONTROL_SIGNING_SM_KEY}). Refusing to materialize a K8s secret that exists nowhere else."
  fi
fi
ksecret agent-control-signing --from-literal=secret="$AGENT_CONTROL_SIGNING_SECRET"

# ── 2c. Mattermost callback router signing secret ─────────────────────────
info "agent-control-router"
AGENT_CONTROL_ROUTER_SM_KEY="agent-control-router-${INTERNAL_SECRET_SUFFIX}"
[[ "$ENV" == "custom" ]] && AGENT_CONTROL_ROUTER_SM_KEY="agent-control-router-custom-${CUSTOM_NS}"
AGENT_CONTROL_ROUTER_SECRET=$(sm_get "$AGENT_CONTROL_ROUTER_SM_KEY" octogee 2>/dev/null || echo "")
if [[ -z "$AGENT_CONTROL_ROUTER_SECRET" ]]; then
  AGENT_CONTROL_ROUTER_SECRET=$(openssl rand -hex 32)
  info "  Generated new agent-control-router secret — saving to Secret Manager..."
  if echo -n "$AGENT_CONTROL_ROUTER_SECRET" | gcloud secrets create "$AGENT_CONTROL_ROUTER_SM_KEY" \
       --data-file=- --project=octogee \
       --replication-policy=user-managed --locations="$TARGET_REGION" 2>/dev/null; then
    :
  else
    echo -n "$AGENT_CONTROL_ROUTER_SECRET" | gcloud secrets versions add "$AGENT_CONTROL_ROUTER_SM_KEY" \
      --data-file=- --project=octogee \
      || fail "Could not persist agent-control-router secret to Secret Manager (key=${AGENT_CONTROL_ROUTER_SM_KEY})."
  fi
fi
ksecret agent-control-router --from-literal=secret="$AGENT_CONTROL_ROUTER_SECRET"

# ── 2d. BYOT sync internal signing secret ─────────────────────────────────
info "byot-sync-internal"
BYOT_SYNC_INTERNAL_SM_KEY="byot-sync-internal-${INTERNAL_SECRET_SUFFIX}"
[[ "$ENV" == "custom" ]] && BYOT_SYNC_INTERNAL_SM_KEY="byot-sync-internal-custom-${CUSTOM_NS}"
BYOT_SYNC_INTERNAL_SECRET=$(sm_get "$BYOT_SYNC_INTERNAL_SM_KEY" octogee 2>/dev/null || echo "")
if [[ -z "$BYOT_SYNC_INTERNAL_SECRET" ]]; then
  BYOT_SYNC_INTERNAL_SECRET=$(openssl rand -hex 32)
  info "  Generated new BYOT sync signing secret — saving to Secret Manager..."
  if echo -n "$BYOT_SYNC_INTERNAL_SECRET" | gcloud secrets create "$BYOT_SYNC_INTERNAL_SM_KEY" \
       --data-file=- --project=octogee \
       --replication-policy=user-managed --locations="$TARGET_REGION" 2>/dev/null; then
    :
  else
    echo -n "$BYOT_SYNC_INTERNAL_SECRET" | gcloud secrets versions add "$BYOT_SYNC_INTERNAL_SM_KEY" \
      --data-file=- --project=octogee \
      || fail "Could not persist BYOT sync signing secret to Secret Manager (key=${BYOT_SYNC_INTERNAL_SM_KEY}). Refusing to materialize a K8s secret that exists nowhere else."
  fi
fi
ksecret byot-sync-internal --from-literal=secret="$BYOT_SYNC_INTERNAL_SECRET"

# ── 3. Gitea admin ────────────────────────────────────────────────────────
info "gitea-admin"
GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${INTERNAL_SECRET_SUFFIX}"
GITEA_ADMIN_PASS=$(sm_get "$GITEA_ADMIN_PASSWORD_SM_KEY" octogee 2>/dev/null || echo "")
if [[ -z "$GITEA_ADMIN_PASS" ]]; then
  GITEA_ADMIN_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
  info "  Generated new Gitea admin password — saving to Secret Manager..."
  echo -n "$GITEA_ADMIN_PASS" | gcloud secrets create "$GITEA_ADMIN_PASSWORD_SM_KEY" \
    --data-file=- --project=octogee \
    --replication-policy=user-managed --locations="$TARGET_REGION" 2>/dev/null || \
  echo -n "$GITEA_ADMIN_PASS" | gcloud secrets versions add "$GITEA_ADMIN_PASSWORD_SM_KEY" \
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
GITEA_DB_PASS=$(sm_get "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET" "$SM_PROJECT")
[[ -n "$GITEA_DB_PASS" ]] || fail "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET not in Secret Manager"

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
GITEA_API_TOKEN_SM_KEY="gitea-api-token-${INTERNAL_SECRET_SUFFIX}"
GIT_API_TOKEN=$(sm_get "$GITEA_API_TOKEN_SM_KEY" octogee 2>/dev/null || echo "")
if [[ -n "$GIT_API_TOKEN" ]]; then
  ksecret gitea-token --from-literal=token="$GIT_API_TOKEN"
else
  warn "$GITEA_API_TOKEN_SM_KEY not in Secret Manager yet — run setup-gitea.sh after Helm to create it"
  ksecret gitea-token --from-literal=token=""
fi

# ── 6. Anthropic API key ──────────────────────────────────────────────────
info "octogee-anthropic"
set +u; ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"; set -u
# Per-env UNIQUE key — read from this env's own SM project (where
# rotate-secret.sh anthropic writes), NOT the shared octogee project, so a
# rotated test key isn't clobbered by the prod key on re-run.
[[ -z "$ANTHROPIC_API_KEY" ]] && ANTHROPIC_API_KEY=$(sm_get ANTHROPIC_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -n "$ANTHROPIC_API_KEY" ]] || fail "ANTHROPIC_API_KEY not found in .env or Secret Manager"
ksecret octogee-anthropic --from-literal=api_key="$ANTHROPIC_API_KEY"

# ── 6b. OpenRouter API key ─────────────────────────────────────────────────
info "octogee-openrouter"
set +u
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
OPENROUTER_PLATFORM_API_KEY="${OPENROUTER_PLATFORM_API_KEY:-}"
set -u
[[ -z "$OPENROUTER_API_KEY" && -n "$OPENROUTER_PLATFORM_API_KEY" ]] && OPENROUTER_API_KEY="$OPENROUTER_PLATFORM_API_KEY"
[[ -z "$OPENROUTER_API_KEY" ]] && OPENROUTER_API_KEY=$(sm_get OPENROUTER_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$OPENROUTER_API_KEY" ]] && OPENROUTER_API_KEY=$(sm_get OPENROUTER_PLATFORM_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -n "$OPENROUTER_API_KEY" ]] || fail "OPENROUTER_API_KEY not found in .env or Secret Manager"
ksecret octogee-openrouter --from-literal=api_key="$OPENROUTER_API_KEY"

# ── 6c. OpenAI API key (llm-broker platform provider + embeddings) ────────
info "OPENAI_API_KEY (llm-broker platform provider + memory search embeddings)"
set +u
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_EMBEDDINGS_API_KEY="${OPENAI_EMBEDDINGS_API_KEY:-}"
set -u
[[ -z "$OPENAI_API_KEY" && -n "$OPENAI_EMBEDDINGS_API_KEY" ]] && OPENAI_API_KEY="$OPENAI_EMBEDDINGS_API_KEY"
OPENAI_API_KEY_SOURCE="env"
if [[ -z "$OPENAI_API_KEY" ]]; then
  OPENAI_API_KEY=$(sm_get OPENAI_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
  OPENAI_API_KEY_SOURCE="secret-manager"
fi
if [[ -n "$OPENAI_API_KEY" ]]; then
  if [[ "$OPENAI_API_KEY_SOURCE" == "env" ]]; then
    if gcloud secrets describe OPENAI_API_KEY --project="$FIREBASE_PROJECT" >/dev/null 2>&1; then
      echo -n "$OPENAI_API_KEY" | gcloud secrets versions add OPENAI_API_KEY \
        --data-file=- \
        --project="$FIREBASE_PROJECT" >/dev/null
    else
      echo -n "$OPENAI_API_KEY" | gcloud secrets create OPENAI_API_KEY \
        --data-file=- \
        --project="$FIREBASE_PROJECT" \
        --replication-policy=user-managed --locations="$TARGET_REGION" >/dev/null
    fi
  fi
  ok "Secret Manager: OPENAI_API_KEY"
  # The llm-broker's platform-openai provider rides the same key (gpt-5.4-mini
  # via the free-tier dial); optional in helm, so absence only 503s openai traffic.
  ksecret octogee-openai --from-literal=api_key="$OPENAI_API_KEY"
else
  warn "OPENAI_API_KEY not found in .env or Secret Manager ($FIREBASE_PROJECT) — memory search embeddings stay disabled and the llm-broker serves no platform-openai traffic until the key is seeded"
fi

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

# ── 7b. Tavily API key ────────────────────────────────────────────────────
info "octogee-tavily"
set +u
TAVILY_API_KEY="${TAVILY_API_KEY:-}"
TAVILY_COST_PER_CREDIT_USD="${TAVILY_COST_PER_CREDIT_USD:-0.008}"
set -u
[[ -z "$TAVILY_API_KEY" ]] && TAVILY_API_KEY=$(sm_get TAVILY_API_KEY octogee 2>/dev/null || echo "")
if [[ -n "$TAVILY_API_KEY" ]]; then
  ksecret octogee-tavily \
    --from-literal=api_key="$TAVILY_API_KEY" \
    --from-literal=cost_per_credit_usd="$TAVILY_COST_PER_CREDIT_USD"
else
  warn "TAVILY_API_KEY not found — creating empty secret (optional)"
  ksecret octogee-tavily \
    --from-literal=api_key="" \
    --from-literal=cost_per_credit_usd="$TAVILY_COST_PER_CREDIT_USD"
fi

# ── 8. Connector OAuth client secrets (octogee-api /api/connect/<provider>) ─
# octogee-api reads client_id + client_secret from these K8s secrets to run the
# Connections OAuth flow (helm wires them with optional:true). Sourced from the
# env file, Secret Manager fallback. The original single GitHub *token* was
# dropped 2026-05-14 when GitHub was thought dead; GitHub returned as a
# Connections connector, so the per-provider OAuth client secrets are
# established here — a regression caused "GitHub connection is not configured".
oauth_secret() {
  local secret="$1" id_var="$2" sec_var="$3"
  info "$secret"
  set +u; local id="${!id_var:-}" sec="${!sec_var:-}"; set -u
  [[ -z "$id" ]]  && id=$(sm_get "$id_var" 2>/dev/null || echo "")
  [[ -z "$sec" ]] && sec=$(sm_get "$sec_var" 2>/dev/null || echo "")
  if [[ -n "$id" && -n "$sec" ]]; then
    ksecret "$secret" --from-literal=client_id="$id" --from-literal=client_secret="$sec"
  else
    warn "$id_var/$sec_var not set — creating empty $secret (optional; OAuth connect disabled for this provider)"
    ksecret "$secret" --from-literal=client_id="" --from-literal=client_secret=""
  fi
}
oauth_secret github-oauth    GITHUB_CLIENT_ID    GITHUB_CLIENT_SECRET
oauth_secret microsoft-oauth MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET

info "google-oauth"
persist_google_env() {
  local env_file="$1"
  save_env_file_value "$env_file" GOOGLE_CLIENT_ID "$G_ID"
  save_env_file_value "$env_file" GOOGLE_CLIENT_SECRET "$G_SEC"
  save_env_file_value "$env_file" GOOGLE_PICKER_API_KEY "$G_PICKER_KEY"
  save_env_file_value "$env_file" GOOGLE_PICKER_APP_ID "$G_PICKER_APP"
}

G_ID="$(resolve_environment_secret_value "${GOOGLE_CLIENT_ID:-}" GOOGLE_CLIENT_ID google-oauth client_id configured_secret_value)"
G_SEC="$(resolve_environment_secret_value "${GOOGLE_CLIENT_SECRET:-}" GOOGLE_CLIENT_SECRET google-oauth client_secret configured_secret_value)"
G_PICKER_KEY="$(resolve_environment_secret_value "${GOOGLE_PICKER_API_KEY:-}" GOOGLE_PICKER_API_KEY google-oauth picker_api_key configured_secret_value)"
G_PICKER_APP="$(resolve_environment_secret_value "${GOOGLE_PICKER_APP_ID:-}" GOOGLE_PICKER_APP_ID google-oauth picker_app_id configured_secret_value)"
[[ -z "$G_ID" || -z "$G_SEC" ]] && warn "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — Google connect disabled"
[[ -z "$G_PICKER_KEY" || -z "$G_PICKER_APP" ]] && warn "GOOGLE_PICKER_API_KEY/GOOGLE_PICKER_APP_ID not set — Drive picker disabled"
if [[ "$ENV" != "custom" ]]; then
  [[ -n "$G_ID" ]] && sync_secret_manager_value GOOGLE_CLIENT_ID "$G_ID" "$FIREBASE_PROJECT"
  [[ -n "$G_SEC" ]] && sync_secret_manager_value GOOGLE_CLIENT_SECRET "$G_SEC" "$FIREBASE_PROJECT"
  [[ -n "$G_PICKER_KEY" ]] && sync_secret_manager_value GOOGLE_PICKER_API_KEY "$G_PICKER_KEY" "$FIREBASE_PROJECT"
  [[ -n "$G_PICKER_APP" ]] && sync_secret_manager_value GOOGLE_PICKER_APP_ID "$G_PICKER_APP" "$FIREBASE_PROJECT"
fi
if [[ -n "$G_ID" && -n "$G_SEC" && -n "$G_PICKER_KEY" && -n "$G_PICKER_APP" ]]; then
  persist_google_env "$ENV_FILE"
  [[ "$ENV" == "test" ]] && persist_google_env "$REPO_DIR/.env.local"
fi
export GOOGLE_CLIENT_ID="$G_ID"
export GOOGLE_CLIENT_SECRET="$G_SEC"
export GOOGLE_PICKER_API_KEY="$G_PICKER_KEY"
export GOOGLE_PICKER_APP_ID="$G_PICKER_APP"
ksecret google-oauth \
  --from-literal=client_id="$G_ID" \
  --from-literal=client_secret="$G_SEC" \
  --from-literal=picker_api_key="$G_PICKER_KEY" \
  --from-literal=picker_app_id="$G_PICKER_APP"

# ── 8b. Connect-state signing secret (octogee-api OAuth state HMAC) ────────
# HMAC secret that signs the OAuth `state` round-tripped through the provider
# (CSRF + payload integrity, 10min TTL). Self-generated — not a provider cred.
# Must NOT rotate during the lifetime of an in-flight connect (rotating
# mid-flow invalidates states users are mid-redirect on). First install:
# generate. Re-run: reuse what's already in Secret Manager. Its absence makes
# every connect throw "CONNECT_STATE_SECRET environment variable is required".
info "connect-state-secret"
CONNECT_STATE_SM_KEY="connect-state-secret-${INTERNAL_SECRET_SUFFIX}"
[[ "$ENV" == "custom" ]] && CONNECT_STATE_SM_KEY="connect-state-secret-custom-${CUSTOM_NS}"
CONNECT_STATE_SECRET=$(sm_get "$CONNECT_STATE_SM_KEY" octogee 2>/dev/null || echo "")
if [[ -z "$CONNECT_STATE_SECRET" ]]; then
  CONNECT_STATE_SECRET=$(openssl rand -hex 32)
  info "  Generated new connect-state secret — saving to Secret Manager..."
  if echo -n "$CONNECT_STATE_SECRET" | gcloud secrets create "$CONNECT_STATE_SM_KEY" \
       --data-file=- --project=octogee \
       --replication-policy=user-managed --locations="$TARGET_REGION" 2>/dev/null; then
    :
  else
    echo -n "$CONNECT_STATE_SECRET" | gcloud secrets versions add "$CONNECT_STATE_SM_KEY" \
      --data-file=- --project=octogee \
      || fail "Could not persist connect-state secret to Secret Manager (key=${CONNECT_STATE_SM_KEY}). Refusing to materialize a K8s secret that exists nowhere else."
  fi
fi
ksecret connect-state-secret --from-literal=secret="$CONNECT_STATE_SECRET"

# ── 9a. Gateway model-key issuer bearer (glm-controller → octogee-api) ─
# A dedicated bearer, separate from the gateway tenant-binding auth. It only
# authorizes Cowboy to mint and revoke opaque LLM broker tokens via
# /internal/model-keys, and is never mounted into gateway pods.
info "gateway-model-key-issuer"
GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN=$(sm_get "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
if [[ -z "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" ]]; then
  EXISTING_MODEL_ISSUER=$(ksecret_key gateway-model-key-issuer bearer_token)
  if [[ -n "$EXISTING_MODEL_ISSUER" ]]; then
    info "  Reusing existing GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN from K8s, back-filling Secret Manager"
    GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN="$EXISTING_MODEL_ISSUER"
    echo -n "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" | gcloud secrets create "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations="$TARGET_REGION" --quiet 2>/dev/null || \
    echo -n "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" | gcloud secrets versions add "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" \
      --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null || true
  else
    GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN=$(openssl rand -hex 32)
    info "  First install — generating GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN, saving to Secret Manager ($FIREBASE_PROJECT)"
    if echo -n "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" | gcloud secrets create "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" \
         --data-file=- --project="$FIREBASE_PROJECT" \
         --replication-policy=user-managed --locations="$TARGET_REGION" --quiet 2>/dev/null; then
      ok "  Created SM secret: GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN"
    elif echo -n "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" | gcloud secrets versions add "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" \
         --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null; then
      ok "  Updated SM secret: GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN"
    else
      warn "  Could not persist to SM — key only in K8s this run; re-run to persist"
    fi
  fi
fi
ksecret gateway-model-key-issuer --from-literal=bearer_token="$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN"

# ── 9a2. Ops Agent bearer (octogee-api → octogee-ops-agent) ─────────────
info "ops-agent-bearer"
OPS_AGENT_BEARER_TOKEN="$(configured_secret_value "${OPS_AGENT_BEARER_TOKEN:-}")"
[[ -n "$OPS_AGENT_BEARER_TOKEN" ]] || OPS_AGENT_BEARER_TOKEN=$(sm_get "OPS_AGENT_BEARER_TOKEN" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -n "$OPS_AGENT_BEARER_TOKEN" ]] || OPS_AGENT_BEARER_TOKEN=$(ksecret_key ops-agent-bearer bearer_token)
[[ -n "$OPS_AGENT_BEARER_TOKEN" ]] || OPS_AGENT_BEARER_TOKEN=$(openssl rand -hex 32)
if [[ "$ENV" != "custom" ]]; then
  sync_secret_manager_value OPS_AGENT_BEARER_TOKEN "$OPS_AGENT_BEARER_TOKEN" "$FIREBASE_PROJECT"
fi
save_env_file_value "$ENV_FILE" OPS_AGENT_BEARER_TOKEN "$OPS_AGENT_BEARER_TOKEN"
ksecret ops-agent-bearer --from-literal=bearer_token="$OPS_AGENT_BEARER_TOKEN"

# ── 9a2. Social notification bearer (Cloud Functions → octogee-api /social) ─
# Dedicated bearer for the out-of-cluster social inbox producer — the only auth
# on the public /api/notifications/social route. octogee-api reads
# the K8s secret; Functions read the Secret Manager copy via defineSecret — both
# must carry the SAME value. Precedence: Secret Manager > existing K8s > generated.
info "social-notification-bearer"
SOCIAL_NOTIFICATION_BEARER=$(sm_get "SOCIAL_NOTIFICATION_BEARER_TOKEN" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
if [[ -z "$SOCIAL_NOTIFICATION_BEARER" ]]; then
  EXISTING_SNB=$(ksecret_key social-notification-bearer bearer-token)
  if [[ -n "$EXISTING_SNB" ]]; then
    info "  Reusing existing social bearer from K8s, back-filling Secret Manager"
    SOCIAL_NOTIFICATION_BEARER="$EXISTING_SNB"
    echo -n "$SOCIAL_NOTIFICATION_BEARER" | gcloud secrets create "SOCIAL_NOTIFICATION_BEARER_TOKEN" \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations="$TARGET_REGION" --quiet 2>/dev/null || \
    echo -n "$SOCIAL_NOTIFICATION_BEARER" | gcloud secrets versions add "SOCIAL_NOTIFICATION_BEARER_TOKEN" \
      --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null || true
  else
    SOCIAL_NOTIFICATION_BEARER=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 40)
    info "  First install — generating social bearer, saving to Secret Manager ($FIREBASE_PROJECT)"
    if echo -n "$SOCIAL_NOTIFICATION_BEARER" | gcloud secrets create "SOCIAL_NOTIFICATION_BEARER_TOKEN" \
         --data-file=- --project="$FIREBASE_PROJECT" \
         --replication-policy=user-managed --locations="$TARGET_REGION" --quiet 2>/dev/null; then
      ok "  Created SM secret: SOCIAL_NOTIFICATION_BEARER_TOKEN"
    elif echo -n "$SOCIAL_NOTIFICATION_BEARER" | gcloud secrets versions add "SOCIAL_NOTIFICATION_BEARER_TOKEN" \
         --data-file=- --project="$FIREBASE_PROJECT" --quiet 2>/dev/null; then
      ok "  Updated SM secret: SOCIAL_NOTIFICATION_BEARER_TOKEN"
    else
      warn "  Could not persist to SM — bearer only in K8s this run; re-run to persist"
    fi
  fi
fi
ksecret social-notification-bearer --from-literal=bearer-token="$SOCIAL_NOTIFICATION_BEARER"

# ── 9b. Fleet controller signing keypair (glm-controller ↔ gateway) ──────
# glm-controller signs the in-cluster migration RPCs with an Ed25519 private
# key; gateway pods verify with only the public key. Secret Manager is the
# durable store and the K8s Secret fans the split material into the right pods:
#   - octogee-fleet-controller/private-key → glm-controller only
#   - octogee-fleet-controller/public-key  → gateway pods only
# Rotating = new SM private-key version + derived public-key version + re-run
# this script + rollout the gateway/controller pods.
info "octogee-fleet-controller (fleet controller Ed25519 keypair)"

persist_sm_file() {
  local name="$1" file="$2"
  if gcloud secrets describe "$name" --project="$FIREBASE_PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions add "$name" --data-file="$file" --project="$FIREBASE_PROJECT" --quiet >/dev/null
    ok "  Updated SM secret: $name"
  else
    gcloud secrets create "$name" --data-file="$file" --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations="$TARGET_REGION" --quiet >/dev/null
    ok "  Created SM secret: $name"
  fi
}

FLEET_PRIVATE_TMP=$(mktemp)
FLEET_PUBLIC_TMP=$(mktemp)
FLEET_DERIVED_PUBLIC_TMP=$(mktemp)
gcloud secrets versions access latest --secret=FLEET_CONTROLLER_PRIVATE_KEY \
  --project="$FIREBASE_PROJECT" > "$FLEET_PRIVATE_TMP" 2>/dev/null || true
gcloud secrets versions access latest --secret=FLEET_CONTROLLER_PUBLIC_KEY \
  --project="$FIREBASE_PROJECT" > "$FLEET_PUBLIC_TMP" 2>/dev/null || true

if [[ ! -s "$FLEET_PRIVATE_TMP" ]]; then
  info "  First install — generating FLEET_CONTROLLER_PRIVATE_KEY, saving to Secret Manager ($FIREBASE_PROJECT)"
  openssl genpkey -algorithm Ed25519 -out "$FLEET_PRIVATE_TMP"
  persist_sm_file "FLEET_CONTROLLER_PRIVATE_KEY" "$FLEET_PRIVATE_TMP"
fi

if ! openssl pkey -in "$FLEET_PRIVATE_TMP" -noout >/dev/null 2>&1; then
  rm -f "$FLEET_PRIVATE_TMP" "$FLEET_PUBLIC_TMP" "$FLEET_DERIVED_PUBLIC_TMP"
  fail "FLEET_CONTROLLER_PRIVATE_KEY is not a valid private key"
fi

openssl pkey -in "$FLEET_PRIVATE_TMP" -pubout -out "$FLEET_DERIVED_PUBLIC_TMP" >/dev/null 2>&1
if [[ ! -s "$FLEET_PUBLIC_TMP" ]] || ! cmp -s "$FLEET_PUBLIC_TMP" "$FLEET_DERIVED_PUBLIC_TMP"; then
  info "  Deriving FLEET_CONTROLLER_PUBLIC_KEY from the private key"
  cp "$FLEET_DERIVED_PUBLIC_TMP" "$FLEET_PUBLIC_TMP"
  persist_sm_file "FLEET_CONTROLLER_PUBLIC_KEY" "$FLEET_PUBLIC_TMP"
fi

# No runtime service account reads these from Secret Manager. SM is only the
# durable store this script reads/writes with operator creds.
ksecret octogee-fleet-controller \
  --from-file=private-key="$FLEET_PRIVATE_TMP" \
  --from-file=public-key="$FLEET_PUBLIC_TMP"
rm -f "$FLEET_PRIVATE_TMP" "$FLEET_PUBLIC_TMP" "$FLEET_DERIVED_PUBLIC_TMP"

# ── 9c. Gateway auth token secret shell + IAM ────────────────────────────
# Legacy compatibility shell for the old Secret Manager OpenClaw-token path.
# Normal Kubernetes gateway pods keep gateway auth pod-local now:
# gateway-edge receives the same per-gateway OPENCLAW_GATEWAY_TOKEN env
# exception, pairs once with OpenClaw, then uses a sidecar-local device token.
# The Secret Manager publisher is opt-in via
# GATEWAY_AUTH_SECRET_MANAGER_PUBLISH=true for rollback/legacy deployments.
#
# Why NOT pre-populate the live value here: the normal runtime does not use SM
# for gateway auth. Legacy opt-in publishing overwrites the placeholder at
# boot if explicitly enabled.
#
# Per-gatewayId naming future-proofs multi-pod fleets — a second gateway
# pod (`gw-a`, `gw-b`) gets its own secret so chat-proxy can route users
# to their assigned pod without mixing tokens.
#
# Gateway IDs by env (match helm/octogee/values.{test,prod}.yaml):
info "gateway-auth-token (Secret Manager, per-gatewayId)"
case "$ENV" in
  prod)      GATEWAY_IDS=("default") ;;
  test)      GATEWAY_IDS=("default") ;;
  build-week) GATEWAY_IDS=("default") ;;
  custom)    GATEWAY_IDS=("default") ;;
esac

# Legacy opt-in publisher/reader roles. These are resource-scoped to the
# per-gateway auth-token secret and should be removed once the SM rollback path
# is deleted.
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
         --replication-policy=user-managed --locations="$TARGET_REGION" \
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

# ── 10. Stripe secrets ────────────────────────────────────────────────────
# Required by octogee-api at startup (not optional). Use placeholder if not
# configured yet — billing is sandbox mode until real keys are set.
info "stripe-secrets"
STRIPE_SECRET_KEY="$(resolve_environment_secret_value "${STRIPE_SECRET_KEY:-}" STRIPE_SECRET_KEY stripe-secrets secret_key configured_secret_value)"
STRIPE_WEBHOOK_SECRET="$(resolve_environment_secret_value "${STRIPE_WEBHOOK_SECRET:-}" STRIPE_WEBHOOK_SECRET stripe-secrets webhook_secret configured_secret_value)"
STRIPE_PRICE_IDS="$(resolve_environment_secret_value "${STRIPE_PRICE_IDS:-}" STRIPE_PRICE_IDS stripe-secrets price_ids configured_stripe_price_ids_value)"
[[ -z "$STRIPE_SECRET_KEY" ]]    && warn "STRIPE_SECRET_KEY not found — using placeholder (billing disabled)"
[[ -z "$STRIPE_WEBHOOK_SECRET" ]] && warn "STRIPE_WEBHOOK_SECRET not found — using placeholder"
[[ -z "$STRIPE_PRICE_IDS" ]] && warn "STRIPE_PRICE_IDS not found — checkout plans remain unavailable"
if [[ -n "$STRIPE_SECRET_KEY" ]]; then
  validate_stripe_secret_key_mode "$ENV" "$STRIPE_SECRET_KEY" \
    || fail "STRIPE_SECRET_KEY mode does not match --env=$ENV"
fi
if [[ -n "$STRIPE_WEBHOOK_SECRET" ]]; then
  validate_stripe_webhook_secret "$STRIPE_WEBHOOK_SECRET" \
    || fail "STRIPE_WEBHOOK_SECRET must be a Stripe whsec_ signing secret"
fi
if [[ "$ENV" != "custom" ]]; then
  [[ -n "$STRIPE_SECRET_KEY" ]] && sync_secret_manager_value STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY" "$FIREBASE_PROJECT"
  [[ -n "$STRIPE_WEBHOOK_SECRET" ]] && sync_secret_manager_value STRIPE_WEBHOOK_SECRET "$STRIPE_WEBHOOK_SECRET" "$FIREBASE_PROJECT"
fi
if [[ -n "$STRIPE_PRICE_IDS" ]]; then
  validate_stripe_price_ids_json "$STRIPE_PRICE_IDS" \
    || fail "STRIPE_PRICE_IDS must map every supported plan and credit key to a Stripe price ID"
  STRIPE_PRICE_IDS="$(canonicalize_stripe_price_ids_json "$STRIPE_PRICE_IDS")" \
    || fail "STRIPE_PRICE_IDS could not be canonicalized"
  if [[ "$ENV" != "custom" ]]; then
    sync_secret_manager_value STRIPE_PRICE_IDS "$STRIPE_PRICE_IDS" "$FIREBASE_PROJECT" canonicalize_stripe_price_ids_json
  fi
  save_env_file_value "$ENV_FILE" STRIPE_PRICE_IDS "$STRIPE_PRICE_IDS"
fi
STRIPE_PRICE_IDS_MATERIALIZED="$(materialize_stripe_price_ids_json "$STRIPE_PRICE_IDS")"
ksecret stripe-secrets \
  --from-literal=secret_key="${STRIPE_SECRET_KEY:-placeholder}" \
  --from-literal=webhook_secret="${STRIPE_WEBHOOK_SECRET:-placeholder}" \
  --from-literal=price_ids="$STRIPE_PRICE_IDS_MATERIALIZED"

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
RESEND_WEBHOOK_SECRET="${RESEND_WEBHOOK_SECRET:-}"
EMAIL_UNSUBSCRIBE_SECRET="${EMAIL_UNSUBSCRIBE_SECRET:-}"
set -u
[[ -z "$RESEND_API_KEY" ]]   && RESEND_API_KEY=$(sm_get RESEND_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$RESEND_FROM_EMAIL" ]] && RESEND_FROM_EMAIL=$(sm_get RESEND_FROM_EMAIL "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$RESEND_WEBHOOK_SECRET" ]] && RESEND_WEBHOOK_SECRET=$(sm_get RESEND_WEBHOOK_SECRET "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$EMAIL_UNSUBSCRIBE_SECRET" ]] && EMAIL_UNSUBSCRIBE_SECRET=$(sm_get EMAIL_UNSUBSCRIBE_SECRET "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$RESEND_API_KEY" ]]   && warn "RESEND_API_KEY not found — emails will fail until configured"
[[ -z "$RESEND_FROM_EMAIL" ]] && warn "RESEND_FROM_EMAIL not found — using placeholder"
[[ -z "$RESEND_WEBHOOK_SECRET" ]] && warn "RESEND_WEBHOOK_SECRET not found — webhook will 503 until configured (Resend dashboard → Webhooks → signing secret)"
[[ -z "$EMAIL_UNSUBSCRIBE_SECRET" ]] && warn "EMAIL_UNSUBSCRIBE_SECRET not found — one-click unsubscribe routes will 500 until configured (generate with: openssl rand -base64 48)"
ksecret resend-secrets \
  --from-literal=api_key="${RESEND_API_KEY:-placeholder}" \
  --from-literal=from_email="${RESEND_FROM_EMAIL:-octo@octogee.com}" \
  --from-literal=from_name="${RESEND_FROM_NAME}" \
  --from-literal=webhook_secret="${RESEND_WEBHOOK_SECRET:-placeholder}" \
  --from-literal=unsubscribe_secret="${EMAIL_UNSUBSCRIBE_SECRET:-placeholder}"

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
SA_KEY_PATH="$HOME/.openclaw/secrets/$TARGET_FIREBASE_PROJECT-sa-key.json"
if [[ -f "$SA_KEY_PATH" ]]; then
  ksecret octogee-sa-key --from-file=key.json="$SA_KEY_PATH"
else
  warn "SA key not found at $SA_KEY_PATH — skipping octogee-sa-key (Workload Identity must be configured)"
fi

# ── Firebase / Cloud Functions secrets (must exist before firebase deploy) ───
# Firebase prompts interactively if these secrets don't exist in Secret Manager.
# Pre-create them with placeholder values; runtime services read the canonical
# K8s secrets directly where possible.
info "Pre-creating Firebase function secrets in Secret Manager (suppress deploy prompts)..."
SM_PROJECT_CF="$FIREBASE_PROJECT"  # Functions run in the Firebase project (octogee-test for test, octogee for prod)

function_secret_value() {
  case "$1" in
    SOCIAL_NOTIFICATION_BEARER_TOKEN) configured_secret_value "${SOCIAL_NOTIFICATION_BEARER:-}" ;;
    GITEA_TOKEN) configured_secret_value "${GIT_API_TOKEN:-}" ;;
    *)
      set +u
      local value="${!1:-}"
      set -u
      configured_secret_value "$value"
      ;;
  esac
}

sync_function_secret() {
  local secret="$1" configured="$2" current
  if gcloud secrets describe "$secret" --project="$SM_PROJECT_CF" >/dev/null 2>&1; then
    if [[ -z "$configured" ]]; then
      info "  $secret already exists in SM ($SM_PROJECT_CF)"
      return 0
    fi
    current="$(sm_get "$secret" "$SM_PROJECT_CF" 2>/dev/null || echo "")"
    if [[ "$current" == "$configured" ]]; then
      info "  $secret already configured in SM ($SM_PROJECT_CF)"
      return 0
    fi
    printf '%s' "$configured" | gcloud secrets versions add "$secret" \
      --data-file=- --project="$SM_PROJECT_CF" --quiet >/dev/null
    ok "  Updated SM secret: $secret"
    return 0
  fi

  [[ -n "$configured" ]] || configured="placeholder"
  printf '%s' "$configured" | gcloud secrets create "$secret" \
    --data-file=- \
    --project="$SM_PROJECT_CF" \
    --replication-policy=user-managed --locations="$TARGET_REGION" \
    --quiet >/dev/null
  ok "  Created SM secret: $secret"
}

# Full list of all defineSecret() references in Cloud Functions — must exist before firebase deploy
for sm_secret in \
  SOCIAL_NOTIFICATION_BEARER_TOKEN \
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
  function_value="$(function_secret_value "$sm_secret")"
  sync_function_secret "$sm_secret" "$function_value" || warn "  Could not sync $sm_secret"
done

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}Secret completeness summary${NC}"
status "mattermost-gateway / admin_user" "${MM_ADMIN_USER:-}"
status "mattermost-gateway / admin_pass" "${MM_ADMIN_PASS:-}"
status "mattermost-gateway / admin_pat" "${MM_ADMIN_PAT:-}"
status "mattermost-gateway / admin_user_id" "${MM_ADMIN_USER_ID:-}"
status "mattermost-gateway / team_id" "${MM_TEAM_ID:-}"
status "gateway-model-key-issuer" "${GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN:-}"
status "ops-agent-bearer" "${OPS_AGENT_BEARER_TOKEN:-}"
status "social-notification-bearer" "${SOCIAL_NOTIFICATION_BEARER:-}"
status "octogee-anthropic" "${ANTHROPIC_API_KEY:-}"
status "octogee-openrouter" "${OPENROUTER_API_KEY:-}"
status "openai-embeddings" "${OPENAI_API_KEY:-}"
status "resend-secrets / api_key" "${RESEND_API_KEY:-}"
status "resend-secrets / from_email" "${RESEND_FROM_EMAIL:-}"
status "github-oauth / client_id" "${GITHUB_CLIENT_ID:-}"
status "google-oauth / client_id" "${GOOGLE_CLIENT_ID:-}"
status "microsoft-oauth / client_id" "${MICROSOFT_CLIENT_ID:-}"
status "connect-state-secret" "${CONNECT_STATE_SECRET:-}"
status "stripe-secrets / secret_key" "${STRIPE_SECRET_KEY:-}"
status "stripe-secrets / webhook_secret" "${STRIPE_WEBHOOK_SECRET:-}"
status "stripe-secrets / price_ids" "${STRIPE_PRICE_IDS:-}"

echo ""
if [[ -z "${MM_ADMIN_PAT:-}" || -z "${MM_TEAM_ID:-}" || -z "${MM_ADMIN_USER_ID:-}" ]]; then
  warn "Mattermost-related secret state is incomplete"
  echo ""
  echo "  Next steps:"
  echo "    1. Run ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG"
  echo "    2. Re-run ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG $(if [[ "$YES" == "true" ]]; then echo "--yes"; fi) if you want a clean re-materialization"
  echo "    3. Do not trust customer provisioning until those values are present"
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
echo "  Canonical sequence (run teardown-env.sh --env=$ENV$TARGET_ARG to see all 9 steps)."
echo ""
echo "  Next (Phase 1 → Helm):"
    echo "    GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET --project=$SM_PROJECT)"
echo "    UMBRELLA_CHART_DIR=\$(mktemp -d)"
echo "    UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\")"
echo "    helm upgrade --install octogee \"\$UMBRELLA_CHART\" \\"
echo "      --server-side=true --force-conflicts \\"
echo "      -f helm/octogee/$VALUES_FILE \\"
echo "      -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) \\"
echo "      -n $K8S_NAMESPACE \\"
echo "      --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
echo "      --kube-context $K8S_CONTEXT \\"
echo "      --wait --timeout=10m"
echo ""
echo "  Phase 2 callers should run after setup-mattermost + setup-gitea, then"
echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE."
echo ""
