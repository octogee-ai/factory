import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { deploymentEnvironmentForProject } from "./deployment-environment.js";

export const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "unknown";

if (!getApps().length) {
  const options: { storageBucket: string; projectId?: string } = {
    storageBucket: `${FIREBASE_PROJECT_ID}.firebasestorage.app`,
  };
  if (FIREBASE_PROJECT_ID !== "unknown") {
    options.projectId = FIREBASE_PROJECT_ID;
  }
  initializeApp(options);
  console.log(
    `${new Date().toISOString().replace("Z", "+00:00")} [provisioner] Firebase: Application Default Credentials (Workload Identity)`,
  );
}

export const OCTOGEE_ENV = deploymentEnvironmentForProject(FIREBASE_PROJECT_ID);

console.log(`${new Date().toISOString().replace("Z", "+00:00")} [provisioner] Environment: ${OCTOGEE_ENV} (${FIREBASE_PROJECT_ID})`);

export const db = getFirestore();

export { getStorage };
