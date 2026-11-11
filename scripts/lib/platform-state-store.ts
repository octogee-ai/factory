import type { Firestore } from "firebase-admin/firestore";
import { deploymentTargetForFirebaseProject } from "@octogee/core/deployment-environment";
import {
  createFirestorePlatformStateStore,
  platformStateStoreForDeploymentTarget,
  type PlatformStateStore,
} from "@octogee/core/platform-state";

export async function operatorPlatformStateStore(db: Firestore, deploymentTargetId: string): Promise<PlatformStateStore> {
  const backend = process.env.PLATFORM_STATE_BACKEND;
  if (backend !== "firestore" && backend !== "postgres") {
    throw new Error(
      `PLATFORM_STATE_BACKEND must name ${deploymentTargetId}'s platform state store (firestore or postgres). ` +
      "Run this command through `npm run --prefix scripts with-platform-state -- --env=<test|prod> -- <command>`, " +
      "which reads the deployed backend and opens the database tunnel.",
    );
  }
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
