import { type GatewayDesiredStatus } from "./glm.js";
export declare const SHARED_POOL_SLOT_ID_PATTERN: RegExp;
export declare const DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED = true;
export declare const DEFAULT_SHARED_GATEWAY_BUILDERS_PER_GATEWAY = 4;
export interface SharedGatewayAutoscalingConfig {
    enabled: boolean;
    buildersPerGateway: number;
}
export interface SharedPoolReplicaBounds {
    minReplicas: number;
    maxReplicas: number;
}
export interface SharedPoolScalingMember {
    gatewayId: string;
    desiredStatus: GatewayDesiredStatus;
    assignmentCount: number;
    mountedCount: number;
    incomingMigrationCount: number;
    converged: boolean;
    platformCurrent: boolean;
}
export interface SharedPoolScalingInput {
    config: SharedGatewayAutoscalingConfig;
    bounds: SharedPoolReplicaBounds;
    members: readonly SharedPoolScalingMember[];
    builderDemandCount: number;
    replacement?: {
        sourceGatewayId: string;
        targetGatewayId: string;
    } | null;
    replacementStalled?: boolean;
}
export type SharedPoolScalingDecision = {
    kind: "hold";
    reason: "disabled" | "steady" | "converging" | "draining" | "malformed-config" | "malformed-state";
} | {
    kind: "resume-member";
    gatewayId: string;
    reason: "minimum-replicas" | "scale-out" | "cancel-drain";
} | {
    kind: "mint-slot";
    reason: "minimum-replicas" | "scale-out";
} | {
    kind: "mint-slot";
    reason: "platform-replacement";
    replacesGatewayId: string;
} | {
    kind: "finish-replacement";
} | {
    kind: "supersede-replacement";
    gatewayId: string;
} | {
    kind: "begin-drain";
    gatewayId: string;
} | {
    kind: "retire-member";
    gatewayId: string;
} | {
    kind: "max-capacity";
    assignmentCount: number;
    hotMemberCount: number;
};
export interface SharedGatewayPoolConfig {
    defaultGatewayId: string;
    sharedGatewayIds: readonly string[];
    sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig;
}
export interface SharedGatewayPoolCandidate {
    gatewayId: string;
    gatewayClass: string;
    desiredStatus: string;
    ready: boolean;
    serving: boolean;
    heartbeatFresh: boolean;
    liveReleaseReady: boolean;
    rosterComplete: boolean;
    incomingMigrationCount: number;
    assignmentCount: number;
}
export type SharedGatewaySelection = {
    kind: "selected";
    gatewayId: string;
    load: number;
    retainedCurrent: boolean;
} | {
    kind: "blocked";
    reason: "no-accepting-shared-gateway";
};
export interface SharedGatewayRebalance {
    fromGatewayId: string;
    toGatewayId: string;
}
export interface SharedPoolMemberRoot {
    gatewayId: string;
    gatewayClass: unknown;
    desiredStatus: unknown;
}
export declare function isSharedPoolSlotId(id: unknown): id is string;
export declare function compareSharedGatewayIds(left: string, right: string): number;
export declare function isSharedPoolMemberRoot(root: SharedPoolMemberRoot): boolean;
export declare function sharedPoolMemberIds(roots: readonly SharedPoolMemberRoot[]): string[];
export declare function deriveSharedGatewayPoolConfig(roots: readonly SharedPoolMemberRoot[], sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig): SharedGatewayPoolConfig | null;
export declare function parseSharedGatewayPoolConfig(value: unknown): SharedGatewayPoolConfig | null;
export declare function parseSharedGatewayAutoscalingConfig(value: unknown): SharedGatewayAutoscalingConfig | null;
export declare function parseSharedPoolReplicaBounds(value: {
    minReplicas: unknown;
    maxReplicas: unknown;
}): SharedPoolReplicaBounds | null;
export declare function authoritativeSharedGatewayLoad(candidate: SharedGatewayPoolCandidate): number;
export declare function isAcceptingSharedGateway(config: SharedGatewayPoolConfig, candidate: SharedGatewayPoolCandidate): boolean;
export declare function isSettledSharedGateway(config: SharedGatewayPoolConfig, candidate: SharedGatewayPoolCandidate): boolean;
export type SharedGatewayPlacementPurpose = "initial-placement" | "migration";
export interface SharedGatewayPlatformPreference {
    platformCurrentGatewayIds: readonly string[];
    buildersPerGateway: number;
}
export declare function platformPreferredSharedGatewayCandidates(input: {
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
    purpose: SharedGatewayPlacementPurpose;
    preference: SharedGatewayPlatformPreference;
    currentGatewayId?: string | null;
}): SharedGatewayPoolCandidate[];
export declare function stableGatewayUidHash(uid: string): number;
export declare function selectSharedGateway(input: {
    uid: string;
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
    purpose: SharedGatewayPlacementPurpose;
    currentGatewayId?: string | null;
}): SharedGatewaySelection;
export declare function planSharedGatewayRebalance(input: {
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
}): SharedGatewayRebalance | null;
