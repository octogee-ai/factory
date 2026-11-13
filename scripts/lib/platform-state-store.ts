import { deploymentTargetForFirebaseProject } from "@octogee/core/deployment-environment";
import { platformStateStoreForDeploymentTarget, type PlatformStateStore } from "@octogee/core/platform-state";

export async function operatorPlatformStateStore(deploymentTargetId: string): Promise<PlatformStateStore> {
  if (!process.env.PLATFORM_DB_HOST) {
    throw new Error(
      `No platform database is open for ${deploymentTargetId}. ` +
      "Run this command through `npm run --prefix scripts with-platform-state -- --env=<test|prod> -- <command>`, " +
      "which opens the database tunnel and sets the PLATFORM_DB_* settings.",
    );
  }
  return platformStateStoreForDeploymentTarget({
    deploymentTargetId,
    applicationName: "octogee-operator",
    logger: console,
  });
}

export function operatorPlatformStateStoreForFirebaseProject(projectId: string): Promise<PlatformStateStore> {
  return operatorPlatformStateStore(deploymentTargetForFirebaseProject(projectId).targetId);
}
