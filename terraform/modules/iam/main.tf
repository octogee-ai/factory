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

resource "google_service_account_iam_member" "workload_identity_octogee_api" {
  service_account_id = google_service_account.gateway.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/octogee-api]"
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

# ── Service Account: glm-controller (Cowboy) ────────────────────────────────
# Dedicated control-plane identity, separate from the shared gateway SA, so the
# privileged teardown grants below (Secret Manager admin, per-gateway service-
# account delete) are NOT inherited by cattle gateway pods — which run as
# octogee-gateway. See OPERATOR-GATEWAY-IDENTITY-AND-BROKERING-SPEC D2 and
# GATEWAY-DECOMMISSION-TEARDOWN-SPEC D5.
resource "google_service_account" "glm_controller" {
  account_id   = "octogee-glm-controller"
  display_name = "Octogee Cowboy / GLM Controller (${var.environment})"
  project      = var.project_id
}

resource "google_service_account_iam_member" "glm_controller_workload_identity" {
  service_account_id = google_service_account.glm_controller.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/glm-controller]"
}

# Firestore (glmGateways / gateways docs) + Firebase Hosting (customer site
# teardown) — the access Cowboy exercised via the shared GSA.
resource "google_project_iam_member" "glm_controller_firebase_admin" {
  project = var.project_id
  role    = "roles/firebase.admin"
  member  = "serviceAccount:${google_service_account.glm_controller.email}"
}

# Secret Manager admin: Cowboy creates + sets IAM on + (on decommission)
# DELETES the per-gateway gateway-auth-token-<id> secrets. accessor is not
# enough — provision needs create/setIamPolicy, teardown needs delete.
resource "google_project_iam_member" "glm_controller_secretmanager_admin" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.glm_controller.email}"
}

# Narrow custom role for per-gateway GSA teardown. NOT serviceAccountAdmin:
# Cowboy never creates SAs nor mutates their IAM beyond delete (deleting the SA
# removes its own Workload-Identity binding). Project-level setIamPolicy is
# deliberately withheld — too broad; per-gateway GSAs should carry resource-
# scoped roles so a delete strands nothing. See
# GATEWAY-DECOMMISSION-TEARDOWN-SPEC §10 OQ2.
resource "google_project_iam_custom_role" "gateway_sa_teardown" {
  role_id     = "octogeeGatewayServiceAccountTeardown"
  title       = "Octogee Gateway Service Account Teardown"
  description = "Delete per-gateway GSAs on gateway decommission (Cowboy)."
  project     = var.project_id
  permissions = [
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.delete",
  ]
}

resource "google_project_iam_member" "glm_controller_gateway_sa_teardown" {
  project = var.project_id
  role    = google_project_iam_custom_role.gateway_sa_teardown.id
  member  = "serviceAccount:${google_service_account.glm_controller.email}"
}
