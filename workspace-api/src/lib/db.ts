import * as admin from "firebase-admin";

if (!admin.apps.length) {
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
