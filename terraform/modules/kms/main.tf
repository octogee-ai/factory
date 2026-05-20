# ── KMS Module ──────────────────────────────────────────────────────────────
# Symmetric encryption key for credential-at-rest in
# `users/{uid}/secrets/{provider}` Firestore docs (workspace-api/src/lib/
# kms.ts). Single key per environment; shared by all integrations
# (Google/Microsoft OAuth tokens, IMAP/SMTP passwords, Twilio auth).
#
# The workspace-api service account (passed in as `consumer_sa_email`)
# gets `cryptoKeyEncrypterDecrypter` — the minimal permission set that
# allows both directions without any administrative reach over the key.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

resource "google_project_service" "kms" {
  project            = var.project_id
  service            = "cloudkms.googleapis.com"
  disable_on_destroy = false
}

resource "google_kms_key_ring" "creds" {
  name     = var.key_ring_name
  location = var.region
  project  = var.project_id

  depends_on = [google_project_service.kms]
}

# Symmetric encryption key. Default purpose `ENCRYPT_DECRYPT` and
# automatic rotation every 90 days (Google-managed key material — no
# operator burden, and rotation does NOT break existing ciphertext:
# KMS decrypts against any historical key version still in `ENABLED`).
resource "google_kms_crypto_key" "creds_at_rest" {
  name            = var.crypto_key_name
  key_ring        = google_kms_key_ring.creds.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

# Grant the workspace-api SA encrypt + decrypt on this key. Scoped to
# this single key (NOT project-wide). Operator-managed: append a
# member to var.additional_decrypter_sas to allow a recovery script
# (read-only) without granting the wider permission to workspace-api.
resource "google_kms_crypto_key_iam_member" "workspace_api_encdec" {
  crypto_key_id = google_kms_crypto_key.creds_at_rest.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${var.consumer_sa_email}"
}

# Extra decrypt-only grants (e.g. an operator's break-glass GSA used
# only by an audited recovery script). Empty by default — append only
# when a use case is justified by an audit trail.
resource "google_kms_crypto_key_iam_member" "extra_decrypters" {
  for_each      = toset(var.additional_decrypter_sas)
  crypto_key_id = google_kms_crypto_key.creds_at_rest.id
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${each.value}"
}
