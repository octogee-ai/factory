variable "project_id" {
  description = "GCP project that owns the Cloud SQL instance"
  type        = string
}

variable "region" {
  description = "GCP region for the Cloud SQL instance"
  type        = string
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

variable "database_version" {
  description = "Cloud SQL database version"
  type        = string
  default     = "POSTGRES_16"
}

variable "create_users" {
  description = "Whether to create SQL users (true for prod, false for test since users are shared)"
  type        = bool
  default     = true
}

variable "agent_store_db_name" {
  description = "Database for the environment's shared PostgreSQL agent stores"
  type        = string
}
