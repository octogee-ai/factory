export const PLACEMENT_RECEIPTS_SUBCOLLECTION = "placement_receipts";
export function placementReceiptDocId(leaseId, generation, kind) {
    if (leaseId.length === 0)
        throw new Error("placement receipt requires a lease id");
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("placement receipt requires a valid generation");
    }
    return `${leaseId}-${generation}-${kind}`;
}
