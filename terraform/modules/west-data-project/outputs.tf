output "project_id" {
  value = google_project.data.project_id
}

output "project_number" {
  value = google_project.data.number
}

output "firestore_database" {
  value = google_firestore_database.default.name
}

output "firebase_storage_bucket" {
  value = google_storage_bucket.firebase.name
}
