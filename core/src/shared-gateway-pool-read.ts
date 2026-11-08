import {
  deriveSharedGatewayPoolConfig,
  parseSharedGatewayAutoscalingConfig,
  type SharedGatewayAutoscalingConfig,
  type SharedGatewayPoolConfig,
} from "@octogee/shared/types/shared-gateway-pool";
import type { PlatformStateRepositories } from "./platform-state/store.js";

export const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";

export async function readSharedGatewayPoolConfigInStore(
  repositories: Pick<PlatformStateRepositories, "gateways">,
): Promise<SharedGatewayPoolConfig | null> {
  const roots = await repositories.gateways.roots.list({ gatewayClass: "shared" });
  return deriveSharedGatewayPoolConfig(roots.map((root) => ({
    gatewayId: root.gatewayId,
    gatewayClass: root.gatewayClass,
    desiredStatus: root.desiredStatus,
  })));
}

export class InvalidSharedGatewayAutoscalingConfigError extends Error {
  constructor() {
    super(`${ORCHESTRATOR_CONFIG_DOC_PATH}.sharedGatewayAutoscaling is invalid`);
  }
}

export async function readSharedGatewayAutoscalingConfigInStore(
  repositories: Pick<PlatformStateRepositories, "config">,
): Promise<SharedGatewayAutoscalingConfig> {
  const orchestrator = await repositories.config.orchestrator.get();
  const config = orchestrator === null
    ? parseSharedGatewayAutoscalingConfig(undefined)
    : orchestrator.sharedGatewayAutoscaling;
  if (config === null) throw new InvalidSharedGatewayAutoscalingConfigError();
  return config;
}
