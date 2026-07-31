import type { Firestore } from "firebase-admin/firestore";
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
    db: Firestore;
    now: () => number;
}
export declare function supersedeRollingSharedGatewayRoll(deps: SharedGatewayRollRecoveryDeps, input: SupersedeRollingSharedGatewayRollInput): Promise<SupersedeRollingSharedGatewayRollResult>;
