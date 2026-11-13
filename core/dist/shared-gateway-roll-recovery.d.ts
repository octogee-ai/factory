import type { PlatformStateStore } from "./platform-state/store.js";
export interface SupersedeRollingSharedGatewayRollInput {
    sourceGatewayId: string;
    targetGatewayId: string;
    expectedLiveRelease: number;
    expectedDesiredRelease: number;
    targetHeartbeatMaxAgeMs?: number;
}
export type SupersedeRollingSharedGatewayRollResult = {
    kind: "scheduled";
    release: number;
    operationId: string;
} | {
    kind: "already-scheduled";
    release: number;
    operationId: string;
} | {
    kind: "not-eligible";
};
export interface SharedGatewayRollRecoveryDeps {
    store: PlatformStateStore;
    now: () => number;
}
export declare function supersedeRollingSharedGatewayRoll(deps: SharedGatewayRollRecoveryDeps, input: SupersedeRollingSharedGatewayRollInput): Promise<SupersedeRollingSharedGatewayRollResult>;
