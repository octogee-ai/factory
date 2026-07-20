import type { ModelCatalogProvider } from "./model-catalog.js";
export declare const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export declare const PLATFORM_MODEL_CONFIG_DOC = "models";
export declare const PLATFORM_CONNECT_CONFIG_DOC = "connect";
export type GoogleConnectStage = "off" | "allowlist" | "on";
export interface PlatformConnectConfig {
    googleStage: GoogleConnectStage;
    googleAllowlistUids: string[];
}
export declare const DEFAULT_PLATFORM_CONNECT_CONFIG: PlatformConnectConfig;
export declare function parsePlatformConnectConfig(value: unknown): PlatformConnectConfig | null;
export declare function googleConnectAllowed(config: PlatformConnectConfig | null, uid: string): boolean;
export declare const DEFAULT_FREE_TIER_MODEL_REF = "platform-openrouter/deepseek/deepseek-v4-pro";
export declare const DEFAULT_OPS_AGENT_MODEL_REF = "platform-openrouter/z-ai/glm-5.2";
export interface PlatformModelConfig {
    freeTierModelRef: string;
    opsAgentModelRef: string;
}
export interface ResolvedFreeTierModel {
    ref: string;
    provider: ModelCatalogProvider;
    upstreamModelId: string;
}
export interface ResolvedOpsAgentModel extends ResolvedFreeTierModel {
    runtimeModelRef: string;
}
export declare function parsePlatformModelConfig(value: unknown): PlatformModelConfig | null;
export declare function resolveFreeTierModel(ref: string): ResolvedFreeTierModel | null;
export declare function resolveOpsAgentModel(ref: string): ResolvedOpsAgentModel | null;
