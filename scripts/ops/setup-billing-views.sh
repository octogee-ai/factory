#!/usr/bin/env bash
# Idempotent creator for the Looker-facing billing views.
# Blocked only on the GCP billing export producing its first table (~hours after
# enablement). Safe to run repeatedly — CREATE OR REPLACE, no-ops until ready.
#
#   bash scripts/ops/setup-billing-views.sh
#
set -euo pipefail

PROJECT=octogee
DS=billing_export
ACCT=01395A_EFECBE_0900D8
DETAIL="${PROJECT}.${DS}.gcp_billing_export_resource_v1_${ACCT}"   # detailed (resource-level, has labels)
STD="${PROJECT}.${DS}.gcp_billing_export_v1_${ACCT}"              # standard (fallback for daily view)

net='ROUND(SUM(cost)+SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c),0)),2)'

# Once the views exist the cron has done its one job — remove its own crontab
# entry so it doesn't linger. Idempotent: only acts if the entry is present, so
# a manual run on a machine without the cron is a harmless no-op.
self_decron() {
  if crontab -l 2>/dev/null | grep -q setup-billing-views.sh; then
    crontab -l 2>/dev/null | grep -v setup-billing-views.sh | crontab -
    echo "  (removed self from crontab — one-time setup complete)"
  fi
}

create_daily() {
  local src="$1"
  bq query --project_id=octogee --use_legacy_sql=false "
    CREATE OR REPLACE VIEW \`${PROJECT}.${DS}.v_daily_cost_by_service\` AS
    SELECT DATE(usage_start_time) day, project.id project, service.description service,
           ${net} net_cost
    FROM \`${src}\` GROUP BY 1,2,3;"
  echo "  ✓ v_daily_cost_by_service  (src: ${src})"
}

create_gke_by_ns() {
  # namespace label key varies by GKE version — match any of the known cost-allocation keys
  bq query --project_id=octogee --use_legacy_sql=false "
    CREATE OR REPLACE VIEW \`${PROJECT}.${DS}.v_gke_cost_by_namespace\` AS
    SELECT DATE(usage_start_time) day,
           (SELECT value FROM UNNEST(labels) WHERE key='goog-k8s-cluster-name') cluster,
           (SELECT value FROM UNNEST(labels)
              WHERE key IN ('goog-k8s-namespace','k8s-namespace','goog-gke-namespace')) namespace,
           sku.description sku,
           ${net} net_cost
    FROM \`${DETAIL}\`
    WHERE service.description='Kubernetes Engine'
    GROUP BY 1,2,3,4;"
  echo "  ✓ v_gke_cost_by_namespace  (src: ${DETAIL})"
}

if bq show "$DETAIL" >/dev/null 2>&1; then
  echo "detailed export present → creating views"
  create_daily "$DETAIL"
  create_gke_by_ns
  echo "done. Point Looker Studio at project=${PROJECT} dataset=${DS} → these views."
  self_decron
elif bq show "$STD" >/dev/null 2>&1; then
  echo "only STANDARD export present → creating daily view; enable the DETAILED (resource-level) export for GKE-by-namespace."
  create_daily "$STD"
else
  echo "billing export not landed yet (no ${DETAIL} or ${STD}). No-op — rerun after the first export."
fi
