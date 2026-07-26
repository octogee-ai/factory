import type { Firestore } from "firebase-admin/firestore";
export type BuilderRuntimeDemandCause = "run-start" | "ticket" | "scheduled" | "shell" | "manual";
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
