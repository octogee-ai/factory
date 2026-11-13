import { lazyInstance } from "@octogee/core/lazy-instance";
import { getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getStorage, type Storage } from "firebase-admin/storage";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

function firebaseApp(): App {
  if (getApps().length === 0) {
    initializeApp({
      storageBucket: `${process.env.GCLOUD_PROJECT}.firebasestorage.app`,
    });
  }
  return getApp();
}

export const db: Firestore = lazyInstance(() => getFirestore(firebaseApp()));
export const auth: Auth = lazyInstance(() => getAuth(firebaseApp()));
export const storage: Storage = lazyInstance(() => getStorage(firebaseApp()));
export const messaging: Messaging = lazyInstance(() => getMessaging(firebaseApp()));
export { FieldValue, Timestamp };
