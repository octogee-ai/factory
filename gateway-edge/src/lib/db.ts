// Modular firebase-admin API — required under NodeNext ESM. The legacy
// `import * as admin from "firebase-admin"` namespace import lands the
// CJS surface under `.default` at runtime, so `admin.apps` is undefined
// and the process crashes at boot (`Cannot read properties of undefined
// (reading 'length')`). vitest's transpile hid it; the Node ESM loader
// is stricter. Same pattern functions/ uses for its ESM migration.
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
