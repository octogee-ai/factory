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
async function parkedComputer(db, tx, ownerUid) {
    const user = await tx.get(db.doc(`users/${ownerUid}`));
    if (!user.exists)
        throw new ComputerAdmissionError(404, "owner not found");
    const parked = readBuilderParkedComputer(user.data());
    if (!parked)
        throw new ComputerAdmissionError(404, "owner has no parked computer");
    if (parked.checkpoint.outcome !== "fresh") {
        throw new ComputerAdmissionError(409, "park checkpoint is stale; activate the Builder and replace through its gateway");
    }
    const runtime = await tx.get(db.doc(`glmGateways/${parked.gatewayId}`));
    if (object(object(runtime.data()).vm).instanceName === parked.instanceName) {
        throw new ComputerAdmissionError(409, "computer is still bound to a gateway; replace through that gateway");
    }
    return { gatewayId: parked.gatewayId, ownerUid, input: { ownerUid, uid: ownerUid, action: "replace" } };
}
function conflicts(data, target) {
    const input = object(data.input);
    return [data.gatewayId, input.gatewayId, input.fromGatewayId, input.toGatewayId].includes(target.gatewayId)
        || [data.inputUid, input.uid, input.ownerUid].includes(target.ownerUid);
}
async function enqueueReplacement(db, requested, actorUid) {
    const operation = db.collection(GLM_OPERATIONS_COLLECTION).doc();
    return db.runTransaction(async (tx) => {
        const target = "gatewayId" in requested
            ? await boundComputer(db, tx, requested.gatewayId)
            : await parkedComputer(db, tx, requested.ownerUid);
        const active = await tx.get(db.collection(GLM_OPERATIONS_COLLECTION).where("status", "in", ["pending", "running"]));
        const conflict = active.docs.find((doc) => conflicts(doc.data(), target));
        if (conflict)
            throw new ComputerAdmissionError(409, `computer operation already in flight: ${conflict.id}`);
        tx.create(operation, {
            kind: "gateway-vm", status: "pending", createdBy: actorUid, origin: "operator",
            createdAt: Date.now(), startedAt: null, completedAt: null, steps: [],
            gatewayId: target.gatewayId, inputUid: target.ownerUid, input: target.input,
        });
        return operation.id;
    });
}
function requestedComputer(req, key) {
    const params = req.params;
    const id = key === "gatewayId" ? params.id : params.uid;
    if (typeof id !== "string" || !id || id.includes("/") || id.length > 256 || (key === "gatewayId" && !isValidGatewayId(id))) {
        throw new ComputerAdmissionError(400, "invalid computer identity");
    }
    if (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
        throw new ComputerAdmissionError(400, "computer replacement accepts an empty object only");
    }
    return key === "gatewayId" ? { gatewayId: id } : { ownerUid: id };
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
                const operationId = await deps.journal({
                    req, what: "replace computer", why: "admin fleet request", target: requested,
                    preActionStatus: { binding: key === "gatewayId" ? "gateway" : "parked-owner" },
                    mutation: { kind: "replace-computer", ...requested },
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
