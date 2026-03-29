output "connector_name" {
  description = "VPC connector name for Cloud Functions"
  value       = google_vpc_access_connector.main.name
}

output "connector_id" {
  description = "VPC connector fully-qualified ID"
  value       = google_vpc_access_connector.main.id
}

output "mattermost_ilb_ip" {
  description = "Static internal IP for Mattermost ILB"
  value       = google_compute_address.mattermost_ilb.address
}

output "gitea_ilb_ip" {
  description = "Static internal IP for Gitea ILB"
  value       = google_compute_address.gitea_ilb.address
}
