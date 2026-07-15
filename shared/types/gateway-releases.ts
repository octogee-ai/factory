import { createHash } from "node:crypto";
import { GATEWAYS_COLLECTION } from "./fleet-controller.js";
import {
  isGatewayMutableConfigForGateway,
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

// Step 2 release/revision model (GATEWAY-RELEASES-SPEC). These types describe
// the desired-identity + immutable-release + revision-realization split that
// supersedes the single overloaded glmGateways desired doc. PR1 adds the
// schema + helpers only; no writer or reader is rerouted yet.

// gateways/{gatewayId}/releases/{n} and gateways/{gatewayId}/assignments/{uid}
// are subcollections of the durable gateway identity doc.
export const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";

// Cowboy-written tombstone table (top-level collection, doc id = revisionId).
// The gateway-router reads it ONLY on the revision-pinned MISS path to answer a
// retired /r/{n} with a typed revision_gone 404 (+ current-revision pointer),
// never by asking a dead pod. Service-addressed traffic never touches it.
export const REVISION_TOMBSTONES_COLLECTION = "revisionTombstones";

// gateways/{gatewayId} desired-identity lifecycle. The Step 2 model drops the
// interim "draining" desiredStatus — pausing scales the live revision down;
// retirement is its own terminal state.
export type GatewayLifecycleStatus = "running" | "paused" | "retired";

export type GatewayRollStatus =
  | "warming"
  | "routing"
  | "migrating"
  | "retiring-source"
  | "failed";

export interface GatewayRollSystemConfigCheckpoint {
  migrationId: string;
  builderSlug: string;
  sourceRevisionId: string;
  checkpointCommit: string | null;
  configHash: string | null;
  checkpointedAt: number | null;
  sourceUnfrozenAt: number | null;
}

export type GatewayRollSystemConfigPhase =
  | "checkpointed"
  | "candidateProven"
  | "promotionIntent"
  | "promoted"
  | "abortIntent"
  | "terminalHold"
  | "cutover"
  | "sourceRetired"
  | "finalized";

export interface GatewayRollSystemConfigState {
  phase: GatewayRollSystemConfigPhase;
  migrationId: string;
  builderSlug: string;
  sourceRevisionId: string;
  targetRevisionId: string;
  checkpointCommit: string;
  configHash: string;
  freezeRef: string;
  freezeObject: string;
  checkpointedAt: number;
  candidateCommit?: string;
  candidateHash?: string;
  candidateRef?: string;
  runtimeConfigHash?: string;
  observedRevisionId?: string;
  targetStartedAt?: number;
  imageTag?: string;
  buildSha?: string;
  openclawVersion?: string;
  provenAt?: number;
  promotionIntentAt?: number;
  promotedCommit?: string;
  promotedAt?: number;
  abortDisposition?: "fail" | "supersede";
  abortReason?: string;
  abortIntentAt?: number;
  terminalError?: string;
  terminalErrorAt?: number;
  cutoverAt?: number;
  sourceRetiredAt?: number;
  finalizedAt?: number;
}

export interface GatewayRollState {
  operationId: string;
  status: GatewayRollStatus;
  fromRelease: number | null;
  toRelease: number;
  sourceRevisionId: string | null;
  targetRevisionId: string;
  acceptingNewAssignments: boolean;
  startedAt: number;
  updatedAt: number;
  error: string | null;
  systemConfigCheckpoint?: GatewayRollSystemConfigCheckpoint | null;
  systemConfigRoll?: GatewayRollSystemConfigState | null;
  // Selector-flip wall-clock. The source revision survives as a forwarder for a
  // drain TTL measured from this durable timestamp, so a controller crash never
  // loses the retire deadline. Null until the flip step runs.
  flippedAt: number | null;
}

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

export interface GatewayLegacyBackfill {
  sourceGlmGatewayIds: string[];
  startedAt: number;
}

export interface GatewayRetirementClaim {
  operationId: string;
  version: number;
  claimedAt: number;
  liveRevisionId: string | null;
  liveRelease: number | null;
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
  liveRevisionId: string | null;
  trafficRevisionId: string | null;
  desiredStatus: GatewayLifecycleStatus;
  roll: GatewayRollState | null;
  idleSleep?: GatewayIdleSleepState | null;
  preemptionHandoff?: GatewayPreemptionHandoffSpec | null;
  retireAfter?: number | null;
  legacyBackfill?: GatewayLegacyBackfill | null;
  retirementVersion?: number;
  retirementClaim?: GatewayRetirementClaim | null;
}

export const W9_CANDIDATE_MANIFEST_PATH =
  "infra/gateway/openclaw-candidates/agent-conversation.json";
export const W9_MATTERMOST_OVERLAY_VALUES_PATH =
  "infra/candidates/values.mattermost-silent-post.yaml";
export const W9_GATEWAY_EDGE_IMAGE_REPOSITORY =
  "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge";

export interface W9GatewayEdgeImage {
  imageRepository: typeof W9_GATEWAY_EDGE_IMAGE_REPOSITORY;
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
    isW9GatewayEdgeImage(value.gatewayEdgeImage, value.imageTag)
  );
}

function hasReleasePayloadShape(value: Record<string, unknown>): boolean {
  return !(
    Object.keys(value).some((field) => !RELEASE_PAYLOAD_FIELD_NAMES.has(field)) ||
    RELEASE_PAYLOAD_REQUIRED_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(value, field),
    )
  );
}

function hasReleasePayloadIdentity(value: Record<string, unknown>): boolean {
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
): value is W9GatewayEdgeImage {
  return (
    isPlainRecord(value) &&
    value.imageRepository === W9_GATEWAY_EDGE_IMAGE_REPOSITORY &&
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
  | "rollout"
  | "repair";

// Mid-roll routing state for one customer's assignment (council-resolved
// "Inbound routing across rolls"). serving = the assigned revision answers
// service-addressed traffic; quiescing/migrating = the assigned revision is
// BLOCKED from serving (the customer is being quiesced/cut over — the edge
// answers 503 + Retry-After until the flip lands). The flip writes serving on
// the target revision and bumps `epoch`.
export type AssignmentState = "serving" | "quiescing" | "migrating";

export function isAssignmentState(value: unknown): value is AssignmentState {
  return value === "serving" || value === "quiescing" || value === "migrating";
}

// Internal-only headers a forwarded intra-family hop carries between two
// gateway-edge sidecars of the SAME gateway. The public gateway-router strips
// them from every inbound request (they must never be client-controllable) and
// an edge never forwards a request that already carries the hop header — one
// hop max, by construction.
export const INTRA_FAMILY_HOP_HEADER = "x-octogee-intra-family-hop";
export const ASSIGNMENT_EPOCH_HEADER = "x-octogee-assignment-epoch";
export const INTERNAL_ROUTING_HEADERS: readonly string[] = [
  INTRA_FAMILY_HOP_HEADER,
  ASSIGNMENT_EPOCH_HEADER,
];

// gateways/{gatewayId}/assignments/{uid} — the revision-assignment layer that
// lets user mirrors stay bare while a roll migrates customers between two
// revisions of the same gateway. `epoch` is monotonic per customer, bumped at
// each cutover flip; `state` gates which revision may serve mid-roll.
export interface AssignmentDoc {
  uid: string;
  slug: string;
  gatewayId: string;
  revisionId: string;
  release: number;
  source: AssignmentSource;
  state: AssignmentState;
  epoch: number;
  updatedAt: number;
  updatedByOperationId: string | null;
}

export type RevisionRollRole = "source" | "target" | null;

export type RevisionLifecycle =
  | "provisioning"
  | "warming"
  | "serving"
  | "draining"
  | "retiring"
  | "retired"
  | "failed";

export type RevisionHeartbeatStatus =
  | "unknown"
  | "ready"
  | "unreachable"
  | "error";

export interface RevisionHelmObservation {
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

export interface RevisionHeartbeatObservation {
  status: RevisionHeartbeatStatus;
  lastHeartbeatAt: number | null;
  version: string | null;
  openclawVersion: string | null;
  internalUrl: string | null;
  startedAt: number | null;
  mountedCustomers: string[];
  migratingIn: string[];
  configStatus?: import("./fleet-controller.js").GatewayConfigStatus;
}

export interface RevisionSystemConfigObservation {
  migrationId: string;
  builderSlug: string;
  sourceRevisionId: string;
  checkpointCommit: string;
  restoredCommit: string;
  acceptedCommit: string;
  configHash: string;
  configReady: true;
  observedRevisionId: string;
  restoreProvenAt: number;
  configReadyAt: number;
  runtimeConfigHash: string;
  observedAt: number;
  sourceUnfrozenAt?: number;
}

// glmGateways/{revisionId} — the Cowboy-owned runtime realization record. In
// Step 2 this collection stops carrying desired configuration and becomes the
// per-revision observation shape below.
//
// During expand, glmGateways holds BOTH kinds of doc: legacy bare-id desired
// docs (GatewayDesiredState, no docKind) and new {gw}-rN revision docs. Every
// glmGateways iterator MUST route through isRevisionRealizationDoc /
// isGatewayDesiredDoc so a revision doc is never mistaken for a legacy desired
// doc (and vice-versa). `docKind` is the explicit discriminator.
export interface RevisionRealizationDoc {
  docKind: "revision";
  revisionId: string;
  gateway: string;
  release: number;
  rollRole: RevisionRollRole;
  lifecycle: RevisionLifecycle;
  createdAt: number;
  createdByOperationId: string | null;
  retiredAt: number | null;
  retireReason: string | null;
  helm: RevisionHelmObservation;
  heartbeat: RevisionHeartbeatObservation;
  systemConfig?: RevisionSystemConfigObservation;
  lastError: { message: string | null; at: number | null };
}

// glmGateways doc-kind discriminators. During expand the collection holds legacy
// bare-id desired docs alongside {gw}-rN revision-realization docs; every
// iterator routes through these so it treats each doc correctly.
export function isRevisionRealizationDoc(data: unknown): data is RevisionRealizationDoc {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.docKind === "revision") return true;
  // Structural fallback for a revision doc written before docKind existed.
  return (
    typeof d.revisionId === "string" &&
    typeof d.gateway === "string" &&
    typeof d.lifecycle === "string"
  );
}

export function isGatewayLegacyBackfill(value: unknown): value is GatewayLegacyBackfill {
  if (!isPlainRecord(value) || !Array.isArray(value.sourceGlmGatewayIds)) return false;
  const sourceGlmGatewayIds = value.sourceGlmGatewayIds;
  return (
    sourceGlmGatewayIds.length > 0 &&
    sourceGlmGatewayIds.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(sourceGlmGatewayIds).size === sourceGlmGatewayIds.length &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    value.startedAt >= 0
  );
}

// A new gateways/{id} durable desired doc (GatewayDoc). Distinct from a legacy
// GatewayDesiredState (no desiredRelease/latestRelease) and a revision doc.
export function isGatewayDesiredDoc(data: unknown): data is GatewayDoc {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.gatewayId === "string" &&
    typeof d.desiredRelease === "number" &&
    typeof d.latestRelease === "number" &&
    (d.desiredStatus === "running" || d.desiredStatus === "paused" || d.desiredStatus === "retired") &&
    (d.legacyBackfill === undefined ||
      d.legacyBackfill === null ||
      isGatewayLegacyBackfill(d.legacyBackfill))
  );
}

// Revision id convention: {gatewayId}-r{release}. Blue/green are transient roll
// ROLES (rollRole), never encoded into identity.
export function revisionIdForRelease(gatewayId: string, release: number): string {
  return `${gatewayId}-r${release}`;
}

// Every revision the durable root references or intends to realize: live +
// traffic + the desired release + BOTH endpoints of any recorded roll — a
// parked failed roll still owns its revisions until an operator resolves it.
// Recovery primitives (orphan-revision retire, stranded-assignment reset)
// refuse to touch a referenced revision; this is deliberately WIDER than the
// renderer's selection, which excludes failed rolls and desired-only releases.
export function rootReferencedRevisionIds(root: GatewayDoc): ReadonlySet<string> {
  const ids = new Set<string>();
  if (root.liveRevisionId) ids.add(root.liveRevisionId);
  if (root.trafficRevisionId) ids.add(root.trafficRevisionId);
  ids.add(revisionIdForRelease(root.gatewayId, root.desiredRelease));
  if (root.roll) {
    if (root.roll.sourceRevisionId) ids.add(root.roll.sourceRevisionId);
    ids.add(root.roll.targetRevisionId);
  }
  return ids;
}

export function helmReleaseNameForRevision(revisionId: string): string {
  return `octogee-gw-${revisionId}`;
}

// Kubernetes Service DNS names, keyed by the ADDRESSED id. Service-addressed
// `/g/{gatewayId}/…` targets the per-gateway Service `gateway-edge-{gatewayId}`
// whose selector Cowboy points at the serving revision; revision-pinned
// `/g/{gatewayId}/r/{n}/…` targets the revision's own Service
// `gateway-edge-{revisionId}`. Both share one formula — the router passes the
// gateway id for the service form and the revision id for the pinned form.
export function gatewayEdgeServiceName(id: string): string {
  return `gateway-edge-${id}`;
}

// The gateway pod Service (preview surface, port 9080), same addressing split.
export function gatewayPodServiceName(id: string): string {
  return `octogee-gateway-${id}`;
}

// Cowboy-written record that a revision has retired. `currentRevisionId` is the
// gateway's live-revision pointer at tombstone-write time (may be null when the
// gateway itself has no live revision), surfaced to the caller in the
// revision_gone 404 so a pinned client can re-derive its service-addressed base.
export interface RevisionTombstone {
  gatewayId: string;
  revision: number;
  revisionId: string;
  currentRevisionId: string | null;
  retiredAt: number;
}

export function revisionTombstoneDocId(gatewayId: string, revision: number): string {
  return revisionIdForRelease(gatewayId, revision);
}

export function isRevisionTombstone(data: unknown): data is RevisionTombstone {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.gatewayId === "string" &&
    typeof d.revision === "number" &&
    typeof d.revisionId === "string" &&
    (d.currentRevisionId === null || typeof d.currentRevisionId === "string") &&
    typeof d.retiredAt === "number"
  );
}

// Deterministic, order-independent hash of a release payload. Used to reject a
// no-op release (payload equals the previous release) and to fingerprint a
// revision's rendered config. Non-cryptographic identity is not required; the
// only contract is: same normalized value → same hash, any change → different.
export function releasePayloadHash(payload: ReleasePayload): string {
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
  | "new-revision"
  | "in-place"
  | "gateway-mutable";

// Release-payload fields that force a NEW revision when they change. Listed for
// documentation + testing; the classifier does not need them because the
// conservative default already returns "new-revision" for anything unlisted.
export const RELEASE_NEW_REVISION_FIELDS = [
  "imageRepository",
  "imageTag",
  "testExperiment",
] as const;

// Release-payload fields that are release-audited but may reconcile IN PLACE on
// the live revision (broker-consumed after request time; no pod restart).
export const RELEASE_IN_PLACE_FIELDS: readonly string[] = [];

// gateways/{gatewayId} DOC fields that mutate without cutting a release. The
// spec's "gateway mutable without release" list also names assignment docs,
// revision heartbeat, and revision lastError — those live in SEPARATE
// collections (gateways/{id}/assignments/{uid}, glmGateways/{revisionId}), not
// as gateway-doc field names, so they are not enumerated here.
export const GATEWAY_MUTABLE_FIELDS = [
  "profile",
  "gatewayClass",
  "imageProfile",
  "sizingTier",
  "computeClass",
  "gcpProject",
  "gatewayContainerSecurityContext",
  "serviceAccountName",
  "serviceAccount",
  "operatorAccess",
  "ownerUid",
  "coOwnerUids",
  "builderSlug",
  "openclawOverrides",
  "modelBrokerLimits",
  "preemption",
  "desiredStatus",
  "roll",
  "idleSleep",
  "preemptionHandoff",
  "liveRelease",
  "liveRevisionId",
  "trafficRevisionId",
  "retireAfter",
] as const;

const IN_PLACE_SET = new Set<string>(RELEASE_IN_PLACE_FIELDS);
const GATEWAY_MUTABLE_SET = new Set<string>(GATEWAY_MUTABLE_FIELDS);

// Conservative classifier over gateway-DOC and release-PAYLOAD field NAMES.
// Only explicitly enumerated in-place / gateway-mutable fields escape the
// default; every other field — including any new field added to the payload
// later — cuts a new revision. That default is the safety property the spec
// pins (operator, 2026-07-08). Separate-collection observations (assignment
// docs, revision heartbeat/lastError) are not gateway-doc fields and are not
// classified here.
export function classifyGatewayField(field: string): GatewayFieldClassification {
  if (IN_PLACE_SET.has(field)) return "in-place";
  if (GATEWAY_MUTABLE_SET.has(field)) return "gateway-mutable";
  return "new-revision";
}

// ---------------------------------------------------------------------------
// Atomic placement (GATEWAY-RELEASES-SPEC "Placement and migration targeting")
// ---------------------------------------------------------------------------
//
// EVERY placement entry point — onboarding (functions), the admin direct-assign
// route (core), and the operator assignment script (scripts) — commits through
// this ONE helper so a customer's user mirror AND their revision assignment doc
// land together, in a single Firestore transaction. Without it, a placement that
// wrote only users/{uid}.provisioning.openclaw.gatewayId (the "decorative layer"
// bug) leaves a customer with no assignment doc: during a roll with
// acceptingNewAssignments=true the mount driver treats them as a gap user and
// mounts them on the OLD live revision, and the source heartbeat then holds the
// roll open as an unassigned-mounted customer.
//
// The destination revision is resolved INSIDE the transaction from a fresh read
// of the gateway doc (spec placement rule): roll.acceptingNewAssignments ?
// roll.targetRevisionId : liveRevisionId — rejecting if the resolved revision is
// not ready. A legacy / un-backfilled gateway (no GatewayDoc) has no assignment
// layer yet, so this writes ONLY the mirror — byte-identical to pre-Step-2
// behavior. Three different packages call it, so it is written against a narrow
// structural Firestore surface that the real firebase-admin Firestore satisfies.

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
}

export type PlacementRejectReason =
  | "gateway-root-invalid"
  | "gateway-not-running"
  | "no-live-revision"
  | "revision-identity-invalid"
  | "revision-not-ready";

export type CommitPlacementResult =
  | { kind: "mirror-only" }
  | { kind: "assignment-preserved" }
  | { kind: "assigned"; revisionId: string; release: number | null }
  | { kind: "rejected"; reason: PlacementRejectReason };

type DurablePlacementRoot = GatewayDoc & GatewayMutableConfig;

function isDurablePlacementRoot(
  value: unknown,
  gatewayId: string,
): value is DurablePlacementRoot {
  return (
    isGatewayDesiredDoc(value) &&
    value.gatewayId === gatewayId &&
    isGatewayMutableConfigForGateway(value, gatewayId)
  );
}

function hasCanonicalPlacementRevision(
  gatewayId: string,
  revisionId: unknown,
  release: unknown,
): revisionId is string {
  return (
    typeof revisionId === "string" &&
    typeof release === "number" &&
    Number.isInteger(release) &&
    release > 0 &&
    revisionId === revisionIdForRelease(gatewayId, release)
  );
}

function placementRevisionRejectReason(
  snap: PlacementDocSnap,
  gatewayId: string,
  revisionId: string,
  release: number,
): PlacementRejectReason | null {
  const data = snap.exists ? snap.data() : undefined;
  if (
    !isRevisionRealizationDoc(data) ||
    data.revisionId !== revisionId ||
    data.gateway !== gatewayId ||
    data.release !== release
  ) {
    return "revision-identity-invalid";
  }
  return data.lifecycle === "serving" ? null : "revision-not-ready";
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

    if (!gatewaySnap.exists) {
      txn.update(userRef, params.mirrorPatch);
      return { kind: "mirror-only" };
    }
    if (!isDurablePlacementRoot(gatewayData, params.gatewayId)) {
      return { kind: "rejected", reason: "gateway-root-invalid" };
    }
    if (gatewayData.desiredStatus !== "running") {
      return { kind: "rejected", reason: "gateway-not-running" };
    }
    if (await preserveExistingAssignment(txn, assignmentRef, userRef, params)) {
      return { kind: "assignment-preserved" };
    }

    const roll = gatewayData.roll;
    const revisionId =
      roll && roll.acceptingNewAssignments ? roll.targetRevisionId : gatewayData.liveRevisionId;
    const release =
      roll && roll.acceptingNewAssignments ? roll.toRelease : gatewayData.liveRelease;
    if (revisionId === null || release === null) {
      return { kind: "rejected", reason: "no-live-revision" };
    }
    if (!hasCanonicalPlacementRevision(params.gatewayId, revisionId, release)) {
      return { kind: "rejected", reason: "revision-identity-invalid" };
    }
    const revisionSnap = await txn.get(
      db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId),
    );
    const revisionRejectReason = placementRevisionRejectReason(
      revisionSnap,
      params.gatewayId,
      revisionId,
      release,
    );
    if (revisionRejectReason) {
      return { kind: "rejected", reason: revisionRejectReason };
    }

    // Mirror + assignment are all-or-nothing: a serving assignment at epoch 0
    // (the steady baseline before any cutover flip bumps the epoch).
    txn.update(userRef, params.mirrorPatch);
    const assignmentDoc: AssignmentDoc = {
      uid: params.uid,
      slug: params.slug,
      gatewayId: params.gatewayId,
      revisionId,
      release,
      source: params.source,
      state: "serving",
      epoch: 0,
      updatedAt: params.now,
      updatedByOperationId: params.updatedByOperationId ?? null,
    };
    txn.set(assignmentRef, assignmentDoc as unknown as Record<string, unknown>);
    return { kind: "assigned", revisionId, release };
  });
}
