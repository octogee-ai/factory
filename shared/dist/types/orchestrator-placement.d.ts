export interface OnboardingOrchestratorConfig {
    defaultGatewayId: string;
    overrides?: Record<string, string>;
    onboardingCohorts?: Record<string, {
        gatewayId?: string;
        [key: string]: unknown;
    }>;
}
export type OnboardingPlacementDecision = {
    kind: "gateway-override";
    gatewayId: string;
} | {
    kind: "default";
    gatewayId: string;
};
export type OnboardingPlacementEligibility = {
    eligible: true;
    slug: string;
} | {
    eligible: false;
    reason: "onboarding-incomplete" | "provisioning-not-started" | "builder-slug-missing";
};
export declare function resolveOnboardingPlacementEligibility(data: Record<string, unknown>): OnboardingPlacementEligibility;
export interface PlacementPointerRewriteResult {
    config: OnboardingOrchestratorConfig;
    changedPointers: string[];
}
export declare function resolveOnboardingPlacementForUid(uid: string, config: OnboardingOrchestratorConfig): OnboardingPlacementDecision;
export declare function rewritePlacementGatewayPointers(config: OnboardingOrchestratorConfig, sourceGatewayId: string, targetGatewayId: string): PlacementPointerRewriteResult;
