import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants as assertCorePlatformInvariants,
  platformInvariantTable as corePlatformInvariantTable,
  platformInvariantViolations as corePlatformInvariantViolations,
  reconcilePlatformInvariants as reconcileCorePlatformInvariants,
  type GatewayConfigClass,
  type PlatformInvariant,
  type SystemConfigInvariantContext,
} from "@octogee/core/system-config-invariants";
import {
  resolveControlIdentityFromEnv,
  resolveOwnerUidFromEnv,
} from "@octogee/shared/types/openclaw-proxy-identity";

export {
  PlatformInvariantPolicyError,
  type PlatformInvariant,
  type SystemConfigInvariantContext,
};

export function systemConfigInvariantContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SystemConfigInvariantContext {
  const rawClass = env.GATEWAY_CLASS ?? env.GATEWAY_PROFILE ?? "shared";
  const gatewayClass: GatewayConfigClass = rawClass === "builder" ? "builder" : "shared";
  return {
    gatewayClass,
    ...(env.GATEWAY_ID ? { gatewayId: env.GATEWAY_ID } : {}),
    ...(env.API_PUBLIC_URL ? { apiOrigin: env.API_PUBLIC_URL } : {}),
    controlIdentity: resolveControlIdentityFromEnv(env),
    ...(resolveOwnerUidFromEnv(env) ? { ownerUid: resolveOwnerUidFromEnv(env) } : {}),
  };
}

export function platformInvariantTable(
  env: NodeJS.ProcessEnv = process.env,
): readonly PlatformInvariant[] {
  return corePlatformInvariantTable(systemConfigInvariantContextFromEnv(env));
}

export function platformInvariantViolations(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return corePlatformInvariantViolations(config, systemConfigInvariantContextFromEnv(env));
}

export function assertPlatformInvariants(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertCorePlatformInvariants(config, systemConfigInvariantContextFromEnv(env));
}

export function reconcilePlatformInvariants(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { changedPaths: string[] } {
  return reconcileCorePlatformInvariants(config, systemConfigInvariantContextFromEnv(env));
}
