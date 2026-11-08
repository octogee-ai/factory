import type { Firestore, Transaction } from "firebase-admin/firestore";
import { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, projectGatewayMutableConfigForGateway, type GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { type GatewayDoc, type GatewayLifecycleStatus, type ReleaseDoc, type ReleasePayload, type GatewayProfileImages, type GatewayEdgeImage } from "@octogee/shared/types/gateway-releases";
import type { PlatformStateRepositories, PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";
export { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, projectGatewayMutableConfigForGateway, };
export type { GatewayMutableConfig };
type FirestoreReader = Pick<Firestore, "doc">;
export type GatewayRootReader = Pick<PlatformStateRepositories, "gateways">;
export type GatewayRuntimeReader = Pick<PlatformStateRepositories, "fleetRegistry">;
export type GatewayStateReader = GatewayRootReader & GatewayRuntimeReader;
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
}
export declare function initialGatewayReleaseDocuments(args: InitialGatewayReleaseArgs): {
    gatewayDoc: GatewayDoc & GatewayMutableConfig;
    releaseDoc: ReleaseDoc;
};
export declare class InitialGatewayReleaseConflictError extends Error {
    readonly gatewayId: string;
    constructor(gatewayId: string);
}
export declare function writeInitialGatewayReleaseInTransaction(transaction: PlatformStateTransaction, args: InitialGatewayReleaseArgs): Promise<void>;
export declare function writeInitialGatewayReleaseInStore(store: PlatformStateStore, args: InitialGatewayReleaseArgs): Promise<void>;
export interface RenderedGatewayConfig extends Omit<GatewayMutableConfig, "configSchemaVersion">, GatewayArtifact {
}
export interface GatewayAuthorization {
    kind: "durable";
    gateway: GatewayDoc;
    config: GatewayMutableConfig;
}
export declare function gatewayArtifactFromReleasePayload(payload: ReleasePayload): GatewayArtifact;
export declare function readGatewayArtifact(db: FirestoreReader, gatewayId: string, release: number | null, transaction?: Pick<Transaction, "get">): Promise<GatewayArtifact | null>;
export declare function readGatewayArtifactInStore(state: GatewayRootReader, gatewayId: string, release: number | null): Promise<GatewayArtifact | null>;
export declare function readGatewayRuntimeDoc(state: GatewayRuntimeReader, gateway: Pick<GatewayDoc, "gatewayId">): Promise<unknown>;
export declare function gatewayRuntimeHeartbeatOf(runtime: unknown, gateway: GatewayDoc): Record<string, unknown> | null;
export declare function readGatewayRuntimeHeartbeat(state: GatewayRuntimeReader, gateway: GatewayDoc): Promise<Record<string, unknown> | null>;
export declare function mergeGatewayConfigWithArtifact(config: GatewayMutableConfig, artifact: GatewayArtifact): RenderedGatewayConfig;
export declare function gatewayAuthorizationFromRootDocument(data: unknown, gatewayId: string): GatewayAuthorization | null;
export declare function readGatewayAuthorization(db: FirestoreReader, gatewayId: string): Promise<GatewayAuthorization | null>;
export declare function readGatewayAuthorizationInStore(state: GatewayRootReader, gatewayId: string): Promise<GatewayAuthorization | null>;
export declare function readServingGatewayAuthorization(state: GatewayStateReader, gatewayId: string): Promise<GatewayAuthorization | null>;
