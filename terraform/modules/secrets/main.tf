# ── Secrets Module ───────────────────────────────────────────────────────────
# Secret Manager secrets + versions for database passwords and service tokens.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

# ── Mattermost DB password ──────────────────────────────────────────────────
resource "google_secret_manager_secret" "mm_db_password" {
  secret_id = var.mm_db_password_secret_id
  project   = var.project_id

  replication {
    user_managed {
      replicas {
        location = "us-central1"
      }
    }
  }
}

resource "google_secret_manager_secret_version" "mm_db_password" {
  secret      = google_secret_manager_secret.mm_db_password.id
  secret_data = var.mm_db_password
}

# ── Gitea DB password ───────────────────────────────────────────────────────
resource "google_secret_manager_secret" "gitea_db_password" {
  secret_id = var.gitea_db_password_secret_id
  project   = var.project_id

  replication {
    user_managed {
      replicas {
        location = "us-central1"
      }
    }
  }
}

resource "google_secret_manager_secret_version" "gitea_db_password" {
  secret      = google_secret_manager_secret.gitea_db_password.id
  secret_data = var.gitea_db_password
}

# ── Cloud SQL connection name ───────────────────────────────────────────────
resource "google_secret_manager_secret" "cloudsql_connection" {
  secret_id = "cloud-sql-connection-name"
  project   = var.project_id

  replication {
    user_managed {
      replicas {
        location = "us-central1"
      }
    }
  }
}

resource "google_secret_manager_secret_version" "cloudsql_connection" {
  secret      = google_secret_manager_secret.cloudsql_connection.id
  secret_data = var.cloudsql_connection_name
}
