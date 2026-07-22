# ── Terraform GCS Backend ────────────────────────────────────────────────────
# State bucket: gs://octogee-terraform-state (owned by the control-plane root)
# Bootstrap/adoption/verification: ./scripts/bootstrap-control-plane.sh
# Each environment uses a separate prefix (prod/ or test/) for full isolation.
#
# Usage:
#   cd terraform/environments/prod
#   terraform init -backend-config=../../backend.tf
#
# The prefix is set in each environment's main.tf via backend config.

terraform {
  backend "gcs" {
    bucket = "octogee-terraform-state"
    # prefix is set per-environment (prod/ or test/)
  }
}
