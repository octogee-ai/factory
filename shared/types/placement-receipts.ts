export const PLACEMENT_RECEIPTS_SUBCOLLECTION = "placement_receipts";

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

export function placementReceiptDocId(
  leaseId: string,
  generation: number,
  kind: PlacementReceiptKind,
): string {
  if (leaseId.length === 0) throw new Error("placement receipt requires a lease id");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("placement receipt requires a valid generation");
  }
  return `${leaseId}-${generation}-${kind}`;
}
