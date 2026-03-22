output "connector_name" {
  description = "VPC connector name for Cloud Functions"
  value       = google_vpc_access_connector.main.name
}

output "connector_id" {
  description = "VPC connector fully-qualified ID"
  value       = google_vpc_access_connector.main.id
}
