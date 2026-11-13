output "mm_db_password_secret_id" {
  description = "Secret Manager secret ID for Mattermost DB password"
  value       = google_secret_manager_secret.mm_db_password.secret_id
}

output "gitea_db_password_secret_id" {
  description = "Secret Manager secret ID for Gitea DB password"
  value       = google_secret_manager_secret.gitea_db_password.secret_id
}

output "mm_db_password_secret_version" {
  description = "Secret Manager version for Mattermost DB password"
  value       = google_secret_manager_secret_version.mm_db_password.name
}

output "gitea_db_password_secret_version" {
  description = "Secret Manager version for Gitea DB password"
  value       = google_secret_manager_secret_version.gitea_db_password.name
}
