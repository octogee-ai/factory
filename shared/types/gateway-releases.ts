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
import { GLM_GATEWAYS_COLLECTION } from "./glm.js";
import type {
  GatewayPreemptionHandoffSpec,
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

export type GatewayIdleSleepStatus =
  | "paused"
  | "empty-waiting"
  | "returning-to-shared";

// Current idle lifecycle state, exactly as the dedicated idle sweeper writes it
// (glm-controller/src/dedicated-gateway-idle-sweeper.ts). Every field is
// optional because the sweeper writes a different subset per status; each field
// when present must match the writer's shape.
export interface GatewayIdleSleepState {
  status?: GatewayIdleSleepStatus;
  action?: string;
  pausedAt?: number;
  emptySince?: number;
  protectedUntil?: number;
  lastActivityAt?: number | null;
  requestedAt?: number;
  operationId?: string;
  targetGatewayId?: string;
}

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

// gateways/{gatewayId} — durable desired gateway identity. No reservation
// mirror (operatorGatewayReservations is the sole durable reservation source)
// and no persistence (all gateways are Spot + emptyDir).
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
  idleSleep?: GatewayIdleSleepState | null;
  preemptionHandoff?: GatewayPreemptionHandoffSpec | null;
  retireAfter?: number | null;
  retirementVersion?: number;
  retirementClaim?: GatewayRetirementClaim | null;
}

export const W9_CANDIDATE_MANIFEST_PATH =
  "infra/gateway/openclaw-candidates/agent-conversation.json";
export const W9_MATTERMOST_OVERLAY_VALUES_PATH =
  "infra/candidates/values.mattermost-silent-post.yaml";
export interface W9GatewayEdgeImage {
  imageRepository: string;
  imageTag: string;
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
  gatewayEdgeImage?: W9GatewayEdgeImage;
  testExperiment?: W9TestPublisherLiveExperiment;
}

const RELEASE_PAYLOAD_FIELD_NAMES = new Set<string>([
  "imageRepository",
  "imageTag",
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
  if (value.testExperiment === undefined) {
    return !isW9CandidateImageTag(value.imageTag) && value.gatewayEdgeImage === undefined;
  }
  return (
    isW9CandidateImageTag(value.imageTag) &&
    isW9TestPublisherLiveExperiment(value.testExperiment) &&
    isW9GatewayEdgeImage(value.gatewayEdgeImage, value.imageTag, value.imageRepository)
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
  lastError: { message: string | null; at: number | null };
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
  "preemption",
  "allocation",
  "desiredStatus",
  "idleSleep",
  "preemptionHandoff",
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
  companionWrites?: ReadonlyArray<{
    collection: string;
    docId: string;
    data: Record<string, unknown>;
    mode?: "upsert" | "create-if-missing";
    mirrorPatchIfWritten?: Record<string, unknown>;
  }>;
}

export type PlacementRejectReason =
  | "gateway-root-invalid"
  | "gateway-not-running"
  | "gateway-not-serving";

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

interface PreparedCompanionWrite {
  ref: PlacementDocRef;
  data: Record<string, unknown>;
  mirrorPatch: Record<string, unknown>;
}

async function preparePlacementCompanionWrites(
  db: PlacementFirestore,
  txn: PlacementTxn,
  params: CommitPlacementParams,
): Promise<PreparedCompanionWrite[]> {
  const prepared: PreparedCompanionWrite[] = [];
  for (const write of params.companionWrites ?? []) {
    const ref = db.collection(write.collection).doc(write.docId);
    if (write.mode === "create-if-missing" && (await txn.get(ref)).exists) continue;
    prepared.push({
      ref,
      data: write.data,
      mirrorPatch: write.mirrorPatchIfWritten ?? {},
    });
  }
  return prepared;
}

function commitPlacementCompanionWrites(
  txn: PlacementTxn,
  writes: readonly PreparedCompanionWrite[],
): void {
  for (const write of writes) txn.set(write.ref, write.data);
}

function placementMirrorPatch(
  params: CommitPlacementParams,
  writes: readonly PreparedCompanionWrite[],
): Record<string, unknown> {
  return Object.assign({}, params.mirrorPatch, ...writes.map((write) => write.mirrorPatch));
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
    const companionWrites = await preparePlacementCompanionWrites(db, txn, params);
    const mirrorPatch = placementMirrorPatch(params, companionWrites);
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;

    if (!gatewaySnap.exists) {
      if (params.requireDurableGateway) {
        return { kind: "rejected", reason: "gateway-root-invalid" };
      }
      txn.update(userRef, mirrorPatch);
      commitPlacementCompanionWrites(txn, companionWrites);
      return { kind: "mirror-only" };
    }
    if (!isDurablePlacementRoot(gatewayData, params.gatewayId)) {
      return { kind: "rejected", reason: "gateway-root-invalid" };
    }
    if (gatewayData.desiredStatus !== "running") {
      return { kind: "rejected", reason: "gateway-not-running" };
    }
    if (await preserveExistingAssignment(
      txn,
      assignmentRef,
      userRef,
      { ...params, mirrorPatch },
    )) {
      commitPlacementCompanionWrites(txn, companionWrites);
      return { kind: "assignment-preserved" };
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

    // Mirror + assignment are all-or-nothing: a serving assignment at epoch 0
    // (the steady baseline before any migration cutover bumps the epoch).
    txn.update(userRef, mirrorPatch);
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
    commitPlacementCompanionWrites(txn, companionWrites);
    return { kind: "assigned", release: gatewayData.liveRelease };
  });
}
