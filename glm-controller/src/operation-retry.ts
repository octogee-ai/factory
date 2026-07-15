import { FieldValue } from "firebase-admin/firestore";
import type { OperationAttemptRecord, OperationStep } from "@octogee/shared/types/glm";
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
  /\bstatus (429|502|503|504)\b/,
  /\bpreempt(ed|ion)?\b/i,
  /config unfreeze cleanup pending/i,
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

const RETRY_BACKOFF_MS_BY_ATTEMPT: Readonly<Record<number, number>> = {
  1: 30_000,
  2: 120_000,
};
const RETRY_BACKOFF_MS_CAP = 480_000;

export function retryBackoffMs(attempt: number): number {
  return RETRY_BACKOFF_MS_BY_ATTEMPT[attempt] ?? RETRY_BACKOFF_MS_CAP;
}

export function shouldPersistClaimedOperationCompletion(status: string): boolean {
  return status === "running";
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
    attempts?: number;
    attemptHistory?: OperationAttemptRecord[];
    startedAt?: number | null;
  };
  result: OperationResult;
  steps: OperationStep[];
  now: number;
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
  const { op, result, steps, now } = input;
  const persistedSteps = steps.length > 0 ? steps : result.steps;
  const attempts = (op.attempts ?? 0) + 1;
  const output = { output: result.output ?? FieldValue.delete() };

  if (result.success) {
    return {
      status: "succeeded",
      completedAt: now,
      attempts,
      steps: persistedSteps,
      error: FieldValue.delete(),
      rolledBack: false,
      nextAttemptAt: FieldValue.delete(),
      waitingOn: FieldValue.delete(),
      ...output,
    };
  }

  const error = result.error ?? "unknown error";
  const classification = classifyOperationFailure(error);
  const attemptRecord: OperationAttemptRecord = {
    attempt: attempts,
    startedAt: op.startedAt ?? now,
    completedAt: now,
    error,
    classification,
    steps: persistedSteps,
  };
  const attemptHistory = [...(op.attemptHistory ?? []), attemptRecord];

  const hasDurableCleanup =
    result.output?.configCleanup !== null &&
    typeof result.output?.configCleanup === "object";
  if (
    classification === "transient" &&
    (attempts < MAX_OPERATION_ATTEMPTS || hasDurableCleanup)
  ) {
    const backoffMs = retryBackoffMs(attempts);
    return {
      status: "pending",
      startedAt: null,
      steps: [],
      attempts,
      attemptHistory,
      nextAttemptAt: now + backoffMs,
      waitingOn: FieldValue.delete(),
      error: `attempt ${attempts} failed (transient): ${error} — retrying in ${Math.round(backoffMs / 1000)}s`,
      ...output,
    };
  }

  return {
    status: "failed",
    completedAt: now,
    attempts,
    attemptHistory,
    steps: persistedSteps,
    error,
    rolledBack: result.rolledBack ?? false,
    nextAttemptAt: FieldValue.delete(),
    waitingOn: FieldValue.delete(),
    ...output,
  };
}
