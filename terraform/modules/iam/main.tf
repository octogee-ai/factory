# ── IAM Module ───────────────────────────────────────────────────────────────
# Service accounts, Workload Identity bindings, and IAM role grants.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

# ── Service Account: octogee-gateway ────────────────────────────────────────
resource "google_service_account" "gateway" {
  account_id   = var.gateway_sa_name
  display_name = "Octogee Gateway (${var.environment})"
  project      = var.project_id
}

# ── Workload Identity binding ───────────────────────────────────────────────
# Allows K8s SA "octogee-gateway" in namespace to act as this GCP SA.
# The WI pool is always in the cluster project (octogee), even when the SA
# is in a different project (octogee-test). Both environments share one cluster.
resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.gateway.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/octogee-gateway]"
}

# ── Cloud SQL Client role ───────────────────────────────────────────────────
# Gateway SA needs cloudsql.client to connect via Cloud SQL Proxy.
resource "google_project_iam_member" "cloudsql_client" {
  project = var.cloudsql_project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# ── Secret Manager accessor ────────────────────────────────────────────────
resource "google_project_iam_member" "secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# ── Firebase Admin (for CF + Firestore) ─────────────────────────────────────
resource "google_project_iam_member" "firebase_admin" {
  project = var.project_id
  role    = "roles/firebase.admin"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}
