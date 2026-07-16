import type { Firestore } from "firebase-admin/firestore";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAY_UNREACHABLE_AFTER_MS,
  GATEWAYS_COLLECTION,
  hasDurableOpenClawConfigControlProtocol,
} from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import {
  isGatewayDesiredDoc,
  isRevisionRealizationDoc,
  revisionIdForRelease,
  type GatewayRetirementClaim as RetirementClaim,
  type GatewayRetirementConfigCheckpoint,
  type GatewayRetirementConfigTerminal,
  type RevisionRealizationDoc,
} from "@octogee/shared/types/gateway-releases";

export class GatewayRetirementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRetirementConflictError";
  }
}

interface RetirementOperation {
  input?: unknown;
  [key: string]: unknown;
}

interface ClaimGatewayRetirementInput {
  db: Firestore;
  gatewayId: string;
  operationId: string;
  operation: RetirementOperation;
  now: number;
  updatedBy: string;
}

interface VerifyGatewayRetirementClaimInput {
  db: Firestore;
  gatewayId: string;
  operationId: string;
  version: number;
  now: number;
  updatedBy: string;
}

interface AttestGatewayRetirementAfterWakeInput
  extends VerifyGatewayRetirementClaimInput {}

interface BindGatewayRetirementConfigCheckpointInput
  extends VerifyGatewayRetirementClaimInput {
  checkpoint: GatewayRetirementConfigCheckpoint;
}

interface VerifyGatewayRetirementConfigCheckpointInput {
  db: Firestore;
  gatewayId: string;
  operationId: string;
  version: number;
  checkpoint: GatewayRetirementConfigCheckpoint;
  now: number;
}

interface BindGatewayRetirementConfigTerminalInput
  extends VerifyGatewayRetirementClaimInput {
  checkpoint: GatewayRetirementConfigCheckpoint;
  terminal: GatewayRetirementConfigTerminal;
  recovery?: true;
}

interface VerifyGatewayRetirementConfigTerminalInput {
  db: Firestore;
  gatewayId: string;
  operationId: string;
  version: number;
  checkpoint: GatewayRetirementConfigCheckpoint;
  terminal: GatewayRetirementConfigTerminal;
  now: number;
}

export type GatewayRetirementVerification =
  | { ok: true }
  | { ok: false; error: string };

export type GatewayRetirementWakeAttestation =
  | { ok: true; wakeRequired: boolean }
  | { ok: false; error: string; retryable: boolean };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function hasGatewayRetirementConfigObligation(status: unknown): boolean {
  if (!isPlainRecord(status)) return false;
  return (
    status.freezeState === "freezing" ||
    status.freezeState === "frozen" ||
    status.bootRole === "source-frozen" ||
    status.bootRole === "target-candidate" ||
    isPlainRecord(status.controlOwner) ||
    nonEmptyString(status.candidateCommit) ||
    nonEmptyString(status.candidateHash)
  );
}

function heartbeatFromRevision(revision: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(revision) || !isPlainRecord(revision.heartbeat)) return null;
  return revision.heartbeat;
}

function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    try {
      const result = (value as { toMillis: () => unknown }).toMillis();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  }
  return null;
}

function freshObservation(value: unknown, now: number): boolean {
  const observedAt = millis(value);
  return observedAt !== null &&
    observedAt <= now + GATEWAY_HEARTBEAT_INTERVAL_MS &&
    now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

function hasRootConfigControlObligation(root: Record<string, unknown>): boolean {
  return root.roll != null || root.systemConfigRoll != null;
}

interface RevisionView {
  id: string;
  data: unknown;
}

type LiveRuntimeIdentity = RetirementClaim["liveRuntimeIdentity"];

interface RetirementStateInspection {
  error: string | null;
  liveRuntimeIdentity: LiveRuntimeIdentity;
}

function canonicalRevision(
  gatewayId: string,
  view: RevisionView,
): RevisionRealizationDoc | null {
  const revision = view.data;
  if (!isRevisionRealizationDoc(revision)) return null;
  return revision.gateway === gatewayId &&
    revision.revisionId === view.id &&
    Number.isInteger(revision.release) &&
    revision.release > 0 &&
    view.id === revisionIdForRelease(gatewayId, revision.release)
    ? revision
    : null;
}

function hasSafeDedicatedConfigTelemetry(
  heartbeat: Record<string, unknown>,
  status: Record<string, unknown> | null,
  now: number,
): boolean {
  return !!status &&
    hasDurableOpenClawConfigControlProtocol(status) &&
    freshObservation(status.observedAt, now) &&
    status.runtimeReady === true &&
    status.freezeState === "unfrozen" &&
    status.bootRole === "normal" &&
    nonEmptyString(heartbeat.openclawVersion) &&
    status.openclawVersion === heartbeat.openclawVersion;
}

function nonRetiredRevisionError(
  gatewayId: string,
  liveRevisionId: string,
  revision: RevisionRealizationDoc,
  now: number,
  configControlRequired: boolean,
): string | null {
  if (revision.lifecycle === "retired") return null;
  const heartbeat = heartbeatFromRevision(revision);
  if (
    !heartbeat ||
    !Array.isArray(heartbeat.mountedCustomers) ||
    !heartbeat.mountedCustomers.every(
      (customer) => typeof customer === "string" && customer.length > 0,
    )
  ) {
    return `gateway ${gatewayId} revision ${revision.revisionId} mount telemetry is unavailable`;
  }
  if (heartbeat.mountedCustomers.length > 0) {
    return `gateway ${gatewayId} revision ${revision.revisionId} still has mounted customers: ${
      heartbeat.mountedCustomers.join(", ")
    }`;
  }
  if (!freshObservation(heartbeat.lastHeartbeatAt, now)) {
    return `gateway ${gatewayId} revision ${revision.revisionId} telemetry is stale or unavailable`;
  }
  if (hasGatewayRetirementConfigObligation(heartbeat.configStatus)) {
    return revision.revisionId === liveRevisionId
      ? `gateway ${gatewayId} live revision has an active config-control obligation`
      : `gateway ${gatewayId} revision ${revision.revisionId} has an active config-control obligation`;
  }
  const status = isPlainRecord(heartbeat.configStatus) ? heartbeat.configStatus : null;
  if (
    configControlRequired &&
    !hasSafeDedicatedConfigTelemetry(heartbeat, status, now)
  ) {
    return `gateway ${gatewayId} revision ${revision.revisionId} config telemetry is stale or unavailable`;
  }
  return null;
}

function liveRuntimeIdentity(
  revision: RevisionRealizationDoc | null,
  now: number,
  configControlRequired: boolean,
): LiveRuntimeIdentity {
  const heartbeat = heartbeatFromRevision(revision);
  const status = heartbeat && isPlainRecord(heartbeat.configStatus)
    ? heartbeat.configStatus
    : null;
  if (!revision || !heartbeat) return null;
  const complete = [
    revision.lifecycle === "serving",
    heartbeat.status === "ready",
    freshObservation(heartbeat.lastHeartbeatAt, now),
    typeof heartbeat.startedAt === "number" && Number.isFinite(heartbeat.startedAt),
    nonEmptyString(heartbeat.version),
    nonEmptyString(heartbeat.openclawVersion),
    !configControlRequired || hasSafeDedicatedConfigTelemetry(heartbeat, status, now),
  ].every(Boolean);
  return complete
    ? {
        startedAt: heartbeat.startedAt as number,
        version: heartbeat.version as string,
        openclawVersion: heartbeat.openclawVersion as string,
      }
    : null;
}

function inspectRetirementState(
  gatewayId: string,
  root: Record<string, unknown>,
  revisions: readonly RevisionView[],
  now: number,
): RetirementStateInspection {
  const configControlRequired = root.gatewayClass !== "shared";
  const liveRevisionId = root.liveRevisionId;
  const liveRelease = root.liveRelease;
  if (
    typeof liveRevisionId !== "string" ||
    !Number.isInteger(liveRelease) ||
    (liveRelease as number) <= 0 ||
    root.trafficRevisionId !== liveRevisionId ||
    liveRevisionId !== revisionIdForRelease(gatewayId, liveRelease as number)
  ) {
    return {
      error: `gateway ${gatewayId} exact live revision telemetry is unavailable`,
      liveRuntimeIdentity: null,
    };
  }

  let liveRevision: RevisionRealizationDoc | null = null;
  for (const view of revisions) {
    const revision = canonicalRevision(gatewayId, view);
    if (!revision) {
      return {
        error: `gateway ${gatewayId} revision ${view.id} telemetry is invalid`,
        liveRuntimeIdentity: null,
      };
    }
    if (view.id === liveRevisionId) liveRevision = revision;
    const error = nonRetiredRevisionError(
      gatewayId,
      liveRevisionId,
      revision,
      now,
      configControlRequired,
    );
    if (error) {
      return {
        error,
        liveRuntimeIdentity: null,
      };
    }
  }

  if (
    !isRevisionRealizationDoc(liveRevision) ||
    liveRevision.revisionId !== liveRevisionId ||
    liveRevision.gateway !== gatewayId ||
    liveRevision.release !== liveRelease
  ) {
    return {
      error: `gateway ${gatewayId} exact live revision telemetry is unavailable`,
      liveRuntimeIdentity: null,
    };
  }

  const identity = liveRuntimeIdentity(liveRevision, now, configControlRequired);
  if (!identity) {
    return {
      error: `gateway ${gatewayId} exact live revision telemetry/config status is unavailable`,
      liveRuntimeIdentity: null,
    };
  }

  return {
    error: null,
    liveRuntimeIdentity: identity,
  };
}

function inspectPausedRetirementState(
  gatewayId: string,
  root: Record<string, unknown>,
  revisions: readonly RevisionView[],
): string | null {
  const liveRevisionId = root.liveRevisionId;
  const liveRelease = root.liveRelease;
  if (
    typeof liveRevisionId !== "string" ||
    !Number.isInteger(liveRelease) ||
    (liveRelease as number) <= 0 ||
    root.trafficRevisionId !== liveRevisionId ||
    liveRevisionId !== revisionIdForRelease(gatewayId, liveRelease as number)
  ) {
    return `gateway ${gatewayId} exact live revision telemetry is unavailable`;
  }

  let foundLive = false;
  for (const view of revisions) {
    const revision = canonicalRevision(gatewayId, view);
    if (!revision) return `gateway ${gatewayId} revision ${view.id} telemetry is invalid`;
    if (view.id === liveRevisionId) foundLive = true;
    if (revision.lifecycle === "retired") continue;
    const heartbeat = heartbeatFromRevision(revision);
    if (
      !heartbeat ||
      !Array.isArray(heartbeat.mountedCustomers) ||
      !heartbeat.mountedCustomers.every(
        (customer) => typeof customer === "string" && customer.length > 0,
      )
    ) {
      return `gateway ${gatewayId} revision ${revision.revisionId} mount telemetry is unavailable`;
    }
    if (heartbeat.mountedCustomers.length > 0) {
      return `gateway ${gatewayId} revision ${revision.revisionId} still has mounted customers: ${
        heartbeat.mountedCustomers.join(", ")
      }`;
    }
    if (hasGatewayRetirementConfigObligation(heartbeat.configStatus)) {
      return revision.revisionId === liveRevisionId
        ? `gateway ${gatewayId} live revision has an active config-control obligation`
        : `gateway ${gatewayId} revision ${revision.revisionId} has an active config-control obligation`;
    }
  }
  return foundLive
    ? null
    : `gateway ${gatewayId} exact live revision telemetry is unavailable`;
}

function runtimeIdentity(value: unknown): LiveRuntimeIdentity {
  if (!isPlainRecord(value)) return null;
  if (
    typeof value.startedAt !== "number" ||
    !Number.isFinite(value.startedAt) ||
    !nonEmptyString(value.version) ||
    !nonEmptyString(value.openclawVersion)
  ) {
    return null;
  }
  return {
    startedAt: value.startedAt,
    version: value.version,
    openclawVersion: value.openclawVersion,
  };
}

function sameRuntimeIdentity(
  left: LiveRuntimeIdentity,
  right: LiveRuntimeIdentity,
): boolean {
  if (!left || !right) return left === right;
  return left.startedAt === right.startedAt &&
    left.version === right.version &&
    left.openclawVersion === right.openclawVersion;
}

function isSha(value: unknown, length: 40 | 64): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function readConfigCheckpoint(value: unknown): GatewayRetirementConfigCheckpoint | null {
  if (!isPlainRecord(value)) return null;
  if (
    !nonEmptyString(value.migrationId) ||
    !nonEmptyString(value.slug) ||
    !nonEmptyString(value.sourceRevisionId) ||
    !nonEmptyString(value.targetRevisionId) ||
    !isSha(value.checkpointCommit, 40) ||
    !isSha(value.configHash, 64) ||
    !isSha(value.freezeObject, 40)
  ) {
    return null;
  }
  return value as unknown as GatewayRetirementConfigCheckpoint;
}

function sameConfigCheckpoint(
  left: GatewayRetirementConfigCheckpoint,
  right: GatewayRetirementConfigCheckpoint,
): boolean {
  return left.migrationId === right.migrationId &&
    left.slug === right.slug &&
    left.sourceRevisionId === right.sourceRevisionId &&
    left.targetRevisionId === right.targetRevisionId &&
    left.checkpointCommit === right.checkpointCommit &&
    left.configHash === right.configHash &&
    left.freezeObject === right.freezeObject;
}

function readConfigTerminal(value: unknown): GatewayRetirementConfigTerminal | null {
  if (!isPlainRecord(value)) return null;
  if (
    !nonEmptyString(value.retirementRef) ||
    !isSha(value.retirementObject, 40)
  ) return null;
  return value as unknown as GatewayRetirementConfigTerminal;
}

function sameConfigTerminal(
  left: GatewayRetirementConfigTerminal,
  right: GatewayRetirementConfigTerminal,
): boolean {
  return left.retirementRef === right.retirementRef &&
    left.retirementObject === right.retirementObject;
}

function readClaim(value: unknown): RetirementClaim | null {
  if (!isPlainRecord(value)) return null;
  const phase = value.phase;
  const identity = runtimeIdentity(value.liveRuntimeIdentity);
  const checkpoint = value.configCheckpoint === null
    ? null
    : readConfigCheckpoint(value.configCheckpoint);
  const terminal = value.configTerminal === null
    ? null
    : readConfigTerminal(value.configTerminal);
  if (
    typeof value.operationId !== "string" ||
    !Number.isInteger(value.version) ||
    (value.version as number) <= 0 ||
    typeof value.claimedAt !== "number" ||
    !Number.isFinite(value.claimedAt) ||
    (value.previousDesiredStatus !== "running" && value.previousDesiredStatus !== "paused") ||
    typeof value.liveRevisionId !== "string" ||
    !Number.isInteger(value.liveRelease) ||
    (value.liveRelease as number) <= 0 ||
    (phase !== "waking" && phase !== "claimed") ||
    (phase === "waking" && value.liveRuntimeIdentity !== null) ||
    (phase === "claimed" && identity === null) ||
    (value.configCheckpoint !== null && checkpoint === null) ||
    (value.configTerminal !== null && terminal === null) ||
    (terminal !== null && checkpoint === null) ||
    (phase === "waking" && checkpoint !== null)
  ) {
    return null;
  }
  return value as unknown as RetirementClaim;
}

function nextRetirementVersion(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new GatewayRetirementConflictError("gateway retirement version is invalid");
  }
  return (value as number) + 1;
}

function operationInput(operation: RetirementOperation): Record<string, unknown> {
  if (!isPlainRecord(operation.input)) {
    throw new Error("retirement operation input must be an object");
  }
  return operation.input;
}

export async function claimGatewayRetirementAtomic(
  input: ClaimGatewayRetirementInput,
): Promise<{ version: number; wakeRequired: boolean }> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  const operationRef = input.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .doc(input.operationId);

  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} durable root is unavailable`);
    }
    const root = rootData as unknown as Record<string, unknown>;
    if (rootData.desiredStatus === "retired") {
      throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} is already retired`);
    }
    if (root.retirementClaim != null) {
      throw new GatewayRetirementConflictError(
        `gateway ${input.gatewayId} already has a retirement claim`,
      );
    }
    if (hasRootConfigControlObligation(root)) {
      throw new GatewayRetirementConflictError(
        `gateway ${input.gatewayId} has an unfinished release roll and config obligation`,
      );
    }
    if (rootData.desiredRelease !== rootData.liveRelease) {
      throw new GatewayRetirementConflictError(
        `gateway ${input.gatewayId} desired release is not converged to live`,
      );
    }

    const revisionsSnap = await transaction.get(
      input.db.collection(GLM_GATEWAYS_COLLECTION).where("gateway", "==", input.gatewayId),
    );
    const revisions = revisionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    const dedicated = root.gatewayClass === "builder" || root.gatewayClass === "operator";
    const wakeRequired = rootData.desiredStatus === "paused" && dedicated;
    const inspection = wakeRequired
      ? { error: inspectPausedRetirementState(input.gatewayId, root, revisions), liveRuntimeIdentity: null }
      : inspectRetirementState(input.gatewayId, root, revisions, input.now);
    if (inspection.error) throw new GatewayRetirementConflictError(inspection.error);

    const version = nextRetirementVersion(root.retirementVersion);
    const claim: RetirementClaim = {
      operationId: input.operationId,
      version,
      claimedAt: input.now,
      phase: wakeRequired ? "waking" : "claimed",
      liveRevisionId: rootData.liveRevisionId,
      liveRelease: rootData.liveRelease,
      liveRuntimeIdentity: inspection.liveRuntimeIdentity,
      previousDesiredStatus: rootData.desiredStatus,
      configCheckpoint: null,
      configTerminal: null,
    };
    transaction.set(
      rootRef,
      {
        desiredStatus: dedicated ? "running" : "retired",
        retirementVersion: version,
        retirementClaim: claim,
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { merge: true },
    );
    transaction.set(operationRef, {
      ...input.operation,
      input: {
        ...operationInput(input.operation),
        retirementClaimVersion: version,
        ...(wakeRequired ? { retirementWakeRequired: true } : {}),
      },
    });
    return { version, wakeRequired };
  });
}

function retryableWakeAttestationError(error: string): boolean {
  return /telemetry is (stale or )?unavailable|telemetry\/config status is unavailable/.test(error);
}

export async function attestGatewayRetirementAfterWakeAtomic(
  input: AttestGatewayRetirementAfterWakeInput,
): Promise<GatewayRetirementWakeAttestation> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable retirement state is unavailable`,
        retryable: true,
      };
    }
    const root = rootData as unknown as Record<string, unknown>;
    const claim = readClaim(root.retirementClaim);
    if (
      !claim ||
      claim.operationId !== input.operationId ||
      claim.version !== input.version
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
        retryable: false,
      };
    }
    if (claim.phase === "claimed") {
      const dedicatedUnbound =
        (root.gatewayClass === "builder" || root.gatewayClass === "operator") &&
        claim.configTerminal === null;
      return rootData.desiredStatus === (dedicatedUnbound ? "running" : "retired")
        ? { ok: true, wakeRequired: claim.previousDesiredStatus === "paused" }
        : {
            ok: false,
            error: `gateway ${input.gatewayId} desiredStatus does not match retirement phase`,
            retryable: false,
          };
    }
    if (
      claim.previousDesiredStatus !== "paused" ||
      rootData.desiredStatus !== "running" ||
      claim.configCheckpoint !== null
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement wake claim is invalid`,
        retryable: false,
      };
    }
    if (
      root.liveRevisionId !== claim.liveRevisionId ||
      root.liveRelease !== claim.liveRelease ||
      rootData.desiredRelease !== rootData.liveRelease ||
      hasRootConfigControlObligation(root)
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable state changed during retirement wake`,
        retryable: false,
      };
    }

    const revisionsSnap = await transaction.get(
      input.db.collection(GLM_GATEWAYS_COLLECTION).where("gateway", "==", input.gatewayId),
    );
    const inspection = inspectRetirementState(
      input.gatewayId,
      root,
      revisionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
      input.now,
    );
    if (inspection.error) {
      return {
        ok: false,
        error: inspection.error,
        retryable: retryableWakeAttestationError(inspection.error),
      };
    }
    transaction.set(
      rootRef,
      {
        retirementClaim: {
          ...claim,
          phase: "claimed",
          liveRuntimeIdentity: inspection.liveRuntimeIdentity,
        },
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { merge: true },
    );
    return { ok: true, wakeRequired: true };
  });
}

function rejectionForCurrentState(
  gatewayId: string,
  root: Record<string, unknown>,
  claim: RetirementClaim,
  revisions: readonly RevisionView[],
  now: number,
): string | null {
  if (
    root.liveRevisionId !== claim.liveRevisionId ||
    root.liveRelease !== claim.liveRelease
  ) {
    return `gateway ${gatewayId} live revision changed after retirement claim`;
  }
  if (hasRootConfigControlObligation(root)) {
    return `gateway ${gatewayId} has an unfinished release roll and config obligation`;
  }
  if (root.desiredRelease !== root.liveRelease) {
    return `gateway ${gatewayId} desired release is not converged to live`;
  }
  const inspection = inspectRetirementState(gatewayId, root, revisions, now);
  if (inspection.error) return inspection.error;
  if (!sameRuntimeIdentity(claim.liveRuntimeIdentity, inspection.liveRuntimeIdentity)) {
    return `gateway ${gatewayId} live runtime identity changed after retirement claim`;
  }
  return null;
}

export async function verifyGatewayRetirementClaimAtomic(
  input: VerifyGatewayRetirementClaimInput,
): Promise<GatewayRetirementVerification> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable retirement state is unavailable`,
      };
    }
    const root = rootData as unknown as Record<string, unknown>;
    const claim = readClaim(root.retirementClaim);
    if (
      !claim ||
      claim.operationId !== input.operationId ||
      claim.version !== input.version
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
      };
    }
    if (claim.phase !== "claimed") {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim has not completed wake attestation`,
      };
    }
    if (claim.configCheckpoint !== null) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement config checkpoint requires bound verification`,
      };
    }

    const revisionsSnap = await transaction.get(
      input.db.collection(GLM_GATEWAYS_COLLECTION).where("gateway", "==", input.gatewayId),
    );
    const stateError = rootData.desiredStatus !== "retired"
      ? `gateway ${input.gatewayId} desiredStatus is no longer retired`
      : rejectionForCurrentState(
        input.gatewayId,
        root,
        claim,
        revisionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
        input.now,
      );
    if (!stateError) return { ok: true };

    transaction.set(
      rootRef,
      {
        ...(rootData.desiredStatus === "retired"
          ? { desiredStatus: claim.previousDesiredStatus }
          : {}),
        retirementClaim: null,
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { merge: true },
    );
    return { ok: false, error: stateError };
  });
}

function checkpointBindingError(
  gatewayId: string,
  operationId: string,
  root: Record<string, unknown>,
  claim: RetirementClaim,
  checkpoint: GatewayRetirementConfigCheckpoint,
): string | null {
  if (
    readConfigCheckpoint(checkpoint) === null ||
    checkpoint.migrationId !== `retire-${operationId}` ||
    checkpoint.sourceRevisionId !== claim.liveRevisionId ||
    checkpoint.targetRevisionId !== `${gatewayId}-r0` ||
    checkpoint.sourceRevisionId === checkpoint.targetRevisionId ||
    root.builderSlug !== checkpoint.slug ||
    (root.gatewayClass !== "builder" && root.gatewayClass !== "operator")
  ) {
    return `gateway ${gatewayId} retirement config checkpoint binding is invalid`;
  }
  return null;
}

export async function bindGatewayRetirementConfigCheckpointAtomic(
  input: BindGatewayRetirementConfigCheckpointInput,
): Promise<GatewayRetirementVerification> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable retirement state is unavailable`,
      };
    }
    const root = rootData as unknown as Record<string, unknown>;
    const claim = readClaim(root.retirementClaim);
    if (
      !claim ||
      claim.operationId !== input.operationId ||
      claim.version !== input.version ||
      claim.phase !== "claimed"
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
      };
    }
    const bindingError = checkpointBindingError(
      input.gatewayId,
      input.operationId,
      root,
      claim,
      input.checkpoint,
    );
    if (bindingError) return { ok: false, error: bindingError };
    if (
      rootData.desiredStatus !== (claim.configTerminal === null ? "running" : "retired") ||
      root.liveRevisionId !== claim.liveRevisionId ||
      root.liveRelease !== claim.liveRelease ||
      rootData.desiredRelease !== rootData.liveRelease ||
      hasRootConfigControlObligation(root)
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable state changed before config checkpoint binding`,
      };
    }
    if (claim.configCheckpoint !== null) {
      return sameConfigCheckpoint(claim.configCheckpoint, input.checkpoint)
        ? { ok: true }
        : {
            ok: false,
            error: `gateway ${input.gatewayId} retirement config checkpoint changed before teardown`,
          };
    }
    transaction.set(
      rootRef,
      {
        retirementClaim: { ...claim, configCheckpoint: input.checkpoint },
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { merge: true },
    );
    return { ok: true };
  });
}

function finalRetirementStateError(
  gatewayId: string,
  root: Record<string, unknown>,
  claim: RetirementClaim,
  revisions: readonly RevisionView[],
  now: number,
  recoveryCheckpoint?: GatewayRetirementConfigCheckpoint,
): string | null {
  if (
    root.liveRevisionId !== claim.liveRevisionId ||
    root.liveRelease !== claim.liveRelease
  ) {
    return `gateway ${gatewayId} live revision changed after retirement claim`;
  }
  if (hasRootConfigControlObligation(root)) {
    return `gateway ${gatewayId} has an unfinished release roll and config obligation`;
  }
  if (root.desiredRelease !== root.liveRelease) {
    return `gateway ${gatewayId} desired release is not converged to live`;
  }

  let liveRevision: RevisionRealizationDoc | null = null;
  for (const view of revisions) {
    const revision = canonicalRevision(gatewayId, view);
    if (!revision) return `gateway ${gatewayId} revision ${view.id} telemetry is invalid`;
    if (revision.lifecycle === "retired") continue;
    if (revision.revisionId !== claim.liveRevisionId) {
      const error = nonRetiredRevisionError(
        gatewayId,
        claim.liveRevisionId as string,
        revision,
        now,
        true,
      );
      if (error) return error;
      continue;
    }
    liveRevision = revision;
    const heartbeat = heartbeatFromRevision(revision);
    if (
      !heartbeat ||
      !Array.isArray(heartbeat.mountedCustomers) ||
      !heartbeat.mountedCustomers.every(
        (customer) => typeof customer === "string" && customer.length > 0,
      )
    ) {
      return `gateway ${gatewayId} revision ${revision.revisionId} mount telemetry is unavailable`;
    }
    if (heartbeat.mountedCustomers.length > 0) {
      return `gateway ${gatewayId} revision ${revision.revisionId} still has mounted customers: ${
        heartbeat.mountedCustomers.join(", ")
      }`;
    }
  }
  const identity = liveRuntimeIdentity(liveRevision, now, false);
  if (!identity) {
    return `gateway ${gatewayId} exact live revision telemetry is unavailable`;
  }
  if (recoveryCheckpoint) {
    const heartbeat = heartbeatFromRevision(liveRevision);
    const status = heartbeat && isPlainRecord(heartbeat.configStatus)
      ? heartbeat.configStatus
      : null;
    const owner = status && isPlainRecord(status.controlOwner)
      ? status.controlOwner
      : null;
    if (
      !heartbeat ||
      !status ||
      !claim.liveRuntimeIdentity ||
      identity.version !== claim.liveRuntimeIdentity.version ||
      identity.openclawVersion !== claim.liveRuntimeIdentity.openclawVersion ||
      !hasDurableOpenClawConfigControlProtocol(status) ||
      !freshObservation(status.observedAt, now) ||
      status.runtimeReady !== true ||
      status.openclawVersion !== heartbeat.openclawVersion ||
      status.freezeState !== "frozen" ||
      status.bootRole !== "source-frozen" ||
      status.checkpointCommit !== recoveryCheckpoint.checkpointCommit ||
      status.configHash !== recoveryCheckpoint.configHash ||
      !owner ||
      owner.migrationId !== recoveryCheckpoint.migrationId ||
      owner.sourceRevisionId !== recoveryCheckpoint.sourceRevisionId ||
      owner.targetRevisionId !== recoveryCheckpoint.targetRevisionId ||
      nonEmptyString(status.candidateCommit) ||
      nonEmptyString(status.candidateHash)
    ) {
      return `gateway ${gatewayId} restarted source retirement fence telemetry is not exact`;
    }
    return null;
  }
  if (!sameRuntimeIdentity(claim.liveRuntimeIdentity, identity)) {
    return `gateway ${gatewayId} live runtime identity changed after retirement claim`;
  }
  return null;
}

export async function verifyGatewayRetirementConfigCheckpointAtomic(
  input: VerifyGatewayRetirementConfigCheckpointInput,
): Promise<GatewayRetirementVerification> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable retirement state is unavailable`,
      };
    }
    const root = rootData as unknown as Record<string, unknown>;
    const claim = readClaim(root.retirementClaim);
    if (
      !claim ||
      claim.operationId !== input.operationId ||
      claim.version !== input.version ||
      claim.phase !== "claimed"
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
      };
    }
    if (
      claim.configCheckpoint === null ||
      !sameConfigCheckpoint(claim.configCheckpoint, input.checkpoint)
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement config checkpoint changed before teardown`,
      };
    }
    const bindingError = checkpointBindingError(
      input.gatewayId,
      input.operationId,
      root,
      claim,
      input.checkpoint,
    );
    if (bindingError) return { ok: false, error: bindingError };
    if (rootData.desiredStatus !== "running") {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} desiredStatus changed before config terminal binding`,
      };
    }
    const revisionsSnap = await transaction.get(
      input.db.collection(GLM_GATEWAYS_COLLECTION).where("gateway", "==", input.gatewayId),
    );
    const stateError = finalRetirementStateError(
      input.gatewayId,
      root,
      claim,
      revisionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
      input.now,
    );
    return stateError ? { ok: false, error: stateError } : { ok: true };
  });
}

function terminalBindingError(
  gatewayId: string,
  checkpoint: GatewayRetirementConfigCheckpoint,
  terminal: GatewayRetirementConfigTerminal,
): string | null {
  if (
    readConfigTerminal(terminal) === null ||
    terminal.retirementRef !==
      `refs/octogee/system-config/retired/${checkpoint.sourceRevisionId}`
  ) {
    return `gateway ${gatewayId} retirement config terminal binding is invalid`;
  }
  return null;
}

export async function bindGatewayRetirementConfigTerminalAtomic(
  input: BindGatewayRetirementConfigTerminalInput,
): Promise<GatewayRetirementVerification> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable retirement state is unavailable`,
      };
    }
    const root = rootData as unknown as Record<string, unknown>;
    const claim = readClaim(root.retirementClaim);
    if (
      !claim ||
      claim.operationId !== input.operationId ||
      claim.version !== input.version ||
      claim.phase !== "claimed"
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
      };
    }
    if (
      claim.configCheckpoint === null ||
      !sameConfigCheckpoint(claim.configCheckpoint, input.checkpoint)
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement config checkpoint changed before teardown`,
      };
    }
    const bindingError = checkpointBindingError(
      input.gatewayId,
      input.operationId,
      root,
      claim,
      input.checkpoint,
    ) ?? terminalBindingError(input.gatewayId, input.checkpoint, input.terminal);
    if (bindingError) return { ok: false, error: bindingError };
    const expectedDesiredStatus = claim.configTerminal === null ? "running" : "retired";
    if (rootData.desiredStatus !== expectedDesiredStatus) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} desiredStatus changed before config terminal binding`,
      };
    }
    if (claim.configTerminal !== null) {
      return sameConfigTerminal(claim.configTerminal, input.terminal)
        ? { ok: true }
        : {
            ok: false,
            error: `gateway ${input.gatewayId} retirement config terminal changed before teardown`,
          };
    }
    const revisionsSnap = await transaction.get(
      input.db.collection(GLM_GATEWAYS_COLLECTION).where("gateway", "==", input.gatewayId),
    );
    const stateError = finalRetirementStateError(
      input.gatewayId,
      root,
      claim,
      revisionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
      input.now,
      input.recovery ? input.checkpoint : undefined,
    );
    if (stateError) return { ok: false, error: stateError };
    transaction.set(
      rootRef,
      {
        desiredStatus: "retired",
        retirementClaim: { ...claim, configTerminal: input.terminal },
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { merge: true },
    );
    return { ok: true };
  });
}

export async function verifyGatewayRetirementConfigTerminalAtomic(
  input: VerifyGatewayRetirementConfigTerminalInput,
): Promise<GatewayRetirementVerification> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable retirement state is unavailable`,
      };
    }
    const root = rootData as unknown as Record<string, unknown>;
    const claim = readClaim(root.retirementClaim);
    if (
      !claim ||
      claim.operationId !== input.operationId ||
      claim.version !== input.version ||
      claim.phase !== "claimed"
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
      };
    }
    if (
      claim.configCheckpoint === null ||
      !sameConfigCheckpoint(claim.configCheckpoint, input.checkpoint)
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement config checkpoint changed before teardown`,
      };
    }
    if (
      claim.configTerminal === null ||
      !sameConfigTerminal(claim.configTerminal, input.terminal)
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement config terminal changed before teardown`,
      };
    }
    const bindingError = checkpointBindingError(
      input.gatewayId,
      input.operationId,
      root,
      claim,
      input.checkpoint,
    ) ?? terminalBindingError(input.gatewayId, input.checkpoint, input.terminal);
    if (bindingError) return { ok: false, error: bindingError };
    return rootData.desiredStatus === "retired"
      ? { ok: true }
      : {
          ok: false,
          error: `gateway ${input.gatewayId} desiredStatus is no longer retired`,
        };
  });
}
