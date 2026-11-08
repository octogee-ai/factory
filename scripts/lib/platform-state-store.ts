import type { Firestore } from "firebase-admin/firestore";
import {
  createFirestorePlatformStateStore,
  platformStateStoreForDeploymentTarget,
  type PlatformStateStore,
} from "@octogee/core/platform-state";

export function operatorPlatformStateStore(db: Firestore, deploymentTargetId: string): Promise<PlatformStateStore> {
  return platformStateStoreForDeploymentTarget({
    deploymentTargetId,
    applicationName: "octogee-operator",
    createFirestoreStore: () => createFirestorePlatformStateStore({ db }),
    logger: console,
  });
}
