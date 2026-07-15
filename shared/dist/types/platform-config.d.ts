import type { ModelCatalogProvider } from "./model-catalog.js";
export declare const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export declare const PLATFORM_MODEL_CONFIG_DOC = "models";
export declare const DEFAULT_FREE_TIER_MODEL_REF = "platform-openrouter/deepseek/deepseek-v4-pro";
export interface PlatformModelConfig {
    freeTierModelRef: string;
}
export interface ResolvedFreeTierModel {
    ref: string;
    provider: ModelCatalogProvider;
    upstreamModelId: string;
}
export declare function parsePlatformModelConfig(value: unknown): PlatformModelConfig | null;
export declare function resolveFreeTierModel(ref: string): ResolvedFreeTierModel | null;
