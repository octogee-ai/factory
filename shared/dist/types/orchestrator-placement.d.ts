export interface OnboardingOrchestratorConfig {
    defaultGatewayId: string;
}
export type OnboardingPlacementEligibility = {
    eligible: true;
    slug: string;
} | {
    eligible: false;
    reason: "onboarding-incomplete" | "provisioning-not-started" | "builder-slug-missing";
};
export declare function resolveOnboardingPlacementEligibility(data: Record<string, unknown>): OnboardingPlacementEligibility;
