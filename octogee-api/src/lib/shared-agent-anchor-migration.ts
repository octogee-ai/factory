import { isDeepStrictEqual } from "node:util";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import { GLM_OPERATIONS_COLLECTION, type CustomerMigrationV2State } from "@octogee/shared/types/glm";
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
  const operationCurrent = [
    operation.kind === "migrate-customer", operation.status === "running", operation.cancellationRequestedAt === undefined,
    operation.cutoverCommittedAt === undefined, Number.isSafeInteger(operation.startedAt), operation.startedAt > 0,
    input.toGatewayId === gatewayId, validDocumentId(input.uid), validDocumentId(input.fromGatewayId), input.fromGatewayId !== gatewayId,
  ].every(Boolean);
  if (!operationCurrent) return null;
  const sourceGatewayId = input.fromGatewayId;
  const [gateway, source, user, assignment, targetAssignment] = await Promise.all([
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(gatewayId)),
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(sourceGatewayId)),
    txn.get(db.collection("users").doc(input.uid)),
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(sourceGatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(input.uid)),
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(gatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(input.uid)),
  ]);
  const target = projectGatewayDesiredRootForGateway(gateway.data(), gatewayId);
  const sourceRoot = projectGatewayDesiredRootForGateway(source.data(), sourceGatewayId);
  if (!target) return null;
  if (!sourceRoot) return null;
  const data = user.data(), assigned = assignment.data() ?? {};
  const openclaw = data?.provisioning?.openclaw;
  const custodyCurrent = [
    target.gatewayClass === "shared", target.desiredStatus === "running", target.retirementClaim == null,
    sourceRoot.retirementClaim == null, !targetAssignment.exists, !customerRuntimeMutationFenced(data),
    slugFromAssignedUser(data) === slug, openclaw?.gatewayId === sourceGatewayId, openclaw?.migration?.operationId === operationId,
    assigned.uid === input.uid, assigned.slug === slug, assigned.gatewayId === sourceGatewayId, assigned.state === "quiescing",
    Number.isSafeInteger(assigned.epoch), assigned.epoch >= 0,
    migrationV2ImportCurrent(operation.customerMigrationV2, { operationId, migrationId, uid: input.uid, slug, sourceGatewayId, targetGatewayId: gatewayId, sourceEpoch: assigned.epoch }),
  ].every(Boolean);
  if (!custodyCurrent) return null;
  const migration: FleetBrokerAgentAnchorMigration = { migrationId, claimStartedAt: operation.startedAt, sourceGatewayId, sourceEpoch: assigned.epoch };
  if (!migrationAuthorityMatches(migration, expected)) return null;
  return { gatewayId, uid: input.uid as string, slug, assignmentEpoch: assigned.epoch as number, assignmentState: "quiescing" as const, migration };
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
