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
