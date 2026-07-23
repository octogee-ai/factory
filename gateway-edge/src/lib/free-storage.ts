import type { TierResolvable } from "@octogee/shared/types/billing";
import { resolveCommercialEntitlements } from "@octogee/shared/types/commercial-entitlements";
import type { PlatformFreeConfig } from "@octogee/shared/types/platform-config";

export function freeWorkspaceStorageLimitBytes(
  userData: TierResolvable,
  projectStorage: boolean,
  config: PlatformFreeConfig,
): number | undefined {
  if (
    projectStorage ||
    resolveCommercialEntitlements(userData).projectMode === "active"
  ) {
    return undefined;
  }
  return config.workspaceStorageGb * 1024 ** 3;
}
