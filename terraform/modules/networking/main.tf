# ── Networking Module ────────────────────────────────────────────────────────
# VPC Serverless Connector for Cloud Functions → GKE ILB access.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.40.0"
    }
  }
}

# ── Static internal IPs for ILBs ────────────────────────────────────────────
# Prevents IP drift on teardown/rebuild. Chat proxy and CFs reference these.

resource "google_compute_address" "mattermost_ilb" {
  name         = "${var.connector_name}-mm-ilb"
  project      = var.project_id
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = "default"
}

resource "google_compute_address" "gitea_ilb" {
  name         = "${var.connector_name}-gitea-ilb"
  project      = var.project_id
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = "default"
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

# ── Static external IP for workspace-api Ingress ────────────────────────────
# GKE Ingress for the environment's public API host

resource "google_compute_global_address" "workspace_api" {
  name    = "workspace-api-ip"
  project = var.project_id
}

# Cloud Armor WAF policy is created in prod main.tf (octogee project, shared
# by both namespaces). Not per-environment — GKE LBs all live in octogee.
