import { builderActivateOperationId } from "./builder-activation-lease.js";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, projectGatewayDesiredRootForGateway, type GatewayDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
type DurableGateway = GatewayDoc & GatewayMutableConfig;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function prelaunchStatusMatches(gatewayId: string, generation: number, lease: Record<string, unknown>, activationBoot: boolean): boolean {
  return lease.status === "provisioning" && lease.activationOperationId === undefined && lease.activatingAt === undefined ||
    activationBoot && ["provisioning", "activating"].includes(String(lease.status)) &&
    lease.activationOperationId === builderActivateOperationId(gatewayId, generation);
}

function prelaunchLease(gateway: DurableGateway, userData: unknown, activationBoot = false): Record<string, unknown> | null {
  const user = record(userData);
  const openclaw = record(record(user?.provisioning)?.openclaw);
  const lease = record(openclaw?.activationLease);
  const allocation = gateway.allocation;
  if (!user || !accountAllowsInteractiveAccess(user) || !lease || !allocation) return null;
  return [
    gateway.desiredStatus === "running",
    gateway.gatewayClass === "builder",
    allocation.kind === "disposable-builder",
    gateway.ownerUid === allocation.claimedByUid,
    lease.leaseId === allocation.leaseId,
    lease.generation === allocation.generation,
    lease.targetGatewayId === gateway.gatewayId,
    prelaunchStatusMatches(gateway.gatewayId, allocation.generation, lease, activationBoot),
    lease.activeAt === undefined,
    typeof lease.sourceGatewayId === "string",
    lease.sourceGatewayId !== gateway.gatewayId,
    openclaw?.gatewayId === lease.sourceGatewayId,
    openclaw?.slug === gateway.builderSlug,
    lease.builderSlug === gateway.builderSlug,
    Number.isSafeInteger(lease.sourceAssignmentEpoch),
  ].every(Boolean) ? lease : null;
}

function samePrelaunchAllocation(gateway: DurableGateway, expected: DurableGateway): boolean {
  return [
    gateway.ownerUid === expected.ownerUid,
    gateway.builderSlug === expected.builderSlug,
    gateway.allocation?.leaseId === expected.allocation?.leaseId,
    gateway.allocation?.generation === expected.allocation?.generation,
    gateway.latestRelease === expected.latestRelease,
  ].every(Boolean);
}

export async function disposableBuilderPrelaunchReserved(input: {
  db: Firestore;
  gateway: DurableGateway;
  transaction?: Transaction;
  expectedGateway?: DurableGateway;
  activationBoot?: true;
}): Promise<boolean> {
  const { db, gateway, transaction, expectedGateway } = input;
  if (expectedGateway && !samePrelaunchAllocation(gateway, expectedGateway)) return false;
  if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder" || !gateway.ownerUid) {
    return false;
  }
  const userRef = db.collection("users").doc(gateway.ownerUid);
  const user = await (transaction ? transaction.get(userRef) : userRef.get());
  const lease = prelaunchLease(gateway, user.data(), input.activationBoot);
  if (!lease) return false;
  const sourceRef = db.collection(GATEWAYS_COLLECTION).doc(lease.sourceGatewayId as string);
  const assignmentRef = sourceRef.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(gateway.ownerUid);
  const targetAssignments = db.collection(GATEWAYS_COLLECTION).doc(gateway.gatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).limit(1);
  const [source, assignment, target] = await Promise.all([
    transaction ? transaction.get(sourceRef) : sourceRef.get(),
    transaction ? transaction.get(assignmentRef) : assignmentRef.get(),
    transaction ? transaction.get(targetAssignments) : targetAssignments.get(),
  ]);
  const sourceRoot = projectGatewayDesiredRootForGateway(source.data(), lease.sourceGatewayId as string);
  const assigned = assignment.data();
  if (!assigned || sourceRoot?.gatewayClass !== "shared") return false;
  return [
    assigned.uid === gateway.ownerUid,
    assigned.slug === gateway.builderSlug,
    assigned.gatewayId === lease.sourceGatewayId,
    assigned.state === "serving",
    assigned.epoch === lease.sourceAssignmentEpoch,
    target.empty,
  ].every(Boolean);
}


function activationLeaseMatches(gateway: DurableGateway, lease: Record<string, unknown> | null): lease is Record<string, unknown> {
  return Boolean(lease && lease.leaseId === gateway.allocation?.leaseId && lease.generation === gateway.allocation?.generation &&
    lease.targetGatewayId === gateway.gatewayId && gateway.allocation?.claimedByUid === gateway.ownerUid && lease.builderSlug === gateway.builderSlug);
}

function activationBootMode(gateway: DurableGateway, lease: Record<string, unknown>): { mode: "prelaunch" | "normal" | "activating"; migrationId?: string } {
  if (["active", "returning", "failed"].includes(String(lease.status))) return { mode: "normal" };
  if (lease.status === "activating" || (lease.status === "provisioning" && lease.activationOperationId !== undefined)) {
    if (typeof lease.activationOperationId !== "string" || lease.activationOperationId !== builderActivateOperationId(gateway.gatewayId, gateway.allocation!.generation)) {
      throw new Error("Builder activation operation is unavailable");
    }
    return { mode: "activating", migrationId: `mig-${lease.activationOperationId}` };
  }
  if (lease.status !== "provisioning" || lease.activatingAt !== undefined || lease.activeAt !== undefined) throw new Error("Builder prelaunch authority is inconsistent");
  return { mode: "prelaunch" };
}

async function hasServingBuilderAssignment(input: {
  db: Firestore; gateway: DurableGateway; transaction: Transaction;
}, userData: Record<string, unknown>, ownerUid: string): Promise<boolean> {
  const { gateway, db, transaction } = input;
  if (record(record(userData.provisioning)?.openclaw)?.gatewayId !== gateway.gatewayId) return false;
  const assigned = (await transaction.get(db.collection(GATEWAYS_COLLECTION).doc(gateway.gatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(ownerUid))).data();
  return assigned?.uid === ownerUid && assigned.state === "serving";
}

export async function disposableBuilderBootMode(input: {
  db: Firestore; gateway: DurableGateway; transaction: Transaction;
}): Promise<{ mode: "prelaunch" | "normal" | "activating"; migrationId?: string }> {
  const { gateway, db, transaction } = input;
  if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder") return { mode: "normal" };
  if (!gateway.ownerUid) throw new Error("Builder prelaunch owner is unavailable");
  const user = await transaction.get(db.collection("users").doc(gateway.ownerUid));
  const data = user.data();
  if (!data) throw new Error("Builder prelaunch owner is unavailable");
  if (await hasServingBuilderAssignment(input, data, gateway.ownerUid)) return { mode: "normal" };
  const lease = record(record(record(data.provisioning)?.openclaw)?.activationLease);
  if (!activationLeaseMatches(gateway, lease)) {
    throw new Error("Builder activation authority is inconsistent");
  }
  const boot = activationBootMode(gateway, lease);
  if (boot.mode !== "normal" && await disposableBuilderPrelaunchReserved({ ...input, activationBoot: true })) return { mode: "prelaunch" };
  if (boot.mode === "prelaunch") throw new Error("Builder prelaunch authority is inconsistent");
  return boot;
}
