# ── IAM Module ───────────────────────────────────────────────────────────────
# Service accounts, Workload Identity bindings, and IAM role grants.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.40.0"
    }
  }
}

# ── Service Account: octogee-gateway ────────────────────────────────────────
resource "google_service_account" "gateway" {
  account_id   = var.gateway_sa_name
  display_name = "Octogee cattle gateway (${var.environment})"
  project      = var.project_id
}

# ── Service Account: octogee-api ────────────────────────────────────────────
resource "google_service_account" "api" {
  account_id   = var.api_sa_name
  display_name = "Octogee API (${var.environment})"
  project      = var.project_id
}

# ── Service Account: llm-broker ─────────────────────────────────────────────
resource "google_service_account" "llm_broker" {
  account_id   = var.llm_broker_sa_name
  display_name = "Octogee LLM broker (${var.environment})"
  project      = var.project_id
}

resource "google_service_account" "ops_agent" {
  account_id   = var.ops_agent_sa_name
  display_name = "Octogee Ops Agent (${var.environment})"
  project      = var.project_id
}

# ── Workload Identity bindings ──────────────────────────────────────────────
# Allows K8s SA "octogee-gateway" in namespace to act as the cattle GCP SA.
# The WI pool is always in the cluster project (octogee), even when the SA
# is in a different project (octogee-test). Both environments share one cluster.
resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.gateway.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/octogee-gateway]"
}

resource "google_service_account_iam_member" "workload_identity_octogee_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/octogee-api]"
}

resource "google_service_account_iam_member" "workload_identity_llm_broker" {
  service_account_id = google_service_account.llm_broker.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/llm-broker]"
}

resource "google_service_account_iam_member" "workload_identity_ops_agent" {
  service_account_id = google_service_account.ops_agent.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/octogee-ops-agent]"
}

resource "google_logging_project_bucket_config" "ops_agent" {
  project        = var.cluster_project_id
  location       = "global"
  bucket_id      = "ops-agent-${var.environment}"
  retention_days = 7
}

resource "google_logging_project_sink" "ops_agent" {
  project                = var.cluster_project_id
  name                   = "ops-agent-${var.environment}"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.ops_agent.id}"
  filter                 = "(resource.type=\"k8s_container\" AND resource.labels.namespace_name=\"${var.namespace}\") OR (resource.type=\"gce_instance\" AND jsonPayload.container.metadata.\"ai.octogee.namespace\"=\"${var.namespace}\")"
  unique_writer_identity = true
}

resource "google_logging_log_view" "ops_agent" {
  name        = "ops-agent"
  bucket      = google_logging_project_bucket_config.ops_agent.id
  description = "Read-only ${var.environment} pod and Builder VM container logs for the Octogee Ops Agent"
  filter      = "resource.type=\"k8s_container\" OR resource.type=\"gce_instance\""
}

resource "google_logging_log_view_iam_member" "ops_agent" {
  parent   = google_logging_log_view.ops_agent.parent
  location = google_logging_log_view.ops_agent.location
  bucket   = google_logging_log_view.ops_agent.bucket
  name     = google_logging_log_view.ops_agent.name
  role     = "roles/logging.viewAccessor"
  member   = "serviceAccount:${google_service_account.ops_agent.email}"
}

# ── Data-access audit trail ─────────────────────────────────────────────────
# Secret payload reads are Data Access audit logs, which GCP leaves off by
# default. octogee-api writes one data-access record per brokered internal
# call; those records are kept for 400 days instead of _Default's 30.
resource "google_project_iam_audit_config" "secretmanager_data_read" {
  project = var.project_id
  service = "secretmanager.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
}

resource "google_logging_project_bucket_config" "data_access_audit" {
  project        = var.cluster_project_id
  location       = "global"
  bucket_id      = "data-access-audit-${var.environment}"
  retention_days = 400
}

resource "google_logging_project_sink" "data_access_audit" {
  project                = var.cluster_project_id
  name                   = "data-access-audit-${var.environment}"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.data_access_audit.id}"
  filter                 = "resource.type=\"k8s_container\" AND resource.labels.namespace_name=\"${var.namespace}\" AND jsonPayload.category=\"data-access\""
  unique_writer_identity = true
}

# ── Cloud SQL Client role ───────────────────────────────────────────────────
# Platform API SA needs cloudsql.client to back the Cloud SQL Proxy.
resource "google_project_iam_member" "cloudsql_client" {
  project = var.cloudsql_project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# ── Secret Manager admin ───────────────────────────────────────────────────
# Platform API creates gateway-auth-token-* secrets and sets per-gateway
# accessor IAM. Cattle gateway pods only receive per-secret grants from this
# flow; they must not carry project-level Secret Manager reach.
resource "google_project_iam_member" "api_secretmanager_admin" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# ── Firebase product access ────────────────────────────────────────────────
resource "google_project_iam_member" "api_firebase" {
  for_each = toset(["roles/datastore.user", "roles/firebaseauth.admin", "roles/firebasehosting.admin", "roles/firebase.viewer"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.api.email}"
}

# ── Firebase Storage object I/O ─────────────────────────────────────────────
# octogee-api serves workspace/profile/post media routes through Firebase Admin
# Storage. Scope object admin to the environment's Firebase Storage bucket
# instead of granting the platform API project-wide storage reach.
resource "google_storage_bucket_iam_member" "api_storage_object_admin" {
  bucket = "${var.project_id}.firebasestorage.app"
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_service_account_iam_member" "api_self_token_creator" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# ── LLM broker runtime grants ───────────────────────────────────────────────
# The broker resolves Anthropic keys off-pod and records usage/cap counters.
# It must not inherit octogee-api's Firebase admin, Secret Manager admin,
# Cloud SQL, or Storage authority.
resource "google_project_iam_member" "llm_broker_datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.llm_broker.email}"
}

resource "google_project_iam_member" "llm_broker_anthropic_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.llm_broker.email}"

  condition {
    title       = "AnthropicProviderKeysOnly"
    description = "LLM broker may access only the platform Anthropic key and per-builder Anthropic BYOT secrets."
    expression  = <<-EOT
    resource.name.startsWith("projects/${var.project_id}/secrets/octogee-anthropic/versions/") ||
    resource.name.startsWith("projects/${data.google_project.this.number}/secrets/octogee-anthropic/versions/") ||
    (resource.name.startsWith("projects/${var.project_id}/secrets/byok-") && resource.name.endsWith("-anthropic/versions/latest")) ||
    (resource.name.startsWith("projects/${data.google_project.this.number}/secrets/byok-") && resource.name.endsWith("-anthropic/versions/latest"))
    EOT
  }
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
resource "google_project_iam_member" "glm_controller_firebase" {
  for_each = toset(["roles/datastore.user", "roles/firebaseauth.admin", "roles/firebasehosting.admin", "roles/firebase.viewer"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.glm_controller.email}"
}

# Secret Manager admin: Cowboy creates + sets IAM on + (on decommission)
# DELETES the per-gateway gateway-auth-token-<id> secrets. accessor is not
# enough — provision needs create/setIamPolicy, teardown needs delete.
resource "google_project_iam_member" "glm_controller_secretmanager_admin" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.glm_controller.email}"
}

# Narrow project-level role for dynamic per-gateway GSA teardown. NOT
# serviceAccountAdmin: Cowboy can delete service accounts such as
# octogee-gw-<gatewayId>, but cannot mutate IAM policy on arbitrary service
# accounts at project scope.
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

# ── Cloud Functions runtime SA: Firebase Auth read ──────────────────────────
# Firestore triggers run as the project's default compute SA. onUserComplete
# writes provisioning state and re-checks the
# Firebase Auth `emailVerified` flag (getAuth().getUser()) as the signup
# email-verification gate — the client-side onboarding AuthGuard is bypassable, so the
# server is the authority. Without this read grant that lookup throws before the
# trigger starts provisioning, and every new signup stalls unprovisioned. Viewer
# is the least privilege that satisfies firebaseauth.users.get.
data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_iam_member" "functions_firebaseauth_viewer" {
  project = var.project_id
  role    = "roles/firebaseauth.viewer"
  member  = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_custom_role" "functions_storage_cleanup" {
  project     = var.project_id
  role_id     = "functionsStorageCleanup"
  title       = "Functions storage cleanup"
  permissions = ["storage.objects.list", "storage.objects.delete"]
}

resource "google_storage_bucket_iam_member" "functions_storage_cleanup" {
  bucket = "${var.project_id}.firebasestorage.app"
  role   = google_project_iam_custom_role.functions_storage_cleanup.id
  member = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_storage_bucket_iam_member" "glm_controller_storage_cleanup" {
  bucket = "${var.project_id}.firebasestorage.app"
  role   = google_project_iam_custom_role.functions_storage_cleanup.id
  member = "serviceAccount:${google_service_account.glm_controller.email}"
}

resource "google_project_iam_member" "functions_datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "functions_pubsub_token_creator" {
  project = var.project_id
  role    = "roles/iam.serviceAccountTokenCreator"
  member  = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "functions_run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "functions_eventarc_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "functions_eventarc_service_agent" {
  project = var.project_id
  role    = "roles/eventarc.serviceAgent"
  member  = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "functions_build_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}
resource "google_artifact_registry_repository_iam_member" "functions_build_images" {
  project    = var.project_id
  location   = var.region
  repository = "gcf-artifacts"
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}
resource "google_storage_bucket_iam_member" "functions_build_sources" {
  for_each = toset([
    "gcf-v2-sources-${data.google_project.this.number}-${var.region}",
    "gcf-v2-uploads-${data.google_project.this.number}.${var.region}.cloudfunctions.appspot.com",
  ])
  bucket = each.value
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

# ── Service Account: firebase-deployer (CI `firebase deploy`) ────────────────
# Dedicated least-privilege identity for GitHub Actions Firebase mutations.
resource "google_service_account" "firebase_deployer" {
  account_id   = var.firebase_deployer_sa_name
  display_name = "Octogee Firebase deployer — CI (${var.environment})"
  project      = var.project_id
}

resource "google_service_account_iam_member" "firebase_deployer_github_actions" {
  service_account_id = google_service_account.firebase_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/94934561284/locations/global/workloadIdentityPools/github-actions/attribute.repository_id/1181841184"
}

resource "google_project_iam_member" "firebase_deployer" {
  for_each = toset([
    "roles/firebase.admin", # firestore rules + hosting + project resolution
    "roles/datastore.indexAdmin",
    "roles/cloudfunctions.admin",              # functions deploy (control plane)
    "roles/run.admin",                         # Gen2 functions back onto Cloud Run
    "roles/cloudscheduler.admin",              # onSchedule functions create Cloud Scheduler jobs
    "roles/iam.serviceAccountUser",            # actAs the functions runtime + Cloud Build SAs
    "roles/cloudbuild.builds.builder",         # functions source build
    "roles/artifactregistry.writer",           # functions container image push
    "roles/storage.admin",                     # functions source-staging bucket
    "roles/serviceusage.serviceUsageConsumer", # quota project / API enablement checks
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.firebase_deployer.email}"
}

# Gen2 functions in functions/ use 7 `defineSecret` params; firebase-tools binds
# each secret to the function's runtime SA on deploy. That needs get +
# get/setIamPolicy on the secrets — NOT roles/secretmanager.admin: a leaked
# deploy key must not read or mutate the platform's Anthropic / gateway-auth
# secrets. versions.{get,list} confirm an enabled version exists WITHOUT
# versions.access (the value read). If a deploy ever needs the value, scope
# versions.access to the specific function secrets, never project-wide.
resource "google_project_iam_custom_role" "firebase_deployer_secret_binding" {
  role_id     = "octogeeFirebaseDeployerSecretBinding"
  title       = "Octogee Firebase Deployer Secret Binding"
  description = "Bind defineSecret secrets to function runtime SAs on deploy (no value read)."
  project     = var.project_id
  permissions = [
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ]
}

resource "google_project_iam_member" "firebase_deployer_secret_binding" {
  project = var.project_id
  role    = google_project_iam_custom_role.firebase_deployer_secret_binding.id
  member  = "serviceAccount:${google_service_account.firebase_deployer.email}"

  condition {
    title      = "function_secret_policy_binding"
    expression = <<-EOT
      resource.name == "projects/${data.google_project.this.number}/secrets/DISCORD_OPS_WEBHOOK_URL" ||
      resource.name.startsWith("projects/${data.google_project.this.number}/secrets/DISCORD_OPS_WEBHOOK_URL/versions/") ||
      resource.name == "projects/${data.google_project.this.number}/secrets/SOCIAL_NOTIFICATION_BEARER_TOKEN" ||
      resource.name.startsWith("projects/${data.google_project.this.number}/secrets/SOCIAL_NOTIFICATION_BEARER_TOKEN/versions/")
    EOT
  }
}
