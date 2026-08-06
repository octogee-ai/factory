variable "project_id" {
  description = "Dedicated Firebase project that contains only customer Hosting sites"
  type        = string
}

variable "project_name" {
  description = "GCP project display name"
  type        = string
}

variable "deployment_target" {
  description = "Exact deployment target owning this customer Hosting project"
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace containing the publisher KSA"
  type        = string
}

variable "cluster_project_id" {
  description = "GKE Workload Identity pool project"
  type        = string
  default     = "octogee"
}

variable "organization_id" {
  description = "Owning Google Cloud organization ID"
  type        = string
}

variable "billing_account_id" {
  description = "Billing account linked at project creation"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "Journal bucket location"
  type        = string
}
