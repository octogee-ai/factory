output "instance_connection_name" {
  description = "Cloud SQL instance connection name (project:region:instance)"
  value       = google_sql_database_instance.main.connection_name
}

output "instance_name" {
  description = "Cloud SQL instance name"
  value       = google_sql_database_instance.main.name
}

output "mattermost_db_name" {
  description = "Mattermost database name"
  value       = google_sql_database.mattermost.name
}

output "gitea_db_name" {
  description = "Gitea database name"
  value       = google_sql_database.gitea.name
}

output "mattermost_password" {
  description = "Mattermost SQL user password"
  value       = random_password.mattermost.result
  sensitive   = true
}

output "gitea_password" {
  description = "Gitea SQL user password"
  value       = random_password.gitea.result
  sensitive   = true
}

output "agent_store_db_name" {
  value = google_sql_database.agent_store.name
}
