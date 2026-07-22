#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-cloud-sql.sh — Configure Cloud SQL instance after creation
#
# Assumes the selected target's Cloud SQL instance already exists.
# Run once after instance is RUNNABLE.
#
# Usage:
#   ./scripts/setup-cloud-sql.sh --env=prod
#   ./scripts/setup-cloud-sql.sh --target=prod-west
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"

SELECTOR=""
for arg in "$@"; do
  case "$arg" in
    --env=*)
      [[ -n "$SELECTOR" ]] && { echo "Exactly one --env or --target is required" >&2; exit 1; }
      SELECTOR="--environment=${arg#*=}"
      ;;
    --target=*)
      [[ -n "$SELECTOR" ]] && { echo "Exactly one --env or --target is required" >&2; exit 1; }
      SELECTOR="$arg"
      ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test|build-week | --target=TARGET_ID"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done
[[ -z "$SELECTOR" ]] && { echo "Exactly one --env or --target is required" >&2; exit 1; }
octogee_load_deployment_target "$SELECTOR"
PROJECT="$TARGET_CLOUD_SQL_PROJECT"
INSTANCE="$TARGET_CLOUD_SQL_INSTANCE"
REGION="$TARGET_CLOUD_SQL_REGION"
DESIRED_PITR="$TARGET_CLOUD_SQL_PITR_ENABLED"
[[ "$DESIRED_PITR" == "true" || "$DESIRED_PITR" == "false" ]] || {
  echo "Invalid Cloud SQL PITR setting for deployment target $TARGET_ID: $DESIRED_PITR" >&2
  exit 1
}

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${BLUE}[cloud-sql]${NC} $*"; }
ok()   { echo -e "${GREEN}[cloud-sql]${NC} ✅ $*"; }
warn() { echo -e "${YELLOW}[cloud-sql]${NC} ⚠️  $*"; }

# ── Wait for instance to be ready ────────────────────────────────────────────
log "Waiting for $INSTANCE to be RUNNABLE..."
while true; do
  STATE=$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" \
    --format="value(state)" 2>/dev/null || echo "PENDING")
  if [[ "$STATE" == "RUNNABLE" ]]; then
    ok "Instance is RUNNABLE"
    break
  fi
  echo "  State: $STATE — waiting 15s..."
  sleep 15
done

# ── Enforce PITR policy (idempotent) ─────────────────────────────────────────
log "Checking PITR setting..."
CURRENT_PITR=$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" \
  --format="value(settings.backupConfiguration.pointInTimeRecoveryEnabled)" 2>/dev/null || echo "")
# gcloud renders the bool as "True"/"False" — normalize.
CURRENT_PITR_NORM=$(echo "$CURRENT_PITR" | tr '[:upper:]' '[:lower:]')

if [[ "$CURRENT_PITR_NORM" == "$DESIRED_PITR" ]]; then
  ok "PITR already matches: $DESIRED_PITR"
else
  log "PITR drift: $CURRENT_PITR_NORM → $DESIRED_PITR"
  warn "Patching PITR — may briefly restart Postgres."
  if [[ "$DESIRED_PITR" == "false" ]]; then
    gcloud sql instances patch "$INSTANCE" --project="$PROJECT" --no-enable-point-in-time-recovery --quiet
  else
    gcloud sql instances patch "$INSTANCE" --project="$PROJECT" --enable-point-in-time-recovery --quiet
  fi
  log "Waiting for instance to settle..."
  while [[ "$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" --format='value(state)')" != "RUNNABLE" ]]; do
    sleep 5
  done
  ok "PITR set to $DESIRED_PITR"
fi

# ── Create databases ──────────────────────────────────────────────────────────
log "Creating databases..."

for DB in mattermost_prod mattermost_test gitea_prod gitea_test; do
  if gcloud sql databases describe "$DB" --instance="$INSTANCE" --project="$PROJECT" &>/dev/null; then
    ok "Database '$DB' already exists"
  else
    gcloud sql databases create "$DB" --instance="$INSTANCE" --project="$PROJECT"
    ok "Created database: $DB"
  fi
done

# ── Create users + store credentials (idempotent) ────────────────────────────
# Critical invariant: the DB user's password MUST equal the Secret Manager
# secret's latest version, since MM and Gitea pods mount the SM value to
# authenticate.
#
# First-time path: generate a random password, create the DB user with it,
# write the SAME value to Secret Manager. Atomic per user.
#
# Re-run path: do nothing. The DB user already has whatever password
# matches the existing SM value (assuming a prior first-time run did its
# job). Generating a fresh password and re-writing only SM — what an
# earlier version of this script did — leaves DB and SM diverged and
# kills MM/Gitea on the next pod restart.
log "Ensuring database users + Secret Manager passwords..."

# Service accounts that need to read the DB-password secrets at runtime
# or during the canonical install sequence. Each gets `secretAccessor` on
# every secret store_secret creates — bindings are idempotent (add same
# member+role twice = single binding), so re-running setup-cloud-sql.sh
# is safe.
#
# Why this matters: a fresh `gcloud secrets create` starts with NO IAM
# bindings. The previous-life secrets had bindings accumulated over time;
# deleting + recreating during the 2026-05-14 right-sizing pass dropped
# them, and the Release workflow's deploy step (gha SA reads MM_DB_PASSWORD
# + gitea-db-password) auth-failed until the bindings were restored.
SECRET_ACCESSOR_SAS=(
  "github-actions@octogee.iam.gserviceaccount.com"
)

grant_secret_accessor() {
  local name="$1"
  for sa in "${SECRET_ACCESSOR_SAS[@]}"; do
    gcloud secrets add-iam-policy-binding "$name" \
      --member="serviceAccount:$sa" \
      --role="roles/secretmanager.secretAccessor" \
      --project="$PROJECT" \
      --quiet >/dev/null 2>&1 \
      && ok "Granted secretAccessor on $name to $sa" \
      || warn "Could not grant secretAccessor on $name to $sa — may need manual setup"
  done
}

store_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project="$PROJECT" &>/dev/null; then
    echo -n "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT" >/dev/null
    ok "Updated secret: $name"
  else
    echo -n "$value" | gcloud secrets create "$name" --data-file=- --project="$PROJECT" \
      --replication-policy=user-managed --locations="$REGION"
    ok "Created secret: $name"
  fi
  grant_secret_accessor "$name"
}

# Secret name per user. The rest of the codebase has historical drift:
# MM uses uppercase-underscore (MM_DB_PASSWORD) in setup-secrets.sh, the
# helm chart env var, setup-mattermost.sh, and the RUNBOOK; gitea uses
# lowercase-hyphen (gitea-db-password) consistently. Match what's already
# load-bearing — drift here means setup-secrets.sh wires the wrong value
# into the K8s `mattermost-cloud-sql` secret and MM auth-fails on boot.
#
# Implementation: `case` rather than `declare -A` so the script works
# under bash 3.2 (the system shell on macOS).
secret_name_for() {
  case "$1" in
    mattermost) echo "MM_DB_PASSWORD" ;;
    gitea)      echo "gitea-db-password" ;;
    *)          echo ""; return 1 ;;
  esac
}

# Two paths per user:
#   - Fresh env (no SM secret + no SQL user): generate random password,
#     create the SQL user, write to SM. Both sides aligned by construction.
#   - Re-run (user exists OR SM secret exists): regenerate password so a
#     stale half-pair (one side missing) doesn't leave the env wedged.
#     `set-password` works whether or not the user existed previously;
#     `store_secret` adds a version to the SM entry or creates it.
for USER in mattermost gitea; do
  SECRET_NAME=$(secret_name_for "$USER")
  USER_EXISTS=false
  SECRET_EXISTS=false
  if gcloud sql users list --instance="$INSTANCE" --project="$PROJECT" 2>/dev/null \
      | awk 'NR>1 {print $1}' | grep -qx "$USER"; then
    USER_EXISTS=true
  fi
  if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT" &>/dev/null; then
    SECRET_EXISTS=true
  fi
  if $USER_EXISTS && $SECRET_EXISTS; then
    ok "User '$USER' + secret '$SECRET_NAME' both present — preserving (no rotation)"
    continue
  fi

  PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
  if $USER_EXISTS; then
    log "User '$USER' exists but secret '$SECRET_NAME' missing — rotating password to realign"
    gcloud sql users set-password "$USER" \
      --instance="$INSTANCE" --project="$PROJECT" --password="$PASS"
    ok "Rotated password for user: $USER"
  else
    log "Creating SQL user '$USER'..."
    gcloud sql users create "$USER" \
      --instance="$INSTANCE" --project="$PROJECT" --password="$PASS"
    ok "Created user: $USER"
  fi
  store_secret "$SECRET_NAME" "$PASS"
done

# Connection name is derived from the instance; safe to refresh on every run.
log "Storing Cloud SQL connection name in Secret Manager..."
CONN_NAME=$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" \
  --format="value(connectionName)")
store_secret "cloud-sql-connection-name" "$CONN_NAME"

# ── Grant Cloud SQL Client role to GKE Workload Identity SA ──────────────────
log "Granting Cloud SQL Client role to Workload Identity service accounts..."

# Get the GKE project SA (Workload Identity for octogee namespace)
for SA in "octogee@octogee.iam.gserviceaccount.com"; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA" \
    --role="roles/cloudsql.client" \
    --quiet 2>/dev/null || warn "Could not grant cloudsql.client to $SA — may need manual setup"
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Cloud SQL setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  Instance:    $INSTANCE ($REGION)"
echo "  Connection:  $CONN_NAME"
echo "  Databases:   mattermost_prod, mattermost_test, gitea_prod, gitea_test"
echo ""
echo "  Next steps:"
echo "  1. Migrate Mattermost: ./scripts/migrate-mm-to-cloud-sql.sh"
echo "  2. Deploy Gitea: ./scripts/setup-gitea.sh"
echo "  3. Update MM deployment to use Cloud SQL Auth Proxy"
echo ""
warn "Credentials stored in Secret Manager — never committed to git"
echo ""
