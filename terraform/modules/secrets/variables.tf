variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "mm_db_password" {
  description = "Mattermost database password"
  type        = string
  sensitive   = true
}

variable "gitea_db_password" {
  description = "Gitea database password"
  type        = string
  sensitive   = true
}

variable "cloudsql_connection_name" {
  description = "Cloud SQL connection name (project:region:instance)"
  type        = string
}

variable "mm_db_password_secret_id" {
  description = "Secret Manager secret ID for MM DB password"
  type        = string
  default     = "mattermost-db-password"
}

variable "gitea_db_password_secret_id" {
  description = "Secret Manager secret ID for Gitea DB password"
  type        = string
  default     = "gitea-db-password"
}
