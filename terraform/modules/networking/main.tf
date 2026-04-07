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

# ── Cloud Armor WAF Policy ─────────────────────────────────────────────────
# Attached to all public-facing GKE BackendConfigs via Helm.
# OWASP CRS 3.3 rules start in preview (log-only) mode to avoid false positives.
# Switch sensitivity_level per rule from 0 (disabled) to 1+ to enable blocking.

resource "google_compute_security_policy" "waf" {
  name    = "octogee-waf"
  project = var.project_id

  # Default rule: allow all traffic
  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }

  # Rate limiting: 100 requests per minute per IP
  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      rate_limit_threshold {
        count        = 100
        interval_sec = 60
      }
      enforce_on_key = "IP"
    }
    description = "Rate limit: 100 req/min per IP"
  }

  # OWASP CRS 3.3 — SQL injection (preview mode)
  rule {
    action   = "deny(403)"
    priority = 2000
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('sqli-v33-stable')"
      }
    }
    preview     = true
    description = "OWASP CRS 3.3: SQL injection (preview)"
  }

  # OWASP CRS 3.3 — XSS (preview mode)
  rule {
    action   = "deny(403)"
    priority = 2001
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-v33-stable')"
      }
    }
    preview     = true
    description = "OWASP CRS 3.3: XSS (preview)"
  }

  # OWASP CRS 3.3 — Remote code execution (preview mode)
  rule {
    action   = "deny(403)"
    priority = 2002
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('rce-v33-stable')"
      }
    }
    preview     = true
    description = "OWASP CRS 3.3: RCE (preview)"
  }

  # OWASP CRS 3.3 — Local file inclusion (preview mode)
  rule {
    action   = "deny(403)"
    priority = 2003
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('lfi-v33-stable')"
      }
    }
    preview     = true
    description = "OWASP CRS 3.3: LFI (preview)"
  }

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable = true
    }
  }
}
