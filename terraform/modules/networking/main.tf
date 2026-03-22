# ── Networking Module ────────────────────────────────────────────────────────
# VPC Serverless Connector for Cloud Functions → GKE ILB access.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

resource "google_vpc_access_connector" "main" {
  name          = var.connector_name
  region        = var.region
  project       = var.project_id
  network       = var.network
  ip_cidr_range = var.ip_cidr_range

  lifecycle {
    prevent_destroy = true
  }
}
