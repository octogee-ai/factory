output "gateway_sa_email" {
  description = "Gateway service account email"
  value       = google_service_account.gateway.email
}

output "gateway_sa_name" {
  description = "Gateway service account fully-qualified name"
  value       = google_service_account.gateway.name
}

output "glm_controller_sa_email" {
  description = "Cowboy / glm-controller dedicated service account email"
  value       = google_service_account.glm_controller.email
}
