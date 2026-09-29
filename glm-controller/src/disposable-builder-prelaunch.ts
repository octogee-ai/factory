import type { Firestore, Transaction } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
} from "@octogee/shared/types/gateway-releases";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import type { DurableGateway } from "./converge-gateway.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function runtimeMatchesPrelaunchRelease(
  gateway: DurableGateway,
  runtime: unknown,
  image: { imageRepository: string; imageTag: string },
): boolean {
  if (!isGatewayRuntimeDoc(runtime) || record(runtime)?.runtime !== "gce-vm") return false;
  return [
    gateway.liveRelease !== null && gateway.liveRelease < gateway.desiredRelease,
    runtime.gatewayId === gateway.gatewayId,
    runtime.release === gateway.desiredRelease,
    runtime.helm?.imageRepository === image.imageRepository,
    runtime.helm?.imageTag === image.imageTag,
    runtime.heartbeat?.status === "booting",
    gatewayHeartbeatMatchesImageTag(runtime.heartbeat?.version, image.imageTag),
    Array.isArray(runtime.heartbeat?.mountedCustomers) && runtime.heartbeat.mountedCustomers.length === 0,
  ].every(Boolean);
}

function prelaunchLease(gateway: DurableGateway, userData: unknown): Record<string, unknown> | null {
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
    lease.status === "provisioning",
    lease.activationOperationId === undefined,
    lease.activatingAt === undefined,
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
}): Promise<boolean> {
  const { db, gateway, transaction, expectedGateway } = input;
  if (expectedGateway && !samePrelaunchAllocation(gateway, expectedGateway)) return false;
  if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder" || !gateway.ownerUid) {
    return false;
  }
  const userRef = db.collection("users").doc(gateway.ownerUid);
  const user = await (transaction ? transaction.get(userRef) : userRef.get());
  const lease = prelaunchLease(gateway, user.data());
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

export async function readDisposableBuilderPrelaunchRefresh(input: {
  db: Firestore;
  gateway: DurableGateway;
  runtime: unknown;
  image: { imageRepository: string; imageTag: string };
  observedImage: { imageRepository: string | null; imageTag: string | null } | null;
}): Promise<boolean> {
  return runtimeMatchesPrelaunchRelease(input.gateway, input.runtime, input.image) &&
    input.observedImage?.imageRepository === input.image.imageRepository &&
    input.observedImage.imageTag === input.image.imageTag &&
    await disposableBuilderPrelaunchReserved(input);
}
