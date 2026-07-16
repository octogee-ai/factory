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
  upgradeReleasePayloadSchema,
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

export function gatewayRevisionIdFromPodName(
  gatewayId: string,
  podName: string | undefined,
): string | null {
  if (!podName) return null;
  const prefix = `octogee-gateway-${gatewayId}-r`;
  if (!podName.startsWith(prefix)) return null;
  const suffix = podName.slice(prefix.length);
  const separator = suffix.indexOf("-");
  if (separator <= 0) return null;
  const release = suffix.slice(0, separator);
  const generatedSuffix = suffix.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(release)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(generatedSuffix)) return null;
  return `${gatewayId}-r${release}`;
}

export function configuredBuilderBootstrapAllowed(
  value: unknown,
  input: { gatewayId: string; revisionId: string | null; slug: string },
): boolean {
  const gateway = eligibleConfiguredBuilderGateway(value, input);
  if (!gateway) return false;
  if (gateway.roll) {
    return gateway.roll.status !== "failed" &&
      gateway.roll.targetRevisionId === input.revisionId;
  }
  return revisionIdForRelease(input.gatewayId, gateway.desiredRelease) === input.revisionId;
}

type ConfiguredBuilderGateway = GatewayDoc & GatewayMutableConfig & { retirementClaim?: unknown };

function eligibleConfiguredBuilderGateway(
  value: unknown,
  input: { gatewayId: string; revisionId: string | null; slug: string },
): ConfiguredBuilderGateway | null {
  if (
    !isGatewayDesiredDoc(value) ||
    value.gatewayId !== input.gatewayId ||
    !isGatewayMutableConfigForGateway(value, input.gatewayId)
  ) {
    return null;
  }
  const gateway = value as ConfiguredBuilderGateway;
  if (
    !input.revisionId ||
    gateway.desiredStatus !== "running" ||
    gateway.retireAfter != null ||
    gateway.retirementClaim != null ||
    gateway.gatewayClass === "shared" ||
    gateway.builderSlug !== input.slug
  ) {
    return null;
  }
  return gateway;
}

function activeRollSourceCredentialHydrationAllowed(
  gateway: ConfiguredBuilderGateway,
  revisionId: string | null,
): boolean {
  const roll = gateway.roll;
  return Boolean(
    revisionId &&
    roll &&
    (roll.status === "warming" || roll.status === "routing" || roll.status === "migrating") &&
    roll.sourceRevisionId === revisionId &&
    gateway.liveRevisionId === revisionId &&
    gateway.trafficRevisionId === revisionId,
  );
}

export function configuredBuilderCredentialBootstrapAllowed(
  value: unknown,
  input: {
    gatewayId: string;
    revisionId: string | null;
    slug: string;
    uid: string;
  },
): boolean {
  const gateway = eligibleConfiguredBuilderGateway(value, input);
  if (!gateway || gateway.ownerUid !== input.uid) return false;
  return configuredBuilderBootstrapAllowed(gateway, input) ||
    activeRollSourceCredentialHydrationAllowed(gateway, input.revisionId);
}

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
  let artifact: ReleasePayload | null = isGatewayArtifact(payload) ? payload : null;
  if (artifact === null) {
    const upgrade = upgradeReleasePayloadSchema(
      payload,
      isRecord(releaseData) ? releaseData.payloadHash : undefined,
    );
    if (upgrade.status === "upgraded") artifact = upgrade.payload;
  }
  if (
    !isRecord(releaseData) ||
    releaseData.gatewayId !== gatewayId ||
    releaseData.release !== release ||
    artifact === null
  ) {
    return null;
  }
  return gatewayArtifactFromReleasePayload(artifact);
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
