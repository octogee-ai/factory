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
  description = "Service account ID for cattle gateways"
  type        = string
  default     = "octogee-gateway"
}

variable "api_sa_name" {
  description = "Service account ID for octogee-api"
  type        = string
  default     = "octogee-api"
}

variable "llm_broker_sa_name" {
  description = "Service account ID for the LLM broker"
  type        = string
  default     = "octogee-llm-broker"
}

variable "ops_agent_sa_name" {
  description = "Service account ID for the read-only Ops Agent"
  type        = string
  default     = "octogee-ops-agent"
}

variable "cloudsql_project_id" {
  description = "Project ID that owns the Cloud SQL instance (always 'octogee')"
  type        = string
  default     = "octogee"
}

variable "cluster_project_id" {
  description = "Project ID that owns the GKE cluster (for Workload Identity pool). Both test and prod use the same cluster in the 'octogee' project."
  type        = string
  default     = "octogee"
}

variable "firebase_deployer_sa_name" {
  description = "Service account ID for the CI Firebase deploy SA (firestore rules + hosting + functions)"
  type        = string
  default     = "firebase-deployer"
}
