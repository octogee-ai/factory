/**
 * Single Firestore + Firebase Admin instance for the entire workspace-api.
 * Replaces 3 different init patterns from Cloud Functions.
 */
import * as admin from "firebase-admin";

if (!admin.apps.length) {
  // Default storageBucket derived from the GKE project — TEST runs in
  // octogee-test → octogee-test.firebasestorage.app, PROD in octogee →
  // octogee.firebasestorage.app. Without this, every `storage.bucket()`
  // call (no-arg, relying on the default) throws "Bucket name not
  // specified or invalid" — observed on TEST 2026-04-26 as a 400 from
  // POST /api/profile/avatar (Coach + user avatar uploads), and would
  // hit workspace/extract-zip + workspace/import-repo identically.
  admin.initializeApp({
    storageBucket: `${process.env.GCLOUD_PROJECT}.firebasestorage.app`,
  });
}

export const db = admin.firestore();
export const auth: admin.auth.Auth = admin.auth();
export const storage: admin.storage.Storage = admin.storage();
export const messaging: admin.messaging.Messaging = admin.messaging();
const firebaseAdmin = admin;
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
