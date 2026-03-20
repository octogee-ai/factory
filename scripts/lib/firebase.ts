/**
 * Octogee Provisioner — Firebase Initialization
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as fs from "fs";
import { SA_KEY_PATH } from "./config.js";

// ── Firebase Init ───────────────────────────────────────────────────────────────

export let FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || "unknown";

if (!getApps().length) {
  if (fs.existsSync(SA_KEY_PATH)) {
    const saKey = JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf-8"));
    FIREBASE_PROJECT_ID = saKey.project_id || FIREBASE_PROJECT_ID;
    initializeApp({
      credential: cert(saKey),
      storageBucket: `${saKey.project_id}.firebasestorage.app`,
    });
    console.log(`${new Date().toISOString().replace("Z", "+00:00")} [provisioner] Firebase: service account key (${SA_KEY_PATH})`);
  } else {
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "unknown";
    FIREBASE_PROJECT_ID = projectId;
    initializeApp({
      storageBucket: `${projectId}.firebasestorage.app`,
    });
    console.log(`${new Date().toISOString().replace("Z", "+00:00")} [provisioner] Firebase: Application Default Credentials (Workload Identity)`);
  }
}

export const OCTOGEE_ENV = FIREBASE_PROJECT_ID === "octogee" ? "prod"
  : FIREBASE_PROJECT_ID === "octogee-test" ? "test" : "unknown";

console.log(`${new Date().toISOString().replace("Z", "+00:00")} [provisioner] Environment: ${OCTOGEE_ENV} (${FIREBASE_PROJECT_ID})`);

export const db = getFirestore();

export { getStorage };
