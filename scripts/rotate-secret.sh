#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Secret Rotation
# ═══════════════════════════════════════════════════════════════════════════
#
# Isolated, on-demand secret rotation. NOT part of teardown/rebuild.
#
# Rotating a secret = updating the source of truth (Secret Manager or the
# upstream service), re-materializing the K8s secret cache, and restarting
# the consumers so they pick up the new value. This script wraps that flow
# for the secrets that rotate most often.
#
# For the full secret inventory and rarer rotations, see RUNBOOK.md →
# "Credential Rotation (Full Playbook)".
#
# SCOPE: --env=test and --env=prod ONLY. Custom namespaces created with
# scripts/provision-namespace.sh are explicitly DISPOSABLE and
# NON-ROTATABLE. To "rotate" a custom namespace, re-provision it:
#     ./scripts/provision-namespace.sh <namespace> --yes
# That destroys the namespace, re-creates Cloud SQL DBs, and re-runs the
# full bootstrap, which materializes fresh secrets in the process.
# If a custom namespace is so long-lived that it needs in-place secret
# rotation, it should be promoted to a real env (test or prod).
#
# Usage:
#   ./scripts/rotate-secret.sh --env=test anthropic
#   ./scripts/rotate-secret.sh --env=test internal-service-key
#   ./scripts/rotate-secret.sh --env=test mm-admin-pat
#   ./scripts/rotate-secret.sh --env=test gitea-pat
#   ./scripts/rotate-secret.sh --env=test discord-ops-webhook
#   ./scripts/rotate-secret.sh --env=test list
#
# Rotatable secrets:
#   anthropic             — ANTHROPIC_API_KEY (reads from stdin or ANTHROPIC_API_KEY env)
#   internal-service-key  — generates a new random 40-char key, persists to SM
#   model-key-issuer      — generates a new issuer bearer token, persists to SM
#   mm-admin-pat          — revokes + remints via setup-mattermost.sh
#   gitea-pat             — revokes + remints via setup-gitea.sh
#   discord-ops-webhook   — DISCORD_OPS_WEBHOOK_URL (reads from stdin or env)
#
# Prod rotations always prompt for confirmation. Test supports --yes.
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ENV=""
YES=false
SECRET=""

for arg in "$@"; do
  case $arg in
    --env=*)   ENV="${arg#*=}" ;;
    --yes|-y)  YES=true ;;
    --help|-h)
      sed -n '4,32p' "$0"
      exit 0
      ;;
    -*)        echo "Unknown flag: $arg"; exit 1 ;;
    *)         SECRET="$arg" ;;
  esac
done

[[ -z "$ENV" || -z "$SECRET" ]] && {
  echo "Usage: $0 --env=prod|test [--yes] <secret-name>"
  echo "       $0 --env=prod|test list"
  exit 1
}

case "$ENV" in
  prod)
    K8S_NAMESPACE="octogee"
    FIREBASE_PROJECT="octogee"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ENV_LABEL="🔴 PRODUCTION"
    ;;
  test)
    K8S_NAMESPACE="octogee-test"
    FIREBASE_PROJECT="octogee-test"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ENV_LABEL="🟡 TEST"
    ;;
  custom)
    cat <<'EOF' >&2

  ⛔ Custom namespaces are non-rotatable by design.

  Custom namespaces (provisioned by scripts/provision-namespace.sh) are
  scratch/feature/dev environments. They are intentionally disposable and
  do not support in-place secret rotation.

  To "rotate" a custom namespace's secrets, re-provision it:

      ./scripts/provision-namespace.sh <namespace> --yes

  That destroys the namespace, drops + recreates the Cloud SQL DBs, and
  re-runs the full bootstrap. Fresh secrets fall out of that process.

  If a custom namespace is so long-lived that it actually needs in-place
  rotation, promote it to a real env (test or prod) — that's the signal
  that "scratch" no longer fits.

EOF
    exit 1
    ;;
  *) echo "Unknown environment: $ENV (use prod or test)"; exit 1 ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }

confirm() {
  $YES && return 0
  echo -ne "  ${YELLOW}$1 [y/N]:${NC} "
  read -r yn
  [[ "$yn" =~ ^[Yy]$ ]]
}

[[ "$ENV" == "prod" && "$YES" == "true" ]] && fail "--yes cannot be used with prod."

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Secret Rotation — ${ENV_LABEL} — ${SECRET}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── kubectl context ────────────────────────────────────────────────────────
gcloud container clusters get-credentials "$CLUSTER_NAME" --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$K8S_CONTEXT" ]] || fail "Wrong kubectl context"
ok "kubectl context: $K8S_CONTEXT"
echo ""

rollout_restart() {
  local deploys=("$@")
  for d in "${deploys[@]}"; do
    kubectl rollout restart "deployment/$d" -n "$K8S_NAMESPACE" 2>/dev/null && ok "Restarted: $d" || warn "Could not restart: $d"
  done
  for d in "${deploys[@]}"; do
    kubectl rollout status "deployment/$d" -n "$K8S_NAMESPACE" --timeout=180s 2>/dev/null || warn "Rollout did not complete: $d"
  done
}

case "$SECRET" in

  list)
    echo "  Rotatable via this script (test + prod only):"
    echo "    anthropic             — ANTHROPIC_API_KEY, standard/cattle BYOK/BYOS fallback (octogee-anthropic; standard gateways only, never operator)"
    echo "    internal-service-key  — INTERNAL_SERVICE_KEY, consumers: octogee-api, cron jobs, social functions"
    echo "    model-key-issuer      — GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN, consumers: octogee-api, glm-controller"
    echo "    social-notification-bearer — SOCIAL_NOTIFICATION_BEARER_TOKEN, consumers: octogee-api /social, social functions"
    echo "    mm-admin-pat          — MM admin PAT + bot token, consumers: octogee-api, glm-controller"
    echo "    gitea-pat             — Gitea API token, consumers: octogee-api, glm-controller"
    echo "    discord-ops-webhook   — DISCORD_OPS_WEBHOOK_URL, consumer: octogee-gateway"
    echo ""
    echo "  For rarer rotations (Gitea SSH host key, Firebase SA key, DB passwords,"
    echo "  Stripe webhook secret, etc.) see RUNBOOK.md → 'Credential Rotation (Full Playbook)'."
    echo ""
    echo "  Custom namespaces are non-rotatable by design — re-provision instead:"
    echo "    ./scripts/provision-namespace.sh <namespace> --yes"
    exit 0
    ;;

  # ── Anthropic API key ───────────────────────────────────────────────────
  anthropic)
    NEW_VALUE="${ANTHROPIC_API_KEY:-}"
    if [[ -z "$NEW_VALUE" ]]; then
      if [[ -t 0 ]]; then
        echo -n "  Paste new ANTHROPIC_API_KEY (input hidden): "
        read -rs NEW_VALUE
        echo ""
      else
        NEW_VALUE=$(cat)
      fi
    fi
    [[ -z "$NEW_VALUE" ]] && fail "No value provided"
    [[ "$NEW_VALUE" =~ ^sk-ant-(api03|oat01)- ]] || warn "Key does not start with sk-ant-api03-/oat01- — proceeding anyway"

    confirm "Rotate ANTHROPIC_API_KEY in $FIREBASE_PROJECT and restart the standard gateway?" || { info "Cancelled"; exit 0; }

    info "Writing new version to Secret Manager ($FIREBASE_PROJECT)..."
    echo -n "$NEW_VALUE" | gcloud secrets versions add ANTHROPIC_API_KEY \
      --data-file=- --project="$FIREBASE_PROJECT" 2>/dev/null || \
    echo -n "$NEW_VALUE" | gcloud secrets create ANTHROPIC_API_KEY \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
      fail "Could not write to Secret Manager"
    ok "Secret Manager updated"

    info "Updating K8s secret octogee-anthropic..."
    kubectl create secret generic octogee-anthropic -n "$K8S_NAMESPACE" \
      --from-literal=api_key="$NEW_VALUE" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    ok "K8s secret octogee-anthropic updated"

    # Shared gateways mount octogee-anthropic directly. Builder/operator
    # gateways hold broker tokens; llm-broker is the provider-key holder.
    info "Restarting llm-broker and shared gateways (classifier reload ~90s)..."
    rollout_restart llm-broker
    SHARED_GWS=$(kubectl get deploy -n "$K8S_NAMESPACE" \
      -l 'app=octogee-gateway,gateway-class=shared' \
      -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}' 2>/dev/null)
    [[ -n "$SHARED_GWS" ]] && rollout_restart $SHARED_GWS || warn "No shared gateways found to restart"

    info "Verifying gateway startup..."
    kubectl logs -n "$K8S_NAMESPACE" -l 'app=octogee-gateway,gateway-class=shared' \
      --tail=15 --max-log-requests=20 2>/dev/null | grep -iE 'anthropic|auth|error' || true
    ok "Rotation complete"
    ;;

  # ── Internal service key ────────────────────────────────────────────────
  internal-service-key)
    confirm "Rotate INTERNAL_SERVICE_KEY in $FIREBASE_PROJECT (octogee-api + cron jobs must use the new value)?" || { info "Cancelled"; exit 0; }

    NEW_VALUE=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 40)

    info "Writing new version to Secret Manager ($FIREBASE_PROJECT)..."
    echo -n "$NEW_VALUE" | gcloud secrets versions add INTERNAL_SERVICE_KEY \
      --data-file=- --project="$FIREBASE_PROJECT" 2>/dev/null || \
    echo -n "$NEW_VALUE" | gcloud secrets create INTERNAL_SERVICE_KEY \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
      fail "Could not write to Secret Manager"
    ok "Secret Manager updated"

    info "Updating K8s secret internal-service-key..."
    kubectl create secret generic internal-service-key -n "$K8S_NAMESPACE" \
      --from-literal=key="$NEW_VALUE" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    ok "K8s secret internal-service-key updated"

    info "Restarting octogee-api so its env picks up the new internal-service-key Secret..."
    rollout_restart octogee-api

    info "Cron jobs read the secret on each invocation — no restart needed."
    info "Social Cloud Functions read the Secret Manager value; redeploy functions only if warm instances keep using an old version."
    ok "Rotation complete"
    ;;

  # ── Gateway model-key issuer bearer ─────────────────────────────────────
  model-key-issuer)
    confirm "Rotate GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN in $FIREBASE_PROJECT (octogee-api + glm-controller must restart)?" || { info "Cancelled"; exit 0; }

    NEW_VALUE=$(openssl rand -hex 32)

    info "Writing new version to Secret Manager ($FIREBASE_PROJECT)..."
    echo -n "$NEW_VALUE" | gcloud secrets versions add GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN \
      --data-file=- --project="$FIREBASE_PROJECT" 2>/dev/null || \
    echo -n "$NEW_VALUE" | gcloud secrets create GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
      fail "Could not write to Secret Manager"
    ok "Secret Manager updated"

    info "Updating K8s secret gateway-model-key-issuer..."
    kubectl create secret generic gateway-model-key-issuer -n "$K8S_NAMESPACE" \
      --from-literal=bearer_token="$NEW_VALUE" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    ok "K8s secret gateway-model-key-issuer updated"

    info "Restarting octogee-api and glm-controller so both sides pick up the new token..."
    rollout_restart octogee-api glm-controller
    ok "Rotation complete"
    ;;

  # ── Social notification bearer ──────────────────────────────────────────
  social-notification-bearer)
    confirm "Rotate the social notification bearer in $FIREBASE_PROJECT (octogee-api /social + social functions must use the new value)?" || { info "Cancelled"; exit 0; }

    NEW_VALUE=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 40)

    info "Writing new version to Secret Manager ($FIREBASE_PROJECT)..."
    echo -n "$NEW_VALUE" | gcloud secrets versions add SOCIAL_NOTIFICATION_BEARER_TOKEN \
      --data-file=- --project="$FIREBASE_PROJECT" 2>/dev/null || \
    echo -n "$NEW_VALUE" | gcloud secrets create SOCIAL_NOTIFICATION_BEARER_TOKEN \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
      fail "Could not write to Secret Manager"
    ok "Secret Manager updated"

    info "Updating K8s secret social-notification-bearer..."
    kubectl create secret generic social-notification-bearer -n "$K8S_NAMESPACE" \
      --from-literal=bearer-token="$NEW_VALUE" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    ok "K8s secret social-notification-bearer updated"

    info "Restarting octogee-api so its env picks up the new social-notification-bearer Secret..."
    rollout_restart octogee-api

    info "Social Cloud Functions read the Secret Manager value; redeploy functions only if warm instances keep using an old version."
    ok "Rotation complete"
    ;;

  # ── MM admin PAT + bot token ────────────────────────────────────────────
  mm-admin-pat)
    confirm "Rotate MM admin PAT and bot token (octogee-api and glm-controller must restart)?" || { info "Cancelled"; exit 0; }

    info "Clearing cached tokens from mattermost-gateway secret to force rotation..."
    # We overwrite admin_token and bot_token with empty strings, then run
    # setup-mattermost.sh which will detect the empty cache and mint new ones.
    EXISTING=$(kubectl get secret mattermost-gateway -n "$K8S_NAMESPACE" -o json 2>/dev/null)
    if [[ -n "$EXISTING" ]]; then
      echo "$EXISTING" | python3 -c "
import sys, json, base64
d = json.load(sys.stdin)
data = d.get('data', {})
data['admin_token'] = base64.b64encode(b'').decode()
data['bot_token'] = base64.b64encode(b'').decode()
d['data'] = data
print(json.dumps(d))
" | kubectl apply -f - >/dev/null
      ok "Cached tokens cleared"
    else
      warn "mattermost-gateway secret not found; setup-mattermost will do a full bootstrap"
    fi

    info "Running setup-mattermost.sh..."
    local_yes=""
    $YES && local_yes="--yes"
    "$SCRIPT_DIR/setup-mattermost.sh" --env="$ENV" $local_yes

    info "Restarting consumers..."
    rollout_restart octogee-api glm-controller
    ok "Rotation complete"
    ;;

  # ── Gitea API token ─────────────────────────────────────────────────────
  gitea-pat)
    confirm "Rotate Gitea API token (octogee-api and glm-controller must restart)?" || { info "Cancelled"; exit 0; }

    info "Clearing cached token from gitea-token secret to force rotation..."
    kubectl create secret generic gitea-token -n "$K8S_NAMESPACE" \
      --from-literal=token="" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    ok "Cached token cleared"

    info "Running setup-gitea.sh..."
    local_yes=""
    $YES && local_yes="--yes"
    "$SCRIPT_DIR/setup-gitea.sh" --env="$ENV" $local_yes

    info "Restarting consumers..."
    rollout_restart octogee-api glm-controller
    ok "Rotation complete"
    ;;

  # ── Discord ops webhook ─────────────────────────────────────────────────
  discord-ops-webhook)
    NEW_VALUE="${DISCORD_OPS_WEBHOOK_URL:-}"
    if [[ -z "$NEW_VALUE" ]]; then
      if [[ -t 0 ]]; then
        echo -n "  Paste new DISCORD_OPS_WEBHOOK_URL (input hidden): "
        read -rs NEW_VALUE
        echo ""
      else
        NEW_VALUE=$(cat)
      fi
    fi
    [[ -z "$NEW_VALUE" ]] && fail "No value provided"
    [[ "$NEW_VALUE" =~ ^https://discord\.com/api/webhooks/ ]] || warn "URL does not match Discord webhook format — proceeding anyway"

    confirm "Rotate DISCORD_OPS_WEBHOOK_URL in $FIREBASE_PROJECT and restart gateway?" || { info "Cancelled"; exit 0; }

    info "Writing new version to Secret Manager ($FIREBASE_PROJECT)..."
    echo -n "$NEW_VALUE" | gcloud secrets versions add DISCORD_OPS_WEBHOOK_URL \
      --data-file=- --project="$FIREBASE_PROJECT" 2>/dev/null || \
    echo -n "$NEW_VALUE" | gcloud secrets create DISCORD_OPS_WEBHOOK_URL \
      --data-file=- --project="$FIREBASE_PROJECT" \
      --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
      fail "Could not write to Secret Manager"
    ok "Secret Manager updated"

    info "Updating K8s secret discord-ops-webhook..."
    kubectl create secret generic discord-ops-webhook -n "$K8S_NAMESPACE" \
      --from-literal=url="$NEW_VALUE" \
      --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    ok "K8s secret discord-ops-webhook updated"

    info "Restarting gateway to pick up new webhook URL..."
    rollout_restart octogee-gateway
    ok "Rotation complete — verify by checking Discord for the next ops event"
    ;;

  *)
    echo "  Unknown secret: $SECRET"
    echo "  Run '$0 --env=$ENV list' to see rotatable secrets."
    echo "  For rarer rotations see RUNBOOK.md → 'Credential Rotation (Full Playbook)'."
    exit 1
    ;;
esac

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Rotation complete — ${ENV_LABEL}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
