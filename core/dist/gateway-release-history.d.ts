import { type GatewayDoc, type ReleaseDoc } from "@octogee/shared/types/gateway-releases";
import { type GatewayClass, type GatewayImageProfile, type GatewayProfile } from "@octogee/shared/types/glm";
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
type ReleaseHistoryGateway = Pick<GatewayDoc, "liveRelease" | "desiredRelease"> & {
    gatewayClass?: GatewayClass | null;
    imageProfile?: GatewayImageProfile | null;
    profile?: GatewayProfile | null;
};
export declare function projectReleaseHistory(input: {
    gateway: ReleaseHistoryGateway;
    releases: ReleaseDoc[];
}): ReleaseHistoryEntry[];
export {};
