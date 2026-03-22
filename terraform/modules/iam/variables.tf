variable "project_id" {
  description = "GCP project ID for this environment"
  type        = string
}

variable "environment" {
  description = "Environment name (prod or test)"
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace for Workload Identity binding"
  type        = string
}

variable "gateway_sa_name" {
  description = "Service account ID for the gateway"
  type        = string
  default     = "octogee-gateway"
}

variable "cloudsql_project_id" {
  description = "Project ID that owns the Cloud SQL instance (always 'octogee')"
  type        = string
  default     = "octogee"
}
