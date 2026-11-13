export declare const PLACEMENT_RECEIPTS_SUBCOLLECTION = "placement_receipts";
export type PlacementReceiptKind = "activated" | "returned" | "activation-failed";
export interface PlacementReceipt {
    schemaVersion: 1;
    kind: PlacementReceiptKind;
    at: number;
    builderSlug: string | null;
    leaseId: string;
    generation: number;
    cause: string | null;
    sizingTier: string | null;
    entitlementTier: string | null;
    gatewayId: string;
    sharedGatewayId: string | null;
    requestedAt: number | null;
    wakeDurationMs: number | null;
    activeDurationMs: number | null;
    operationId: string | null;
    retirementOperationId: string | null;
    operatorTerminated: boolean;
    error: string | null;
}
export declare function placementReceiptDocId(leaseId: string, generation: number, kind: PlacementReceiptKind): string;
