import type { MigrationProgressRecord } from "./glm.js";
import { createHash } from "node:crypto";
import { accountAllowsInteractiveAccess } from "./account-lifecycle.js";
import { GATEWAYS_COLLECTION } from "./fleet-controller.js";
import type {
  GatewayPodPlacement,
  GatewayPodReplacements,
} from "./gateway-pod-replacements.js";
import {
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "./gateway-mutable-config.js";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import {
  GLM_GATEWAYS_COLLECTION,
} from "./glm.js";
import type {
  GatewayDesiredStatus,
} from "./glm.js";

// Simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): durable identity
// (gateways/{id}) + immutable releases (releases/{n}) + ONE stable-name
// realization per gateway (glmGateways/{gatewayId} runtime doc). A roll is a
// desiredRelease write; Kubernetes surge replacement is the only mechanism.

// gateways/{gatewayId}/releases/{n} and gateways/{gatewayId}/assignments/{uid}
// are subcollections of the durable gateway identity doc.
export const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";

// gateways/{gatewayId} desired-identity lifecycle. Pausing scales the gateway
// to zero; retirement is its own terminal state.
export type GatewayLifecycleStatus = GatewayDesiredStatus;

export interface GatewayRetirementClaim {
  operationId: string;
  version: number;
  claimedAt: number;
  phase: "claimed";
  liveRelease: number | null;
  liveRuntimeIdentity: {
    startedAt: number;
    version: string;
    openclawVersion: string;
  } | null;
  previousDesiredStatus: Exclude<GatewayLifecycleStatus, "retired">;
}

// gateways/{gatewayId} — durable desired gateway identity. Gateways have no
// reservation mirror or persistent volume.
export interface GatewayDoc {
  gatewayId: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  latestRelease: number;
  desiredRelease: number;
  liveRelease: number | null;
  desiredStatus: GatewayLifecycleStatus;
  retireAfter?: number | null;
  retirementVersion?: number;
  retirementClaim?: GatewayRetirementClaim | null;
}

export interface GatewayEdgeImage {
  imageRepository: string;
  imageTag: string;
}

export interface GatewayProfileImages {
  builder: {
    imageRepository: string;
    imageTag: string;
  };
}

const DIGEST_BOUND_IMAGE_TAG_PATTERN =
  /^[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
// Immutable release payload. Gateway policy lives exclusively on
// gateways/{gatewayId}, never in a release or revision.
export interface ReleasePayload {
  imageRepository: string;
  imageTag: string;
  openclawSourceSha?: string;
  profileImages?: GatewayProfileImages;
  gatewayEdgeImage?: GatewayEdgeImage;
}

const RELEASE_PAYLOAD_FIELD_NAMES = new Set<string>([
  "imageRepository",
  "imageTag",
  "openclawSourceSha",
  "profileImages",
  "gatewayEdgeImage",
]);

const RELEASE_PAYLOAD_REQUIRED_FIELDS = [
  "imageRepository",
  "imageTag",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isReleasePayload(value: unknown): value is ReleasePayload {
  if (!isPlainRecord(value)) return false;
  if (!hasReleasePayloadShape(value) || !hasReleasePayloadIdentity(value)) return false;
  if (
    value.openclawSourceSha !== undefined &&
    (typeof value.openclawSourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.openclawSourceSha))
  ) {
    return false;
  }
  if (
    value.profileImages !== undefined &&
    !isGatewayProfileImages(value.profileImages, value.imageRepository, value.imageTag)
  ) {
    return false;
  }
  return value.gatewayEdgeImage === undefined ||
    isGatewayEdgeImage(value.gatewayEdgeImage, value.imageRepository);
}

function isGatewayProfileImages(
  value: unknown,
  gatewayImageRepository: string,
  gatewayImageTag: string,
): value is GatewayProfileImages {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1) return false;
  const builder = value.builder;
  if (!isPlainRecord(builder) || Object.keys(builder).length !== 2) return false;
  const gatewayPackageSuffix = "/octogee-gateway";
  const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
    ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/octogee-gateway-builder`
    : "";
  return (
    builder.imageRepository === expectedRepository &&
    typeof builder.imageTag === "string" &&
    DIGEST_BOUND_IMAGE_TAG_PATTERN.test(builder.imageTag) &&
    builder.imageTag.split("@", 1)[0] === gatewayImageTag.split("@", 1)[0]
  );
}

export function isGatewayEdgeImage(
  value: unknown,
  gatewayImageRepository: string,
): value is GatewayEdgeImage {
  const gatewayPackageSuffix = "/octogee-gateway";
  const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
    ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/gateway-edge`
    : "";
  return (
    isPlainRecord(value) &&
    value.imageRepository === expectedRepository &&
    typeof value.imageTag === "string" &&
    IMAGE_TAG_PATTERN.test(value.imageTag)
  );
}

export type ReleasePayloadSchemaUpgrade =
  | {
      status: "current";
      payload: ReleasePayload;
      payloadHash: string;
    }
  | {
      status: "upgraded";
      migration: "remove-retired-mac-ops-token-protocol";
      payload: ReleasePayload;
      payloadHash: string;
    }
  | {
      status: "unsupported";
      reason: "payload-hash-mismatch" | "unsupported-payload-schema";
    };

export function upgradeReleasePayloadSchema(
  payload: unknown,
  persistedPayloadHash: unknown,
): ReleasePayloadSchemaUpgrade {
  if (
    typeof persistedPayloadHash !== "string" ||
    persistedPayloadHash !== releasePayloadValueHash(payload)
  ) {
    return { status: "unsupported", reason: "payload-hash-mismatch" };
  }
  if (isReleasePayload(payload)) {
    return { status: "current", payload, payloadHash: persistedPayloadHash };
  }
  if (
    !isPlainRecord(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, "macOpsTokenProtocol")
  ) {
    return { status: "unsupported", reason: "unsupported-payload-schema" };
  }
  const upgraded = { ...payload };
  delete upgraded.macOpsTokenProtocol;
  if (!isReleasePayload(upgraded)) {
    return { status: "unsupported", reason: "unsupported-payload-schema" };
  }
  return {
    status: "upgraded",
    migration: "remove-retired-mac-ops-token-protocol",
    payload: upgraded,
    payloadHash: releasePayloadValueHash(upgraded),
  };
}

function hasReleasePayloadShape(value: Record<string, unknown>): boolean {
  return !(
    Object.keys(value).some((field) => !RELEASE_PAYLOAD_FIELD_NAMES.has(field)) ||
    RELEASE_PAYLOAD_REQUIRED_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(value, field),
    )
  );
}

function hasReleasePayloadIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { imageRepository: string; imageTag: string } {
  return (
    typeof value.imageRepository === "string" &&
    value.imageRepository.length > 0 &&
    typeof value.imageTag === "string" &&
    value.imageTag.length > 0 &&
    IMAGE_TAG_PATTERN.test(value.imageTag)
  );
}

// gateways/{gatewayId}/releases/{n} — append-only. Rollback cuts a NEW release
// whose payload equals a prior release; it never rewrites history.
export interface ReleaseDoc {
  gatewayId: string;
  release: number;
  createdAt: number;
  createdBy: string;
  sourceRelease: number | null;
  note: string | null;
  payloadHash: string;
  payload: ReleasePayload;
}

export type AssignmentSource =
  | "onboarding"
  | "migrate-customer"
  | "repair";

// Migration-plane routing state for one customer's assignment. serving = the
// assigned gateway answers service-addressed traffic; quiescing/migrating =
// the customer is being moved between gateways (the edge answers 503 +
// Retry-After until the cutover lands). The cutover writes serving on the
// target gateway's assignment and bumps `epoch`.
export type AssignmentState = "serving" | "quiescing" | "migrating";

export function isAssignmentState(value: unknown): value is AssignmentState {
  return value === "serving" || value === "quiescing" || value === "migrating";
}

// Internal-only headers a forwarded intra-family hop carries between two
// gateways/{gatewayId}/assignments/{uid} — which customers a gateway serves.
// `epoch` is monotonic per customer, bumped at each migration cutover; `state`
// gates serving while a customer moves between gateways.
export interface AssignmentDoc {
  uid: string;
  slug: string;
  gatewayId: string;
  source: AssignmentSource;
  state: AssignmentState;
  epoch: number;
  // When this Builder started serving on this gateway; a cutover restarts it.
  createdAt: number;
  updatedAt: number;
  updatedByOperationId: string | null;
  handoffProgress?: MigrationProgressRecord[];
}

export type GatewayRuntimeLifecycle =
  | "provisioning"
  | "serving"
  | "failed";

export type GatewayHeartbeatStatus =
  | "unknown"
  | "booting"
  | "ready"
  | "unreachable"
  | "error";

export interface GatewayHelmObservation {
  releaseName: string;
  deploymentName: string;
  gatewayServiceName: string;
  gatewayEdgeServiceName: string;
  serviceAccountName: string;
  imageRepository: string | null;
  imageTag: string | null;
  replicas: number | null;
  availableReplicas: number | null;
  lastAppliedAt: number | null;
}

export interface GatewayHeartbeatObservation {
  status: GatewayHeartbeatStatus;
  lastHeartbeatAt: number | null;
  version: string | null;
  openclawVersion: string | null;
  internalUrl: string | null;
  startedAt: number | null;
  mountedCustomers: string[];
  migratingIn: string[];
  configStatus?: import("./fleet-controller.js").GatewayConfigStatus;
  configuredBuilder?: import("./fleet-controller.js").ConfiguredBuilderReport | null;
}

// glmGateways/{gatewayId} — the Cowboy-owned runtime observation record for the
// gateway's single stable-name realization: which release is applied, what the
// pod last reported. Never desired configuration (that is gateways/{id}).
export interface GatewayRuntimeDoc {
  docKind: "runtime";
  gatewayId: string;
  release: number;
  lifecycle: GatewayRuntimeLifecycle;
  createdAt: number;
  createdByOperationId: string | null;
  helm: GatewayHelmObservation;
  heartbeat: GatewayHeartbeatObservation;
  kubernetes?: GatewayKubernetesObservation;
  podReplacements?: GatewayPodReplacements;
  lastError: { message: string | null; at: number | null };
}

export interface GatewayKubernetesObservation {
  status: "ready" | "not-ready" | "missing" | "unknown";
  totalPods: number;
  readyPods: number;
  observedAt: number;
  // The pods observed, each with its owning ReplicaSet and node placement. The
  // next observation diffs against this to notice a pod that vanished, asks the
  // ReplicaSet whether it still wanted that pod, and names the vacated GCE
  // instance — which is unrecoverable once the node is gone.
  pods?: GatewayPodPlacement[];
}

export function hasFreshReadyKubernetesObservation(
  runtime: GatewayRuntimeDoc,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const observation = runtime.kubernetes;
  return observation?.status === "ready" &&
    Number.isSafeInteger(observation.totalPods) &&
    observation.totalPods > 0 &&
    Number.isSafeInteger(observation.readyPods) &&
    observation.readyPods > 0 &&
    Number.isFinite(observation.observedAt) &&
    nowMs >= observation.observedAt &&
    nowMs - observation.observedAt <= maxAgeMs;
}

export function isGatewayRuntimeDoc(data: unknown): data is GatewayRuntimeDoc {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.docKind === "runtime" &&
    typeof d.gatewayId === "string" &&
    typeof d.release === "number" &&
    typeof d.lifecycle === "string"
  );
}

// A gateways/{id} durable desired doc (GatewayDoc), distinct from a legacy
// GatewayDesiredState (no desiredRelease/latestRelease).
export function isGatewayDesiredDoc(data: unknown): data is GatewayDoc {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.gatewayId === "string" &&
    typeof d.desiredRelease === "number" &&
    typeof d.latestRelease === "number" &&
    (d.desiredStatus === "running" ||
      d.desiredStatus === "paused" ||
      d.desiredStatus === "draining" ||
      d.desiredStatus === "retired")
  );
}

export function projectGatewayDesiredRootForGateway(
  value: unknown,
  gatewayId: string,
): (GatewayDoc & GatewayMutableConfig) | null {
  if (!isGatewayDesiredDoc(value) || value.gatewayId !== gatewayId) return null;
  const projected = projectGatewayMutableConfigForGateway(value, gatewayId);
  return projected as (GatewayDoc & GatewayMutableConfig) | null;
}

export function helmReleaseNameForGateway(gatewayId: string): string {
  return `octogee-gw-${gatewayId}`;
}

// Kubernetes Service DNS names for the gateway's stable-name resources.
// Service-addressed `/g/{gatewayId}/…` targets `gateway-edge-{gatewayId}`;
// the chart renders both names directly from the bare gateway id.
export function gatewayEdgeServiceName(id: string): string {
  return `gateway-edge-${id}`;
}

// The gateway pod Service (preview surface, port 9080).
export function gatewayPodServiceName(id: string): string {
  return `octogee-gateway-${id}`;
}

// Deterministic, order-independent hash of a release payload. Used to reject a
// no-op release (payload equals the previous release) and to fingerprint a
// revision's rendered config. Non-cryptographic identity is not required; the
// only contract is: same normalized value → same hash, any change → different.
export function releasePayloadHash(payload: ReleasePayload): string {
  return releasePayloadValueHash(payload);
}

export const PLATFORM_RELEASE_RECORD_DOC_PATH = "glmControllerState/platformRelease";

export interface PlatformReleaseRecord {
  schemaVersion: 1;
  payloadHash: string;
  imageTag: string;
  openclawSourceSha: string | null;
  writtenAt: number;
}

export function platformReleaseRecord(
  payload: ReleasePayload,
  writtenAt: number,
): PlatformReleaseRecord {
  return {
    schemaVersion: 1,
    payloadHash: releasePayloadHash(payload),
    imageTag: payload.imageTag,
    openclawSourceSha: payload.openclawSourceSha ?? null,
    writtenAt,
  };
}

export function parsePlatformReleaseRecord(value: unknown): PlatformReleaseRecord | null {
  if (!isPlainRecord(value)) return null;
  const { schemaVersion, payloadHash, imageTag, openclawSourceSha, writtenAt } = value;
  if (
    schemaVersion !== 1 ||
    typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/.test(payloadHash) ||
    typeof imageTag !== "string" || imageTag.length === 0 ||
    (openclawSourceSha !== null && typeof openclawSourceSha !== "string") ||
    typeof writtenAt !== "number" || !Number.isSafeInteger(writtenAt) || writtenAt < 0
  ) {
    return null;
  }
  return { schemaVersion, payloadHash, imageTag, openclawSourceSha, writtenAt };
}

function releasePayloadValueHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareKeys(a, b));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export type GatewayFieldClassification =
  | "release"
  | "gateway-mutable";

// Release-payload fields — audited via an immutable release; changing one is a
// roll. Listed for documentation + testing; the classifier does not need them
// because the conservative default already returns "release" for anything
// unlisted.
export const RELEASE_FIELDS = [
  "imageRepository",
  "imageTag",
] as const;

// gateways/{gatewayId} DOC fields that mutate without cutting a release.
// Separate-collection observations (assignment docs, runtime heartbeat /
// lastError) are not gateway-doc fields and are not enumerated here.
export const GATEWAY_MUTABLE_FIELDS = [
  "profile",
  "gatewayClass",
  "imageProfile",
  "sizingTier",
  "gcpProject",
  "gatewayContainerSecurityContext",
  "serviceAccountName",
  "serviceAccount",
  "builderAccess",
  "ownerUid",
  "builderSlug",
  "modelBrokerLimits",
  "allocation",
  "standby",
  "desiredStatus",
  "liveRelease",
  "retireAfter",
] as const;

const GATEWAY_MUTABLE_SET = new Set<string>(GATEWAY_MUTABLE_FIELDS);

// Conservative classifier over gateway-DOC and release-PAYLOAD field NAMES.
// Only explicitly enumerated gateway-mutable fields escape the default; every
// other field — including any new field added to the payload later — is
// release-audited. That default is the safety property the spec pins
// (operator, 2026-07-08).
export function classifyGatewayField(field: string): GatewayFieldClassification {
  if (GATEWAY_MUTABLE_SET.has(field)) return "gateway-mutable";
  return "release";
}

// ---------------------------------------------------------------------------
// Atomic placement (GATEWAY-RELEASES-SPEC "Placement and migration targeting")
// ---------------------------------------------------------------------------
//
// EVERY placement entry point — onboarding (functions), the admin direct-assign
// route (core), and the operator assignment script (scripts) — commits through
// this ONE helper so a customer's user mirror AND their assignment doc land
// together, in a single Firestore transaction. Without it, a placement that
// wrote only users/{uid}.provisioning.openclaw.gatewayId (the "decorative layer"
// bug) leaves a customer with no assignment doc — invisible to the edge's
// quiesce gate and the mount roster.
//
// Serving eligibility is resolved INSIDE the transaction from a fresh read of
// the gateway root + runtime doc, rejecting if the gateway is not serving. A
// legacy gateway (no GatewayDoc) has no assignment layer, so this writes ONLY
// the mirror. Three different packages call it, so it is written against a
// narrow structural Firestore surface that the real firebase-admin Firestore
// satisfies.

export interface PlacementDocSnap {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

export interface PlacementDocRef {
  get: () => Promise<PlacementDocSnap>;
  set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<unknown>;
  update: (data: Record<string, unknown>) => Promise<unknown>;
  collection: (name: string) => { doc: (id: string) => PlacementDocRef };
}

export interface PlacementTxn {
  get: (ref: PlacementDocRef) => Promise<PlacementDocSnap>;
  set: (ref: PlacementDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  update: (ref: PlacementDocRef, data: Record<string, unknown>) => void;
}

export interface PlacementFirestore {
  collection: (name: string) => { doc: (id: string) => PlacementDocRef };
  runTransaction: <T>(body: (txn: PlacementTxn) => Promise<T>) => Promise<T>;
}

export interface PlacementTargetValidationContext {
  txn: PlacementTxn;
  gatewayRef: PlacementDocRef;
  assignmentRef: PlacementDocRef;
  gateway: GatewayDoc & GatewayMutableConfig;
  runtime: Record<string, unknown>;
}

export interface CommitPlacementParams {
  uid: string;
  slug: string;
  // Bare gateway id — the placement target.
  gatewayId: string;
  source: AssignmentSource;
  now: number;
  // The exact users/{uid} mirror patch the caller already writes today
  // (gatewayId + gatewayProfile + controlUiEnabled + any model-metadata deletes).
  // Passed in so this helper stays agnostic to per-caller mirror shaping and
  // preserves each entry point's field set byte-for-byte.
  mirrorPatch: Record<string, unknown>;
  atomicCreate?: {
    userField: string;
    userPatch: Record<string, unknown>;
    writes: ReadonlyArray<{
      collection: string;
      document: string;
      data: Record<string, unknown>;
    }>;
  };
  updatedByOperationId?: string | null;
  assignmentWrite?: "upsert" | "create-if-missing";
  requireDurableGateway?: boolean;
  automatic?: boolean;
  validateTarget?: (
    context: PlacementTargetValidationContext,
  ) => Promise<PlacementRejectReason | null>;
}

export type PlacementRejectReason =
  | "account-not-interactive"
  | "restore-in-progress"
  | "source-transfer-in-progress"
  | "gateway-root-invalid"
  | "gateway-not-running"
  | "gateway-not-serving"
  | "gateway-target-not-accepting"
  | "assigned-elsewhere";

export type CommitPlacementResult =
  | { kind: "mirror-only" }
  | { kind: "assignment-preserved" }
  | { kind: "assigned"; release: number | null }
  | { kind: "rejected"; reason: PlacementRejectReason };

type DurablePlacementRoot = GatewayDoc & GatewayMutableConfig;

function isDurablePlacementRoot(
  value: unknown,
  gatewayId: string,
): value is DurablePlacementRoot {
  return projectGatewayDesiredRootForGateway(value, gatewayId) !== null;
}

function placementRuntimeRejectReason(
  snap: PlacementDocSnap,
  gatewayId: string,
): PlacementRejectReason | null {
  const data = snap.exists ? snap.data() : undefined;
  if (!isGatewayRuntimeDoc(data) || data.gatewayId !== gatewayId) {
    return "gateway-not-serving";
  }
  return data.lifecycle === "serving" ? null : "gateway-not-serving";
}

async function preserveExistingAssignment(
  txn: PlacementTxn,
  assignmentRef: PlacementDocRef,
  userRef: PlacementDocRef,
  params: CommitPlacementParams,
): Promise<boolean> {
  if (params.assignmentWrite !== "create-if-missing") return false;
  const assignmentSnap = await txn.get(assignmentRef);
  if (!assignmentSnap.exists) return false;
  txn.update(userRef, params.mirrorPatch);
  return true;
}

async function assignedElsewhere(
  db: PlacementFirestore,
  txn: PlacementTxn,
  userData: Record<string, unknown> | undefined,
  params: CommitPlacementParams,
): Promise<boolean> {
  const provisioning = isPlainRecord(userData?.provisioning) ? userData.provisioning : undefined;
  const openclaw = isPlainRecord(provisioning?.openclaw) ? provisioning.openclaw : undefined;
  const currentGatewayId = openclaw?.gatewayId;
  if (typeof currentGatewayId !== "string" || currentGatewayId === params.gatewayId) return false;
  const current = await txn.get(
    db.collection(GATEWAYS_COLLECTION).doc(currentGatewayId)
      .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(params.uid),
  );
  return current.exists;
}

function placementGatewayRejectReason(
  gatewayData: Record<string, unknown> | undefined,
  params: CommitPlacementParams,
): PlacementRejectReason | null {
  if (!isDurablePlacementRoot(gatewayData, params.gatewayId)) return "gateway-root-invalid";
  return gatewayData.desiredStatus === "running" ? null : "gateway-not-running";
}

async function placementUserWriteContext(
  db: PlacementFirestore,
  txn: PlacementTxn,
  userRef: PlacementDocRef,
  params: CommitPlacementParams,
): Promise<{
  userData: Record<string, unknown> | undefined;
  mirrorPatch: Record<string, unknown>;
  applyAtomicWrites(): void;
}> {
  const userSnap = await txn.get(userRef);
  const userData = userSnap.exists ? userSnap.data() : undefined;
  const atomicCreate = params.atomicCreate;
  const shouldCreate = Boolean(
    atomicCreate &&
    !Object.prototype.hasOwnProperty.call(userData ?? {}, atomicCreate.userField),
  );
  const mirrorPatch = shouldCreate
    ? { ...params.mirrorPatch, ...atomicCreate!.userPatch }
    : params.mirrorPatch;
  return {
    userData,
    mirrorPatch,
    applyAtomicWrites() {
      if (!shouldCreate || !atomicCreate) return;
      for (const write of atomicCreate.writes) {
        txn.set(db.collection(write.collection).doc(write.document), write.data);
      }
    },
  };
}

function commitMissingGateway(
  txn: PlacementTxn,
  userRef: PlacementDocRef,
  params: CommitPlacementParams,
  mirrorPatch: Record<string, unknown>,
  applyAtomicWrites: () => void,
): CommitPlacementResult {
  if (params.requireDurableGateway) {
    return { kind: "rejected", reason: "gateway-root-invalid" };
  }
  txn.update(userRef, mirrorPatch);
  applyAtomicWrites();
  return { kind: "mirror-only" };
}

async function readServingRuntime(
  db: PlacementFirestore,
  txn: PlacementTxn,
  gatewayId: string,
): Promise<{ runtime: Record<string, unknown> } | { reason: PlacementRejectReason }> {
  const runtimeSnap = await txn.get(db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId));
  const reason = placementRuntimeRejectReason(runtimeSnap, gatewayId);
  if (reason) return { reason };
  const runtime = runtimeSnap.data();
  return runtime ? { runtime } : { reason: "gateway-not-serving" };
}

export function customerRestoreFencePresent(user: unknown): boolean {
  if (!isPlainRecord(user) || !isPlainRecord(user.provisioning)) return false;
  const openclaw = user.provisioning.openclaw;
  return isPlainRecord(openclaw) && openclaw.restoreFence !== undefined;
}

export function customerRuntimeMutationFenced(user: unknown): boolean {
  if (customerRestoreFencePresent(user)) return true;
  if (!isPlainRecord(user) || !isPlainRecord(user.provisioning)) return false;
  const openclaw = user.provisioning.openclaw;
  return isPlainRecord(openclaw) && openclaw.sourceTransferFence !== undefined;
}

export async function commitPlacementAtomic(
  db: PlacementFirestore,
  params: CommitPlacementParams,
): Promise<CommitPlacementResult> {
  const userRef = db.collection("users").doc(params.uid);
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(params.gatewayId);
  const assignmentRef = gatewayRef
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
    .doc(params.uid);
  return db.runTransaction<CommitPlacementResult>(async (txn) => {
    const { userData, mirrorPatch, applyAtomicWrites } = await placementUserWriteContext(
      db,
      txn,
      userRef,
      params,
    );
    if (customerRuntimeMutationFenced(userData)) {
      return { kind: "rejected", reason: customerRestoreFencePresent(userData) ? "restore-in-progress" : "source-transfer-in-progress" };
    }
    if (!accountAllowsInteractiveAccess(userData)) {
      return { kind: "rejected", reason: "account-not-interactive" };
    }
    if (await assignedElsewhere(db, txn, userData, params)) {
      return { kind: "rejected", reason: "assigned-elsewhere" };
    }
    const gatewaySnap = await txn.get(gatewayRef);
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
    if (!gatewaySnap.exists) {
      return commitMissingGateway(txn, userRef, params, mirrorPatch, applyAtomicWrites);
    }
    const gatewayRejectReason = placementGatewayRejectReason(gatewayData, params);
    if (gatewayRejectReason) return { kind: "rejected", reason: gatewayRejectReason };
    if (!isDurablePlacementRoot(gatewayData, params.gatewayId)) return { kind: "rejected", reason: "gateway-root-invalid" };
    const runtimeResult = await readServingRuntime(db, txn, params.gatewayId);
    if ("reason" in runtimeResult) return { kind: "rejected", reason: runtimeResult.reason };
    if (params.validateTarget) {
      const targetRejectReason = await params.validateTarget({
        txn,
        gatewayRef,
        assignmentRef,
        gateway: gatewayData,
        runtime: runtimeResult.runtime,
      });
      if (targetRejectReason) return { kind: "rejected", reason: targetRejectReason };
    }
    if (await preserveExistingAssignment(
      txn,
      assignmentRef,
      userRef,
      { ...params, mirrorPatch },
    )) {
      applyAtomicWrites();
      return { kind: "assignment-preserved" };
    }

    txn.update(userRef, mirrorPatch);
    applyAtomicWrites();
    const assignmentDoc: AssignmentDoc = {
      uid: params.uid,
      slug: params.slug,
      gatewayId: params.gatewayId,
      source: params.source,
      state: "serving",
      epoch: 0,
      createdAt: params.now,
      updatedAt: params.now,
      updatedByOperationId: params.updatedByOperationId ?? null,
    };
    txn.set(assignmentRef, assignmentDoc as unknown as Record<string, unknown>);
    return { kind: "assigned", release: gatewayData.liveRelease };
  });
}
