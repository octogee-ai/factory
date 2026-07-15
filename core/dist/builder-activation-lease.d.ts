import type { Firestore } from "firebase-admin/firestore";
export type ActivationGatewayClass = "builder" | "operator";
export interface FirestoreDocLike {
    id: string;
    data(): Record<string, unknown>;
}
export interface RolloutBodyError {
    status: number;
    body: Record<string, unknown>;
}
export interface BuilderActivationTarget {
    gatewayId: string;
    gatewayClass: ActivationGatewayClass;
    desiredStatus: "running" | "paused" | "draining" | "retired" | null;
    builderSlug: string | null;
}
export type BuilderActivationPlan = {
    ok: {
        action: "already-active";
        target: BuilderActivationTarget;
    } | {
        action: "wake";
        target: BuilderActivationTarget;
        status: string;
    } | {
        action: "migrate";
        target: BuilderActivationTarget;
    };
} | {
    error: RolloutBodyError;
};
export type BuilderActivationLeaseResult = {
    statusCode: number;
    body: Record<string, unknown>;
};
type WorkspaceSlugsForUser = (data: {
    username?: string | null;
}) => string[];
export declare function findPendingActivationOperation(docs: ReadonlyArray<FirestoreDocLike>, uid: string, gatewayId: string, source: string): {
    id: string;
    kind: unknown;
} | null;
export declare function resolveBuilderActivationPlan(opts: {
    uid: string;
    builderSlug: string;
    currentGatewayId: string | null;
    requestedGatewayClass?: ActivationGatewayClass;
    gateways: ReadonlyArray<FirestoreDocLike>;
    gatewayHeartbeats: ReadonlyMap<string, Record<string, unknown>>;
    pendingOps: ReadonlyArray<FirestoreDocLike>;
}): BuilderActivationPlan;
export declare function requestBuilderActivationLease(opts: {
    db: Firestore;
    uid: string;
    requestedGatewayClass?: ActivationGatewayClass;
    reason?: string;
    createdBy: string;
    workspaceSlugsForUser: WorkspaceSlugsForUser;
    now?: number;
}): Promise<BuilderActivationLeaseResult>;
export declare function activationLeaseMissCanMintTicket(result: BuilderActivationLeaseResult): boolean;
export {};
