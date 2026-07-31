import { type GatewayDesiredStatus } from "./glm.js";
export declare const PRIMARY_SHARED_GATEWAY_ID = "shared-a";
export declare const STANDARD_SHARED_GATEWAY_IDS: readonly ["shared-a", "shared-b", "shared-c", "shared-d"];
export declare const DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS = 2;
export declare const DEFAULT_SHARED_GATEWAY_TARGET_ASSIGNMENTS_PER_MEMBER = 4;
export declare const DEFAULT_SHARED_GATEWAY_AUTOSCALING_COOLDOWN_MS = 300000;
export interface SharedGatewayAutoscalingConfig {
    minHotMembers: number;
    targetAssignmentsPerMember: number;
    cooldownMs: number;
}
export interface SharedGatewayAutoscalingMember {
    gatewayId: string;
    desiredStatus: GatewayDesiredStatus;
    assignmentCount: number;
    mountedCount: number;
    incomingMigrationCount: number;
    converged: boolean;
}
export interface SharedGatewayAutoscalingInput {
    config: SharedGatewayAutoscalingConfig;
    members: readonly SharedGatewayAutoscalingMember[];
    now: number;
    lastAutoscalingActionAt: number | null;
}
export type SharedGatewayAutoscalingDecision = {
    kind: "hold";
    reason: "steady" | "cooldown" | "converging" | "draining" | "minimum-hot-members" | "malformed-config" | "malformed-state";
} | {
    kind: "resume-member";
    gatewayId: string;
    reason: "minimum-hot-members" | "scale-out" | "cancel-drain";
} | {
    kind: "begin-drain";
    gatewayId: string;
} | {
    kind: "pause-drained-member";
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
    managedBy?: unknown;
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
export declare function parseSharedGatewayPoolConfig(value: unknown): SharedGatewayPoolConfig | null;
export declare function parseSharedGatewayAutoscalingConfig(value: unknown, memberCount: number): SharedGatewayAutoscalingConfig | null;
export declare function authoritativeSharedGatewayLoad(candidate: SharedGatewayPoolCandidate): number;
export declare function isAcceptingSharedGateway(config: SharedGatewayPoolConfig, candidate: SharedGatewayPoolCandidate): boolean;
export declare function stableGatewayUidHash(uid: string): number;
export declare function selectSharedGateway(input: {
    uid: string;
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
    currentGatewayId?: string | null;
}): SharedGatewaySelection;
export declare function planSharedGatewayRebalance(input: {
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
}): SharedGatewayRebalance | null;
