variable "project_id" {
  description = "GCP project that owns the Cloud SQL instance"
  type        = string
}

variable "region" {
  description = "GCP region for the Cloud SQL instance"
  type        = string
  default     = "us-central1"
}

variable "instance_name" {
  description = "Cloud SQL instance name"
  type        = string
  default     = "octogee-pg"
}

variable "tier" {
  description = "Cloud SQL machine tier"
  type        = string
  default     = "db-f1-micro"
}

variable "mattermost_db_name" {
  description = "Database name for Mattermost"
  type        = string
}

variable "gitea_db_name" {
  description = "Database name for Gitea"
  type        = string
}

variable "create_users" {
  description = "Whether to create SQL users (true for prod, false for test since users are shared)"
  type        = bool
  default     = true
}
