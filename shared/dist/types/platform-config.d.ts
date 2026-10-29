import type { TrialGrant } from "./billing.js";
import { type BuilderTierName, type PersonalTierName } from "./billing-tiers.js";
import type { ModelCatalogProvider } from "./model-catalog.js";
import { DEFAULT_SIGNUP_OFFER_BUDGET_POLICY, parseSignupOfferBudgetPolicy, type ModelBrokerSignupOfferBudget, type SignupOfferBudgetPolicy } from "./signup-offer.js";
export { DEFAULT_SIGNUP_OFFER_BUDGET_POLICY, parseSignupOfferBudgetPolicy, };
export type { SignupOfferBudgetPolicy };
export declare const DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS: number;
export interface PlatformRuntimeConfig {
    disposableGatewayIdleMs: number;
}
export declare const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export declare const PLATFORM_MODEL_CONFIG_DOC = "models";
export declare const PLATFORM_CONNECT_CONFIG_DOC = "connect";
export declare const PLATFORM_FREE_CONFIG_DOC = "free";
export declare const PLATFORM_TRIAL_CONFIG_DOC = "trial";
export declare const TRIAL_CONFIG_SCHEMA_VERSION: 2;
export interface PlatformFreeConfig {
    schemaVersion: 1;
    workspaceStorageGb: number;
    updatedAt?: unknown;
    updatedBy?: string;
}
export declare const DEFAULT_PLATFORM_FREE_CONFIG: PlatformFreeConfig;
export declare function parsePlatformFreeConfig(value: unknown): PlatformFreeConfig | null;
export type TrialBuilderTier = Exclude<BuilderTierName, "enterprise">;
export interface PlatformTrialConfig {
    schemaVersion: typeof TRIAL_CONFIG_SCHEMA_VERSION;
    offerId: string;
    offerVersion: number;
    durationDays: number;
    defaultPersonalTier: PersonalTierName;
    defaultBuilderTier: TrialBuilderTier | null;
    budgetPolicy: SignupOfferBudgetPolicy;
    updatedAt?: unknown;
    updatedBy?: string;
}
export declare const DEFAULT_PLATFORM_TRIAL_CONFIG: PlatformTrialConfig;
export declare function parsePlatformTrialConfig(value: unknown): PlatformTrialConfig | null;
export declare function trialConfigHash(config: PlatformTrialConfig): string;
export declare function createSignupOffer(uid: string, config: PlatformTrialConfig, claimedAtMs: number): {
    grant: TrialGrant;
    budgetKey: string;
    budget: ModelBrokerSignupOfferBudget;
};
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
export declare const DEFAULT_FREE_TIER_MODEL_REF = "platform-openrouter/deepseek/deepseek-v4-pro";
export declare const DEFAULT_OPS_AGENT_MODEL_REF = "platform-openrouter/openai/gpt-6-luna";
export declare const DEFAULT_BUILDER_AGENT_MODEL_REF = "platform-openrouter/openai/gpt-5.6-luna";
export declare const DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF: string | null;
export interface BuilderAgentModelDefault {
    primary: string;
    fallbacks: string[];
}
export interface PlatformModelConfig {
    freeTierModelRef: string;
    opsAgentModelRef: string;
    builderAgentModelRef: string;
    builderAgentFallbackModelRef: string | null;
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
export declare function builderAgentModelDefaultFromDoc(data: unknown): BuilderAgentModelDefault;
export declare function parseBuilderAgentModelDefault(value: unknown): BuilderAgentModelDefault | null;
export declare function resolveFreeTierModel(ref: string): ResolvedFreeTierModel | null;
export declare function resolveOpsAgentModel(ref: string): ResolvedOpsAgentModel | null;
