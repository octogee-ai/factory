import { isDeepStrictEqual } from "node:util";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
import { builderActivationRecoveryTargetMatches, sharedRecoveryTargetCleaned, migrationCancellationDeferred } from "@octogee/core/fleet-state";
import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import { GLM_OPERATIONS_COLLECTION, readSchedulerMigrationIdentity, type CustomerMigrationV2State } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, customerRuntimeMutationFenced, projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import type { FleetBrokerAgentAnchorMigration } from "@octogee/shared/types/fleet-broker";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";

interface AgentAnchorMigrationRequest {
  gatewayId: string;
  slug: string;
  migrationId: unknown;
  podUid?: string;
  expected?: FleetBrokerAgentAnchorMigration;
}

const POD_UID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sharedAgentAnchorMigrationScope(db: Firestore, txn: Transaction, request: AgentAnchorMigrationRequest) {
  const { migrationId } = request;
  if (typeof migrationId === "string" && migrationId.startsWith("surge-")) return sharedSurgeAgentAnchorScope(db, txn, request);
  return sharedCrossGatewayAgentAnchorScope(db, txn, request);
}

async function sharedCrossGatewayAgentAnchorScope(db: Firestore, txn: Transaction, request: AgentAnchorMigrationRequest) {
  const { gatewayId, slug, migrationId, expected } = request;
  if (!validMigrationId(migrationId)) return null;
  const operationId = migrationId.slice(4);
  const operation = (await txn.get(db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId))).data() ?? {};
  const input = operation.input ?? {};
  if (!migrationOperationCurrent(operation, input, gatewayId, operationId)) return null;
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
  const activation = builderActivationTarget({ operationId, input, openclaw, sourceEpoch: assigned.epoch, targetRoot: gateway.data() });
  const sourceTargetCurrent = activation
    ? activation.matches
    : target?.gatewayClass === "shared" || sharedRecoveryTargetCleaned(input, operation.schedulerHandoff);
  if (!migrationCustodyCurrent({ sourceRequest, sourceRoot, target, operationId, operation, input, slug, assigned, sourceTargetCurrent,
    builderTargetActivating: activation?.activating === true, targetAssigned: targetAssignment.exists, data, openclaw, migrationId, sourceGatewayId, targetGatewayId })) return null;
  const migration: FleetBrokerAgentAnchorMigration = { migrationId, claimStartedAt: operation.startedAt, sourceGatewayId, sourceEpoch: assigned.epoch };
  if (!migrationAuthorityMatches(migration, expected)) return null;
  return { gatewayId, uid: input.uid as string, slug, assignmentEpoch: assigned.epoch as number, assignmentState: "quiescing" as const, migration };
}

function builderActivationTarget({ operationId, input, openclaw, sourceEpoch, targetRoot }: {
  operationId: string; input: DocumentData; openclaw: DocumentData | undefined; sourceEpoch: number; targetRoot: DocumentData | undefined;
}): { matches: boolean; activating: boolean } | null {
  if (input.source !== "builder-activation-lease") return null;
  const matches = builderActivationRecoveryTargetMatches({ operationId, input, openclaw: openclaw ?? {}, sourceEpoch, targetRoot });
  return { matches, activating: matches && openclaw?.activationLease?.status === "activating" };
}

async function sharedSurgeAgentAnchorScope(
  db: Firestore, txn: Transaction, request: AgentAnchorMigrationRequest,
) {
  const { gatewayId, slug, migrationId, podUid, expected } = request;
  if (typeof migrationId !== "string") return null;
  const prefix = `surge-${gatewayId}-`;
  const logicalTargetPodUid = migrationId.startsWith(prefix) ? migrationId.slice(prefix.length) : "";
  if (!podUid || !POD_UID_SHAPE.test(podUid) || !POD_UID_SHAPE.test(logicalTargetPodUid)) return null;
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  const [gateway, assignments] = await Promise.all([
    txn.get(gatewayRef), txn.get(gatewayRef.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).where("slug", "==", slug).limit(2)),
  ]);
  if (!sharedSurgeGatewayCurrent(gateway.data(), gatewayId) || assignments.size !== 1) return null;
  const assignment = assignments.docs[0]!, assigned = assignment.data(), uid = assignment.id;
  if (!sharedSurgeAssignmentCurrent(assigned, uid, request) ||
      sharedSurgeReceivingPodUid(assigned, migrationId, logicalTargetPodUid) !== podUid) return null;
  const data = (await txn.get(db.collection("users").doc(uid))).data();
  if (!sharedSurgeCustomerCurrent(data, request)) return null;
  const migration: FleetBrokerAgentAnchorMigration = { migrationId, claimStartedAt: assigned.updatedAt, sourceGatewayId: gatewayId, sourceEpoch: assigned.epoch };
  if (!migrationAuthorityMatches(migration, expected)) return null;
  return { gatewayId, uid, slug, assignmentEpoch: assigned.epoch as number, assignmentState: "quiescing" as const, migration };
}

export async function sharedAssignedSourceSurgeAnchorScope(
  db: Firestore, txn: Transaction, request: AgentAnchorMigrationRequest & { uid: string },
) {
  const { gatewayId, slug, migrationId, podUid, uid, expected } = request;
  const prefix = `surge-${gatewayId}-`;
  const targetPodUid = typeof migrationId === "string" && migrationId.startsWith(prefix) ? migrationId.slice(prefix.length) : "";
  if (!podUid || !POD_UID_SHAPE.test(podUid) || !POD_UID_SHAPE.test(targetPodUid) || podUid === targetPodUid || !validDocumentId(uid)) return null;
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  const [gateway, assignment, user] = await Promise.all([
    txn.get(gatewayRef), txn.get(gatewayRef.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid)), txn.get(db.collection("users").doc(uid)),
  ]);
  const assigned = assignment.data();
  if (!sharedSurgeGatewayCurrent(gateway.data(), gatewayId) || !assigned || !sharedSurgeAssignmentCurrent(assigned, uid, request) ||
      !sharedSurgeCustomerCurrent(user.data(), request) ||
      !sharedSurgeSourcePodCurrent(assigned, migrationId, targetPodUid, podUid)) return null;
  const sourceSurge: FleetBrokerAgentAnchorMigration = { migrationId: migrationId as string, claimStartedAt: assigned.updatedAt, sourceGatewayId: gatewayId, sourceEpoch: assigned.epoch };
  if (!migrationAuthorityMatches(sourceSurge, expected)) return null;
  return { gatewayId, uid, slug, assignmentEpoch: assigned.epoch as number, assignmentState: "quiescing" as const, sourceSurge };
}

function sharedSurgeReceivingPodUid(assignment: DocumentData, migrationId: unknown, logicalTargetPodUid: string): string | null {
  const marker = assignment.sharedSurgeForwardRecovery;
  if (marker === undefined) return logicalTargetPodUid;
  if (marker?.operationId !== migrationId || marker.targetPodUid !== logicalTargetPodUid ||
      typeof marker.receivingPodUid !== "string" || !POD_UID_SHAPE.test(marker.receivingPodUid)) return null;
  return marker.receivingPodUid;
}

function sharedSurgeSourcePodCurrent(assignment: DocumentData, migrationId: unknown, logicalTargetPodUid: string, podUid: string): boolean {
  const receivingPodUid = sharedSurgeReceivingPodUid(assignment, migrationId, logicalTargetPodUid);
  return receivingPodUid !== null && podUid !== receivingPodUid;
}

function sharedSurgeGatewayCurrent(data: DocumentData | undefined, gatewayId: string): boolean {
  const root = projectGatewayDesiredRootForGateway(data, gatewayId);
  return [root?.gatewayClass === "shared", ["running", "draining"].includes(root?.desiredStatus ?? ""),
    root?.retirementClaim == null, data?.runtimeRestartFence == null].every(Boolean);
}

function sharedSurgeAssignmentCurrent(assigned: DocumentData, uid: string, { gatewayId, slug, migrationId }: AgentAnchorMigrationRequest): boolean {
  return [validDocumentId(uid), assigned.uid === uid, assigned.slug === slug, assigned.gatewayId === gatewayId,
    assigned.state === "quiescing", assigned.updatedByOperationId === migrationId,
    Number.isSafeInteger(assigned.epoch), assigned.epoch >= 0, Number.isSafeInteger(assigned.updatedAt), assigned.updatedAt > 0].every(Boolean);
}

function sharedSurgeCustomerCurrent(data: DocumentData | undefined, { gatewayId, slug, migrationId }: AgentAnchorMigrationRequest): boolean {
  const openclaw = data?.provisioning?.openclaw, marker = readWorkspaceMigrationMarker(openclaw);
  return [!customerRuntimeMutationFenced(data), slugFromAssignedUser(data) === slug, openclaw?.gatewayId === gatewayId,
    openclaw?.status === "complete", marker?.state === "moving", marker?.operationId === migrationId,
    Number.isSafeInteger(marker?.startedAt), (marker?.startedAt ?? 0) > 0].every(Boolean);
}

function migrationOperationCurrent(operation: DocumentData, input: DocumentData, gatewayId: string, operationId: string): boolean {
  return [
    operation.kind === "migrate-customer", operation.status === "running",
    operation.cancellationRequestedAt === undefined || migrationCancellationDeferred(operation, operationId),
    operation.cutoverCommittedAt === undefined, Number.isSafeInteger(operation.startedAt), operation.startedAt > 0,
    validDocumentId(input.uid), validDocumentId(input.fromGatewayId), validDocumentId(input.toGatewayId),
    input.fromGatewayId !== input.toGatewayId, gatewayId === input.toGatewayId || gatewayId === input.fromGatewayId,
  ].every(Boolean);
}

function migrationCustodyCurrent({ sourceRequest, sourceRoot, target, operationId, operation, input, slug,
  assigned, sourceTargetCurrent, builderTargetActivating, targetAssigned, data, openclaw, migrationId, sourceGatewayId, targetGatewayId }: {
  sourceRequest: boolean;
  sourceRoot: NonNullable<ReturnType<typeof projectGatewayDesiredRootForGateway>>;
  target: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  operationId: string;
  operation: DocumentData;
  input: DocumentData;
  slug: string;
  assigned: DocumentData;
  sourceTargetCurrent: boolean;
  builderTargetActivating: boolean;
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
      : (target?.gatewayClass === "shared" || builderTargetActivating) && target?.desiredStatus === "running" && target.retirementClaim == null,
    sourceRoot.retirementClaim == null, !targetAssigned, !customerRuntimeMutationFenced(data),
    slugFromAssignedUser(data) === slug, openclaw?.gatewayId === sourceGatewayId, openclaw?.migration?.operationId === operationId,
    assigned.uid === input.uid, assigned.slug === slug, assigned.gatewayId === sourceGatewayId, assigned.state === "quiescing",
    Number.isSafeInteger(assigned.epoch), assigned.epoch >= 0,
    cancelledImportCustodyCurrent(operation, slug, assigned.epoch),
    migrationV2ImportCurrent(operation.customerMigrationV2, { operationId, migrationId, uid: input.uid, slug, sourceGatewayId, targetGatewayId, sourceEpoch: assigned.epoch }),
  ].every(Boolean);
}

function cancelledImportCustodyCurrent(operation: DocumentData, slug: string, sourceEpoch: unknown): boolean {
  if (operation.cancellationRequestedAt === undefined || operation.customerMigrationV2 !== undefined) return true;
  const handoff = operation.schedulerHandoff;
  return handoff?.slug === slug && handoff.forwardRecovery?.sourceEpoch === sourceEpoch;
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
  return [state.phase === "sourceQuiesced", state.cutoverAt === undefined,
    state.operationId === expected.operationId, state.migrationId === expected.migrationId,
    state.uid === expected.uid, state.slug === expected.slug, state.sourceGatewayId === expected.sourceGatewayId,
    state.targetGatewayId === expected.targetGatewayId, state.sourceEpoch === expected.sourceEpoch,
    state.sourceAssignmentMode === "assigned",
  ].every(Boolean);
}
