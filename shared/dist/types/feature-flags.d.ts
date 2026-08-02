export declare const FEATURE_FLAG_KEYS: readonly ["release-openclaw-dashboard", "release-agent-import", "release-agent-export", "release-builder-gateway"];
export type FeatureFlagKey = typeof FEATURE_FLAG_KEYS[number];
export interface FeatureFlagDefinition {
    userVisible: boolean;
}
export declare const FEATURE_FLAGS: Record<FeatureFlagKey, FeatureFlagDefinition>;
export declare const USER_VISIBLE_FEATURE_FLAG_KEYS: ("release-agent-export" | "release-agent-import" | "release-builder-gateway" | "release-openclaw-dashboard")[];
export interface FeatureSubject {
    uid: string;
    isAdmin: boolean;
    workspaceSlug?: string;
    planTier?: string;
    gatewayClass?: string;
    gatewayProfile?: string;
}
export type FeatureDecision = {
    state: "enabled";
    value: true;
} | {
    state: "disabled";
    value: false;
} | {
    state: "unavailable";
    value: false;
    reason: "timeout" | "provider_error";
};
export interface FeaturePolicy {
    evaluate(key: FeatureFlagKey, subject: FeatureSubject, context: string): Promise<FeatureDecision>;
}
export declare function isFeatureFlagKey(value: unknown): value is FeatureFlagKey;
