import { FieldValue } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, isValidGatewayId, readBuilderParkedComputer } from "@octogee/shared/types/glm";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
class ComputerAdmissionError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function assignedGateway(user) {
    return object(object(user.provisioning).openclaw).gatewayId;
}
async function boundComputer(db, tx, gatewayId) {
    const [rootSnap, runtimeSnap] = await Promise.all([
        tx.get(db.doc(`gateways/${gatewayId}`)), tx.get(db.doc(`glmGateways/${gatewayId}`)),
    ]);
    const root = projectGatewayDesiredRootForGateway(rootSnap.data(), gatewayId);
    if (!root)
        throw new ComputerAdmissionError(404, "gateway not found");
    if (root.gatewayClass !== "builder" || !root.ownerUid || !root.builderSlug || root.desiredStatus === "retired" || root.retirementClaim != null) {
        throw new ComputerAdmissionError(409, "replacement requires an owned, non-retiring Builder gateway");
    }
    const runtime = object(runtimeSnap.data());
    const vm = object(runtime.vm);
    if (runtime.runtime !== "gce-vm" || typeof vm.instanceName !== "string" || !vm.instanceName) {
        throw new ComputerAdmissionError(409, "gateway has no bound VM computer");
    }
    const owner = await tx.get(db.doc(`users/${root.ownerUid}`));
    if (!owner.exists || assignedGateway(object(owner.data())) !== gatewayId) {
        throw new ComputerAdmissionError(409, "gateway is no longer the owner's current assignment");
    }
    return { gatewayId, ownerUid: root.ownerUid, input: { gatewayId, uid: root.ownerUid, action: "replace" } };
}
async function parkedComputer(db, tx, ownerUid, force) {
    const user = await tx.get(db.doc(`users/${ownerUid}`));
    if (!user.exists)
        throw new ComputerAdmissionError(404, "owner not found");
    const parked = readBuilderParkedComputer(user.data());
    if (!parked)
        throw new ComputerAdmissionError(404, "owner has no parked computer");
    if (force && (!parked.instanceId || !isValidGatewayId(parked.gatewayId)))
        throw new ComputerAdmissionError(409, "force recovery requires the parked computer identity");
    if (!force && parked.checkpoint.outcome !== "fresh") {
        throw new ComputerAdmissionError(409, "park checkpoint is stale; activate the Builder and replace through its gateway");
    }
    const runtime = await tx.get(db.doc(`glmGateways/${parked.gatewayId}`));
    if (object(object(runtime.data()).vm).instanceName === parked.instanceName) {
        throw new ComputerAdmissionError(409, "computer is still bound to a gateway; replace through that gateway");
    }
    if (force) {
        const root = await tx.get(db.doc(`gateways/${parked.gatewayId}`));
        const data = object(root.data());
        if (root.exists && (data.ownerUid !== ownerUid || data.gatewayClass !== "builder" || !["paused", "retired"].includes(String(data.desiredStatus)))) {
            throw new ComputerAdmissionError(409, "force recovery requires an absent or stopped, owned Builder gateway");
        }
    }
    return { gatewayId: parked.gatewayId, ownerUid, input: { ownerUid, uid: ownerUid, action: "replace", ...(force ? { force: true, expectedGatewayId: parked.gatewayId, expectedInstanceId: parked.instanceId } : {}) } };
}
function conflicts(data, target) {
    const input = object(data.input);
    return [data.gatewayId, input.gatewayId, input.fromGatewayId, input.toGatewayId].includes(target.gatewayId)
        || [data.inputUid, input.uid, input.ownerUid].includes(target.ownerUid);
}
async function servingShared(db, tx, ownerUid, openclaw) {
    const gatewayId = typeof openclaw.gatewayId === "string" ? openclaw.gatewayId : "";
    if (!isValidGatewayId(gatewayId))
        throw new ComputerAdmissionError(409, "Builder has no valid serving assignment");
    const root = object((await tx.get(db.doc(`gateways/${gatewayId}`))).data());
    if (root.gatewayClass !== "shared")
        throw new ComputerAdmissionError(409, "computer recovery requires a Shared assignment");
    const assignment = object((await tx.get(db.doc(`gateways/${gatewayId}/assignments/${ownerUid}`))).data());
    if (assignment.uid !== ownerUid || assignment.gatewayId !== gatewayId || assignment.state !== "serving" || !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0)
        throw new ComputerAdmissionError(409, "computer recovery requires a serving Shared assignment");
    return { gatewayId, epoch: assignment.epoch };
}
function assertInactiveLease(openclaw) {
    if (openclaw.activationLease != null && !["parked", "failed"].includes(String(object(openclaw.activationLease).status)))
        throw new ComputerAdmissionError(409, "Builder activation is in progress");
}
function recoveryOperationMatches(existing, input, ownerUid, fence) {
    return existing.status === "failed" && existing.kind === "gateway-vm" && existing.origin === "operator" && input.action === "replace" && input.force === true &&
        input.ownerUid === ownerUid && input.uid === ownerUid && input.expectedGatewayId === fence.gatewayId && input.expectedInstanceId === fence.instanceId;
}
async function retryForceRecovery(db, tx, ownerUid, actorUid, provisioning) {
    const fence = object(provisioning.computerRecovery);
    const operationId = typeof fence.operationId === "string" ? fence.operationId : "";
    if (!operationId || operationId.includes("/") || typeof fence.gatewayId !== "string" || !isValidGatewayId(fence.gatewayId) || typeof fence.instanceId !== "string" || !fence.instanceId)
        throw new ComputerAdmissionError(409, "computer recovery fence is malformed");
    const openclaw = object(provisioning.openclaw);
    assertInactiveLease(openclaw);
    const shared = await servingShared(db, tx, ownerUid, openclaw);
    const ref = db.doc(`${GLM_OPERATIONS_COLLECTION}/${operationId}`);
    const operationSnapshot = await tx.get(ref);
    const existing = object(operationSnapshot.data());
    const input = operationSnapshot.exists ? object(existing.input) : { ownerUid, uid: ownerUid, action: "replace", force: true, expectedGatewayId: fence.gatewayId, expectedInstanceId: fence.instanceId };
    if (operationSnapshot.exists && !recoveryOperationMatches(existing, input, ownerUid, fence))
        throw new ComputerAdmissionError(409, "computer recovery is already in progress or cannot be retried");
    const active = await tx.get(db.collection(GLM_OPERATIONS_COLLECTION).where("status", "in", ["pending", "running"]));
    const target = { ownerUid, gatewayId: fence.gatewayId, input };
    if (active.docs.some(doc => {
        const candidate = doc.data();
        const candidateInput = object(candidate.input);
        const fencedPending = candidate.status === "pending" && (candidateInput.uid === ownerUid || (candidateInput.uid == null && candidateInput.ownerUid === ownerUid));
        return conflicts(candidate, target) && !fencedPending;
    }))
        throw new ComputerAdmissionError(409, "conflicting computer operation is in progress");
    tx.update(db.doc(`users/${ownerUid}`), { "provisioning.computerRecovery": { ...fence, sharedGatewayId: shared.gatewayId, assignmentEpoch: shared.epoch } });
    if (operationSnapshot.exists)
        tx.update(ref, { status: "pending", startedAt: null, completedAt: null, steps: [], error: FieldValue.delete(), expireAt: FieldValue.delete(), nextAttemptAt: FieldValue.delete() });
    else
        tx.create(ref, { kind: "gateway-vm", status: "pending", createdBy: actorUid, origin: "operator", createdAt: Date.now(), startedAt: null, completedAt: null, steps: [], gatewayId: fence.gatewayId, inputUid: ownerUid, input });
    return operationId;
}
async function fenceForceRecovery(db, tx, target, operationId) {
    const ref = db.doc(`users/${target.ownerUid}`);
    const user = object((await tx.get(ref)).data());
    const provisioning = object(user.provisioning);
    const openclaw = object(provisioning.openclaw);
    if (provisioning.computerRecovery != null)
        throw new ComputerAdmissionError(409, "computer recovery is already in progress");
    assertInactiveLease(openclaw);
    const shared = await servingShared(db, tx, target.ownerUid, openclaw);
    tx.update(ref, { "provisioning.computerRecovery": { operationId, gatewayId: target.gatewayId, instanceId: target.input.expectedInstanceId, sharedGatewayId: shared.gatewayId, assignmentEpoch: shared.epoch } });
}
async function enqueueReplacement(db, requested, actorUid) {
    const operation = db.collection(GLM_OPERATIONS_COLLECTION).doc();
    return db.runTransaction(async (tx) => {
        if ("force" in requested && requested.force) {
            const owner = object((await tx.get(db.doc(`users/${requested.ownerUid}`))).data());
            const provisioning = object(owner.provisioning);
            if (provisioning.computerRecovery != null)
                return retryForceRecovery(db, tx, requested.ownerUid, actorUid, provisioning);
        }
        const target = "gatewayId" in requested
            ? await boundComputer(db, tx, requested.gatewayId)
            : await parkedComputer(db, tx, requested.ownerUid, requested.force === true);
        const active = await tx.get(db.collection(GLM_OPERATIONS_COLLECTION).where("status", "in", ["pending", "running"]));
        const conflict = active.docs.find((doc) => conflicts(doc.data(), target));
        if (conflict)
            throw new ComputerAdmissionError(409, `computer operation already in flight: ${conflict.id}`);
        if ("force" in requested && requested.force)
            await fenceForceRecovery(db, tx, target, operation.id);
        tx.create(operation, {
            kind: "gateway-vm", status: "pending", createdBy: actorUid, origin: "operator",
            createdAt: Date.now(), startedAt: null, completedAt: null, steps: [],
            gatewayId: target.gatewayId, inputUid: target.ownerUid, input: target.input,
        });
        return operation.id;
    });
}
function forceRequested(req, key) {
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body))
        throw new ComputerAdmissionError(400, "invalid computer replacement request");
    const force = key === "ownerUid" && body.force === true && body.acceptBootDataLoss === true && Object.keys(body).length === 2;
    if (Object.keys(body).length !== 0 && !force)
        throw new ComputerAdmissionError(400, "force recovery requires force and acceptBootDataLoss");
    return force;
}
function requestedComputer(req, key) {
    const params = req.params;
    const id = key === "gatewayId" ? params.id : params.uid;
    if (typeof id !== "string" || !id || id.includes("/") || id.length > 256 || (key === "gatewayId" && !isValidGatewayId(id))) {
        throw new ComputerAdmissionError(400, "invalid computer identity");
    }
    const force = forceRequested(req, key);
    return key === "gatewayId" ? { gatewayId: id } : { ownerUid: id, ...(force ? { force: true } : {}) };
}
export function addAdminComputerRoutes(router, deps) {
    for (const [path, key] of [["/gateways/:id/computer/replace", "gatewayId"], ["/customers/:uid/computer/replace", "ownerUid"]]) {
        router.post(path, async (req, res, next) => {
            try {
                const actor = req;
                if (!actor.uid) {
                    res.status(401).json({ error: "Unauthenticated" });
                    return;
                }
                if (!actor.isAdmin) {
                    res.status(403).json({ error: "Admin access required" });
                    return;
                }
                if (!deps.replacementEnabled)
                    throw new ComputerAdmissionError(409, "Computer replacement is unavailable in this release; the existing computer and home are retained.");
                const requested = requestedComputer(req, key);
                const force = "force" in requested && requested.force === true;
                const operationId = await deps.journal({
                    req, what: "replace computer", why: force ? "operator accepted possible boot data loss for force recovery" : "admin fleet request", target: requested,
                    preActionStatus: { binding: key === "gatewayId" ? "gateway" : "parked-owner" },
                    mutation: { kind: "replace-computer", ...requested },
                    ...(force ? { forced: true } : {}),
                    action: () => enqueueReplacement(deps.db, requested, actor.uid),
                });
                res.status(202).json({ ...requested, operationId });
            }
            catch (error) {
                if (error instanceof ComputerAdmissionError)
                    res.status(error.status).json({ error: error.message });
                else
                    next(error);
            }
        });
    }
}
