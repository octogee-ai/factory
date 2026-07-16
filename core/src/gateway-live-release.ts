import type { Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  effectiveGatewayServiceAccountNameForGateway,
  isBareGatewayId,
  isGatewayMutableConfig,
  isGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  isGatewayDesiredDoc,
  isReleasePayload,
  isRevisionRealizationDoc,
  revisionIdForRelease,
  type GatewayDoc,
  type ReleasePayload,
  type W9GatewayEdgeImage,
  type W9TestPublisherLiveExperiment,
} from "@octogee/shared/types/gateway-releases";

export {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  effectiveGatewayServiceAccountNameForGateway,
  isBareGatewayId,
  isGatewayMutableConfig,
  isGatewayMutableConfigForGateway,
};
export type { GatewayMutableConfig };

type FirestoreReader = Pick<Firestore, "doc">;

export interface GatewayArtifact {
  imageRepository: string;
  imageTag: string;
  gatewayEdgeImage?: W9GatewayEdgeImage;
  testExperiment?: W9TestPublisherLiveExperiment;
}

export interface RenderedGatewayConfig
  extends Omit<GatewayMutableConfig, "configSchemaVersion">,
    GatewayArtifact {}

export interface GatewayAuthorization {
  kind: "durable";
  gateway: GatewayDoc;
  config: GatewayMutableConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalGatewayRevision(
  gatewayId: string,
  revisionId: string | null,
  release: number | null,
): { revisionId: string; release: number } | null {
  if (
    typeof revisionId !== "string" ||
    typeof release !== "number" ||
    !Number.isInteger(release) ||
    release < 1 ||
    revisionId !== revisionIdForRelease(gatewayId, release)
  ) {
    return null;
  }
  return { revisionId, release };
}

export function gatewayArtifactFromReleasePayload(payload: ReleasePayload): GatewayArtifact {
  return {
    imageRepository: payload.imageRepository,
    imageTag: payload.imageTag,
    ...(payload.gatewayEdgeImage === undefined
      ? {}
      : { gatewayEdgeImage: payload.gatewayEdgeImage }),
    ...(payload.testExperiment === undefined
      ? {}
      : { testExperiment: payload.testExperiment }),
  };
}

function isGatewayArtifact(value: unknown): value is GatewayArtifact {
  return isReleasePayload(value);
}

export async function readGatewayArtifact(
  db: FirestoreReader,
  gatewayId: string,
  release: number | null,
): Promise<GatewayArtifact | null> {
  if (!isBareGatewayId(gatewayId)) return null;
  if (typeof release !== "number" || !Number.isInteger(release) || release < 1) return null;
  const releaseSnap = await db
    .doc(`${GATEWAYS_COLLECTION}/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/${release}`)
    .get();
  const releaseData = releaseSnap.exists ? releaseSnap.data() : undefined;
  const payload = isRecord(releaseData) ? releaseData.payload : undefined;
  if (
    !isRecord(releaseData) ||
    releaseData.gatewayId !== gatewayId ||
    releaseData.release !== release ||
    !isGatewayArtifact(payload)
  ) {
    return null;
  }
  return gatewayArtifactFromReleasePayload(payload);
}

export async function readGatewayLiveRevisionHeartbeat(
  db: FirestoreReader,
  gateway: GatewayDoc,
): Promise<Record<string, unknown> | null> {
  const live = canonicalGatewayRevision(
    gateway.gatewayId,
    gateway.liveRevisionId,
    gateway.liveRelease,
  );
  if (!live) return null;
  const revisionSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${live.revisionId}`).get();
  const revision = revisionSnap.exists ? revisionSnap.data() : undefined;
  if (
    !isRevisionRealizationDoc(revision) ||
    revision.revisionId !== live.revisionId ||
    revision.gateway !== gateway.gatewayId ||
    revision.release !== live.release ||
    revision.lifecycle !== "serving" ||
    !isRecord(revision.heartbeat)
  ) {
    return null;
  }
  return revision.heartbeat;
}

export function mergeGatewayConfigWithArtifact(
  config: GatewayMutableConfig,
  artifact: GatewayArtifact,
): RenderedGatewayConfig {
  return {
    profile: config.profile,
    gatewayClass: config.gatewayClass,
    imageProfile: config.imageProfile,
    sizingTier: config.sizingTier,
    computeClass: config.computeClass,
    gcpProject: config.gcpProject,
    gatewayContainerSecurityContext: config.gatewayContainerSecurityContext,
    serviceAccountName: config.serviceAccountName,
    serviceAccount: config.serviceAccount,
    operatorAccess: config.operatorAccess,
    ownerUid: config.ownerUid,
    coOwnerUids: [...config.coOwnerUids],
    builderSlug: config.builderSlug,
    openclawOverrides: config.openclawOverrides,
    modelBrokerLimits: config.modelBrokerLimits,
    preemption: config.preemption,
    ...artifact,
  };
}

export function gatewayAuthorizationFromRootDocument(
  data: unknown,
  gatewayId: string,
): GatewayAuthorization | null {
  if (!isBareGatewayId(gatewayId)) return null;
  if (
    !isGatewayDesiredDoc(data) ||
    data.gatewayId !== gatewayId ||
    !isGatewayMutableConfigForGateway(data, gatewayId)
  ) {
    return null;
  }
  return { kind: "durable", gateway: data, config: data };
}

export async function readGatewayAuthorization(
  db: FirestoreReader,
  gatewayId: string,
): Promise<GatewayAuthorization | null> {
  if (!isBareGatewayId(gatewayId)) return null;
  const gatewaySnap = await db.doc(`${GATEWAYS_COLLECTION}/${gatewayId}`).get();
  const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
  return gatewaySnap.exists ? gatewayAuthorizationFromRootDocument(gatewayData, gatewayId) : null;
}

export async function readRevisionGatewayAuthorization(
  db: FirestoreReader,
  gatewayId: string,
  revisionId: string,
): Promise<GatewayAuthorization | null> {
  const gatewaySnap = await db.doc(`${GATEWAYS_COLLECTION}/${gatewayId}`).get();
  const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
  if (!gatewaySnap.exists) return null;
  const authorization = gatewayAuthorizationFromRootDocument(gatewayData, gatewayId);
  if (!authorization) return null;

  const live = canonicalGatewayRevision(
    authorization.gateway.gatewayId,
    authorization.gateway.liveRevisionId,
    authorization.gateway.liveRelease,
  );
  const target = authorization.gateway.roll
    ? canonicalGatewayRevision(
        authorization.gateway.gatewayId,
        authorization.gateway.roll.targetRevisionId,
        authorization.gateway.roll.toRelease,
      )
    : null;
  let expected: { revisionId: string; release: number } | null = null;
  if (live?.revisionId === revisionId) {
    expected = live;
  } else if (target?.revisionId === revisionId) {
    expected = target;
  }
  if (!expected) return null;

  const revisionSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${revisionId}`).get();
  const revisionData = revisionSnap.exists ? revisionSnap.data() : undefined;
  if (
    !isRevisionRealizationDoc(revisionData) ||
    revisionData.revisionId !== revisionId ||
    revisionData.gateway !== gatewayId ||
    revisionData.release !== expected.release
  ) {
    return null;
  }
  return authorization;
}

export async function readServingGatewayAuthorization(
  db: FirestoreReader,
  gatewayId: string,
): Promise<GatewayAuthorization | null> {
  const authorization = await readGatewayAuthorization(db, gatewayId);
  if (!authorization) return null;
  if (authorization.gateway.desiredStatus !== "running") return null;
  const live = canonicalGatewayRevision(
    authorization.gateway.gatewayId,
    authorization.gateway.liveRevisionId,
    authorization.gateway.liveRelease,
  );
  if (!live) return null;

  const revisionSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${live.revisionId}`).get();
  const revisionData = revisionSnap.exists ? revisionSnap.data() : undefined;
  if (
    !isRevisionRealizationDoc(revisionData) ||
    revisionData.revisionId !== live.revisionId ||
    revisionData.gateway !== gatewayId ||
    revisionData.release !== live.release ||
    revisionData.lifecycle !== "serving"
  ) {
    return null;
  }
  return authorization;
}
