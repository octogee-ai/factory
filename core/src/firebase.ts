import { createServiceLogger } from "@octogee/shared/server/service-logger";
const logger = createServiceLogger("provisioner");
import { getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage as storageForApp, type Storage } from "firebase-admin/storage";
import { lazyInstance } from "./lazy-instance.js";
import { platformStateStoreFromEnvironment } from "./platform-state/postgres/store-from-environment.js";

export const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "unknown";

function firebaseApp(): App {
  if (getApps().length === 0) {
    const options: { storageBucket: string; projectId?: string } = {
      storageBucket: `${FIREBASE_PROJECT_ID}.firebasestorage.app`,
    };
    if (FIREBASE_PROJECT_ID !== "unknown") {
      options.projectId = FIREBASE_PROJECT_ID;
    }
    initializeApp(options);
    logger.info(
      `Firebase: Application Default Credentials (Workload Identity) for ${FIREBASE_PROJECT_ID}`,
    );
  }
  return getApp();
}

export const db: Firestore = lazyInstance(() => getFirestore(firebaseApp()));

export const platformStateStore = lazyInstance(() => platformStateStoreFromEnvironment({
  applicationName: "octogee-provisioner",
  logger,
}));

export function getStorage(): Storage {
  return storageForApp(firebaseApp());
}
