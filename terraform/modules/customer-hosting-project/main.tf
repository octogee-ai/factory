terraform {
  required_providers {
    google = {
      source                = "hashicorp/google"
      version               = ">= 7.40.0"
      configuration_aliases = [google.bootstrap]
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 7.40.0"
    }
  }
}

locals {
  required_services = toset([
    "cloudbilling.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
  ])
  publisher_service_account_id = "octogee-project-publisher"
  journal_bucket_name          = "${var.project_id}-publish-journal"
}

resource "google_project" "customer_hosting" {
  provider = google.bootstrap

  name                = var.project_name
  project_id          = var.project_id
  org_id              = var.organization_id
  billing_account     = var.billing_account_id
  auto_create_network = false
  deletion_policy     = "PREVENT"

  labels = {
    deployment-target = var.deployment_target
    managed-by        = "terraform"
    purpose           = "customer-hosting"
  }
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = google_project.customer_hosting.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firebase_project" "customer_hosting" {
  provider = google-beta
  project  = google_project.customer_hosting.project_id

  depends_on = [google_project_service.required]
}

resource "google_firebase_hosting_site" "default" {
  provider        = google-beta
  project         = google_project.customer_hosting.project_id
  site_id         = google_project.customer_hosting.project_id
  deletion_policy = "PREVENT"

  depends_on = [google_firebase_project.customer_hosting]
}

resource "google_storage_bucket" "publish_journal" {
  project                     = google_project.customer_hosting.project_id
  name                        = local.journal_bucket_name
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age            = 8
      matches_prefix = ["artifacts/"]
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_service_account" "publisher" {
  project      = google_project.customer_hosting.project_id
  account_id   = local.publisher_service_account_id
  display_name = "Octogee customer project publisher (${var.deployment_target})"

  depends_on = [google_project_service.required]
}

resource "google_service_account_iam_member" "publisher_workload_identity" {
  service_account_id = google_service_account.publisher.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.cluster_project_id}.svc.id.goog[${var.namespace}/octogee-project-publisher]"
}

resource "google_project_iam_member" "publisher_hosting_admin" {
  project = google_project.customer_hosting.project_id
  role    = "roles/firebasehosting.admin"
  member  = "serviceAccount:${google_service_account.publisher.email}"
}

resource "google_storage_bucket_iam_member" "publisher_journal" {
  for_each = toset([
    "roles/storage.objectCreator",
    "roles/storage.objectViewer",
  ])

  bucket = google_storage_bucket.publish_journal.name
  role   = each.value
  member = "serviceAccount:${google_service_account.publisher.email}"
}
