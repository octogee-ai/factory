import type { Firestore, Transaction } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
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
  releasePayloadHash,
  upgradeReleasePayloadSchema,
  type GatewayDoc,
  type GatewayLifecycleStatus,
  type ReleaseDoc,
  type ReleasePayload,
  type GatewayProfileImages,
  type GatewayEdgeImage,
} from "@octogee/shared/types/gateway-releases";
import type { PlatformStateRepositories, PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";

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

export type GatewayRootReader = Pick<PlatformStateRepositories, "gateways">;
export type GatewayRuntimeReader = Pick<PlatformStateRepositories, "fleetRegistry">;
export type GatewayStateReader = GatewayRootReader & GatewayRuntimeReader;

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

export function initialGatewayReleaseDocuments(
  args: InitialGatewayReleaseArgs,
): {
  gatewayDoc: GatewayDoc & GatewayMutableConfig;
  releaseDoc: ReleaseDoc;
} {
  const gatewayDoc: GatewayDoc & GatewayMutableConfig = {
    gatewayId: args.gatewayId,
    createdAt: args.now,
    createdBy: args.createdBy,
    updatedAt: args.now,
    updatedBy: args.createdBy,
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    desiredStatus: args.desiredStatus,
    ...args.config,
  };
  const payload: ReleasePayload = { ...args.artifact };
  const releaseDoc: ReleaseDoc = {
    gatewayId: args.gatewayId,
    release: 1,
    createdAt: args.now,
    createdBy: args.createdBy,
    sourceRelease: null,
    note: null,
    payloadHash: releasePayloadHash(payload),
    payload,
  };
  return { gatewayDoc, releaseDoc };
}

export class InitialGatewayReleaseConflictError extends Error {
  constructor(readonly gatewayId: string) {
    super(`gateway ${gatewayId} already exists`);
  }
}

export async function writeInitialGatewayReleaseInTransaction(
  transaction: PlatformStateTransaction,
  args: InitialGatewayReleaseArgs,
): Promise<void> {
  const { gatewayDoc, releaseDoc } = initialGatewayReleaseDocuments(args);
  const [existing, releaseExisting] = await Promise.all([
    transaction.gateways.roots.get(args.gatewayId),
    transaction.gateways.releases.get(args.gatewayId, 1),
  ]);
  if (existing !== null || releaseExisting !== null) {
    throw new InitialGatewayReleaseConflictError(args.gatewayId);
  }
  await transaction.gateways.roots.create(gatewayDoc);
  await transaction.gateways.releases.createInitial(releaseDoc);
}

export async function writeInitialGatewayReleaseInStore(
  store: PlatformStateStore,
  args: InitialGatewayReleaseArgs,
): Promise<void> {
  await store.transaction({ label: "gateway-release.initial" }, (transaction) =>
    writeInitialGatewayReleaseInTransaction(transaction, args));
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
    ...(payload.openclawSourceSha === undefined
      ? {}
      : { openclawSourceSha: payload.openclawSourceSha }),
    ...(payload.profileImages === undefined
      ? {}
      : { profileImages: payload.profileImages }),
    ...(payload.gatewayEdgeImage === undefined
      ? {}
      : { gatewayEdgeImage: payload.gatewayEdgeImage }),
  };
}

function isGatewayArtifact(value: unknown): value is GatewayArtifact {
  return isReleasePayload(value);
}

function isReleaseNumber(release: number | null): release is number {
  return typeof release === "number" && Number.isInteger(release) && release >= 1;
}

export async function readGatewayArtifact(
  db: FirestoreReader,
  gatewayId: string,
  release: number | null,
  transaction?: Pick<Transaction, "get">,
): Promise<GatewayArtifact | null> {
  if (!isBareGatewayId(gatewayId) || !isReleaseNumber(release)) return null;
  const releaseRef = db.doc(`${GATEWAYS_COLLECTION}/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/${release}`);
  const releaseSnap = await (transaction ? transaction.get(releaseRef) : releaseRef.get());
  return artifactFromStoredRelease(releaseSnap.exists ? releaseSnap.data() : undefined, gatewayId, release);
}

export async function readGatewayArtifactInStore(
  state: GatewayRootReader,
  gatewayId: string,
  release: number | null,
): Promise<GatewayArtifact | null> {
  if (!isBareGatewayId(gatewayId) || !isReleaseNumber(release)) return null;
  return artifactFromStoredRelease(await state.gateways.releases.get(gatewayId, release), gatewayId, release);
}

function artifactFromStoredRelease(releaseData: unknown, gatewayId: string, release: number): GatewayArtifact | null {
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

export async function readGatewayRuntimeDoc(
  state: GatewayRuntimeReader,
  gateway: Pick<GatewayDoc, "gatewayId">,
): Promise<unknown> {
  const stored = await state.fleetRegistry.get(gateway.gatewayId);
  if (stored === null) return undefined;
  const { revision: _revision, ...record } = stored;
  return { docKind: "runtime", ...record };
}

export function gatewayRuntimeHeartbeatOf(
  runtime: unknown,
  gateway: GatewayDoc,
): Record<string, unknown> | null {
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

export async function readGatewayRuntimeHeartbeat(
  state: GatewayRuntimeReader,
  gateway: GatewayDoc,
): Promise<Record<string, unknown> | null> {
  return gatewayRuntimeHeartbeatOf(await readGatewayRuntimeDoc(state, gateway), gateway);
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
    gcpProject: config.gcpProject,
    gatewayContainerSecurityContext: config.gatewayContainerSecurityContext,
    serviceAccountName: config.serviceAccountName,
    serviceAccount: config.serviceAccount,
    builderAccess: config.builderAccess,
    ownerUid: config.ownerUid,
    builderSlug: config.builderSlug,
    modelBrokerLimits: config.modelBrokerLimits,
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
  return gatewaySnap.exists ? gatewayAuthorizationFromRootDocument(gatewaySnap.data(), gatewayId) : null;
}

export async function readGatewayAuthorizationInStore(
  state: GatewayRootReader,
  gatewayId: string,
): Promise<GatewayAuthorization | null> {
  if (!isBareGatewayId(gatewayId)) return null;
  const stored = await state.gateways.roots.get(gatewayId);
  if (stored === null) return null;
  const { revision: _revision, ...root } = stored;
  return gatewayAuthorizationFromRootDocument(root, gatewayId);
}

export async function readServingGatewayAuthorization(
  state: GatewayStateReader,
  gatewayId: string,
): Promise<GatewayAuthorization | null> {
  const authorization = await readGatewayAuthorizationInStore(state, gatewayId);
  if (!authorization || authorization.gateway.desiredStatus !== "running") return null;
  const runtime = await state.fleetRegistry.get(gatewayId);
  return runtime?.lifecycle === "serving" ? authorization : null;
}
