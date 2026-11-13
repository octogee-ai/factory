output "project_id" {
  value = google_project.customer_hosting.project_id
}

output "publisher_service_account_email" {
  value = google_service_account.publisher.email
}

output "journal_bucket" {
  value = google_storage_bucket.publish_journal.name
}

output "default_site_id" {
  value = google_firebase_hosting_site.default.site_id
}
