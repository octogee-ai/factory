export const FEATURE_FLAG_KEYS = [
  "release-openclaw-dashboard",
  "release-agent-import",
  "release-agent-export",
  "release-builder-gateway",
  "release-obsidian-connection",
  "release-workspace-sharing",
  "release-project-repo-source",
  "release-voice-talk",
  "release-coach-readiness",
] as const;

export type FeatureFlagKey = typeof FEATURE_FLAG_KEYS[number];

export interface FeatureFlagDefinition {
  userVisible: boolean;
  adminBypass?: boolean;
}

export const FEATURE_FLAGS: Record<FeatureFlagKey, FeatureFlagDefinition> = {
  "release-openclaw-dashboard": { userVisible: true },
  "release-agent-import": { userVisible: true },
  "release-agent-export": { userVisible: true },
  "release-builder-gateway": { userVisible: true },
  "release-obsidian-connection": { userVisible: true },
  "release-workspace-sharing": { userVisible: true },
  "release-project-repo-source": { userVisible: true, adminBypass: true },
  "release-voice-talk": { userVisible: true, adminBypass: true },
  "release-coach-readiness": { userVisible: true },
};

export function featureFlagBypassedForAdmin(
  key: FeatureFlagKey,
  subject: FeatureSubject,
): boolean {
  return subject.isAdmin === true && FEATURE_FLAGS[key].adminBypass === true;
}

export const USER_VISIBLE_FEATURE_FLAG_KEYS = FEATURE_FLAG_KEYS.filter(
  (key) => FEATURE_FLAGS[key].userVisible,
);

export interface FeatureSubject {
  uid: string;
  isAdmin: boolean;
  workspaceSlug?: string;
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
