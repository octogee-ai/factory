import type { Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  effectiveGatewayServiceAccountNameForGateway,
  isBareGatewayId,
  isGatewayMutableConfig,
  isGatewayMutableConfigForGateway,
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  isGatewayRuntimeDoc,
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
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
  projectGatewayMutableConfigForGateway,
};
export type { GatewayMutableConfig };

type FirestoreReader = Pick<Firestore, "doc">;

// A gateway's pods are named octogee-gateway-<id>-<replicaset>-<pod> by the
// stable-name Deployment. Pod identity binds to the gateway alone — never to a
// release or lifecycle state (GATEWAY-SIMPLE-ROLL-SPEC identity-pure boot).
export function podBelongsToGateway(
  gatewayId: string,
  podName: string | undefined,
): boolean {
  if (!podName) return false;
  const prefix = `octogee-gateway-${gatewayId}-`;
  if (!podName.startsWith(prefix)) return false;
  const suffix = podName.slice(prefix.length);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(suffix);
}

export function configuredBuilderBootstrapAllowed(
  value: unknown,
  input: { gatewayId: string; podName: string | undefined; slug: string },
): boolean {
  return eligibleConfiguredBuilderGateway(value, input) !== null;
}

type ConfiguredBuilderGateway = GatewayDoc & GatewayMutableConfig & { retirementClaim?: unknown };

function eligibleConfiguredBuilderGateway(
  value: unknown,
  input: { gatewayId: string; podName: string | undefined; slug: string },
): ConfiguredBuilderGateway | null {
  const gateway = projectGatewayDesiredRootForGateway(
    value,
    input.gatewayId,
  ) as ConfiguredBuilderGateway | null;
  if (gateway === null) return null;
  if (
    !podBelongsToGateway(input.gatewayId, input.podName) ||
    gateway.gatewayClass === "shared" ||
    gateway.builderSlug !== input.slug
  ) {
    return null;
  }
  return gateway;
}

export function configuredBuilderCredentialBootstrapAllowed(
  value: unknown,
  input: {
    gatewayId: string;
    podName: string | undefined;
    slug: string;
    uid: string;
  },
): boolean {
  const gateway = eligibleConfiguredBuilderGateway(value, input);
  return gateway !== null && gateway.ownerUid === input.uid;
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

export async function readGatewayRuntimeHeartbeat(
  db: FirestoreReader,
  gateway: GatewayDoc,
): Promise<Record<string, unknown> | null> {
  const runtimeSnap = await db
    .doc(`${GLM_GATEWAYS_COLLECTION}/${gateway.gatewayId}`)
    .get();
  const runtime = runtimeSnap.exists ? runtimeSnap.data() : undefined;
  if (
    !isGatewayRuntimeDoc(runtime) ||
    runtime.gatewayId !== gateway.gatewayId ||
    runtime.lifecycle !== "serving" ||
    !isRecord(runtime.heartbeat)
  ) {
    return null;
  }
  return runtime.heartbeat;
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
  const gateway = projectGatewayDesiredRootForGateway(data, gatewayId);
  if (gateway === null) return null;
  return { kind: "durable", gateway, config: gateway };
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

export async function readServingGatewayAuthorization(
  db: FirestoreReader,
  gatewayId: string,
): Promise<GatewayAuthorization | null> {
  const authorization = await readGatewayAuthorization(db, gatewayId);
  if (!authorization) return null;
  if (authorization.gateway.desiredStatus !== "running") return null;

  const runtimeSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`).get();
  const runtimeData = runtimeSnap.exists ? runtimeSnap.data() : undefined;
  if (
    !isGatewayRuntimeDoc(runtimeData) ||
    runtimeData.gatewayId !== gatewayId ||
    runtimeData.lifecycle !== "serving"
  ) {
    return null;
  }
  return authorization;
}
