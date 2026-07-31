import { createHash } from "node:crypto";
import { GATEWAYS_COLLECTION } from "./fleet-controller.js";
import {
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "./gateway-mutable-config.js";
import {
  IMAGE_TAG_PATTERN,
  isW9CandidateImageTag,
} from "./image-tag.js";
import {
  GLM_GATEWAYS_COLLECTION,
  isOperatorManaged,
} from "./glm.js";
import type {
  ManagedBy,
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
export type GatewayLifecycleStatus = "running" | "paused" | "retired";

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

export interface GatewayCapacityRebalanceIntent {
  nonce: string;
  active: boolean;
  operationId: string;
  previousNonce: string | null;
  sourcePodUids: string[];
  requestedAt: number;
}

// gateways/{gatewayId} — durable desired gateway identity. Gateways have no
// reservation mirror and no persistence (all gateways are Spot + emptyDir).
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
  managedBy?: ManagedBy;
  retireAfter?: number | null;
  retirementVersion?: number;
  retirementClaim?: GatewayRetirementClaim | null;
  capacityRebalanceNonce?: string;
  capacityRebalance?: GatewayCapacityRebalanceIntent;
}

export const W9_CANDIDATE_MANIFEST_PATH =
  "infra/gateway/openclaw-candidates/agent-conversation.json";
export const W9_MATTERMOST_OVERLAY_VALUES_PATH =
  "infra/candidates/values.mattermost-silent-post.yaml";
export interface W9GatewayEdgeImage {
  imageRepository: string;
  imageTag: string;
}

export interface GatewayEdgeImage {
  imageRepository: string;
  imageTag: string;
}

export interface GatewayProfileImages {
  operator: {
    imageRepository: string;
    imageTag: string;
  };
}

export interface W9TestPublisherLiveExperiment {
  kind: "w9-agent-conversation";
  mode: "publisher-live";
  candidateManifest: {
    path: typeof W9_CANDIDATE_MANIFEST_PATH;
    sha256: string;
  };
  mattermostOverlay: {
    valuesPath: typeof W9_MATTERMOST_OVERLAY_VALUES_PATH;
    imageReference: string;
  };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_BOUND_IMAGE_TAG_PATTERN =
  /^[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
const DIGEST_BOUND_IMAGE_REFERENCE_PATTERN =
  /^[a-z0-9][a-z0-9./_-]*:[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;

export function isW9TestPublisherLiveExperiment(
  value: unknown,
): value is W9TestPublisherLiveExperiment {
  if (!isPlainRecord(value) || value.kind !== "w9-agent-conversation" || value.mode !== "publisher-live") {
    return false;
  }
  const candidateManifest = value.candidateManifest;
  const mattermostOverlay = value.mattermostOverlay;
  return (
    isPlainRecord(candidateManifest) &&
    candidateManifest.path === W9_CANDIDATE_MANIFEST_PATH &&
    typeof candidateManifest.sha256 === "string" &&
    SHA256_PATTERN.test(candidateManifest.sha256) &&
    isPlainRecord(mattermostOverlay) &&
    mattermostOverlay.valuesPath === W9_MATTERMOST_OVERLAY_VALUES_PATH &&
    typeof mattermostOverlay.imageReference === "string" &&
    DIGEST_BOUND_IMAGE_REFERENCE_PATTERN.test(mattermostOverlay.imageReference)
  );
}

// Immutable release payload: the build artifact plus its bounded W9 TEST
// experiment contract. Gateway policy lives exclusively on gateways/{gatewayId},
// never in a release or revision.
export interface ReleasePayload {
  imageRepository: string;
  imageTag: string;
  profileImages?: GatewayProfileImages;
  gatewayEdgeImage?: GatewayEdgeImage;
  testExperiment?: W9TestPublisherLiveExperiment;
}

const RELEASE_PAYLOAD_FIELD_NAMES = new Set<string>([
  "imageRepository",
  "imageTag",
  "profileImages",
  "gatewayEdgeImage",
  "testExperiment",
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
    value.profileImages !== undefined &&
    !isGatewayProfileImages(value.profileImages, value.imageRepository, value.imageTag)
  ) {
    return false;
  }
  if (value.testExperiment === undefined) {
    return (
      !isW9CandidateImageTag(value.imageTag) &&
      (value.gatewayEdgeImage === undefined ||
        (isGatewayEdgeImage(value.gatewayEdgeImage, value.imageRepository) &&
          !isW9CandidateImageTag(value.gatewayEdgeImage.imageTag)))
    );
  }
  return (
    isW9CandidateImageTag(value.imageTag) &&
    isW9TestPublisherLiveExperiment(value.testExperiment) &&
    isW9GatewayEdgeImage(value.gatewayEdgeImage, value.imageTag, value.imageRepository)
  );
}

function isGatewayProfileImages(
  value: unknown,
  gatewayImageRepository: string,
  gatewayImageTag: string,
): value is GatewayProfileImages {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1) return false;
  const operator = value.operator;
  if (!isPlainRecord(operator) || Object.keys(operator).length !== 2) return false;
  const gatewayPackageSuffix = "/octogee-gateway";
  const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
    ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/octogee-gateway-operator`
    : "";
  return (
    operator.imageRepository === expectedRepository &&
    typeof operator.imageTag === "string" &&
    DIGEST_BOUND_IMAGE_TAG_PATTERN.test(operator.imageTag) &&
    operator.imageTag.split("@", 1)[0] === gatewayImageTag.split("@", 1)[0]
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

function w9CandidateImageName(imageTag: string): string {
  return imageTag.slice(0, imageTag.indexOf("@"));
}

export function isW9GatewayEdgeImage(
  value: unknown,
  gatewayImageTag: string,
  gatewayImageRepository: string,
): value is W9GatewayEdgeImage {
  const gatewayPackageSuffix = "/octogee-gateway";
  const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
    ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/gateway-edge`
    : "";
  return (
    isPlainRecord(value) &&
    value.imageRepository === expectedRepository &&
    typeof value.imageTag === "string" &&
    isW9CandidateImageTag(value.imageTag) &&
    isW9CandidateImageTag(gatewayImageTag) &&
    w9CandidateImageName(value.imageTag) === w9CandidateImageName(gatewayImageTag)
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
  updatedAt: number;
  updatedByOperationId: string | null;
}

export type GatewayRuntimeLifecycle =
  | "provisioning"
  | "serving"
  | "failed";

export type GatewayHeartbeatStatus =
  | "unknown"
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
  lastError: { message: string | null; at: number | null };
}

export interface GatewayKubernetesObservation {
  status: "ready" | "not-ready" | "missing" | "unknown";
  totalPods: number;
  readyPods: number;
  observedAt: number;
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
    (d.desiredStatus === "running" || d.desiredStatus === "paused" || d.desiredStatus === "retired")
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
  "testExperiment",
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
  "operatorAccess",
  "ownerUid",
  "builderSlug",
  "openclawOverrides",
  "modelBrokerLimits",
  "allocation",
  "desiredStatus",
  "managedBy",
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
  // (gatewayId + gatewayProfile + shellsEnabled + any model-metadata deletes).
  // Passed in so this helper stays agnostic to per-caller mirror shaping and
  // preserves each entry point's field set byte-for-byte.
  mirrorPatch: Record<string, unknown>;
  updatedByOperationId?: string | null;
  assignmentWrite?: "upsert" | "create-if-missing";
  requireDurableGateway?: boolean;
  automatic?: boolean;
  validateTarget?: (
    context: PlacementTargetValidationContext,
  ) => Promise<PlacementRejectReason | null>;
}

export type PlacementRejectReason =
  | "gateway-root-invalid"
  | "gateway-operator-managed"
  | "builder-operator-managed"
  | "gateway-not-running"
  | "gateway-not-serving"
  | "gateway-target-not-accepting";

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

function builderIsOperatorManaged(data: Record<string, unknown> | undefined): boolean {
  const provisioning = data?.provisioning;
  if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning)) {
    return false;
  }
  const openclaw = (provisioning as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) return false;
  return isOperatorManaged((openclaw as Record<string, unknown>).managedBy);
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

async function automaticBuilderRejectReason(
  txn: PlacementTxn,
  userRef: PlacementDocRef,
  params: CommitPlacementParams,
): Promise<PlacementRejectReason | null> {
  if (!params.automatic) return null;
  const userSnap = await txn.get(userRef);
  const userData = userSnap.exists ? userSnap.data() : undefined;
  return builderIsOperatorManaged(userData)
    ? "builder-operator-managed"
    : null;
}

function placementGatewayRejectReason(
  gatewayData: Record<string, unknown> | undefined,
  params: CommitPlacementParams,
): PlacementRejectReason | null {
  if (!isDurablePlacementRoot(gatewayData, params.gatewayId)) return "gateway-root-invalid";
  if (params.automatic && isOperatorManaged(gatewayData.managedBy)) {
    return "gateway-operator-managed";
  }
  return gatewayData.desiredStatus === "running" ? null : "gateway-not-running";
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
    const gatewaySnap = await txn.get(gatewayRef);
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
    const builderRejectReason = await automaticBuilderRejectReason(txn, userRef, params);
    if (builderRejectReason) return { kind: "rejected", reason: builderRejectReason };

    if (!gatewaySnap.exists) {
      if (params.requireDurableGateway) {
        return { kind: "rejected", reason: "gateway-root-invalid" };
      }
      txn.update(userRef, params.mirrorPatch);
      return { kind: "mirror-only" };
    }
    const gatewayRejectReason = placementGatewayRejectReason(gatewayData, params);
    if (gatewayRejectReason) return { kind: "rejected", reason: gatewayRejectReason };
    if (!isDurablePlacementRoot(gatewayData, params.gatewayId)) {
      return { kind: "rejected", reason: "gateway-root-invalid" };
    }
    const runtimeSnap = await txn.get(
      db.collection(GLM_GATEWAYS_COLLECTION).doc(params.gatewayId),
    );
    const runtimeRejectReason = placementRuntimeRejectReason(
      runtimeSnap,
      params.gatewayId,
    );
    if (runtimeRejectReason) {
      return { kind: "rejected", reason: runtimeRejectReason };
    }
    const runtimeData = runtimeSnap.data();
    if (!runtimeData) {
      return { kind: "rejected", reason: "gateway-not-serving" };
    }
    if (params.validateTarget) {
      const targetRejectReason = await params.validateTarget({
        txn,
        gatewayRef,
        assignmentRef,
        gateway: gatewayData,
        runtime: runtimeData,
      });
      if (targetRejectReason) return { kind: "rejected", reason: targetRejectReason };
    }
    if (await preserveExistingAssignment(
      txn,
      assignmentRef,
      userRef,
      params,
    )) {
      return { kind: "assignment-preserved" };
    }

    txn.update(userRef, params.mirrorPatch);
    const assignmentDoc: AssignmentDoc = {
      uid: params.uid,
      slug: params.slug,
      gatewayId: params.gatewayId,
      source: params.source,
      state: "serving",
      epoch: 0,
      updatedAt: params.now,
      updatedByOperationId: params.updatedByOperationId ?? null,
    };
    txn.set(assignmentRef, assignmentDoc as unknown as Record<string, unknown>);
    return { kind: "assigned", release: gatewayData.liveRelease };
  });
}
