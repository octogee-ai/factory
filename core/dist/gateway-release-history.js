import { revisionIdForRelease, } from "@octogee/shared/types/gateway-releases";
// A normal release cut always sources from the immediately-preceding release
// (appendGatewayRelease sets sourceRelease = latestRelease = release - 1). A
// rollback cuts release = latest + 1 whose source is an EARLIER release (the
// same-payload target is rejected as a no-op, so the source is always ≤
// release - 2). Therefore a release is a rollback iff its source is not its
// immediate predecessor — a marker that survives retention pruning of the
// source doc (no payload-hash lookup needed).
function rollbackSource(release, sourceRelease) {
    if (sourceRelease == null)
        return null;
    return sourceRelease === release - 1 ? null : sourceRelease;
}
export function projectReleaseHistory(input) {
    const { liveRelease, desiredRelease } = input.gateway;
    return [...input.releases]
        .sort((a, b) => b.release - a.release)
        .map((r) => ({
        release: r.release,
        revisionId: revisionIdForRelease(r.gatewayId, r.release),
        imageRepository: r.payload.imageRepository,
        imageTag: r.payload.imageTag,
        createdAt: typeof r.createdAt === "number" ? new Date(r.createdAt).toISOString() : null,
        createdBy: r.createdBy,
        note: r.note,
        payloadHash: r.payloadHash,
        sourceRelease: r.sourceRelease,
        live: liveRelease != null && r.release === liveRelease,
        desired: r.release === desiredRelease,
        rolledBackFrom: rollbackSource(r.release, r.sourceRelease),
    }));
}
