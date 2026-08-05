import { createHash } from "node:crypto";
import type {
  CustomerMigrationV2GatewayRootFence,
  CustomerMigrationV2Phase,
  CustomerMigrationV2State,
} from "@octogee/shared/types/glm";
import {
  projectGatewayDesiredRootForGateway,
} from "@octogee/shared/types/gateway-releases";
import {
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import {
  isDefinitiveConfigRpcRejection,
  MigrationTransportError,
  type MigrationClient,
} from "./fleet-migration-client.js";

const SYSTEM_CONFIG_COMMIT = /^[0-9a-f]{40,64}$/;

function acceptedSystemConfigCommit(value: unknown): string {
  if (typeof value !== "string" || !SYSTEM_CONFIG_COMMIT.test(value)) {
    throw new Error("customer migration V2 source flush did not prove an accepted system-config commit");
  }
  return value;
}

export interface CustomerMigrationV2CutoverFence {
  operationId: string;
  migrationId: string;
  sourceGatewayId: string;
  sourceEpoch: number;
  sourceRelease: number;
  sourceAssignmentMode: "assigned" | "unassigned-live";
  sourceRootFence: CustomerMigrationV2GatewayRootFence;
  targetGatewayId: string;
  targetRelease: number;
  targetRootFence: CustomerMigrationV2GatewayRootFence;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function mutableConfigHash(config: GatewayMutableConfig): string {
  const canonical = canonicalJsonValue({
    configSchemaVersion: config.configSchemaVersion,
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
    openclawOverrides: config.openclawOverrides,
    modelBrokerLimits: config.modelBrokerLimits,
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function customerMigrationV2GatewayRootFence(
  value: unknown,
  gatewayId: string,
): CustomerMigrationV2GatewayRootFence | null {
  const root = projectGatewayDesiredRootForGateway(value, gatewayId);
  if (root === null) return null;
  const valid = [
    root.desiredStatus === "running",
    root.retireAfter == null,
    (root as { retirementClaim?: unknown }).retirementClaim == null,
    typeof root.liveRelease === "number",
    root.desiredRelease === root.liveRelease,
    typeof root.updatedAt === "number" && Number.isFinite(root.updatedAt),
    root.gatewayClass === "builder",
    typeof root.ownerUid === "string" && root.ownerUid.length > 0,
    typeof root.builderSlug === "string" && root.builderSlug.length > 0,
  ].every(Boolean);
  if (!valid) return null;
  const fenced = root as typeof root & {
    updatedAt: number;
    liveRelease: number;
    gatewayClass: "builder";
    ownerUid: string;
    builderSlug: string;
  };
  return {
    gatewayId,
    updatedAt: fenced.updatedAt,
    latestRelease: fenced.latestRelease,
    desiredRelease: fenced.desiredRelease,
    liveRelease: fenced.liveRelease,
    gatewayClass: fenced.gatewayClass,
    ownerUid: fenced.ownerUid,
    builderSlug: fenced.builderSlug,
    configHash: mutableConfigHash(fenced),
  };
}

export function customerMigrationV2GatewayRootFenceEqual(
  left: CustomerMigrationV2GatewayRootFence | null | undefined,
  right: CustomerMigrationV2GatewayRootFence | null | undefined,
): boolean {
  return !!left && !!right &&
    left.gatewayId === right.gatewayId &&
    left.updatedAt === right.updatedAt &&
    left.latestRelease === right.latestRelease &&
    left.desiredRelease === right.desiredRelease &&
    left.liveRelease === right.liveRelease &&
    left.gatewayClass === right.gatewayClass &&
    left.ownerUid === right.ownerUid &&
    left.builderSlug === right.builderSlug &&
    left.configHash === right.configHash;
}

export function customerMigrationV2GatewayRootFenceMatches(
  value: unknown,
  fence: CustomerMigrationV2GatewayRootFence,
): boolean {
  const current = customerMigrationV2GatewayRootFence(value, fence.gatewayId);
  return current !== null && customerMigrationV2GatewayRootFenceEqual(current, fence);
}

export interface CustomerMigrationV2Deps {
  client: MigrationClient;
  setSourceAssignmentState: (state: "serving" | "quiescing") => Promise<void>;
  commitCutover: (fence: CustomerMigrationV2CutoverFence) => Promise<void>;
  now: () => number;
}

export async function advanceCustomerMigrationV2(
  state: CustomerMigrationV2State,
  deps: CustomerMigrationV2Deps,
): Promise<CustomerMigrationV2State> {
  return ADVANCE_HANDLERS[state.phase](state, deps);
}

type AdvanceHandler = (
  state: CustomerMigrationV2State,
  deps: CustomerMigrationV2Deps,
) => Promise<CustomerMigrationV2State>;

async function advancePreparation(
  state: CustomerMigrationV2State,
  deps: CustomerMigrationV2Deps,
): Promise<CustomerMigrationV2State> {
  switch (state.phase) {
    case "initialized":
      await deps.client.transferState({
        migrationId: state.migrationId,
        fromGatewayId: state.sourceGatewayId,
        fromTransportId: state.sourceGatewayId,
        toGatewayId: state.targetGatewayId,
        toTransportId: state.targetGatewayId,
        slug: state.slug,
        mode: "keys",
        includeActivationManifest: false,
      });
      return { ...state, phase: "keysSynced" };
    case "keysSynced":
      await deps.client.transferState({
        migrationId: state.migrationId,
        fromGatewayId: state.sourceGatewayId,
        toGatewayId: state.targetGatewayId,
        fromTransportId: state.sourceGatewayId,
        toTransportId: state.targetGatewayId,
        slug: state.slug,
        mode: "pre",
        includeActivationManifest: false,
      });
      return { ...state, phase: "preSynced" };
    default:
      throw new Error(`customer migration V2 preparation cannot advance ${state.phase}`);
  }
}

async function advanceForward(
  state: CustomerMigrationV2State,
  deps: CustomerMigrationV2Deps,
): Promise<CustomerMigrationV2State> {
  switch (state.phase) {
    case "preSynced": {
      await deps.setSourceAssignmentState("quiescing");
      await deps.client.quiesce({
        migrationId: state.migrationId,
        gatewayId: state.sourceGatewayId,
        transportId: state.sourceGatewayId,
        slug: state.slug,
      });
      const flush = await deps.client.flushGateway({
        migrationId: state.migrationId,
        gatewayId: state.sourceGatewayId,
        transportId: state.sourceGatewayId,
        slug: state.slug,
        reason: "migration-final",
      });
      return {
        ...state,
        phase: "sourceQuiesced",
        sourceSystemConfigCommit: acceptedSystemConfigCommit(flush.systemConfigCommit),
      };
    }
    case "sourceQuiesced": {
      const expectedSystemConfigCommit = acceptedSystemConfigCommit(
        state.sourceSystemConfigCommit,
      );
      await deps.client.transferState({
        migrationId: state.migrationId,
        fromGatewayId: state.sourceGatewayId,
        toGatewayId: state.targetGatewayId,
        fromTransportId: state.sourceGatewayId,
        toTransportId: state.targetGatewayId,
        slug: state.slug,
        mode: "final",
        includeActivationManifest: true,
      });
      await deps.client.flushGateway({
        migrationId: state.migrationId,
        gatewayId: state.targetGatewayId,
        transportId: state.targetGatewayId,
        slug: state.slug,
        reason: "migration-converge",
        expectedSystemConfigCommit,
      });
      return { ...state, phase: "finalSynced" };
    }
    case "finalSynced":
      await deps.client.verifyTarget({
        migrationId: state.migrationId,
        gatewayId: state.targetGatewayId,
        transportId: state.targetGatewayId,
        slug: state.slug,
      });
      return { ...state, phase: "targetVerified" };
    case "targetVerified":
      await deps.commitCutover({
        operationId: state.operationId,
        migrationId: state.migrationId,
        sourceGatewayId: state.sourceGatewayId,
        sourceEpoch: state.sourceEpoch,
        sourceRelease: state.sourceRelease,
        sourceAssignmentMode: state.sourceAssignmentMode,
        sourceRootFence: state.sourceRootFence,
        targetGatewayId: state.targetGatewayId,
        targetRelease: state.targetRelease,
        targetRootFence: state.targetRootFence,
      });
      return { ...state, phase: "cutover", cutoverAt: deps.now() };
    case "cutover":
      await deps.client.unmount({
        migrationId: state.migrationId,
        gatewayId: state.sourceGatewayId,
        transportId: state.sourceGatewayId,
        slug: state.slug,
      });
      return { ...state, phase: "sourceRetired", sourceRetiredAt: deps.now() };
    case "sourceRetired":
      return { ...state, phase: "complete", completedAt: deps.now() };
    default:
      throw new Error(`customer migration V2 forward path cannot advance ${state.phase}`);
  }
}

async function advanceAbort(
  state: CustomerMigrationV2State,
  deps: CustomerMigrationV2Deps,
): Promise<CustomerMigrationV2State> {
  switch (state.phase) {
    case "abortIntent":
      await deps.setSourceAssignmentState("serving");
      await deps.client.unmount({
        migrationId: state.migrationId,
        gatewayId: state.targetGatewayId,
        transportId: state.targetGatewayId,
        slug: state.slug,
      });
      return { ...state, phase: "abortTargetUnmounted" };
    case "abortTargetUnmounted":
      return { ...state, phase: "aborted", abortedAt: deps.now() };
    default:
      throw new Error(`customer migration V2 abort path cannot advance ${state.phase}`);
  }
}

async function terminalState(
  state: CustomerMigrationV2State,
): Promise<CustomerMigrationV2State> {
  return state;
}

const ADVANCE_HANDLERS: Record<CustomerMigrationV2Phase, AdvanceHandler> = {
  initialized: advancePreparation,
  keysSynced: advancePreparation,
  preSynced: advanceForward,
  sourceQuiesced: advanceForward,
  finalSynced: advanceForward,
  targetVerified: advanceForward,
  cutover: advanceForward,
  sourceRetired: advanceForward,
  abortIntent: advanceAbort,
  abortTargetUnmounted: advanceAbort,
  complete: terminalState,
  aborted: terminalState,
};

const POST_INTENT_PHASES: ReadonlySet<CustomerMigrationV2Phase> = new Set([
  "cutover",
  "sourceRetired",
  "complete",
]);

export function isCustomerMigrationV2PostIntent(state: CustomerMigrationV2State): boolean {
  return POST_INTENT_PHASES.has(state.phase);
}

const NEXT_PHASE: Readonly<Partial<Record<CustomerMigrationV2Phase, CustomerMigrationV2Phase>>> = {
  initialized: "keysSynced",
  keysSynced: "preSynced",
  preSynced: "sourceQuiesced",
  sourceQuiesced: "finalSynced",
  finalSynced: "targetVerified",
  targetVerified: "cutover",
  cutover: "sourceRetired",
  sourceRetired: "complete",
  abortIntent: "abortTargetUnmounted",
  abortTargetUnmounted: "aborted",
};

export function isCustomerMigrationV2Transition(
  from: CustomerMigrationV2Phase,
  to: CustomerMigrationV2Phase,
): boolean {
  if (from === to) return true;
  if (NEXT_PHASE[from] === to) return true;
  return to === "abortIntent" &&
    from !== "initialized" &&
    !POST_INTENT_PHASES.has(from) &&
    !isAbortPhaseName(from);
}

function isAbortPhaseName(phase: CustomerMigrationV2Phase): boolean {
  return phase === "abortIntent" ||
    phase === "abortTargetUnmounted" ||
    phase === "aborted";
}

export function beginCustomerMigrationV2Abort(
  state: CustomerMigrationV2State,
  reason: string,
  now: number,
): CustomerMigrationV2State {
  if (isCustomerMigrationV2PostIntent(state)) {
    throw new Error(
      `customer migration V2 phase ${state.phase} crossed cutover and must roll forward`,
    );
  }
  if (state.phase === "initialized") {
    throw new Error("customer migration V2 has no durable target footprint to abort");
  }
  if (isAbortPhaseName(state.phase)) {
    return state;
  }
  return {
    ...state,
    phase: "abortIntent",
    abortFromPhase: state.phase,
    abortReason: reason,
    abortIntentAt: now,
  };
}

export type CustomerMigrationV2ErrorClass = "retry" | "terminal";

interface CustomerMigrationErrorRecord {
  status?: unknown;
  code?: unknown;
  name?: unknown;
  retryable?: unknown;
  message?: unknown;
}

const RETRYABLE_ERROR_NAMES = new Set<unknown>(["AbortError", "TimeoutError"]);
const RETRYABLE_ERROR_CODES = new Set<unknown>([
  4,
  8,
  10,
  14,
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

function customerMigrationErrorRecord(error: unknown): CustomerMigrationErrorRecord {
  if (!error || typeof error !== "object") return {};
  return error as CustomerMigrationErrorRecord;
}

function statusErrorClass(status: unknown): CustomerMigrationV2ErrorClass | null {
  if (typeof status !== "number") return null;
  return status === 408 || status === 429 || status >= 500 ? "retry" : "terminal";
}

function errorMessageIsRetryable(error: unknown, record: CustomerMigrationErrorRecord): boolean {
  const message = error instanceof Error ? error.message : String(record.message ?? error);
  return /response lost|fetch failed|terminated|premature close|unexpected end|truncated|network|socket|ECONN|timed? out|timeout|unavailable|temporar|stale|restarted/i.test(message);
}

export function classifyCustomerMigrationV2Error(
  error: unknown,
): CustomerMigrationV2ErrorClass {
  if (isDefinitiveConfigRpcRejection(error)) return "terminal";
  if (error instanceof MigrationTransportError) return "retry";
  const record = customerMigrationErrorRecord(error);
  if (record.retryable === true) return "retry";
  if (RETRYABLE_ERROR_NAMES.has(record.name)) return "retry";
  if (RETRYABLE_ERROR_CODES.has(record.code)) return "retry";
  const statusClass = statusErrorClass(record.status);
  if (statusClass) return statusClass;
  return errorMessageIsRetryable(error, record) ? "retry" : "terminal";
}
