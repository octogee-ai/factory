import type { IsolatedGatewayAllocation } from "./gateway-mutable-config.js";
export interface ContinuousPlacementOwnedGateway {
    gatewayId: string;
    gatewayClass: string;
    ownerUid: string | null;
    desiredStatus: string;
    ready: boolean;
    disposable?: boolean;
    allocation?: IsolatedGatewayAllocation | null;
}
export interface ContinuousUserPlacementInput {
    uid: string;
    userData: Record<string, unknown>;
    currentGatewayId: string | null;
    defaultGatewayId: string;
    ownedGateway: ContinuousPlacementOwnedGateway | null;
    now?: Date;
}
export interface ContinuousUserPlacement {
    targetGatewayId: string;
    ownedGatewayId: string | null;
}
export declare function resolveLiveActivationTargetGatewayId(input: Pick<ContinuousUserPlacementInput, "userData" | "now">): string | null;
export declare function resolveContinuousUserPlacement(input: ContinuousUserPlacementInput): ContinuousUserPlacement;
export type DefaultPlacementEligibility = {
    eligible: true;
    slug: string;
} | {
    eligible: false;
    reason: "not-admitted" | "provisioning-not-started" | "builder-slug-missing" | "account-not-interactive" | "operator-managed";
};
export declare function resolveDefaultPlacementEligibility(data: Record<string, unknown>): DefaultPlacementEligibility;
