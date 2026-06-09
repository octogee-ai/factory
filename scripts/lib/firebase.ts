import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

export const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "unknown";

if (!getApps().length) {
  initializeApp({
    storageBucket: `${FIREBASE_PROJECT_ID}.firebasestorage.app`,
  });
  console.log(
    `${new Date().toISOString().replace("Z", "+00:00")} [provisioner] Firebase: Application Default Credentials (Workload Identity)`,
  );
}

function resolveOctogeeEnv(projectId: string): "prod" | "test" | "unknown" {
  if (projectId === "octogee") return "prod";
  if (projectId === "octogee-test") return "test";
  return "unknown";
}

export const OCTOGEE_ENV = resolveOctogeeEnv(FIREBASE_PROJECT_ID);

console.log(`${new Date().toISOString().replace("Z", "+00:00")} [provisioner] Environment: ${OCTOGEE_ENV} (${FIREBASE_PROJECT_ID})`);

export const db = getFirestore();

export { getStorage };
