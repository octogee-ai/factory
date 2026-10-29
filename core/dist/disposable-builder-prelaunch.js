import { builderActivateOperationId } from "./builder-activation-lease.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function prelaunchLease(gateway, userData) {
    const user = record(userData);
    const openclaw = record(record(user?.provisioning)?.openclaw);
    const lease = record(openclaw?.activationLease);
    const allocation = gateway.allocation;
    if (!user || !accountAllowsInteractiveAccess(user) || !lease || !allocation)
        return null;
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
function samePrelaunchAllocation(gateway, expected) {
    return [
        gateway.ownerUid === expected.ownerUid,
        gateway.builderSlug === expected.builderSlug,
        gateway.allocation?.leaseId === expected.allocation?.leaseId,
        gateway.allocation?.generation === expected.allocation?.generation,
        gateway.latestRelease === expected.latestRelease,
    ].every(Boolean);
}
export async function disposableBuilderPrelaunchReserved(input) {
    const { db, gateway, transaction, expectedGateway } = input;
    if (expectedGateway && !samePrelaunchAllocation(gateway, expectedGateway))
        return false;
    if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder" || !gateway.ownerUid) {
        return false;
    }
    const userRef = db.collection("users").doc(gateway.ownerUid);
    const user = await (transaction ? transaction.get(userRef) : userRef.get());
    const lease = prelaunchLease(gateway, user.data());
    if (!lease)
        return false;
    const sourceRef = db.collection(GATEWAYS_COLLECTION).doc(lease.sourceGatewayId);
    const assignmentRef = sourceRef.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(gateway.ownerUid);
    const targetAssignments = db.collection(GATEWAYS_COLLECTION).doc(gateway.gatewayId)
        .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).limit(1);
    const [source, assignment, target] = await Promise.all([
        transaction ? transaction.get(sourceRef) : sourceRef.get(),
        transaction ? transaction.get(assignmentRef) : assignmentRef.get(),
        transaction ? transaction.get(targetAssignments) : targetAssignments.get(),
    ]);
    const sourceRoot = projectGatewayDesiredRootForGateway(source.data(), lease.sourceGatewayId);
    const assigned = assignment.data();
    if (!assigned || sourceRoot?.gatewayClass !== "shared")
        return false;
    return [
        assigned.uid === gateway.ownerUid,
        assigned.slug === gateway.builderSlug,
        assigned.gatewayId === lease.sourceGatewayId,
        assigned.state === "serving",
        assigned.epoch === lease.sourceAssignmentEpoch,
        target.empty,
    ].every(Boolean);
}
function activationLeaseMatches(gateway, lease) {
    return Boolean(lease && lease.leaseId === gateway.allocation?.leaseId && lease.generation === gateway.allocation?.generation &&
        lease.targetGatewayId === gateway.gatewayId && gateway.allocation?.claimedByUid === gateway.ownerUid && lease.builderSlug === gateway.builderSlug);
}
function activationBootMode(gateway, lease) {
    if (["active", "returning", "failed"].includes(String(lease.status)))
        return { mode: "normal" };
    if (lease.status === "activating" || (lease.status === "provisioning" && lease.activationOperationId !== undefined)) {
        if (typeof lease.activationOperationId !== "string" || lease.activationOperationId !== builderActivateOperationId(gateway.gatewayId, gateway.allocation.generation)) {
            throw new Error("Builder activation operation is unavailable");
        }
        return { mode: "activating", migrationId: `mig-${lease.activationOperationId}` };
    }
    if (lease.status !== "provisioning" || lease.activatingAt !== undefined || lease.activeAt !== undefined)
        throw new Error("Builder prelaunch authority is inconsistent");
    return { mode: "prelaunch" };
}
export async function disposableBuilderBootMode(input) {
    const { gateway, db, transaction } = input;
    if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder")
        return { mode: "normal" };
    if (!gateway.ownerUid)
        throw new Error("Builder prelaunch owner is unavailable");
    const user = await transaction.get(db.collection("users").doc(gateway.ownerUid));
    const data = user.data();
    if (!data)
        throw new Error("Builder prelaunch owner is unavailable");
    const lease = record(record(record(data.provisioning)?.openclaw)?.activationLease);
    if (!activationLeaseMatches(gateway, lease)) {
        throw new Error("Builder activation authority is inconsistent");
    }
    const boot = activationBootMode(gateway, lease);
    if (boot.mode === "prelaunch" && !await disposableBuilderPrelaunchReserved(input))
        throw new Error("Builder prelaunch authority is inconsistent");
    return boot;
}
