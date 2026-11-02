import type { Firestore, Transaction } from "firebase-admin/firestore";
import { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, projectGatewayMutableConfigForGateway, type GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { type GatewayDoc, type GatewayLifecycleStatus, type ReleaseDoc, type ReleasePayload, type GatewayProfileImages, type GatewayEdgeImage } from "@octogee/shared/types/gateway-releases";
export { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, projectGatewayMutableConfigForGateway, };
export type { GatewayMutableConfig };
type FirestoreReader = Pick<Firestore, "doc">;
export declare function podBelongsToGateway(gatewayId: string, podName: string | undefined): boolean;
export declare function configuredBuilderBootstrapAllowed(value: unknown, input: {
    gatewayId: string;
    podName: string | undefined;
    slug: string;
}): boolean;
export declare function configuredBuilderCredentialBootstrapAllowed(value: unknown, input: {
    gatewayId: string;
    podName: string | undefined;
    slug: string;
    uid: string;
}): boolean;
export interface GatewayArtifact {
    imageRepository: string;
    imageTag: string;
    openclawSourceSha?: string;
    profileImages?: GatewayProfileImages;
    gatewayEdgeImage?: GatewayEdgeImage;
}
export interface InitialGatewayReleaseArgs {
    gatewayId: string;
    config: GatewayMutableConfig;
    artifact: GatewayArtifact;
    createdBy: string;
    now: number;
    desiredStatus: GatewayLifecycleStatus;
    validateAdditional?: (transaction: Transaction) => Promise<void>;
    writeAdditional?: (transaction: Transaction) => void;
}
export declare function initialGatewayReleaseDocuments(args: InitialGatewayReleaseArgs): {
    gatewayDoc: GatewayDoc & GatewayMutableConfig;
    releaseDoc: ReleaseDoc;
};
export declare class InitialGatewayReleaseConflictError extends Error {
    readonly gatewayId: string;
    constructor(gatewayId: string);
}
export declare function writeInitialGatewayRelease(db: Firestore, args: InitialGatewayReleaseArgs): Promise<void>;
export interface RenderedGatewayConfig extends Omit<GatewayMutableConfig, "configSchemaVersion">, GatewayArtifact {
}
export interface GatewayAuthorization {
    kind: "durable";
    gateway: GatewayDoc;
    config: GatewayMutableConfig;
}
export declare function gatewayArtifactFromReleasePayload(payload: ReleasePayload): GatewayArtifact;
export declare function readGatewayArtifact(db: FirestoreReader, gatewayId: string, release: number | null, transaction?: Pick<Transaction, "get">): Promise<GatewayArtifact | null>;
export declare function readGatewayRuntimeDoc(db: FirestoreReader, gateway: GatewayDoc): Promise<unknown>;
export declare function gatewayRuntimeHeartbeatOf(runtime: unknown, gateway: GatewayDoc): Record<string, unknown> | null;
export declare function readGatewayRuntimeHeartbeat(db: FirestoreReader, gateway: GatewayDoc): Promise<Record<string, unknown> | null>;
export declare function mergeGatewayConfigWithArtifact(config: GatewayMutableConfig, artifact: GatewayArtifact): RenderedGatewayConfig;
export declare function gatewayAuthorizationFromRootDocument(data: unknown, gatewayId: string): GatewayAuthorization | null;
export declare function readGatewayAuthorization(db: FirestoreReader, gatewayId: string): Promise<GatewayAuthorization | null>;
export declare function readServingGatewayAuthorization(db: FirestoreReader, gatewayId: string): Promise<GatewayAuthorization | null>;
