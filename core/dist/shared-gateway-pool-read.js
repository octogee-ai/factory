import { deriveSharedGatewayPoolConfig, parseSharedGatewayAutoscalingConfig, } from "@octogee/shared/types/shared-gateway-pool";
export const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";
export async function readSharedGatewayPoolConfigInStore(repositories) {
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
export async function readSharedGatewayAutoscalingConfigInStore(repositories) {
    const orchestrator = await repositories.config.orchestrator.get();
    const config = orchestrator === null
        ? parseSharedGatewayAutoscalingConfig(undefined)
        : orchestrator.sharedGatewayAutoscaling;
    if (config === null)
        throw new InvalidSharedGatewayAutoscalingConfigError();
    return config;
}
