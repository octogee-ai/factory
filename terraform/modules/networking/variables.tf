variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "connector_name" {
  description = "VPC connector name"
  type        = string
  default     = "octogee-connector"
}

variable "network" {
  description = "VPC network name"
  type        = string
  default     = "default"
}

variable "ip_cidr_range" {
  description = "IP CIDR range for the VPC connector"
  type        = string
  default     = "10.10.0.0/28"
}

variable "static_ip_suffix" {
  description = "Suffix appended to env-scoped static IP names (e.g. '-test' for test env). Prod leaves blank."
  type        = string
  default     = ""
}

variable "cluster_project_id" {
  description = "GCP project that hosts the GKE cluster. GKE Ingress resolves global static IP names against this project — they must live here, not the namespace/workload project. Today both prod + test live in `octogee` on one cluster."
  type        = string
  default     = "octogee"
}
