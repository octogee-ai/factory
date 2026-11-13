variable "deployment_target" {
  description = "Exact candidate deployment target"
  type        = string
}

variable "project_id" {
  description = "Fresh Firebase and customer-data project ID"
  type        = string
}

variable "project_name" {
  description = "GCP project display name"
  type        = string
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
  description = "Immutable Firebase data location"
  type        = string

  validation {
    condition     = var.region == "us-west1"
    error_message = "Fresh friends-and-family data projects must be created in us-west1."
  }
}

variable "authorized_domains" {
  description = "Firebase Auth redirect domains for this target"
  type        = list(string)
}

variable "retirement_mode" {
  description = "Explicitly allow destruction of an abandoned WEST candidate data project"
  type        = bool
  default     = false
}

variable "github_actions_service_account" {
  description = "Email of the GitHub Actions service account granted the data project CI roles"
  type        = string
}
