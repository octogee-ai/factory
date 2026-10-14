import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';
import { customerRuntimeMutationFenced } from '@octogee/shared/types/gateway-releases';
import { readWorkspaceMigrationMarker } from '@octogee/shared/types/workspace-migration';
import { MAX_OPERATION_ATTEMPT_HISTORY } from '../operation-retry.js';

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sourcePodSelectionFailure(error: unknown, gatewayId: string): boolean {
  const prefix = `expected exactly one ready pod for transport=${gatewayId}; found `;
  if (typeof error !== 'string' || !error.startsWith(prefix)) return false;
  const cardinality = error.slice(prefix.length), count = Number(cardinality);
  return /^(0|[1-9]\d*)$/.test(cardinality) && Number.isSafeInteger(count) && count !== 1;
}

function untouchedTransportHistory(row: DocumentData): boolean {
  const history = row.attemptHistory;
  if (!positiveInteger(row.attempts) || !Array.isArray(history) || history.length !== Math.min(row.attempts, MAX_OPERATION_ATTEMPT_HISTORY)) return false;
  const firstRetainedAttempt = row.attempts - history.length + 1;
  const error = `expected exactly one ready pod for transport=${row.input.fromGatewayId}; found 0`;
  return history.every((attempt, index) => attempt?.attempt === firstRetainedAttempt + index &&
    attempt.classification === 'transient' && sourcePodSelectionFailure(attempt.error, row.input.fromGatewayId) &&
    (index < history.length - 1 || attempt.error === error) &&
    positiveInteger(attempt.startedAt) && positiveInteger(attempt.completedAt) && attempt.completedAt >= attempt.startedAt &&
    Array.isArray(attempt.steps) && attempt.steps.length === 1 &&
    attempt.steps[0]?.name === 'keys-sync-state' && attempt.steps[0].status === 'failed' && attempt.steps[0].error === attempt.error);
}

function handoffMatches(row: DocumentData, id: string): boolean {
  const input = row.input, handoff = row.schedulerHandoff;
  return handoff && handoff.uid === input.uid && handoff.slug === input.builderSlug &&
    handoff.fromGatewayId === input.fromGatewayId && handoff.toGatewayId === input.toGatewayId &&
    handoff.migrationId === `mig-${id}:scheduler:${row.attempts}` &&
    ['stageAfterCutover', 'stagedAt', 'sourceRecovery'].every(key => handoff[key] === undefined);
}

function queuedSharedScope(row: DocumentData): boolean {
  const input = row.input;
  return row.kind === 'migrate-customer' && input &&
    ['uid', 'builderSlug', 'fromGatewayId', 'toGatewayId'].every(key => typeof input[key] === 'string' && input[key].length > 0 && !input[key].includes('/')) &&
    input.fromGatewayId.startsWith('shared-') && input.toGatewayId.startsWith('shared-') && input.fromGatewayId !== input.toGatewayId &&
    input.sourceTransferMode === undefined && input.recoverSourceOnly === undefined;
}

function unclaimedRetry(row: DocumentData): boolean {
  const untouched = ['customerMigrationV2', 'sourceTransferExecution', 'schedulerHandoffLost', 'cutoverCommittedAt',
    'restoreAttempt', 'cancellationRequestedAt', 'rolledBack', 'lastResumedAt'];
  return row.status === 'pending' && row.startedAt === null && row.completedAt === null &&
    (row.resumeCount === undefined || row.resumeCount === 0) && untouched.every(key => row[key] === undefined) &&
    Array.isArray(row.steps) && row.steps.length === 0 &&
    (row.output === undefined || row.output && typeof row.output === 'object' && !Array.isArray(row.output) &&
      Object.keys(row.output).every(key => key === 'stateMigration'));
}

function queuedSharedMigrationBeforeTransport(row: DocumentData, id: string): boolean {
  return queuedSharedScope(row) && unclaimedRetry(row) && handoffMatches(row, id) && untouchedTransportHistory(row);
}

function sourceOwnerMatches(row: DocumentData, id: string, owner: DocumentData | undefined): boolean {
  const openclaw = owner?.provisioning?.openclaw, marker = readWorkspaceMigrationMarker(openclaw);
  return !customerRuntimeMutationFenced(owner) && openclaw?.gatewayId === row.input.fromGatewayId &&
    openclaw.nativeSharedContextRestore === undefined &&
    ['complete', 'provisioning'].includes(openclaw.status) && marker?.operationId === id && marker.state === 'preparing' && marker.phase === 'preparing';
}

function sourceAssignmentMatches(row: DocumentData, id: string, assignment: DocumentData | undefined): boolean {
  if (!assignment) return false;
  return assignment.uid === row.input.uid && assignment.slug === row.input.builderSlug && assignment.gatewayId === row.input.fromGatewayId &&
    assignment.state === 'serving' && Number.isSafeInteger(assignment.epoch) && assignment.epoch >= 0 &&
    assignment.updatedByOperationId !== id &&
    (assignment.updatedByOperationId == null || typeof assignment.updatedByOperationId === 'string' && assignment.updatedByOperationId.length > 0);
}

export async function queuedSharedMigrationOwnsSource(
  db: Firestore, tx: Transaction, row: DocumentData, id: string,
): Promise<boolean> {
  if (!queuedSharedMigrationBeforeTransport(row, id)) return false;
  const { uid, fromGatewayId, toGatewayId } = row.input;
  const [user, source, target] = await Promise.all([
    tx.get(db.doc(`users/${uid}`)), tx.get(db.doc(`gateways/${fromGatewayId}/assignments/${uid}`)),
    tx.get(db.doc(`gateways/${toGatewayId}/assignments/${uid}`)),
  ]);
  return !target.exists && sourceOwnerMatches(row, id, user.data()) && sourceAssignmentMatches(row, id, source.data());
}
