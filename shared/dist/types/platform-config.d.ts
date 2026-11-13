import type { ModelCatalogProvider } from "./model-catalog.js";
export declare const DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS: number;
export interface PlatformRuntimeConfig {
    disposableGatewayIdleMs: number;
}
export declare const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export declare const PLATFORM_MODEL_CONFIG_DOC = "models";
export declare const PLATFORM_CONNECT_CONFIG_DOC = "connect";
export declare const PLATFORM_FREE_CONFIG_DOC = "free";
export interface PlatformFreeConfig {
    schemaVersion: 1;
    workspaceStorageGb: number;
    updatedAt?: unknown;
    updatedBy?: string;
}
export declare const DEFAULT_PLATFORM_FREE_CONFIG: PlatformFreeConfig;
export declare function parsePlatformFreeConfig(value: unknown): PlatformFreeConfig | null;
export type GoogleConnectStage = "off" | "allowlist" | "on";
export declare const GOOGLE_CONNECT_STAGES: readonly GoogleConnectStage[];
export declare const GOOGLE_CONNECT_CAPABILITY_KEYS: readonly ["calendar", "gmail", "drive", "drive-full", "tasks", "contacts"];
export type GoogleConnectCapabilityKey = (typeof GOOGLE_CONNECT_CAPABILITY_KEYS)[number];
export type GoogleConnectStages = Record<GoogleConnectCapabilityKey, GoogleConnectStage>;
export interface PlatformConnectConfig {
    googleStages: GoogleConnectStages;
    googleAllowlistUids: string[];
}
export declare const DEFAULT_PLATFORM_CONNECT_CONFIG: PlatformConnectConfig;
export declare function isGoogleConnectCapabilityKey(value: unknown): value is GoogleConnectCapabilityKey;
export declare function parseGoogleConnectStages(value: unknown): GoogleConnectStages | null;
export declare function parsePlatformConnectConfig(value: unknown): PlatformConnectConfig | null;
export declare function googleCapabilityConnectAllowed(config: PlatformConnectConfig | null, uid: string, capability: GoogleConnectCapabilityKey): boolean;
export declare function googleConnectAllowed(config: PlatformConnectConfig | null, uid: string): boolean;
export interface GoogleConsentPermission {
    permitted: GoogleConnectCapabilityKey[];
    excluded: GoogleConnectCapabilityKey[];
}
export declare function googleConsentPermission(config: PlatformConnectConfig | null, uid: string, requested: readonly GoogleConnectCapabilityKey[]): GoogleConsentPermission;
export declare const DEFAULT_HOUSE_MODEL_REF: string;
export declare const DEFAULT_OPS_AGENT_MODEL_REF = "platform-openrouter/openai/gpt-6-luna";
export declare const DEFAULT_USER_AGENT_MODEL_REF: string;
export declare const DEFAULT_USER_AGENT_FALLBACK_MODEL_REF: string | null;
export interface UserAgentModelDefault {
    primary: string;
    fallbacks: string[];
}
export interface PlatformModelConfig {
    freeTierModelRef: string;
    opsAgentModelRef: string;
    builderAgentModelRef: string;
    builderAgentFallbackModelRef: string | null;
}
export interface ResolvedHouseModel {
    ref: string;
    provider: ModelCatalogProvider;
    upstreamModelId: string;
}
export interface ResolvedOpsAgentModel extends ResolvedHouseModel {
    runtimeModelRef: string;
}
export declare function parsePlatformModelConfig(value: unknown): PlatformModelConfig | null;
export declare function userAgentModelDefaultFromDoc(data: unknown): UserAgentModelDefault;
export declare function parseUserAgentModelDefault(value: unknown): UserAgentModelDefault | null;
export declare function resolveHouseModel(ref: string): ResolvedHouseModel | null;
export declare function resolveOpsAgentModel(ref: string): ResolvedOpsAgentModel | null;
