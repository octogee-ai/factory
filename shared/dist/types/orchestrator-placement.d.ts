import type { DisposableBuilderGatewayAllocation } from "./gateway-mutable-config.js";
import type { ManagedBy } from "./glm.js";
export interface OnboardingOrchestratorConfig {
    defaultGatewayId: string;
}
export interface ContinuousPlacementOwnedGateway {
    gatewayId: string;
    gatewayClass: string;
    ownerUid: string | null;
    desiredStatus: string;
    ready: boolean;
    managedBy?: ManagedBy;
    disposable?: boolean;
    allocation?: DisposableBuilderGatewayAllocation | null;
}
export interface ContinuousBuilderPlacementInput {
    uid: string;
    userData: Record<string, unknown>;
    currentGatewayId: string | null;
    defaultGatewayId: string;
    ownedGateway: ContinuousPlacementOwnedGateway | null;
    now?: Date;
}
export interface ContinuousBuilderPlacement {
    targetGatewayId: string;
    ownedGatewayId: string | null;
}
export declare function resolveLiveActivationTargetGatewayId(input: Pick<ContinuousBuilderPlacementInput, "userData" | "now">): string | null;
export declare function resolveContinuousBuilderPlacement(input: ContinuousBuilderPlacementInput): ContinuousBuilderPlacement;
export type OnboardingPlacementEligibility = {
    eligible: true;
    slug: string;
} | {
    eligible: false;
    reason: "onboarding-incomplete" | "provisioning-not-started" | "builder-slug-missing";
};
export declare function resolveOnboardingPlacementEligibility(data: Record<string, unknown>): OnboardingPlacementEligibility;
