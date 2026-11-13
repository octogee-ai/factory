output "project_id" {
  value = google_project.data.project_id
}

output "project_number" {
  value = google_project.data.number
}

output "runtime_ready_project_id" {
  value      = google_project.data.project_id
  depends_on = [google_project_service_identity.eventarc]
}

output "firestore_database" {
  value = google_firestore_database.default.name
}

output "firebase_storage_bucket" {
  value = google_storage_bucket.firebase.name
}

output "firebase_web_app_id" {
  value = google_firebase_web_app.platform.app_id
}
