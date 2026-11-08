import { type SharedGatewayAutoscalingConfig, type SharedGatewayPoolConfig } from "@octogee/shared/types/shared-gateway-pool";
import type { PlatformStateRepositories } from "./platform-state/store.js";
export declare const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";
export declare function readSharedGatewayPoolConfigInStore(repositories: Pick<PlatformStateRepositories, "gateways">): Promise<SharedGatewayPoolConfig | null>;
export declare class InvalidSharedGatewayAutoscalingConfigError extends Error {
    constructor();
}
export declare function readSharedGatewayAutoscalingConfigInStore(repositories: Pick<PlatformStateRepositories, "config">): Promise<SharedGatewayAutoscalingConfig>;
