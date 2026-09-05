import type { SizingTier } from "./sizing.js";

export type GatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

export const MANAGED_BY_VALUES = ["cowboy", "operator"] as const;
export type ManagedBy = (typeof MANAGED_BY_VALUES)[number];
export const DEFAULT_MANAGED_BY: ManagedBy = "cowboy";

export function resolveManagedBy(value: unknown): ManagedBy {
  return value === "operator" ? "operator" : DEFAULT_MANAGED_BY;
}

export function isOperatorManaged(value: unknown): boolean {
  return resolveManagedBy(value) === "operator";
}

export const GATEWAY_PROFILES = ["standard", "builder"] as const;
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];

export const GATEWAY_CLASSES = ["shared", "builder"] as const;
export type GatewayClass = (typeof GATEWAY_CLASSES)[number];

export const GATEWAY_IMAGE_PROFILES = ["standard", "builder"] as const;
export type GatewayImageProfile = (typeof GATEWAY_IMAGE_PROFILES)[number];

export interface GatewayDesiredState {
  gatewayId: string;

  /**
   * Durable identity this instance belongs to (`shared-a`, `bender`) — bare,
   * never blue/green-suffixed. Explicit on every instance written after the
   * gateway field landed; older docs derive it from gatewayId by convention
   * via deriveGatewayIdentity until backfilled.
   */
  gateway?: string;

  imageRepository: string;
  imageTag: string;

  /**
   * Legacy overloaded image/capability selector. Keep for compatibility with
   * already-authored desired-state docs and API clients. New callers should set
   * gatewayClass + imageProfile explicitly.
   */
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  desiredStatus: GatewayDesiredStatus;

  createdBy: string;

  retireAfter?: number;

  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;

  gcpProject?: string;

  gatewayContainerSecurityContext?: Record<string, unknown>;

  builderAccess?: BuilderGatewayAccessSpec;

  lastError?: { at: number; message: string } | null;

  openclawOverrides?: Record<string, unknown>;

  ownerUid?: string;

  builderSlug?: string;

  sizingTier?: SizingTier;

  modelBrokerLimits?: GatewayModelBrokerLimits;

  runtime?: GatewayRuntime;

  vmSpec?: GatewayVmSpec;

  vm?: GatewayVmState | null;
}

export const GATEWAY_RUNTIMES = ["cluster", "gce-vm"] as const;
export type GatewayRuntime = (typeof GATEWAY_RUNTIMES)[number];

export function isGatewayRuntime(value: unknown): value is GatewayRuntime {
  return typeof value === "string" && (GATEWAY_RUNTIMES as readonly string[]).includes(value);
}

export function resolveGatewayRuntime(value: unknown): GatewayRuntime {
  return isGatewayRuntime(value) ? value : "cluster";
}

export const GATEWAY_VM_PROVISIONING_MODELS = ["SPOT", "STANDARD"] as const;
export type GatewayVmProvisioningModel = (typeof GATEWAY_VM_PROVISIONING_MODELS)[number];

export interface GatewayVmSpec {
  zone: string;
  machineType: string;
  imageFamily: string;
  imageProject?: string;
  diskSizeGb: number;
  provisioningModel: GatewayVmProvisioningModel;
  serviceAccountEmail: string;
  subnetwork: string;
}

export interface GatewayVmState {
  instanceName: string;
  zone: string;
  instanceId: string | null;
  internalIp: string | null;
  status: string | null;
  provisioningModel: GatewayVmProvisioningModel | null;
  updatedAt: number;
}

export const GATEWAY_VM_INSTANCE_PREFIX = "octogee-gw-";
const GCE_INSTANCE_NAME_MAX = 63;
const GATEWAY_VM_NAME_HASH_LENGTH = 8;

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function gatewayVmInstanceName(gatewayId: string): string {
  const trimmed = gatewayId.trim();
  if (!trimmed) throw new Error("gatewayVmInstanceName: gatewayId is empty");
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) throw new Error(`gatewayVmInstanceName: gatewayId ${JSON.stringify(gatewayId)} has no usable characters`);
  const full = `${GATEWAY_VM_INSTANCE_PREFIX}${normalized}`;
  if (full.length <= GCE_INSTANCE_NAME_MAX) return full;
  const suffix = fnv1a32Hex(trimmed).slice(0, GATEWAY_VM_NAME_HASH_LENGTH);
  const budget = GCE_INSTANCE_NAME_MAX - GATEWAY_VM_INSTANCE_PREFIX.length - suffix.length - 1;
  return `${GATEWAY_VM_INSTANCE_PREFIX}${normalized.slice(0, budget).replace(/-$/, "")}-${suffix}`;
}

export interface GatewayModelBrokerLimits {
  spendWindowUsd?: number | null;
  spendWeekUsd?: number | null;
  requestsPerMinute?: number | null;
}

export interface GatewayServiceAccountSpec {
  create?: boolean;
  annotations?: Record<string, string>;
}

export const GATEWAY_CONTROL_IDENTITY_MODES = ["shared-operator", "per-user"] as const;
export type GatewayControlIdentity = (typeof GATEWAY_CONTROL_IDENTITY_MODES)[number];
export const DEFAULT_GATEWAY_CONTROL_IDENTITY: GatewayControlIdentity = "shared-operator";

export function isGatewayControlIdentity(value: unknown): value is GatewayControlIdentity {
  return (
    typeof value === "string" &&
    (GATEWAY_CONTROL_IDENTITY_MODES as readonly string[]).includes(value)
  );
}

export function resolveGatewayControlIdentity(value: unknown): GatewayControlIdentity {
  return value === "per-user" ? "per-user" : DEFAULT_GATEWAY_CONTROL_IDENTITY;
}

export interface BuilderGatewayAccessSpec {
  controlUiEnabled?: boolean;
  controlIdentity?: GatewayControlIdentity;
  kubeApiServerEgressCidrs?: string[];
  reason?: string;
  verifiedAt?: number;
  verifiedBy?: string;
}

export const BUILDER_GATEWAY_LOCKED_ACCESS: BuilderGatewayAccessSpec = {
  controlUiEnabled: false,
  reason: "runtime-trust-boundary-not-provisioned",
};

export function defaultBuilderGatewayAccess(
  ownerUid: string | null | undefined,
): BuilderGatewayAccessSpec {
  return ownerUid
    ? {
      controlUiEnabled: true,
      reason: "owned-runtime-gateway",
    }
    : BUILDER_GATEWAY_LOCKED_ACCESS;
}

export function resolveBuilderGatewayAccess(
  ownerUid: string | null | undefined,
  builderAccess: BuilderGatewayAccessSpec | null | undefined,
): BuilderGatewayAccessSpec {
  return {
    ...defaultBuilderGatewayAccess(ownerUid),
    ...(builderAccess ?? {}),
  };
}

export const BUILDER_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";
export const GATEWAY_ID_MAX_LENGTH = 32;
export const GATEWAY_ID_REQUIREMENT =
  "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit";

export const BUILDER_GATEWAY_LOCKED_SERVICE_ACCOUNT: GatewayServiceAccountSpec = {
  create: true,
};

export function isValidGatewayId(id: unknown): id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > GATEWAY_ID_MAX_LENGTH) {
    return false;
  }
  if (!isGatewayIdEndpoint(id.charCodeAt(0))) return false;
  if (!isGatewayIdEndpoint(id.charCodeAt(id.length - 1))) return false;
  for (let i = 1; i < id.length - 1; i += 1) {
    const code = id.charCodeAt(i);
    if (!isGatewayIdEndpoint(code) && code !== 45) return false;
  }
  return true;
}

function isGatewayIdEndpoint(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

const ROLL_ROLE_SUFFIXES = ["-blue", "-green"] as const;

export const NEW_GATEWAY_ID_REQUIREMENT =
  `${GATEWAY_ID_REQUIREMENT}; the -blue/-green suffixes are reserved for roll roles`;

// Creation-time validator: roll-role suffixes are reserved so the
// deriveGatewayIdentity convention fallback is safe by construction.
// Instance ids minted by the blue/green machinery (shared-a-blue) stay valid
// under isValidGatewayId for routing and reconciliation.
export function isValidNewGatewayId(id: unknown): id is string {
  if (!isValidGatewayId(id)) return false;
  return !ROLL_ROLE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

// Resolves the durable gateway identity for an instance: the explicit
// `gateway` field when present, else a naming-convention fallback that
// strips a trailing -blue/-green roll-role suffix. Instance ids without that
// suffix are their own bare identity (for example, a shared root or one-off runtime).
export function deriveGatewayIdentity(
  gatewayId: string,
  explicitGateway?: unknown,
): string {
  if (typeof explicitGateway === "string" && explicitGateway.length > 0) {
    return explicitGateway;
  }
  for (const suffix of ROLL_ROLE_SUFFIXES) {
    if (gatewayId.endsWith(suffix)) return gatewayId.slice(0, -suffix.length);
  }
  return gatewayId;
}

export function builderGatewayServiceAccountName(gatewayId: string): string {
  return `${BUILDER_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
}

export function isGatewayClassControlUiAccessEnabled(
  gatewayClass: GatewayClass | undefined,
  builderAccess: BuilderGatewayAccessSpec | undefined,
): boolean {
  return gatewayClass === "builder" && builderAccess?.controlUiEnabled === true;
}

export function resolveUserGatewayControlState(
  data:
    | {
        gatewayClass?: unknown;
        profile?: unknown;
        imageProfile?: unknown;
        ownerUid?: unknown;
        builderAccess?: BuilderGatewayAccessSpec;
      }
    | undefined,
  uid: string,
): { gatewayProfile: GatewayProfile; controlUiEnabled: boolean } {
  const gatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(data?.gatewayClass) ? data.gatewayClass : undefined,
    profile: isGatewayProfile(data?.profile) ? data.profile : undefined,
    imageProfile: isGatewayProfile(data?.imageProfile) ? data.imageProfile : undefined,
  });
  const userOwns = data?.ownerUid === uid;
  return {
    gatewayProfile: gatewayClass === "builder" ? "builder" : "standard",
    controlUiEnabled: userOwns && isGatewayClassControlUiAccessEnabled(gatewayClass, data?.builderAccess),
  };
}

export type OperationKind =
  | "add-gateway"
  | "gateway-vm"
  | "migrate-customer"
  | "retire-gateway"
  | "restart-gateway"
  | "recycle-gateway"
  | "scale-shared-member"
  | "rollout"
  | "deprovision-customer"
  | "suspend-customer"
  | "erase-customer";

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled-back";

export const OPERATION_ORIGINS = ["automatic", "operator"] as const;
export type OperationOrigin = (typeof OPERATION_ORIGINS)[number];

export function resolveOperationOrigin(value: unknown): OperationOrigin {
  return value === "automatic" ? "automatic" : "operator";
}

export const OPERATION_AUDIT_RECORD_TYPE = "audit" as const;
export const OPERATION_AUDIT_SCHEMA_VERSION = 1 as const;

export const OPERATION_AUDIT_LIFECYCLE_STAGES = [
  "intent-recorded",
  "action-started",
  "action-completed",
  "action-partial",
  "action-failed",
] as const;
export type OperationAuditLifecycleStage =
  (typeof OPERATION_AUDIT_LIFECYCLE_STAGES)[number];

export type OperationAuditStatus = "recorded" | "in-progress" | "completed" | "failed";
export type OperationAuditOutcome = "completed" | "partial" | "failed";

export interface OperationAuditAliasPlan {
  alias: string;
  expectedTarget?: string | null;
  intendedTarget: string;
}

export type OperationAuditAliasOutcomeStatus =
  | "applied"
  | "already-applied"
  | "skipped"
  | "failed";

export interface OperationAuditAliasOutcome {
  alias: string;
  status: OperationAuditAliasOutcomeStatus;
  observedTarget?: string | null;
  error?: string;
}

export interface OperationAuditReleaseRolloutLinkage {
  releaseId?: string;
  releaseTag?: string;
  rolloutOperationId?: string;
}

export interface OperationAuditTestProvenance {
  environment: "test";
  sourceCommit?: string;
  verifiedBy?: string;
  verifiedAt?: number;
}

export interface OperationAuditPartialOutcome {
  summary: string;
  details?: Record<string, unknown>;
}

export interface OperationAuditDocument {
  recordType: typeof OPERATION_AUDIT_RECORD_TYPE;
  schemaVersion: typeof OPERATION_AUDIT_SCHEMA_VERSION;
  status: OperationAuditStatus;
  lifecycleStage: OperationAuditLifecycleStage;
  idempotencyKey: string;
  mutationFingerprint: string;
  mutation: Record<string, unknown>;
  actor: string;
  forced: boolean;
  what: string;
  why: string;
  target: Record<string, unknown>;
  preActionStatus: Record<string, unknown>;
  aliasPlan: OperationAuditAliasPlan[];
  aliasOutcomes?: OperationAuditAliasOutcome[];
  releaseRollout?: OperationAuditReleaseRolloutLinkage;
  testProvenance?: OperationAuditTestProvenance;
  outcome?: OperationAuditOutcome;
  partialOutcome?: OperationAuditPartialOutcome;
  createdAt: number;
  actionClaimId?: string;
  actionStartedAt?: number;
  actionRecoveryCount?: number;
  completedAt: number | null;
  error?: string;
}

export interface OperationAuditRecord extends OperationAuditDocument {
  id: string;
}

export type GlmOperationRecord = Operation | OperationAuditRecord;

function isAuditObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyAuditString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteAuditNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAuditAliasPlan(value: unknown): value is OperationAuditAliasPlan[] {
  return Array.isArray(value) && value.every((entry) =>
    isAuditObject(entry) &&
    isNonEmptyAuditString(entry.alias) &&
    isNonEmptyAuditString(entry.intendedTarget) &&
    (entry.expectedTarget === undefined || entry.expectedTarget === null ||
      typeof entry.expectedTarget === "string")
  );
}

function isAuditAliasOutcomes(value: unknown): value is OperationAuditAliasOutcome[] {
  const statuses: ReadonlySet<string> = new Set([
    "applied",
    "already-applied",
    "skipped",
    "failed",
  ]);
  return Array.isArray(value) && value.every((entry) =>
    isAuditObject(entry) &&
    isNonEmptyAuditString(entry.alias) &&
    typeof entry.status === "string" && statuses.has(entry.status) &&
    (entry.observedTarget === undefined || entry.observedTarget === null ||
      typeof entry.observedTarget === "string") &&
    (entry.error === undefined || typeof entry.error === "string")
  );
}

function isAuditReleaseRollout(value: unknown): boolean {
  return isAuditObject(value) &&
    (value.releaseId === undefined || isNonEmptyAuditString(value.releaseId)) &&
    (value.releaseTag === undefined || isNonEmptyAuditString(value.releaseTag)) &&
    (value.rolloutOperationId === undefined || isNonEmptyAuditString(value.rolloutOperationId));
}

function isAuditTestProvenance(value: unknown): boolean {
  return isAuditObject(value) && value.environment === "test" &&
    (value.sourceCommit === undefined || isNonEmptyAuditString(value.sourceCommit)) &&
    (value.verifiedBy === undefined || isNonEmptyAuditString(value.verifiedBy)) &&
    (value.verifiedAt === undefined || isFiniteAuditNumber(value.verifiedAt));
}

function isAuditPartialOutcome(value: unknown): boolean {
  return isAuditObject(value) && isNonEmptyAuditString(value.summary) &&
    (value.details === undefined || isAuditObject(value.details));
}

function hasAuditClaim(value: Record<string, unknown>): boolean {
  return isNonEmptyAuditString(value.actionClaimId) && isFiniteAuditNumber(value.actionStartedAt) &&
    typeof value.actionRecoveryCount === "number" &&
    Number.isInteger(value.actionRecoveryCount) && value.actionRecoveryCount >= 0;
}

function hasRecordedAuditState(value: Record<string, unknown>): boolean {
  return value.lifecycleStage === "intent-recorded" && value.completedAt === null &&
    value.actionClaimId === undefined && value.actionStartedAt === undefined &&
    value.outcome === undefined && value.partialOutcome === undefined && value.error === undefined;
}

function hasInProgressAuditState(value: Record<string, unknown>): boolean {
  return value.lifecycleStage === "action-started" && value.completedAt === null &&
    hasAuditClaim(value) && value.outcome === undefined &&
    value.partialOutcome === undefined && value.error === undefined;
}

function hasCompletedAuditState(value: Record<string, unknown>): boolean {
  if (!hasAuditClaim(value) || !isFiniteAuditNumber(value.completedAt)) return false;
  if (value.error !== undefined) return false;
  if (value.lifecycleStage === "action-completed") {
    return value.outcome === "completed" && value.partialOutcome === undefined;
  }
  return value.lifecycleStage === "action-partial" && value.outcome === "partial" &&
    isAuditObject(value.partialOutcome) && isNonEmptyAuditString(value.partialOutcome.summary);
}

function hasFailedAuditState(value: Record<string, unknown>): boolean {
  return value.lifecycleStage === "action-failed" && value.outcome === "failed" &&
    hasAuditClaim(value) && isFiniteAuditNumber(value.completedAt) &&
    isNonEmptyAuditString(value.error);
}

function hasLegalAuditState(value: Record<string, unknown>): boolean {
  if (value.status === "recorded") return hasRecordedAuditState(value);
  if (value.status === "in-progress") return hasInProgressAuditState(value);
  if (value.status === "completed") return hasCompletedAuditState(value);
  return value.status === "failed" && hasFailedAuditState(value);
}

export function isOperationAuditRow(value: unknown): value is Record<string, unknown> & {
  recordType: typeof OPERATION_AUDIT_RECORD_TYPE;
} {
  return (
    isAuditObject(value) && value.recordType === OPERATION_AUDIT_RECORD_TYPE
  );
}

function hasRequiredAuditRecordMetadata(value: Record<string, unknown>): boolean {
  return value.schemaVersion === OPERATION_AUDIT_SCHEMA_VERSION &&
    isNonEmptyAuditString(value.idempotencyKey) &&
    isNonEmptyAuditString(value.mutationFingerprint) &&
    isAuditObject(value.mutation) &&
    isNonEmptyAuditString(value.actor) &&
    typeof value.forced === "boolean" &&
    isNonEmptyAuditString(value.what) &&
    isNonEmptyAuditString(value.why) &&
    isAuditObject(value.target) &&
    isAuditObject(value.preActionStatus) &&
    isAuditAliasPlan(value.aliasPlan) &&
    isFiniteAuditNumber(value.createdAt);
}

function isOptionalAuditField(
  value: unknown,
  validator: (value: unknown) => boolean,
): boolean {
  return value === undefined || validator(value);
}

function hasValidOptionalAuditRecordFields(value: Record<string, unknown>): boolean {
  return isOptionalAuditField(value.aliasOutcomes, isAuditAliasOutcomes) &&
    isOptionalAuditField(value.releaseRollout, isAuditReleaseRollout) &&
    isOptionalAuditField(value.testProvenance, isAuditTestProvenance) &&
    isOptionalAuditField(value.partialOutcome, isAuditPartialOutcome);
}

function hasValidOptionalAuditRecoveryCount(value: Record<string, unknown>): boolean {
  return value.actionRecoveryCount === undefined ||
    (typeof value.actionRecoveryCount === "number" &&
      Number.isInteger(value.actionRecoveryCount) && value.actionRecoveryCount >= 0);
}

export function isOperationAuditRecord(value: unknown): value is OperationAuditDocument {
  if (!isOperationAuditRow(value)) return false;
  return hasRequiredAuditRecordMetadata(value) &&
    hasValidOptionalAuditRecordFields(value) &&
    hasValidOptionalAuditRecoveryCount(value) &&
    hasLegalAuditState(value);
}

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface OperationStep {
  name: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  createdBy: string;
  origin?: OperationOrigin;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: OperationStep[];
  error?: string;
  rolledBack?: boolean;
  // Heartbeat for the stuck-op reaper: bumped every time a step is reported and on
  // resume-adoption. Lets a long or resumed roll keep proving liveness so it is reaped
  // only when progress genuinely stalls, not on absolute age since first claim.
  lastProgressAt?: number;
  // Incremented each time a controller re-adopts this op after a restart (observability).
  resumeCount?: number;
  // A serially-exclusive op (e.g. rollout) parked pending because a conflicting op of
  // the same kind is running. Human-readable, e.g. "bender-blue → bender-green". Cleared
  // once the op is claimed.
  waitingOn?: string | null;
  // Set when a transient failure schedules an automatic retry; the op stays `pending`
  // until this passes. Cleared once claimed.
  nextAttemptAt?: number | null;
  // Total handler invocations so far (first run = 1). Ordinary transient work
  // caps at MAX_OPERATION_ATTEMPTS; explicit level-triggered obligations may exceed it.
  attempts?: number;
  // One entry per FAILED attempt — retried or terminal — preserving that attempt's
  // steps/error/classification (the live `steps` field resets on retry). Successful
  // completions append nothing.
  attemptHistory?: OperationAttemptRecord[];
  output?: Record<string, unknown>;
  customerMigrationV2?: CustomerMigrationV2State;
}

export type CustomerMigrationV2Phase =
  | "initialized"
  | "keysSynced"
  | "preSynced"
  | "sourceQuiesced"
  | "finalSynced"
  | "targetVerified"
  | "freshSourceQuiesced"
  | "freshCutoverReady"
  | "cutover"
  | "sourceRetired"
  | "complete"
  | "abortIntent"
  | "abortTargetUnmounted"
  | "aborted";

export interface CustomerMigrationV2GatewayRootFence {
  gatewayId: string;
  updatedAt: number;
  latestRelease: number;
  desiredRelease: number;
  liveRelease: number;
  gatewayClass: "builder";
  ownerUid: string;
  builderSlug: string;
  configHash: string;
}

export interface CustomerMigrationV2State {
  phase: CustomerMigrationV2Phase;
  strategy?: "migrate-state" | "provision-fresh";
  operationId: string;
  migrationId: string;
  uid: string;
  slug: string;
  sourceGatewayId: string;
  sourceRelease: number;
  sourceEpoch: number;
  sourceAssignmentMode: "assigned" | "unassigned-live";
  sourceRootFence: CustomerMigrationV2GatewayRootFence;
  targetGatewayId: string;
  targetRelease: number;
  targetRootFence: CustomerMigrationV2GatewayRootFence;
  sourceSystemConfigCommit?: string;
  cutoverAt?: number;
  sourceRetiredAt?: number;
  completedAt?: number;
  abortFromPhase?: CustomerMigrationV2Phase;
  abortReason?: string;
  abortIntentAt?: number;
  abortedAt?: number;
}

export interface OperationAttemptRecord {
  attempt: number;
  startedAt: number;
  completedAt: number;
  error: string;
  classification: "transient" | "terminal";
  steps: OperationStep[];
}

export interface HelmInstanceValue {
  enabled: boolean;
  image: { repository: string; tag: string };
  gatewayId: string;

  chartFingerprint?: string;
  deploymentIntentFingerprint?: string;
  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;
  gatewayContainerSecurityContext?: Record<string, unknown>;
  builderAccess?: BuilderGatewayAccessSpec;

  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  ownerUid?: string;
  builderSlug?: string;

  sizingTier?: SizingTier;

  replicas?: number;
}

export type HelmInstancesMap = Record<string, HelmInstanceValue>;

export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";
export const GLM_MIGRATION_TRANSFER_TASKS_COLLECTION =
  "glmMigrationTransferTasks";

export function isGatewayClass(value: unknown): value is GatewayClass {
  return (
    typeof value === "string" &&
    (GATEWAY_CLASSES as readonly string[]).includes(value)
  );
}

export function isGatewayProfile(value: unknown): value is GatewayProfile {
  return (
    typeof value === "string" &&
    (GATEWAY_PROFILES as readonly string[]).includes(value)
  );
}

export function resolveGatewayClass(input: {
  gatewayClass?: GatewayClass;
  profile?: GatewayProfile;
  imageProfile?: GatewayImageProfile;
}): GatewayClass {
  return input.gatewayClass === "builder" ? "builder" : "shared";
}

export function resolveGatewayImageProfile(input: {
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  profile?: GatewayProfile;
}): GatewayImageProfile {
  if (input.imageProfile === "builder") return "builder";
  if (input.imageProfile === "standard") return "standard";
  if (!input.gatewayClass && input.profile === "builder") return "builder";
  return resolveGatewayClass(input) === "builder" ? "builder" : "standard";
}
