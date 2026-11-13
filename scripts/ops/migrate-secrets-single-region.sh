#!/usr/bin/env bash
# Migrate Secret Manager secrets from automatic (all-region) replication to
# the selected target's single region. Replication is immutable, so each secret is
# recreated IN PLACE (same name): read value (+ per-secret IAM) -> delete ->
# recreate single-region -> re-add value -> restore IAM -> verify the value.
# Idempotent — skips secrets that are already single-region.
#
# DRY-RUN by default. Pass --apply to actually mutate.
#
# Skips terraform-managed secrets (mattermost-db-password, gitea-db-password,
# cloud-sql-connection-name): those migrate via `terraform apply` after the
# terraform/modules/secrets replication change, so this script never desyncs
# Terraform state.
#
# Why: automatic replication stores every version in ~26 regions at
# a per-version, per-region price. Each platform target is single-region, so this
# buys no real availability (region down => cluster down) and costs ~25x.
# See DECISIONS.md. bash 3.2 compatible (macOS default).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/../lib/deployment-target.sh"

SELECTOR=""
APPLY=false
for arg in "$@"; do
  case "$arg" in
    --env=*) SELECTOR="--environment=${arg#*=}" ;;
    --target=*) SELECTOR="$arg" ;;
    --apply) APPLY=true ;;
    *) echo "Usage: $0 (--env=prod|test | --target=TARGET_ID) [--apply]" >&2; exit 1 ;;
  esac
done
[[ -n "$SELECTOR" ]] || { echo "Usage: $0 (--env=prod|test | --target=TARGET_ID) [--apply]" >&2; exit 1; }
octogee_load_deployment_target "$SELECTOR"
PROJECT="$TARGET_FIREBASE_PROJECT"
REGION="$TARGET_REGION"

TF_MANAGED="mattermost-db-password gitea-db-password cloud-sql-connection-name"
is_tf_managed() { case " $TF_MANAGED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

repl_kind() {
  gcloud secrets describe "$1" --project="$PROJECT" --format=json 2>/dev/null \
    | python3 -c 'import json,sys
try: print("automatic" if "automatic" in json.load(sys.stdin).get("replication",{}) else "single")
except Exception: print("error")'
}

echo "== Secret Manager single-region migration =="
echo "project=$PROJECT  region=$REGION  apply=$APPLY"
echo

migrated=0; skipped=0; failed=0
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  kind=$(repl_kind "$name")
  if [[ "$kind" == "single" ]]; then echo "  skip (already single-region): $name"; skipped=$((skipped+1)); continue; fi
  if [[ "$kind" == "error"  ]]; then echo "  WARN (cannot read replication; skipping): $name"; skipped=$((skipped+1)); continue; fi
  if is_tf_managed "$name";   then echo "  skip (terraform-managed; use 'terraform apply'): $name"; skipped=$((skipped+1)); continue; fi
  if ! $APPLY; then echo "  WOULD migrate -> $REGION: $name"; migrated=$((migrated+1)); continue; fi

  # --- live recreate for one secret ---
  val=$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT" 2>/dev/null || true)
  if [[ -z "$val" ]]; then echo "  FAIL (cannot read value; NOT touching): $name"; failed=$((failed+1)); continue; fi
  iam=$(gcloud secrets get-iam-policy "$name" --project="$PROJECT" --format=json 2>/dev/null || true)

  if ! gcloud secrets delete "$name" --project="$PROJECT" --quiet 2>/dev/null; then
    echo "  FAIL (delete failed; secret still intact): $name"; failed=$((failed+1)); continue
  fi
  if ! printf '%s' "$val" | gcloud secrets create "$name" --project="$PROJECT" \
        --replication-policy=user-managed --locations="$REGION" --data-file=- 2>/dev/null; then
    echo "  CRITICAL: recreate FAILED after delete — '$name' is GONE, recreate it manually now."
    failed=$((failed+1)); continue
  fi
  if [[ -n "$iam" ]] && printf '%s' "$iam" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("bindings") else 1)' 2>/dev/null; then
    # Strip the captured etag — it belongs to the deleted secret. The fresh
    # secret has a new etag; sending the stale one makes set-iam-policy 409 on
    # etag-mismatch. No etag = unconditional set, correct for an empty new policy.
    printf '%s' "$iam" | python3 -c 'import json,sys; p=json.load(sys.stdin); p.pop("etag",None); json.dump(p,sys.stdout)' \
      | gcloud secrets set-iam-policy "$name" /dev/stdin --project="$PROJECT" >/dev/null 2>&1 \
      && echo "    + restored per-secret IAM" || echo "    WARN: IAM restore failed (re-grant manually): $name"
  fi
  check=$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT" 2>/dev/null || true)
  if [[ "$check" == "$val" ]]; then echo "  migrated: $name"; migrated=$((migrated+1)); else echo "  FAIL (value mismatch after recreate): $name"; failed=$((failed+1)); fi
  unset val check iam
done <<< "$(gcloud secrets list --project="$PROJECT" --format='value(name)' 2>/dev/null)"

echo
echo "== done: migrated/would-migrate=$migrated  skipped=$skipped  failed=$failed  (apply=$APPLY) =="
$APPLY || echo "DRY-RUN — re-run with --apply to perform the migration."
[[ "$failed" -gt 0 ]] && exit 1 || exit 0
