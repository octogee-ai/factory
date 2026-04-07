#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Bootstrap — Single entry point
# ═══════════════════════════════════════════════════════════════════════════
#
# Runs setup-mattermost.sh and setup-secrets.sh in the correct order,
# then validates the result with verify-secrets.sh.
#
# This is the script to run when:
#   - Setting up a fresh environment
#   - Repairing secret drift after an incident
#   - Before the first `helm upgrade` on a new cluster
#
# Usage:
#   ./scripts/bootstrap-env.sh --env=test [--yes]
#   ./scripts/bootstrap-env.sh --env=prod
#
# What it does (in order):
#   1. setup-mattermost.sh  → admin PAT, bot token, team, K8s secret
#   2. setup-secrets.sh     → remaining K8s secrets (gitea, stripe, etc.)
#   3. verify-secrets.sh    → validates all required secrets + keys
#
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

ENV=""
EXTRA_ARGS=()

for arg in "$@"; do
  case $arg in
    --env=*)  ENV="${arg#*=}" ;;
    --yes|-y) EXTRA_ARGS+=("--yes") ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test [--yes]"
      echo ""
      echo "Runs setup-mattermost.sh, setup-secrets.sh, and verify-secrets.sh in order."
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test [--yes]"; exit 1; }

case "$ENV" in
  prod) NS="octogee" ;;
  test) NS="octogee-test" ;;
  *) echo "Unknown env: $ENV"; exit 1 ;;
esac

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Octogee Environment Bootstrap — ${ENV}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Ensure namespace exists (teardown deletes it)
kubectl create namespace "$NS" 2>/dev/null || true

# ── Step 0: Gitea SSH key ───────────────────────────────────────────────
echo -e "${BOLD}[0/3] Gitea SSH key${NC}"
echo ""

if kubectl get secret gitea-ssh-key -n "$NS" >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} gitea-ssh-key secret exists"
else
  echo "  Generating SSH keypair for Gitea..."
  TMPKEY=$(mktemp)
  ssh-keygen -t ed25519 -f "$TMPKEY" -N "" -C "octogee-gateway@octogee.local" -q
  kubectl create secret generic gitea-ssh-key -n "$NS" \
    --from-file=id_ed25519="$TMPKEY" \
    --from-file=id_ed25519.pub="${TMPKEY}.pub"
  echo -e "  ${GREEN}✓${NC} gitea-ssh-key secret created"

  # Register public key in Gitea (requires port-forward or in-cluster access)
  GITEA_TOKEN=$(kubectl get secret gitea-token -n "$NS" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d)
  if [ -n "$GITEA_TOKEN" ]; then
    PUB_KEY=$(cat "${TMPKEY}.pub")
    # Try in-cluster Gitea URL first
    GITEA_URL="http://octogee-gitea-http.${NS}.svc.cluster.local:3000"
    RESP=$(kubectl exec deployment/octogee-gitea -n "$NS" -- \
      curl -s -o /dev/null -w "%{http_code}" "${GITEA_URL}/api/v1/user" \
      -H "Authorization: token $GITEA_TOKEN" 2>/dev/null || echo "000")
    if [ "$RESP" = "200" ]; then
      kubectl exec deployment/octogee-gitea -n "$NS" -- \
        curl -s -X POST "${GITEA_URL}/api/v1/user/keys" \
        -H "Authorization: token $GITEA_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"title\": \"octogee-gateway\", \"key\": \"$PUB_KEY\"}" >/dev/null 2>&1
      echo -e "  ${GREEN}✓${NC} SSH public key registered in Gitea"
    else
      echo -e "  ⚠ Could not reach Gitea API — register the SSH key manually"
      echo "    Public key: $PUB_KEY"
    fi
  fi
  rm -f "$TMPKEY" "${TMPKEY}.pub"
fi
echo ""

# ── Step 1: Mattermost bootstrap ────────────────────────────────────────
echo -e "${BOLD}[1/3] Mattermost bootstrap${NC}"
echo ""
"$SCRIPT_DIR/setup-mattermost.sh" --env="$ENV" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
echo ""

# ── Step 2: Remaining secrets ───────────────────────────────────────────
echo -e "${BOLD}[2/3] Remaining K8s secrets${NC}"
echo ""
"$SCRIPT_DIR/setup-secrets.sh" --env="$ENV" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
echo ""

# ── Step 3: Verify everything ──────────────────────────────────────────
echo -e "${BOLD}[3/3] Verification${NC}"
echo ""
if "$SCRIPT_DIR/verify-secrets.sh" --env="$ENV"; then
  echo ""
  echo -e "${GREEN}${BOLD}Bootstrap complete — environment is ready for helm upgrade.${NC}"
  echo ""
  echo "  Next steps:"
  echo "    helm upgrade --install octogee helm/octogee \\"
  echo "      -f helm/octogee/values.${ENV}.yaml \\"
  echo "      -n <namespace> --create-namespace"
  echo ""
  echo "  After deploy:"
  echo "    helm test octogee -n <namespace>"
  echo ""
else
  echo ""
  echo -e "${RED}${BOLD}Bootstrap incomplete — see errors above.${NC}"
  echo ""
  echo "  Some secrets failed verification. Fix the issues above and re-run:"
  echo "    ./scripts/bootstrap-env.sh --env=${ENV}"
  echo ""
  exit 1
fi
