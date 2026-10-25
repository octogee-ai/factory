import { isDeepStrictEqual } from "node:util";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
import { builderActivationRecoveryTargetMatches, sharedRecoveryTargetCleaned } from "@octogee/core/fleet-state";
import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import { GLM_OPERATIONS_COLLECTION, readSchedulerMigrationIdentity, type CustomerMigrationV2State } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, customerRuntimeMutationFenced, projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import type { FleetBrokerAgentAnchorMigration } from "@octogee/shared/types/fleet-broker";

export async function sharedAgentAnchorMigrationScope(
  db: Firestore, txn: Transaction, request: { gatewayId: string; slug: string; migrationId: unknown; expected?: FleetBrokerAgentAnchorMigration },
) {
  const { gatewayId, slug, migrationId, expected } = request;
  if (!validMigrationId(migrationId)) return null;
  const operationId = migrationId.slice(4);
  const operation = (await txn.get(db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId))).data() ?? {};
  const input = operation.input ?? {};
  if (!migrationOperationCurrent(operation, input, gatewayId)) return null;
  const sourceGatewayId = input.fromGatewayId, targetGatewayId = input.toGatewayId;
  const sourceRequest = gatewayId === sourceGatewayId;
  const [gateway, source, user, assignment, targetAssignment] = await Promise.all([
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(targetGatewayId)),
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(sourceGatewayId)),
    txn.get(db.collection("users").doc(input.uid)),
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(sourceGatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(input.uid)),
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(targetGatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(input.uid)),
  ]);
  const target = projectGatewayDesiredRootForGateway(gateway.data(), targetGatewayId);
  const sourceRoot = projectGatewayDesiredRootForGateway(source.data(), sourceGatewayId);
  if (!sourceRoot) return null;
  const data = user.data(), assigned = assignment.data() ?? {};
  const openclaw = data?.provisioning?.openclaw;
  const sourceTargetCurrent = input.source === "builder-activation-lease"
    ? builderActivationRecoveryTargetMatches({ operationId, input, openclaw: openclaw ?? {}, sourceEpoch: assigned.epoch, targetRoot: gateway.data() })
    : target?.gatewayClass === "shared" || sharedRecoveryTargetCleaned(input, operation.schedulerHandoff);
  if (!migrationCustodyCurrent({ sourceRequest, sourceRoot, target, operationId, operation, input, slug,
    assigned, sourceTargetCurrent, targetAssigned: targetAssignment.exists, data, openclaw, migrationId, sourceGatewayId, targetGatewayId })) return null;
  const migration: FleetBrokerAgentAnchorMigration = { migrationId, claimStartedAt: operation.startedAt, sourceGatewayId, sourceEpoch: assigned.epoch };
  if (!migrationAuthorityMatches(migration, expected)) return null;
  return { gatewayId, uid: input.uid as string, slug, assignmentEpoch: assigned.epoch as number, assignmentState: "quiescing" as const, migration };
}

function migrationOperationCurrent(operation: DocumentData, input: DocumentData, gatewayId: string): boolean {
  return [
    operation.kind === "migrate-customer", operation.status === "running", operation.cancellationRequestedAt === undefined,
    operation.cutoverCommittedAt === undefined, Number.isSafeInteger(operation.startedAt), operation.startedAt > 0,
    validDocumentId(input.uid), validDocumentId(input.fromGatewayId), validDocumentId(input.toGatewayId),
    input.fromGatewayId !== input.toGatewayId, gatewayId === input.toGatewayId || gatewayId === input.fromGatewayId,
  ].every(Boolean);
}

function migrationCustodyCurrent({ sourceRequest, sourceRoot, target, operationId, operation, input, slug,
  assigned, sourceTargetCurrent, targetAssigned, data, openclaw, migrationId, sourceGatewayId, targetGatewayId }: {
  sourceRequest: boolean;
  sourceRoot: NonNullable<ReturnType<typeof projectGatewayDesiredRootForGateway>>;
  target: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  operationId: string;
  operation: DocumentData;
  input: DocumentData;
  slug: string;
  assigned: DocumentData;
  sourceTargetCurrent: boolean;
  targetAssigned: boolean;
  data: DocumentData | undefined;
  openclaw: DocumentData | undefined;
  migrationId: string;
  sourceGatewayId: string;
  targetGatewayId: string;
}): boolean {
  return [
    sourceRequest
      ? sourceRoot.gatewayClass === "shared" && ["running", "draining"].includes(sourceRoot.desiredStatus) &&
        assigned.updatedByOperationId === operationId && sourceRecoveryIntentCurrent(operationId, operation, input, slug, assigned.epoch) && sourceTargetCurrent
      : target?.gatewayClass === "shared" && target.desiredStatus === "running" && target.retirementClaim == null,
    sourceRoot.retirementClaim == null, !targetAssigned, !customerRuntimeMutationFenced(data),
    slugFromAssignedUser(data) === slug, openclaw?.gatewayId === sourceGatewayId, openclaw?.migration?.operationId === operationId,
    assigned.uid === input.uid, assigned.slug === slug, assigned.gatewayId === sourceGatewayId, assigned.state === "quiescing",
    Number.isSafeInteger(assigned.epoch), assigned.epoch >= 0,
    migrationV2ImportCurrent(operation.customerMigrationV2, { operationId, migrationId, uid: input.uid, slug, sourceGatewayId, targetGatewayId, sourceEpoch: assigned.epoch }),
  ].every(Boolean);
}

function sourceRecoveryIntentCurrent(operationId: string, operation: Record<string, unknown>, input: Record<string, unknown>, slug: string, sourceEpoch: unknown): boolean {
  if (operation.schedulerHandoffReleased === true || input.builderSlug !== undefined && input.builderSlug !== slug) return false;
  if (input.recoverSourceOnly !== true) return true;
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const handoff = record(operation.schedulerHandoff), recovery = record(handoff.sourceRecovery);
  return [handoff.uid === input.uid, handoff.slug === slug, handoff.fromGatewayId === input.fromGatewayId,
    handoff.toGatewayId === input.toGatewayId, readSchedulerMigrationIdentity(operationId, handoff.migrationId) !== null,
    recovery.migrationId === handoff.migrationId, recovery.sourceEpoch === sourceEpoch, Array.isArray(recovery.steps)].every(Boolean);
}

function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("/");
}

function validMigrationId(value: unknown): value is string {
  return typeof value === "string" && /^mig-[a-zA-Z0-9_-]+$/.test(value);
}

function migrationAuthorityMatches(current: FleetBrokerAgentAnchorMigration, expected?: FleetBrokerAgentAnchorMigration): boolean {
  return expected === undefined || isDeepStrictEqual(current, expected);
}

function migrationV2ImportCurrent(
  state: CustomerMigrationV2State | undefined,
  expected: Pick<CustomerMigrationV2State, "operationId" | "migrationId" | "uid" | "slug" | "sourceGatewayId" | "targetGatewayId" | "sourceEpoch">,
): boolean {
  if (state === undefined) return true;
  return [state.phase === "sourceQuiesced", state.cutoverAt === undefined, state.strategy === "migrate-state",
    state.operationId === expected.operationId, state.migrationId === expected.migrationId,
    state.uid === expected.uid, state.slug === expected.slug, state.sourceGatewayId === expected.sourceGatewayId,
    state.targetGatewayId === expected.targetGatewayId, state.sourceEpoch === expected.sourceEpoch,
    state.sourceAssignmentMode === "assigned",
  ].every(Boolean);
}
