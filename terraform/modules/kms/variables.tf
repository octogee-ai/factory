variable "project_id" {
  description = "GCP project that owns the KMS key ring + key"
  type        = string
}

variable "region" {
  description = "GCP region for the key ring"
  type        = string
}

variable "key_ring_name" {
  description = "Name of the KMS key ring"
  type        = string
  default     = "octogee-creds"
}

variable "crypto_key_name" {
  description = "Name of the symmetric crypto key (creates `projects/{p}/locations/{r}/keyRings/{ring}/cryptoKeys/{name}`)"
  type        = string
  default     = "integrations-at-rest"
}

variable "consumer_sa_email" {
  description = "Service account email that needs encrypt + decrypt on the key (workspace-api SA in production)"
  type        = string
}

variable "additional_decrypter_sas" {
  description = "Extra SAs to grant decrypt-only (break-glass / recovery scripts; empty by default — append upward, never start broad)"
  type        = list(string)
  default     = []
}

variable "crypto_key_deletion_policy" {
  description = "Terraform deletion policy for the credential key; normal environments must retain PREVENT"
  type        = string
  default     = "PREVENT"

  validation {
    condition     = contains(["PREVENT", "DELETE"], var.crypto_key_deletion_policy)
    error_message = "crypto_key_deletion_policy must be PREVENT or DELETE."
  }
}
