import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type {
  CustomerMigrationV2State,
  OperationAttemptRecord,
  OperationStep,
} from "@octogee/shared/types/glm";
import type { OperationResult } from "./operation-router.js";

export type OperationFailureClassification = "transient" | "terminal";

// Explicit allowlist, terminal by default: "TRUE validation failures... fail
// immediately" is the safe default for a string-classified error. Only causes
// we recognize as environmental (network/K8s-API hiccups, timeouts, preemption)
// get an automatic retry.
const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /\btime[d ]?out\b/i,
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
  /\bstatus (429|502|503|504)\b/,
  /\bpreempt(ed|ion)?\b/i,
  /config unfreeze cleanup pending/i,
  /source unmount cleanup pending/i,
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
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(error))
    ? "transient"
    : "terminal";
}

export const MAX_OPERATION_ATTEMPTS = 3;
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

export function shouldPersistClaimedOperationCompletion(input: {
  status: string;
  startedAt: unknown;
  claimedStartedAt: unknown;
}): boolean {
  return input.status === "running" && input.startedAt === input.claimedStartedAt;
}

export function operationNeedsDurableCustomerMigrationV2Resume(op: {
  kind?: string;
  customerMigrationV2?: CustomerMigrationV2State;
}): boolean {
  return op.kind === "migrate-customer" && op.customerMigrationV2 !== undefined;
}

export function operationNeedsDurableRestartResume(op: {
  kind?: string;
  customerMigrationV2?: CustomerMigrationV2State;
}): boolean {
  return op.kind === "suspend-customer" ||
    op.kind === "erase-customer" ||
    operationNeedsDurableCustomerMigrationV2Resume(op);
}

export function supersededRollMigrationAction(op: {
  status: string;
  output?: Record<string, unknown>;
}): "cancel" | "wait" | "done" {
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
  return recordOutput(result.output?.retirementFencePending) ||
    recordOutput(result.output?.deletionFencePending) ||
    recordOutput(result.output?.deletionCleanupRetry) ||
    op.kind === "suspend-customer" ||
    op.kind === "erase-customer";
}

function isLevelTriggeredBuilderReturn(op: OperationCompletionInput["op"]): boolean {
  const fromGatewayId = op.input?.fromGatewayId;
  return op.kind === "migrate-customer" &&
    op.origin === "automatic" &&
    op.input?.source === "builder-activation-lease" &&
    typeof fromGatewayId === "string" &&
    op.id === `builder-return-${fromGatewayId}`;
}

function isGatewayMigrationReadinessFailure(error: string): boolean {
  return /gateway .* is not migration-ready/i.test(error);
}

function isLevelTriggeredContinuousPlacement(
  op: OperationCompletionInput["op"],
): boolean {
  return op.kind === "migrate-customer" &&
    op.origin === "automatic" &&
    op.input?.source === "continuous-placement-policy" &&
    typeof op.id === "string" &&
    /^placement-[a-f0-9]{32}$/.test(op.id);
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

function pendingCompletion(
  input: OperationCompletionInput,
  attempts: number,
  failure: FailureCompletionContext,
): Record<string, unknown> {
  const backoffMs = retryBackoffMs(attempts);
  return {
    status: "pending",
    startedAt: null,
    steps: [],
    expireAt: FieldValue.delete(),
    attempts,
    attemptHistory: failure.attemptHistory,
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
  if (result.success) return successfulCompletion(input, persistedSteps, attempts);

  const failure = failureCompletionContext(input, persistedSteps, attempts);
  const retryBeyondCap =
    failure.levelTriggeredFence ||
    (isLevelTriggeredBuilderReturn(op) && !isGatewayMigrationReadinessFailure(failure.error)) ||
    isLevelTriggeredContinuousPlacement(op);
  const retry = shouldRetry(
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
