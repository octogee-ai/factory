# ── Cloud SQL Module ─────────────────────────────────────────────────────────
# Manages Cloud SQL users, databases, and grants on the shared octogee-pg instance.
# The shared instance is managed only by the production environment.

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

data "google_sql_database_instance" "main" {
  name    = var.instance_name
  project = var.project_id
}

# ── Databases ───────────────────────────────────────────────────────────────
resource "google_sql_database" "mattermost" {
  name     = var.mattermost_db_name
  instance = data.google_sql_database_instance.main.name
  project  = var.project_id
}

resource "google_sql_database" "gitea" {
  name     = var.gitea_db_name
  instance = data.google_sql_database_instance.main.name
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
  instance = data.google_sql_database_instance.main.name
  password = random_password.mattermost.result
  project  = var.project_id
}

resource "google_sql_user" "gitea" {
  count    = var.create_users ? 1 : 0
  name     = "gitea"
  instance = data.google_sql_database_instance.main.name
  password = random_password.gitea.result
  project  = var.project_id
}

resource "google_sql_database" "agent_store" {
  name     = var.agent_store_db_name
  instance = data.google_sql_database_instance.main.name
  project  = var.project_id
}
