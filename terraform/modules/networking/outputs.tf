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

output "workspace_api_ip" {
  description = "Static external IP for workspace-api Ingress"
  value       = google_compute_global_address.workspace_api.address
}

output "chat_proxy_ip" {
  description = "Static external IP for chat-proxy Ingress"
  value       = google_compute_global_address.chat_proxy.address
}

output "waf_policy_name" {
  description = "Cloud Armor WAF policy name — reference in Helm BackendConfigs"
  value       = google_compute_security_policy.waf.name
}
