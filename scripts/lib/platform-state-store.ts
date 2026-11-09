import type { Firestore } from "firebase-admin/firestore";
import { deploymentTargetForFirebaseProject } from "@octogee/core/deployment-environment";
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

export function operatorPlatformStateStoreForFirebaseProject(db: Firestore, projectId: string): Promise<PlatformStateStore> {
  return operatorPlatformStateStore(db, deploymentTargetForFirebaseProject(projectId).targetId);
}

export function assertFirestorePlatformBackend(command: string, environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.PLATFORM_STATE_BACKEND === "postgres") {
    throw new Error(`${command} only handles Firestore platform state and refuses to run with PLATFORM_STATE_BACKEND=postgres`);
  }
}
