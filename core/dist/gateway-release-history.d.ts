import { type GatewayDoc, type ReleaseDoc } from "@octogee/shared/types/gateway-releases";
export interface ReleaseHistoryEntry {
    release: number;
    revisionId: string;
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
export declare function projectReleaseHistory(input: {
    gateway: Pick<GatewayDoc, "liveRelease" | "desiredRelease">;
    releases: ReleaseDoc[];
}): ReleaseHistoryEntry[];
