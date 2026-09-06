export const MANAGED_BY_VALUES = ["cowboy", "operator"];
export const DEFAULT_MANAGED_BY = "cowboy";
export function resolveManagedBy(value) {
    return value === "operator" ? "operator" : DEFAULT_MANAGED_BY;
}
export function isOperatorManaged(value) {
    return resolveManagedBy(value) === "operator";
}
export const GATEWAY_PROFILES = ["standard", "builder"];
export const GATEWAY_CLASSES = ["shared", "builder"];
export const GATEWAY_IMAGE_PROFILES = ["standard", "builder"];
export const GATEWAY_RUNTIMES = ["cluster", "gce-vm"];
export function isGatewayRuntime(value) {
    return typeof value === "string" && GATEWAY_RUNTIMES.includes(value);
}
export function resolveGatewayRuntime(value) {
    return isGatewayRuntime(value) ? value : "cluster";
}
export const GATEWAY_VM_PROVISIONING_MODELS = ["SPOT", "STANDARD"];
export const GATEWAY_VM_ORIGINS = ["warm-pool", "cold"];
export const GATEWAY_VM_STOP_REASONS = ["idle", "preempted", "operator"];
export function isGatewayVmStopReason(value) {
    return typeof value === "string" && GATEWAY_VM_STOP_REASONS.includes(value);
}
export const GATEWAY_VM_PARKED_CHECKPOINT_OUTCOMES = ["fresh", "stale"];
export function isGatewayVmParkedCheckpoint(value) {
    const c = value;
    return !!c
        && typeof c.outcome === "string" && GATEWAY_VM_PARKED_CHECKPOINT_OUTCOMES.includes(c.outcome)
        && (c.requestedAt === null || typeof c.requestedAt === "number")
        && (c.completedAt === null || typeof c.completedAt === "number");
}
export const BUILDER_PARKED_COMPUTER_FIELD = "provisioning.computer";
export function isBuilderParkedComputer(value) {
    const p = value;
    return !!p
        && typeof p.instanceName === "string" && p.instanceName.length > 0
        && typeof p.zone === "string" && p.zone.length > 0
        && (p.instanceId === null || typeof p.instanceId === "string")
        && typeof p.gatewayId === "string" && p.gatewayId.length > 0
        && typeof p.parkedAt === "number" && Number.isFinite(p.parkedAt)
        && isGatewayVmParkedCheckpoint(p.checkpoint);
}
export function readBuilderParkedComputer(userData) {
    const provisioning = userData?.provisioning;
    if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning))
        return null;
    const computer = provisioning.computer;
    return isBuilderParkedComputer(computer) ? computer : null;
}
export const GLM_GATEWAY_VM_SUBCOLLECTION = "vm";
export const GLM_GATEWAY_VM_RUNTIME_DOC = "runtime";
export function gatewayVmRuntimeDocPath(gatewayId) {
    return `${GLM_GATEWAYS_COLLECTION}/${gatewayId}/${GLM_GATEWAY_VM_SUBCOLLECTION}/${GLM_GATEWAY_VM_RUNTIME_DOC}`;
}
export function isGatewayVmRuntimeBundle(value) {
    const b = value;
    return !!b
        && typeof b.version === "string" && b.version.length > 0
        && typeof b.gatewayId === "string" && b.gatewayId.length > 0
        && typeof b.imageRepository === "string"
        && typeof b.imageTag === "string"
        && Array.isArray(b.containers) && b.containers.length > 0
        && Array.isArray(b.volumes)
        && !!b.hostAliases && typeof b.hostAliases === "object"
        && !!b.kubernetes && typeof b.kubernetes.apiHost === "string";
}
export const COMPUTER_HOME_CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const COMPUTER_HOME_CHECKPOINT_KEEP = 5;
export const COMPUTER_HOME_CHECKPOINT_NAME_RE = /^\d{8}T\d{6}Z\.tar\.gz$/u;
export const COMPUTER_HOME_CHECKPOINT_CONTENT_TYPE = "application/gzip";
export function homeCheckpointOutstanding(home) {
    const requestedAt = home?.checkpointRequestedAt;
    if (typeof requestedAt !== "number")
        return false;
    const completedAt = home?.lastCheckpoint?.completedAt;
    return typeof completedAt !== "number" || completedAt < requestedAt
        || typeof home?.checkpointAcknowledgedAt !== "number" || home.checkpointAcknowledgedAt < requestedAt;
}
export function isGatewayVmHomeCheckpoint(value) {
    const c = value;
    return !!c
        && typeof c.name === "string" && COMPUTER_HOME_CHECKPOINT_NAME_RE.test(c.name)
        && typeof c.size === "number" && Number.isSafeInteger(c.size) && c.size > 0 && c.size <= COMPUTER_HOME_CHECKPOINT_MAX_BYTES
        && typeof c.sha256 === "string" && /^[a-f0-9]{64}$/u.test(c.sha256)
        && (c.instanceId === null || typeof c.instanceId === "string")
        && typeof c.completedAt === "number" && Number.isFinite(c.completedAt);
}
export function computerHomeCheckpointName(at) {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime()))
        throw new Error("computer-home checkpoint time is invalid");
    return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.tar.gz`;
}
export function gatewayVmPodName(gatewayId, instanceId) {
    if (!/^\d+$/.test(instanceId))
        throw new Error(`gatewayVmPodName: instance id must be numeric, got ${instanceId}`);
    return `octogee-gateway-${gatewayId}-vm-${instanceId}`;
}
export const BUILDER_COMPUTER_INSTANCE_PREFIX = "octogee-computer-";
export const GATEWAY_DESKTOP_NODE_CONTAINER = "desktop-node";
export const GATEWAY_DESKTOP_NODE_STATE_VOLUME = "desktop-node-state";
export const GATEWAY_DESKTOP_NODE_NAME = "octogee-desktop";
export const GATEWAY_DESKTOP_RUNTIME_DIR = "/run/user/1000";
const GCE_INSTANCE_NAME_MAX = 63;
const GCE_INSTANCE_NAME_HASH_LENGTH = 8;
function fnv1a32Hex(input) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
function gceInstanceName(prefix, raw, what) {
    const trimmed = raw.trim();
    if (!trimmed)
        throw new Error(`${what} is empty`);
    const normalized = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    if (!normalized)
        throw new Error(`${what} ${JSON.stringify(raw)} has no usable characters`);
    const full = `${prefix}${normalized}`;
    if (full.length <= GCE_INSTANCE_NAME_MAX)
        return full;
    const suffix = fnv1a32Hex(trimmed).slice(0, GCE_INSTANCE_NAME_HASH_LENGTH);
    const budget = GCE_INSTANCE_NAME_MAX - prefix.length - suffix.length - 1;
    return `${prefix}${normalized.slice(0, budget).replace(/-$/, "")}-${suffix}`;
}
export function builderComputerInstanceName(environment, ownerUid) {
    const env = environment.trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(env))
        throw new Error(`builderComputerInstanceName: environment ${JSON.stringify(environment)} is not a name segment`);
    return gceInstanceName(`${BUILDER_COMPUTER_INSTANCE_PREFIX}${env}-`, ownerUid, "builderComputerInstanceName: ownerUid");
}
export const GATEWAY_CONTROL_IDENTITY_MODES = ["shared-operator", "per-user"];
export const DEFAULT_GATEWAY_CONTROL_IDENTITY = "shared-operator";
export function isGatewayControlIdentity(value) {
    return (typeof value === "string" &&
        GATEWAY_CONTROL_IDENTITY_MODES.includes(value));
}
export function resolveGatewayControlIdentity(value) {
    return value === "per-user" ? "per-user" : DEFAULT_GATEWAY_CONTROL_IDENTITY;
}
export const BUILDER_GATEWAY_LOCKED_ACCESS = {
    controlUiEnabled: false,
    reason: "runtime-trust-boundary-not-provisioned",
};
export function defaultBuilderGatewayAccess(ownerUid) {
    return ownerUid
        ? {
            controlUiEnabled: true,
            reason: "owned-runtime-gateway",
        }
        : BUILDER_GATEWAY_LOCKED_ACCESS;
}
export function resolveBuilderGatewayAccess(ownerUid, builderAccess) {
    return {
        ...defaultBuilderGatewayAccess(ownerUid),
        ...(builderAccess ?? {}),
    };
}
export const BUILDER_GATEWAY_SERVICE_ACCOUNT_PREFIX = "octogee-gw-";
export const GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME = "octogee-gateway";
export const GATEWAY_ID_MAX_LENGTH = 32;
export const GATEWAY_ID_REQUIREMENT = "gatewayId must be a lowercase DNS-safe id, 1-32 chars, starting and ending with a letter or digit";
export const BUILDER_GATEWAY_LOCKED_SERVICE_ACCOUNT = {
    create: true,
};
export function isValidGatewayId(id) {
    if (typeof id !== "string" || id.length === 0 || id.length > GATEWAY_ID_MAX_LENGTH) {
        return false;
    }
    if (!isGatewayIdEndpoint(id.charCodeAt(0)))
        return false;
    if (!isGatewayIdEndpoint(id.charCodeAt(id.length - 1)))
        return false;
    for (let i = 1; i < id.length - 1; i += 1) {
        const code = id.charCodeAt(i);
        if (!isGatewayIdEndpoint(code) && code !== 45)
            return false;
    }
    return true;
}
function isGatewayIdEndpoint(code) {
    return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}
const ROLL_ROLE_SUFFIXES = ["-blue", "-green"];
export const NEW_GATEWAY_ID_REQUIREMENT = `${GATEWAY_ID_REQUIREMENT}; the -blue/-green suffixes are reserved for roll roles`;
// Creation-time validator: roll-role suffixes are reserved so the
// deriveGatewayIdentity convention fallback is safe by construction.
// Instance ids minted by the blue/green machinery (shared-a-blue) stay valid
// under isValidGatewayId for routing and reconciliation.
export function isValidNewGatewayId(id) {
    if (!isValidGatewayId(id))
        return false;
    return !ROLL_ROLE_SUFFIXES.some((suffix) => id.endsWith(suffix));
}
// Resolves the durable gateway identity for an instance: the explicit
// `gateway` field when present, else a naming-convention fallback that
// strips a trailing -blue/-green roll-role suffix. Instance ids without that
// suffix are their own bare identity (for example, a shared root or one-off runtime).
export function deriveGatewayIdentity(gatewayId, explicitGateway) {
    if (typeof explicitGateway === "string" && explicitGateway.length > 0) {
        return explicitGateway;
    }
    for (const suffix of ROLL_ROLE_SUFFIXES) {
        if (gatewayId.endsWith(suffix))
            return gatewayId.slice(0, -suffix.length);
    }
    return gatewayId;
}
export function builderGatewayServiceAccountName(gatewayId) {
    return `${BUILDER_GATEWAY_SERVICE_ACCOUNT_PREFIX}${gatewayId}`;
}
export function isGatewayClassControlUiAccessEnabled(gatewayClass, builderAccess) {
    return gatewayClass === "builder" && builderAccess?.controlUiEnabled === true;
}
export function resolveUserGatewayControlState(data, uid) {
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
export const OPERATION_ORIGINS = ["automatic", "operator"];
export function resolveOperationOrigin(value) {
    return value === "automatic" ? "automatic" : "operator";
}
export const OPERATION_AUDIT_RECORD_TYPE = "audit";
export const OPERATION_AUDIT_SCHEMA_VERSION = 1;
export const OPERATION_AUDIT_LIFECYCLE_STAGES = [
    "intent-recorded",
    "action-started",
    "action-completed",
    "action-partial",
    "action-failed",
];
function isAuditObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isNonEmptyAuditString(value) {
    return typeof value === "string" && value.length > 0;
}
function isFiniteAuditNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isAuditAliasPlan(value) {
    return Array.isArray(value) && value.every((entry) => isAuditObject(entry) &&
        isNonEmptyAuditString(entry.alias) &&
        isNonEmptyAuditString(entry.intendedTarget) &&
        (entry.expectedTarget === undefined || entry.expectedTarget === null ||
            typeof entry.expectedTarget === "string"));
}
function isAuditAliasOutcomes(value) {
    const statuses = new Set([
        "applied",
        "already-applied",
        "skipped",
        "failed",
    ]);
    return Array.isArray(value) && value.every((entry) => isAuditObject(entry) &&
        isNonEmptyAuditString(entry.alias) &&
        typeof entry.status === "string" && statuses.has(entry.status) &&
        (entry.observedTarget === undefined || entry.observedTarget === null ||
            typeof entry.observedTarget === "string") &&
        (entry.error === undefined || typeof entry.error === "string"));
}
function isAuditReleaseRollout(value) {
    return isAuditObject(value) &&
        (value.releaseId === undefined || isNonEmptyAuditString(value.releaseId)) &&
        (value.releaseTag === undefined || isNonEmptyAuditString(value.releaseTag)) &&
        (value.rolloutOperationId === undefined || isNonEmptyAuditString(value.rolloutOperationId));
}
function isAuditTestProvenance(value) {
    return isAuditObject(value) && value.environment === "test" &&
        (value.sourceCommit === undefined || isNonEmptyAuditString(value.sourceCommit)) &&
        (value.verifiedBy === undefined || isNonEmptyAuditString(value.verifiedBy)) &&
        (value.verifiedAt === undefined || isFiniteAuditNumber(value.verifiedAt));
}
function isAuditPartialOutcome(value) {
    return isAuditObject(value) && isNonEmptyAuditString(value.summary) &&
        (value.details === undefined || isAuditObject(value.details));
}
function hasAuditClaim(value) {
    return isNonEmptyAuditString(value.actionClaimId) && isFiniteAuditNumber(value.actionStartedAt) &&
        typeof value.actionRecoveryCount === "number" &&
        Number.isInteger(value.actionRecoveryCount) && value.actionRecoveryCount >= 0;
}
function hasRecordedAuditState(value) {
    return value.lifecycleStage === "intent-recorded" && value.completedAt === null &&
        value.actionClaimId === undefined && value.actionStartedAt === undefined &&
        value.outcome === undefined && value.partialOutcome === undefined && value.error === undefined;
}
function hasInProgressAuditState(value) {
    return value.lifecycleStage === "action-started" && value.completedAt === null &&
        hasAuditClaim(value) && value.outcome === undefined &&
        value.partialOutcome === undefined && value.error === undefined;
}
function hasCompletedAuditState(value) {
    if (!hasAuditClaim(value) || !isFiniteAuditNumber(value.completedAt))
        return false;
    if (value.error !== undefined)
        return false;
    if (value.lifecycleStage === "action-completed") {
        return value.outcome === "completed" && value.partialOutcome === undefined;
    }
    return value.lifecycleStage === "action-partial" && value.outcome === "partial" &&
        isAuditObject(value.partialOutcome) && isNonEmptyAuditString(value.partialOutcome.summary);
}
function hasFailedAuditState(value) {
    return value.lifecycleStage === "action-failed" && value.outcome === "failed" &&
        hasAuditClaim(value) && isFiniteAuditNumber(value.completedAt) &&
        isNonEmptyAuditString(value.error);
}
function hasLegalAuditState(value) {
    if (value.status === "recorded")
        return hasRecordedAuditState(value);
    if (value.status === "in-progress")
        return hasInProgressAuditState(value);
    if (value.status === "completed")
        return hasCompletedAuditState(value);
    return value.status === "failed" && hasFailedAuditState(value);
}
export function isOperationAuditRow(value) {
    return (isAuditObject(value) && value.recordType === OPERATION_AUDIT_RECORD_TYPE);
}
function hasRequiredAuditRecordMetadata(value) {
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
function isOptionalAuditField(value, validator) {
    return value === undefined || validator(value);
}
function hasValidOptionalAuditRecordFields(value) {
    return isOptionalAuditField(value.aliasOutcomes, isAuditAliasOutcomes) &&
        isOptionalAuditField(value.releaseRollout, isAuditReleaseRollout) &&
        isOptionalAuditField(value.testProvenance, isAuditTestProvenance) &&
        isOptionalAuditField(value.partialOutcome, isAuditPartialOutcome);
}
function hasValidOptionalAuditRecoveryCount(value) {
    return value.actionRecoveryCount === undefined ||
        (typeof value.actionRecoveryCount === "number" &&
            Number.isInteger(value.actionRecoveryCount) && value.actionRecoveryCount >= 0);
}
export function isOperationAuditRecord(value) {
    if (!isOperationAuditRow(value))
        return false;
    return hasRequiredAuditRecordMetadata(value) &&
        hasValidOptionalAuditRecordFields(value) &&
        hasValidOptionalAuditRecoveryCount(value) &&
        hasLegalAuditState(value);
}
export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";
export const GLM_MIGRATION_TRANSFER_TASKS_COLLECTION = "glmMigrationTransferTasks";
export function isGatewayClass(value) {
    return (typeof value === "string" &&
        GATEWAY_CLASSES.includes(value));
}
export function isGatewayProfile(value) {
    return (typeof value === "string" &&
        GATEWAY_PROFILES.includes(value));
}
export function resolveGatewayClass(input) {
    return input.gatewayClass === "builder" ? "builder" : "shared";
}
export function resolveGatewayImageProfile(input) {
    if (input.imageProfile === "builder")
        return "builder";
    if (input.imageProfile === "standard")
        return "standard";
    if (!input.gatewayClass && input.profile === "builder")
        return "builder";
    return resolveGatewayClass(input) === "builder" ? "builder" : "standard";
}
