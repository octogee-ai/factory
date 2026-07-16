import type { Firestore } from "firebase-admin/firestore";
import { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, type GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import { type GatewayDoc, type ReleasePayload, type W9GatewayEdgeImage, type W9TestPublisherLiveExperiment } from "@octogee/shared/types/gateway-releases";
export { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, };
export type { GatewayMutableConfig };
type FirestoreReader = Pick<Firestore, "doc">;
export declare function gatewayRevisionIdFromPodName(gatewayId: string, podName: string | undefined): string | null;
export declare function configuredBuilderBootstrapAllowed(value: unknown, input: {
    gatewayId: string;
    revisionId: string | null;
    slug: string;
}): boolean;
export interface GatewayArtifact {
    imageRepository: string;
    imageTag: string;
    gatewayEdgeImage?: W9GatewayEdgeImage;
    testExperiment?: W9TestPublisherLiveExperiment;
}
export interface RenderedGatewayConfig extends Omit<GatewayMutableConfig, "configSchemaVersion">, GatewayArtifact {
}
export interface GatewayAuthorization {
    kind: "durable";
    gateway: GatewayDoc;
    config: GatewayMutableConfig;
}
export declare function gatewayArtifactFromReleasePayload(payload: ReleasePayload): GatewayArtifact;
export declare function readGatewayArtifact(db: FirestoreReader, gatewayId: string, release: number | null): Promise<GatewayArtifact | null>;
export declare function readGatewayLiveRevisionHeartbeat(db: FirestoreReader, gateway: GatewayDoc): Promise<Record<string, unknown> | null>;
export declare function mergeGatewayConfigWithArtifact(config: GatewayMutableConfig, artifact: GatewayArtifact): RenderedGatewayConfig;
export declare function gatewayAuthorizationFromRootDocument(data: unknown, gatewayId: string): GatewayAuthorization | null;
export declare function readGatewayAuthorization(db: FirestoreReader, gatewayId: string): Promise<GatewayAuthorization | null>;
export declare function readRevisionGatewayAuthorization(db: FirestoreReader, gatewayId: string, revisionId: string): Promise<GatewayAuthorization | null>;
export declare function readServingGatewayAuthorization(db: FirestoreReader, gatewayId: string): Promise<GatewayAuthorization | null>;
