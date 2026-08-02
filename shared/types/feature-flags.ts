export const FEATURE_FLAG_KEYS = [
  "release-openclaw-dashboard",
  "release-agent-import",
  "release-agent-export",
  "release-builder-gateway",
] as const;

export type FeatureFlagKey = typeof FEATURE_FLAG_KEYS[number];

export interface FeatureFlagDefinition {
  userVisible: boolean;
}

export const FEATURE_FLAGS: Record<FeatureFlagKey, FeatureFlagDefinition> = {
  "release-openclaw-dashboard": { userVisible: true },
  "release-agent-import": { userVisible: true },
  "release-agent-export": { userVisible: true },
  "release-builder-gateway": { userVisible: true },
};

export const USER_VISIBLE_FEATURE_FLAG_KEYS = FEATURE_FLAG_KEYS.filter(
  (key) => FEATURE_FLAGS[key].userVisible,
);

export interface FeatureSubject {
  uid: string;
  isAdmin: boolean;
  workspaceSlug?: string;
  planTier?: string;
  gatewayClass?: string;
  gatewayProfile?: string;
}

export type FeatureDecision =
  | { state: "enabled"; value: true }
  | { state: "disabled"; value: false }
  | { state: "unavailable"; value: false; reason: "timeout" | "provider_error" };

export interface FeaturePolicy {
  evaluate(
    key: FeatureFlagKey,
    subject: FeatureSubject,
    context: string,
  ): Promise<FeatureDecision>;
}

export function isFeatureFlagKey(value: unknown): value is FeatureFlagKey {
  return typeof value === "string" && (FEATURE_FLAG_KEYS as readonly string[]).includes(value);
}
