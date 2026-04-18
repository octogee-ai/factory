/**
 * Single Firestore + Firebase Admin instance for the entire workspace-api.
 * Replaces 3 different init patterns from Cloud Functions.
 */
import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth: admin.auth.Auth = admin.auth();
export const storage: admin.storage.Storage = admin.storage();
export const messaging: admin.messaging.Messaging = admin.messaging();
const firebaseAdmin = admin;
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
