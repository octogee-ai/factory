output "crypto_key_name" {
  description = "Full resource name of the credential-at-rest KMS key. Pass to workspace-api as OCTOGEE_KMS_KEY_NAME env var."
  value       = google_kms_crypto_key.creds_at_rest.id
}

output "key_ring_name" {
  description = "Resource name of the key ring (used by operator scripts / audit tools)"
  value       = google_kms_key_ring.creds.id
}
