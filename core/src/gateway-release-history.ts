import {
  type GatewayDoc,
  type ReleaseDoc,
} from "@octogee/shared/types/gateway-releases";

export interface ReleaseHistoryEntry {
  release: number;
  imageRepository: string;
  imageTag: string;
  createdAt: string | null;
  createdBy: string;
  note: string | null;
  payloadHash: string;
  sourceRelease: number | null;
  live: boolean;
  desired: boolean;
  rolledBackFrom: number | null;
}

// A normal release cut always sources from the immediately-preceding release
// (appendGatewayRelease sets sourceRelease = latestRelease = release - 1). A
// rollback cuts release = latest + 1 whose source is an EARLIER release (the
// same-payload target is rejected as a no-op, so the source is always ≤
// release - 2). Therefore a release is a rollback iff its source is not its
// immediate predecessor — a marker that survives retention pruning of the
// source doc (no payload-hash lookup needed).
function rollbackSource(release: number, sourceRelease: number | null): number | null {
  if (sourceRelease == null) return null;
  return sourceRelease === release - 1 ? null : sourceRelease;
}

export function projectReleaseHistory(input: {
  gateway: Pick<GatewayDoc, "liveRelease" | "desiredRelease">;
  releases: ReleaseDoc[];
}): ReleaseHistoryEntry[] {
  const { liveRelease, desiredRelease } = input.gateway;
  return [...input.releases]
    .sort((a, b) => b.release - a.release)
    .map((r) => ({
      release: r.release,
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
