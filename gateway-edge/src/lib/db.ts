

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getStorage, type Storage } from "firebase-admin/storage";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

if (getApps().length === 0) {
  initializeApp({
    storageBucket: `${process.env.GCLOUD_PROJECT}.firebasestorage.app`,
  });
}

export const db = getFirestore();
export const auth: Auth = getAuth();
export const storage: Storage = getStorage();
export const messaging: Messaging = getMessaging();
export { FieldValue, Timestamp };
