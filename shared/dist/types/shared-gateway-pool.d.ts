export interface SharedGatewayPoolConfig {
    defaultGatewayId: string;
    sharedGatewayIds: readonly string[];
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
    converging: boolean;
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
