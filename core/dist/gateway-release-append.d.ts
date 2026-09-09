import type { Firestore } from "firebase-admin/firestore";
import { type GatewayDoc, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { type GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { type GatewayArtifact } from "./gateway-live-release.js";
export type DurableGatewayRoot = GatewayDoc & GatewayMutableConfig;
export declare function asDurableGatewayRoot(data: unknown, gatewayId: string): DurableGatewayRoot | null;
export declare class StaleGatewayReleaseError extends Error {
    readonly gatewayId: string;
    readonly expectedRelease: number;
    readonly actualRelease: number;
    constructor(gatewayId: string, expectedRelease: number, actualRelease: number);
}
export declare class InvalidGatewayRootError extends Error {
    readonly gatewayId: string;
    constructor(gatewayId: string);
}
export interface AppendGatewayReleaseArgs {
    gateway: GatewayDoc;
    artifact: GatewayArtifact;
    payload?: ReleasePayload;
    createdBy: string;
    now: number;
    sourceRelease: number | null;
    note: string | null;
    origin?: "automatic" | "operator";
}
export declare function rolloutOperationInput(gatewayId: string, targetRelease: number, artifact: GatewayArtifact): Record<string, unknown>;
export declare function appendGatewayRelease(db: Firestore, args: AppendGatewayReleaseArgs): Promise<{
    release: number;
    operationId: string | null;
}>;
