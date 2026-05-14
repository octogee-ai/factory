#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-cloud-sql.sh — Configure Cloud SQL instance after creation
#
# Assumes octogee-pg instance already exists (created async above).
# Run once after instance is RUNNABLE.
#
# Usage:
#   ./scripts/setup-cloud-sql.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT="octogee"
INSTANCE="octogee-pg"
REGION="us-central1"

# Right-sized for pre-customer workload: 1 vCPU (Cloud SQL Enterprise floor)
# + 1.75 GiB RAM (1792 MiB = 256 × 7; memory must be a multiple of 256 MiB
# in Cloud SQL custom tiers). Bump via gcloud `instances patch --tier=
# db-custom-N-MEMmb` when MM/Gitea actually need more — Postgres OOMs are
# loud, so this is a safer floor than the previous db-custom-1-3840 default.
DESIRED_TIER="db-custom-1-1792"
# PITR adds WAL archive storage cost (~few $/mo for MM activity). Pre-customer
# we don't need point-in-time restore — the 7 daily backups already cover
# the rollback envelope.
DESIRED_PITR="false"

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

# ── Enforce instance right-sizing (idempotent) ────────────────────────────────
log "Checking instance tier + PITR settings..."
CURRENT_TIER=$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" \
  --format="value(settings.tier)" 2>/dev/null || echo "")
CURRENT_PITR=$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" \
  --format="value(settings.backupConfiguration.pointInTimeRecoveryEnabled)" 2>/dev/null || echo "")
# gcloud renders the bool as "True"/"False" — normalize.
CURRENT_PITR_NORM=$(echo "$CURRENT_PITR" | tr '[:upper:]' '[:lower:]')

PATCH_FLAGS=()
if [[ "$CURRENT_TIER" != "$DESIRED_TIER" ]]; then
  log "Tier drift: $CURRENT_TIER → $DESIRED_TIER"
  PATCH_FLAGS+=("--tier=$DESIRED_TIER")
fi
if [[ "$CURRENT_PITR_NORM" != "$DESIRED_PITR" ]]; then
  log "PITR drift: $CURRENT_PITR_NORM → $DESIRED_PITR"
  if [[ "$DESIRED_PITR" == "false" ]]; then
    PATCH_FLAGS+=("--no-enable-point-in-time-recovery")
  else
    PATCH_FLAGS+=("--enable-point-in-time-recovery")
  fi
fi

if [[ ${#PATCH_FLAGS[@]} -gt 0 ]]; then
  warn "Patching instance settings — this may briefly restart Postgres."
  gcloud sql instances patch "$INSTANCE" --project="$PROJECT" "${PATCH_FLAGS[@]}" --quiet
  log "Waiting for instance to settle..."
  while [[ "$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" --format='value(state)')" != "RUNNABLE" ]]; do
    sleep 5
  done
  ok "Instance settings patched: tier=$DESIRED_TIER, PITR=$DESIRED_PITR"
else
  ok "Instance settings already match: tier=$DESIRED_TIER, PITR=$DESIRED_PITR"
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

# ── Create users ──────────────────────────────────────────────────────────────
log "Creating database users..."

# Generate random passwords
MM_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
GITEA_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)

for USER_DB in "mattermost:mattermost_prod" "gitea:gitea_prod"; do
  USER="${USER_DB%%:*}"
  DB="${USER_DB##*:}"
  PASS="${USER}_${USER}_pass"  # placeholder — overridden below
  [[ "$USER" == "mattermost" ]] && PASS="$MM_PASS"
  [[ "$USER" == "gitea" ]] && PASS="$GITEA_PASS"

  if gcloud sql users list --instance="$INSTANCE" --project="$PROJECT" | grep -q "^$USER "; then
    ok "User '$USER' already exists"
  else
    gcloud sql users create "$USER" \
      --instance="$INSTANCE" \
      --project="$PROJECT" \
      --password="$PASS"
    ok "Created user: $USER"
  fi
done

# ── Store credentials in Secret Manager ──────────────────────────────────────
log "Storing credentials in Secret Manager..."

store_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project="$PROJECT" &>/dev/null; then
    echo -n "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT"
    ok "Updated secret: $name"
  else
    echo -n "$value" | gcloud secrets create "$name" --data-file=- --project="$PROJECT" \
      --replication-policy=user-managed --locations="$REGION"
    ok "Created secret: $name"
  fi
}

# Cloud SQL instance connection name
CONN_NAME=$(gcloud sql instances describe "$INSTANCE" --project="$PROJECT" \
  --format="value(connectionName)")
store_secret "cloud-sql-connection-name" "$CONN_NAME"
store_secret "mattermost-db-password" "$MM_PASS"
store_secret "gitea-db-password" "$GITEA_PASS"

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
