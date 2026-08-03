import type { GatewayDesiredStatus } from "@octogee/shared/types/glm";

export interface MigrationGatewayRoot {
  desiredStatus: GatewayDesiredStatus;
  desiredRelease: number;
  liveRelease: number | null;
}

function releaseIsConverged(root: MigrationGatewayRoot): boolean {
  return root.liveRelease !== null && root.desiredRelease === root.liveRelease;
}

export function migrationSourceRootIsStable(root: MigrationGatewayRoot): boolean {
  return (
    (root.desiredStatus === "running" || root.desiredStatus === "draining") &&
    releaseIsConverged(root)
  );
}

export function migrationTargetRootIsStable(root: MigrationGatewayRoot): boolean {
  return root.desiredStatus === "running" && releaseIsConverged(root);
}
