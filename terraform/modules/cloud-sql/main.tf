# ── Cloud SQL Module ─────────────────────────────────────────────────────────
# Manages Cloud SQL users, databases, and grants on the shared octogee-pg instance.
# The instance itself already exists — import it, don't recreate.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.40.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# ── Data: existing Cloud SQL instance (imported) ────────────────────────────
# nosemgrep: gcp-sql-database-require-ssl
resource "google_sql_database_instance" "main" {
  name             = var.instance_name
  project          = var.project_id
  region           = var.region
  database_version = var.database_version

  # Settings are imported from existing instance — do not modify here
  # unless intentionally changing instance config.
  settings {
    tier = var.tier
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [settings]
  }
}

# ── Databases ───────────────────────────────────────────────────────────────
resource "google_sql_database" "mattermost" {
  name     = var.mattermost_db_name
  instance = google_sql_database_instance.main.name
  project  = var.project_id
}

resource "google_sql_database" "gitea" {
  name     = var.gitea_db_name
  instance = google_sql_database_instance.main.name
  project  = var.project_id
}

# ── Passwords ───────────────────────────────────────────────────────────────
resource "random_password" "mattermost" {
  length  = 32
  special = false
}

resource "random_password" "gitea" {
  length  = 32
  special = false
}

# ── Users ───────────────────────────────────────────────────────────────────
# mattermost and gitea users are shared across envs (same Cloud SQL instance).
# Each env calls this module, but only the prod env should create the users.
# Test env connects with the same credentials via cross-project IAM.

resource "google_sql_user" "mattermost" {
  count    = var.create_users ? 1 : 0
  name     = "mattermost"
  instance = google_sql_database_instance.main.name
  password = random_password.mattermost.result
  project  = var.project_id
}

resource "google_sql_user" "gitea" {
  count    = var.create_users ? 1 : 0
  name     = "gitea"
  instance = google_sql_database_instance.main.name
  password = random_password.gitea.result
  project  = var.project_id
}
