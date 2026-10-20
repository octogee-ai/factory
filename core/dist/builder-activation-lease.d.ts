import type { Firestore } from "firebase-admin/firestore";
export type BuilderRuntimeDemandCause = "run-start" | "chat" | "scheduled" | "manual";
export type BuilderActivationLeaseResult = {
    statusCode: number;
    body: Record<string, unknown>;
};
export interface BuilderRuntimeDemandRequest {
    db: Firestore;
    uid: string;
    reportingGatewayId?: string;
    assignmentEpoch?: number;
    eventKey?: string;
    cause?: BuilderRuntimeDemandCause;
    observedAt?: number;
    createdBy: string;
    now?: number;
    leaseIdFactory?: () => string;
}
export declare function requestBuilderActivationLease(input: BuilderRuntimeDemandRequest): Promise<BuilderActivationLeaseResult>;
export declare function builderActivateOperationId(gatewayId: string, generation: number): string;
export declare function builderReturnOperationId(gatewayId: string, generation: number): string;
export declare function builderRecoverOperationId(gatewayId: string, generation: number): string;
export declare function placementRetireOperationId(uid: string, gatewayId: string, generation: number): string;
export declare function isBuilderActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
export declare function isBuilderReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
