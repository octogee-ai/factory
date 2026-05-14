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

# PITR adds WAL archive storage cost (~few $/mo for MM activity). Pre-customer
# we don't need point-in-time restore — the 7 daily backups already cover the
# rollback envelope. Sized in 2026-05-14 right-sizing pass.
#
# Tier-drift detection was considered but dropped: Cloud SQL Postgres has a
# 3840 MiB minimum per vCPU, and shared-core tiers are deprecated for new
# Postgres instances. The current db-custom-1-3840 IS the floor for 1 vCPU,
# so there's no smaller-tier knob to enforce. Re-introduce a tier check if
# we ever scale vCPUs up and want a guard against accidental over-provision.
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

# ── Enforce PITR off (idempotent) ────────────────────────────────────────────
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
