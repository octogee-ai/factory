import { userEntitlements, type UserEntitlementInputs } from "@octogee/shared/types/user-entitlements";
import type { PlatformFreeConfig } from "@octogee/shared/types/platform-config";

export function freeWorkspaceStorageLimitBytes(
  userData: UserEntitlementInputs,
  projectStorage: boolean,
  config: PlatformFreeConfig,
): number | undefined {
  if (
    projectStorage ||
    userEntitlements().projectMode(userData) === "active"
  ) {
    return undefined;
  }
  return config.workspaceStorageGb * 1024 ** 3;
}
