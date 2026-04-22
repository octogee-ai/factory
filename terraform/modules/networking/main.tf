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
# GKE Ingress for api.octogee.com / api-test.octogee.com

resource "google_compute_global_address" "workspace_api" {
  name    = "workspace-api-ip"
  project = var.project_id
}

resource "google_compute_global_address" "chat_proxy" {
  name    = "chat-proxy-ip"
  project = var.project_id
}

# ── Static external IP for gateway fleet-control plane Ingress ──────────────
# GKE Ingress for fleet.octogee.com / fleet-test.octogee.com (the fleet
# controller's Cloud Tasks push target — see docs/GATEWAY-PLATFORM-SPEC.md
# §Cloud Tasks Routing). Dedicated IP so this LB can be swapped or rolled
# back without touching the data-plane LBs.
resource "google_compute_global_address" "fleet_control" {
  name    = "fleet-control-ip${var.static_ip_suffix}"
  project = var.project_id
}

# Cloud Armor WAF policy is created in prod main.tf (octogee project, shared
# by both namespaces). Not per-environment — GKE LBs all live in octogee.
