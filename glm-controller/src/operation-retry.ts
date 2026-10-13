import { sourceTransferBlocksRelease } from './lib/source-transfer-execution.js';
import type { SourceTransferExecution } from '@octogee/shared/types/glm';
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type {
  CustomerMigrationV2State,
  OperationAttemptRecord,
  Operation,
  OperationStep,
} from "@octogee/shared/types/glm";
import type { OperationResult } from "./operation-router.js";
import { MIGRATE_CUSTOMER_KIND } from "./operation-kinds.js";

export type OperationFailureClassification = "transient" | "terminal";

export function isGatewayStartupUnavailable(error: string | undefined): boolean {
  return typeof error === "string" && /\b(?:agent \S+ (?:has not completed startup inspection and preparation|startup preparation was superseded)|gateway starting; retry shortly)\b/i.test(error);
}

// Explicit allowlist, terminal by default: "TRUE validation failures... fail
// immediately" is the safe default for a string-classified error. Only causes
// we recognize as environmental (network/K8s-API hiccups, timeouts, preemption)
// get an automatic retry.
const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /^source management health unconfirmed; outcome remains fenced$/,
  /^restore recovery Kubernetes outcome is unresolved$/,
  /^restore recovery images are not ready; outcome remains fenced$/,
  /rsync import port \d+ is already serving migrationId=/,
  /\btimed?\s?out\b/i,
  /\bsocket closed before connect response\b/i,
  /\bis held for migration\b/i,
  /\bquiesce did not drain\b/i,
  /\bScheduler runs are still draining\b/i,
  /\bexpected exactly one (ready|running) pod for transport=\S+; found \d+/i,
  /\boperation \S+ did not finish within \d+ms\b/i,
  /did not (warm|become ready|render|publish)/i,
  /durable desired revision did not materialize/i,
  /never published a heartbeat/i,
  /\bdeadline exceeded\b/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bfetch failed\b/i,
  /\bterminated\b/i,
  /\bpremature close\b/i,
  /\bunexpected end\b/i,
  /\btruncated\b/i,
  /\b14 UNAVAILABLE\b/i,
  /\b(status|HTTP) (429|502|503|504)\b/,
  /\bdatabase is locked\b/i,
  /\bpreempt(ed|ion)?\b/i,
  /You must be logged in to the server \(Unauthorized\)/,
  /config unfreeze cleanup pending/i,
  /source unmount cleanup pending/i,
  /scheduler handoff cleanup pending/i,
  /retirement config freeze failed/i,
  /system config writer lock is busy/i,
  /system config mutation unavailable: writer-lock-busy/i,
  /fleet will retry/i,
  /gateway .* is not migration-ready/i,
  /\[migration-http\] local SSH public key is missing for /i,
  /\[migration-activation:[^\]]+\] source has no applied fingerprint; converge it before migration/i,
];

export function classifyOperationFailure(
  error: string | undefined,
): OperationFailureClassification {
  if (!error) return "terminal";
  if (isGatewayStartupUnavailable(error)) return "transient";
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(error))
    ? "transient"
    : "terminal";
}

export const MAX_OPERATION_ATTEMPTS = 3;
export const MAX_PREEMPTED_OPERATION_ATTEMPTS = 6;
export const MAX_OPERATION_ATTEMPT_HISTORY = 20;

// `completedAt` is a plain epoch number, which a native Firestore TTL policy
// cannot read; `expireAt` is its Timestamp twin. Terminal rows only — a row that
// can still change must never carry an expiry.
export const OPERATION_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

function journalExpiry(now: number): Timestamp {
  return Timestamp.fromMillis(now + OPERATION_JOURNAL_RETENTION_MS);
}

const RETRY_BACKOFF_MS_BY_ATTEMPT: Readonly<Record<number, number>> = {
  1: 30_000,
  2: 120_000,
};
const RETRY_BACKOFF_MS_CAP = 480_000;

export function retryBackoffMs(attempt: number): number {
  return RETRY_BACKOFF_MS_BY_ATTEMPT[attempt] ?? RETRY_BACKOFF_MS_CAP;
}

export const MAX_REQUESTED_RETRY_DELAY_MS = 60 * 60_000;

function requestedRetryDelayMs(result: OperationResult): number {
  const requested = result.retryAfterMs;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(requested, MAX_REQUESTED_RETRY_DELAY_MS);
}

export function shouldPersistClaimedOperationCompletion(input: {
  status: string;
  startedAt: unknown;
  claimedStartedAt: unknown;
}): boolean {
  return input.status === "running" && input.startedAt === input.claimedStartedAt;
}

export function operationFirstStartedAt(op: Pick<Operation,
  "status" | "firstStartedAt" | "startedAt" | "attempts" | "resumeCount" | "attemptHistory"
>, now: number): number | null {
  if (op.firstStartedAt !== undefined) return op.firstStartedAt;
  const neverClaimed = op.status === "pending" && op.startedAt === null &&
    !op.attempts && !op.resumeCount && !op.attemptHistory?.length;
  return neverClaimed ? now : null;
}

export function operationNeedsDurableCustomerMigrationV2Resume(op: {
  kind?: string;
  customerMigrationV2?: CustomerMigrationV2State;
  sourceTransferExecution?: SourceTransferExecution;
}): boolean {
  return op.kind === MIGRATE_CUSTOMER_KIND && op.customerMigrationV2 !== undefined;
}

export function operationNeedsDurableRestartResume(op: {
  id?: string;
  kind?: string;
  origin?: string;
  input?: Record<string, unknown>;
  customerMigrationV2?: CustomerMigrationV2State;
  sourceTransferExecution?: SourceTransferExecution;
}): boolean {
  return sourceTransferBlocksRelease(op.sourceTransferExecution) || op.kind === "suspend-customer" ||
    (op.kind === "restart-gateway" && (op.input?.restoreRecovery !== undefined || op.input?.sourceRecovery !== undefined)) ||
    op.kind === "erase-customer" ||
    isLevelTriggeredBuilderReturn(op) ||
    operationNeedsDurableCustomerMigrationV2Resume(op);
}

export function supersededRollMigrationAction(op: {
  status: string;
  output?: Record<string, unknown>;
  sourceTransferExecution?: SourceTransferExecution;
}): "cancel" | "wait" | "done" {
  if (sourceTransferBlocksRelease(op.sourceTransferExecution)) return "wait";
  if (op.status === "running") return "wait";
  if (op.status === "pending") {
    const cleanup = op.output?.configCleanup;
    return cleanup !== null && typeof cleanup === "object" ? "wait" : "cancel";
  }
  return "done";
}

export interface OperationCompletionInput {
  op: {
    id?: string;
    kind?: string;
    origin?: string;
    input?: Record<string, unknown>;
    attempts?: number;
    attemptHistory?: OperationAttemptRecord[];
    startedAt?: number | null;
    customerMigrationV2?: CustomerMigrationV2State;
  sourceTransferExecution?: SourceTransferExecution;
  };
  result: OperationResult;
  steps: OperationStep[];
  now: number;
}

export function verifiedDeletionCompletion(
  result: OperationResult,
): { deletionId: string; archiveId: string } | null {
  if (!result.success) return null;
  const value = result.output?.verifiedDeletion;
  if (!value || typeof value !== "object") return null;
  const deletionId = (value as { deletionId?: unknown }).deletionId;
  const archiveId = (value as { archiveId?: unknown }).archiveId;
  return typeof deletionId === "string" && typeof archiveId === "string"
    ? { deletionId, archiveId }
    : null;
}

function resultOutput(result: OperationResult): Record<string, unknown> {
  return { output: result.output ?? FieldValue.delete() };
}

function successfulCompletion(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
): Record<string, unknown> {
  const scrubbedInput = input.result.scrubInputOnSuccess
    ? {
        input: FieldValue.delete(),
        inputUid: FieldValue.delete(),
        createdBy: FieldValue.delete(),
        attemptHistory: FieldValue.delete(),
        steps: [],
      }
    : {};
  return {
    status: "succeeded",
    completedAt: input.now,
    expireAt: journalExpiry(input.now),
    attempts,
    steps: persistedSteps,
    error: FieldValue.delete(),
    rolledBack: false,
    nextAttemptAt: FieldValue.delete(),
    waitingOn: FieldValue.delete(),
    ...resultOutput(input.result),
    ...scrubbedInput,
  };
}

function recordOutput(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function hasLevelTriggeredFence(input: OperationCompletionInput): boolean {
  const { op, result } = input;
  if (recordOutput(result.output?.deletionBlocked)) return false;
  return recordOutput(result.output?.retirementFencePending) ||
    recordOutput(result.output?.deletionFencePending) ||
    recordOutput(result.output?.deletionCleanupRetry) ||
    op.kind === "suspend-customer" ||
    op.kind === "erase-customer";
}

function isLevelTriggeredBuilderReturn(op: OperationCompletionInput["op"]): boolean {
  const fromGatewayId = op.input?.fromGatewayId;
  return op.kind === MIGRATE_CUSTOMER_KIND &&
    op.origin === "automatic" &&
    op.input?.source === "builder-activation-lease" &&
    typeof fromGatewayId === "string" &&
    op.id === `builder-return-${fromGatewayId}`;
}

export function computerPreemptionError(role: "source" | "target", instanceName: string, cause: string): string {
  return `${role} computer ${instanceName} was preempted: ${cause}`;
}

function isComputerPreemptionFailure(error: string): boolean {
  return /^(source|target) computer \S+ was preempted: /.test(error);
}

function isGatewayMigrationReadinessFailure(error: string): boolean {
  return /gateway .* is not migration-ready/i.test(error);
}

function isLevelTriggeredContinuousPlacement(
  op: OperationCompletionInput["op"],
): boolean {
  return op.kind === MIGRATE_CUSTOMER_KIND &&
    op.origin === "automatic" &&
    op.input?.source === "continuous-placement-policy" &&
    typeof op.id === "string" &&
    /^placement-[a-f0-9]{32}$/.test(op.id);
}

function isFencedManagementHealthFailure(op: OperationCompletionInput["op"], error: string): boolean {
  const source = op.input?.sourceRecovery as { managementRecovery?: unknown } | undefined;
  return op.kind === "restart-gateway" && source?.managementRecovery !== undefined &&
    error === "source management health unconfirmed; outcome remains fenced";
}

interface FailureCompletionContext {
  error: string;
  classification: OperationFailureClassification;
  attemptHistory: OperationAttemptRecord[];
  levelTriggeredFence: boolean;
}

function failureCompletionContext(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
): FailureCompletionContext {
  const error = input.result.error ?? "unknown error";
  const levelTriggeredFence = hasLevelTriggeredFence(input);
  const classification = levelTriggeredFence ? "transient" : classifyOperationFailure(error);
  const attemptRecord: OperationAttemptRecord = {
    attempt: attempts,
    startedAt: input.op.startedAt ?? input.now,
    completedAt: input.now,
    error,
    classification,
    steps: persistedSteps,
  };
  return {
    error,
    classification,
    levelTriggeredFence,
    attemptHistory: [...(input.op.attemptHistory ?? []), attemptRecord]
      .slice(-MAX_OPERATION_ATTEMPT_HISTORY),
  };
}

function restartAbortedMigration(op: OperationCompletionInput["op"]): Record<string, unknown> {
  return op.customerMigrationV2?.phase === "aborted"
    ? { customerMigrationV2: FieldValue.delete() }
    : {};
}

function pendingCompletion(
  input: OperationCompletionInput,
  attempts: number,
  failure: FailureCompletionContext,
): Record<string, unknown> {
  const backoffMs = Math.max(retryBackoffMs(attempts), requestedRetryDelayMs(input.result));
  return {
    ...restartAbortedMigration(input.op),
    status: "pending",
    startedAt: null,
    steps: [],
    expireAt: FieldValue.delete(),
    attempts,
    attemptHistory: failure.attemptHistory,
    queuedAt: input.op.kind === MIGRATE_CUSTOMER_KIND && input.result.rolledBack === true &&
      !recordOutput(input.result.output?.configCleanup) &&
      (input.op.customerMigrationV2 === undefined || input.op.customerMigrationV2.phase === "aborted")
      ? input.now : FieldValue.delete(),
    nextAttemptAt: input.now + backoffMs,
    waitingOn: FieldValue.delete(),
    error: `attempt ${attempts} failed (transient): ${failure.error} — retrying in ${Math.round(backoffMs / 1000)}s`,
    ...resultOutput(input.result),
  };
}

function failedCompletion(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
  failure: FailureCompletionContext,
): Record<string, unknown> {
  return {
    status: "failed",
    completedAt: input.now,
    expireAt: journalExpiry(input.now),
    attempts,
    attemptHistory: failure.attemptHistory,
    steps: persistedSteps,
    error: failure.error,
    rolledBack: input.result.rolledBack ?? false,
    nextAttemptAt: FieldValue.delete(),
    waitingOn: FieldValue.delete(),
    ...resultOutput(input.result),
  };
}

// Decides, and builds the Firestore update for, what happens after a claimed
// op's handler returns. Success always completes. A failure retries (requeues
// to `pending` with backoff) when its cause classifies as transient AND the
// attempt cap hasn't been reached; otherwise it fails terminally with the
// cause. Every FAILED attempt — retried or terminal — is appended to
// attemptHistory (the live `steps` field resets on retry), so all prior
// attempts stay visible however the op ends.
export function buildOperationCompletionUpdate(
  input: OperationCompletionInput,
): Record<string, unknown> {
  const { op, result, steps } = input;
  const persistedSteps = steps.length > 0 ? steps : result.steps;
  const attempts = (op.attempts ?? 0) + 1;
  if (sourceTransferBlocksRelease(op.sourceTransferExecution)) return {
    status:'pending',startedAt:null,completedAt:null,expireAt:FieldValue.delete(),steps:persistedSteps,
    nextAttemptAt:input.now+30_000,lastProgressAt:input.now,error:'source transfer termination not observed',
  };
  if (result.waitingForBuilderIdle === true) {
    if (op.kind !== MIGRATE_CUSTOMER_KIND || result.success) throw new Error("only pending customer migrations can wait for active Builder work");
    return {
      status: "pending", startedAt: null, completedAt: null, expireAt: FieldValue.delete(),
      steps: persistedSteps, nextAttemptAt: input.now + 15_000, lastProgressAt: input.now,
      waitingOn: "builder-idle", error: FieldValue.delete(), rolledBack: false,
    };
  }
  if (result.success) return successfulCompletion(input, persistedSteps, attempts);

  const failure = failureCompletionContext(input, persistedSteps, attempts);
  const retryBeyondCap = retriesBeyondAttemptCap(op, failure, attempts);
  const retry = !needsSharedRollbackRecovery(input, persistedSteps) && shouldRetry(
    op,
    result,
    failure.classification,
    attempts,
    retryBeyondCap,
  );
  return retry
    ? pendingCompletion(input, attempts, failure)
    : failedCompletion(input, persistedSteps, attempts, failure);
}

function retriesBeyondAttemptCap(op: OperationCompletionInput["op"], failure: FailureCompletionContext, attempts: number): boolean {
  return failure.levelTriggeredFence ||
    isFencedManagementHealthFailure(op, failure.error) ||
    (isComputerPreemptionFailure(failure.error) && attempts < MAX_PREEMPTED_OPERATION_ATTEMPTS) ||
    (isLevelTriggeredBuilderReturn(op) && !isGatewayMigrationReadinessFailure(failure.error)) ||
    isLevelTriggeredContinuousPlacement(op);
}

function shouldRetry(
  op: OperationCompletionInput["op"],
  result: OperationResult,
  classification: OperationFailureClassification,
  attempts: number,
  retryBeyondCap: boolean,
): boolean {
  if (classification !== "transient") return false;
  const hasDurableCleanup =
    result.output?.configCleanup !== null &&
    typeof result.output?.configCleanup === "object";
  const activeMigration = op.customerMigrationV2;
  const hasActiveCustomerMigrationV2 = activeMigration !== undefined &&
    activeMigration.phase !== "complete" &&
    activeMigration.phase !== "aborted";
  return attempts < MAX_OPERATION_ATTEMPTS ||
    hasDurableCleanup ||
    retryBeyondCap ||
    hasActiveCustomerMigrationV2;
}

function needsSharedRollbackRecovery(input: OperationCompletionInput, steps: OperationStep[]): boolean {
  return input.op.kind === MIGRATE_CUSTOMER_KIND &&
    input.op.customerMigrationV2 === undefined &&
    typeof input.op.input?.fromGatewayId === "string" &&
    input.op.input.fromGatewayId.startsWith("shared-") &&
    input.result.rolledBack !== true &&
    (input.op.input.recoverSourceOnly === true || input.result.rolledBack === false &&
      steps.some((step) => step.name.startsWith("rollback:") && step.status === "failed"));
}
