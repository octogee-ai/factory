import { GLM_OPERATIONS_COLLECTION, isGatewayClass, isGatewayProfile, resolveGatewayClass, } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { projectGatewayDesiredRootForGateway, } from "@octogee/shared/types/gateway-releases";
import { readGatewayRuntimeHeartbeat } from "./gateway-live-release.js";
function asStringOrNull(v) {
    return typeof v === "string" && v.length > 0 ? v : null;
}
function readUserGatewayId(data) {
    const provisioning = data?.provisioning ?? {};
    const openclaw = provisioning.openclaw ?? {};
    return asStringOrNull(openclaw.gatewayId);
}
function projectDesiredStatus(data) {
    const v = data?.desiredStatus;
    if (v === "running" || v === "paused" || v === "draining" || v === "retired")
        return v;
    return null;
}
function resolveCustomerSlug(userData, workspaceSlugsForUser) {
    const provisioning = userData.provisioning ?? {};
    const openclaw = provisioning.openclaw ?? {};
    const openclawSlug = asStringOrNull(openclaw.slug);
    return (openclawSlug ??
        workspaceSlugsForUser(userData)[0] ??
        null);
}
export function findPendingMigrationToGateway(docs, uid, gatewayId) {
    for (const doc of docs) {
        const data = doc.data();
        const input = typeof data.input === "object" && data.input !== null
            ? data.input
            : {};
        if (data.kind === "migrate-customer" &&
            input.uid === uid &&
            input.toGatewayId === gatewayId) {
            return { id: doc.id, kind: data.kind };
        }
    }
    return null;
}
function gatewayActivationClass(data) {
    return resolveGatewayClass({
        gatewayClass: isGatewayClass(data.gatewayClass) ? data.gatewayClass : undefined,
        profile: isGatewayProfile(data.profile) ? data.profile : undefined,
        imageProfile: isGatewayProfile(data.imageProfile) ? data.imageProfile : undefined,
    });
}
function durableActivationGateway(doc) {
    const data = doc.data();
    return projectGatewayDesiredRootForGateway(data, doc.id);
}
function isInactiveDedicatedStatus(status) {
    return status === "draining" || status === "retired";
}
function currentActivationTarget(snapshot, target, uid, builderSlug) {
    if (!snapshot.exists)
        return null;
    const gateway = durableActivationGateway({
        id: target.gatewayId,
        data: () => snapshot.data(),
    });
    if (!gateway || gateway.ownerUid !== uid)
        return null;
    if (gatewayActivationClass(gateway) !== target.gatewayClass)
        return null;
    const currentBuilderSlug = asStringOrNull(gateway.builderSlug);
    if (currentBuilderSlug !== null && currentBuilderSlug !== builderSlug)
        return null;
    return gateway;
}
async function commitActivationPlan(input) {
    const targetRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.target.gatewayId);
    return input.db.runTransaction(async (txn) => {
        const targetSnapshot = await txn.get(targetRef);
        const gateway = currentActivationTarget(targetSnapshot, input.target, input.uid, input.builderSlug);
        if (!gateway) {
            return { ok: false, code: "activation-gateway-changed", desiredStatus: null };
        }
        const desiredStatus = projectDesiredStatus(gateway);
        if (gateway.retirementClaim != null || isInactiveDedicatedStatus(desiredStatus)) {
            return { ok: false, code: "activation-gateway-retiring", desiredStatus };
        }
        if (input.action === "already-active" && desiredStatus !== "running") {
            return { ok: false, code: "activation-gateway-changed", desiredStatus };
        }
        if (input.action !== "already-active") {
            txn.update(targetRef, { desiredStatus: "running" });
        }
        if (input.operation)
            txn.set(input.operation.ref, input.operation.data);
        txn.update(input.userRef, input.userPatch);
        return { ok: true };
    });
}
function activationCommitConflict(result, gatewayId) {
    if (result.ok)
        return null;
    return {
        statusCode: 409,
        body: {
            code: result.code,
            error: "activation gateway changed while acquiring the lease",
            gatewayId,
            desiredStatus: result.desiredStatus,
        },
    };
}
export function resolveBuilderActivationPlan(opts) {
    if (!opts.currentGatewayId) {
        return {
            error: {
                status: 409,
                body: {
                    code: "no-current-gateway-assignment",
                    error: "user has no current gateway assignment; assign before activation",
                    uid: opts.uid,
                },
            },
        };
    }
    const ownedClassGateways = opts.gateways
        .map((doc) => {
        const data = durableActivationGateway(doc);
        if (!data)
            return null;
        if (data.ownerUid !== opts.uid)
            return null;
        const gatewayClass = gatewayActivationClass(data);
        if (gatewayClass === "shared")
            return null;
        if (opts.requestedGatewayClass && gatewayClass !== opts.requestedGatewayClass) {
            return null;
        }
        return {
            gatewayId: doc.id,
            gatewayClass,
            desiredStatus: projectDesiredStatus(data),
            builderSlug: asStringOrNull(data.builderSlug),
        };
    })
        .filter((v) => v !== null);
    const slugMismatches = ownedClassGateways.filter((gw) => gw.builderSlug !== null && gw.builderSlug !== opts.builderSlug);
    if (slugMismatches.length > 0) {
        return {
            error: {
                status: 409,
                body: {
                    code: "owned-activation-gateway-slug-mismatch",
                    error: "owned activation gateway builderSlug does not match user slug",
                    uid: opts.uid,
                    builderSlug: opts.builderSlug,
                    gatewayIds: slugMismatches.map((gw) => gw.gatewayId),
                },
            },
        };
    }
    const candidates = ownedClassGateways.filter((gw) => gw.builderSlug === null || gw.builderSlug === opts.builderSlug);
    if (candidates.length === 0) {
        return {
            error: {
                status: 404,
                body: {
                    code: "no-owned-dedicated-activation-gateway",
                    error: "no owned dedicated activation gateway found",
                    uid: opts.uid,
                    builderSlug: opts.builderSlug,
                    ...(opts.requestedGatewayClass ? { gatewayClass: opts.requestedGatewayClass } : {}),
                },
            },
        };
    }
    if (candidates.length > 1) {
        return {
            error: {
                status: 409,
                body: {
                    code: "multiple-owned-activation-gateways",
                    error: "multiple owned activation gateways match; operator must choose one",
                    uid: opts.uid,
                    builderSlug: opts.builderSlug,
                    ...(opts.requestedGatewayClass ? { gatewayClass: opts.requestedGatewayClass } : {}),
                    gatewayIds: candidates.map((gw) => gw.gatewayId),
                },
            },
        };
    }
    const target = candidates[0];
    if (isInactiveDedicatedStatus(target.desiredStatus)) {
        return {
            error: {
                status: 409,
                body: {
                    code: "activation-gateway-not-runnable",
                    error: "activation gateway is not runnable",
                    gatewayId: target.gatewayId,
                    desiredStatus: target.desiredStatus,
                },
            },
        };
    }
    const targetHeartbeat = opts.gatewayHeartbeats.get(target.gatewayId);
    const targetStatus = typeof targetHeartbeat?.status === "string"
        ? targetHeartbeat.status
        : "missing";
    if (opts.currentGatewayId === target.gatewayId) {
        if (targetStatus === "ready")
            return { ok: { action: "already-active", target } };
        return { ok: { action: "wake", target, status: targetStatus } };
    }
    const existing = findPendingMigrationToGateway(opts.pendingOps, opts.uid, target.gatewayId);
    if (existing) {
        return {
            error: {
                status: 409,
                body: {
                    code: "builder-activation-already-running",
                    error: "builder activation is already running",
                    uid: opts.uid,
                    gatewayId: target.gatewayId,
                    operationId: existing.id,
                    kind: existing.kind,
                },
            },
        };
    }
    if (targetStatus !== "ready") {
        return { ok: { action: "wake", target, status: targetStatus } };
    }
    return { ok: { action: "migrate", target } };
}
export async function requestBuilderActivationLease(opts) {
    const { db, uid } = opts;
    const now = opts.now ?? Date.now();
    const userRef = db.collection("users").doc(uid);
    const [userSnap, gatewaySnap, pendingOpsSnap] = await Promise.all([
        userRef.get(),
        db.collection(GATEWAYS_COLLECTION).get(),
        db
            .collection(GLM_OPERATIONS_COLLECTION)
            .where("status", "in", ["pending", "running"])
            .get(),
    ]);
    if (!userSnap.exists) {
        return {
            statusCode: 404,
            body: { code: "user-not-found", error: "user not found", uid },
        };
    }
    const userData = userSnap.data();
    const currentGatewayId = readUserGatewayId(userData);
    const builderSlug = resolveCustomerSlug(userData, opts.workspaceSlugsForUser);
    if (!builderSlug) {
        return {
            statusCode: 409,
            body: {
                code: "no-resolvable-builder-slug",
                error: "user has no resolvable builder slug",
                uid,
            },
        };
    }
    const gatewayRoots = gatewaySnap.docs
        .map((doc) => ({ doc: doc, root: durableActivationGateway(doc) }))
        .filter((entry) => entry.root !== null);
    const gatewayHeartbeats = new Map();
    const liveHeartbeats = await Promise.all(gatewayRoots.map(async ({ root }) => ({
        gatewayId: root.gatewayId,
        heartbeat: await readGatewayRuntimeHeartbeat(db, root),
    })));
    for (const { gatewayId, heartbeat } of liveHeartbeats) {
        if (heartbeat)
            gatewayHeartbeats.set(gatewayId, heartbeat);
    }
    const plan = resolveBuilderActivationPlan({
        uid,
        builderSlug,
        currentGatewayId,
        requestedGatewayClass: opts.requestedGatewayClass,
        gateways: gatewayRoots.map(({ doc }) => doc),
        gatewayHeartbeats,
        pendingOps: pendingOpsSnap.docs,
    });
    if ("error" in plan) {
        return {
            statusCode: plan.error.status,
            body: plan.error.body,
        };
    }
    const target = plan.ok.target;
    const leaseBase = {
        gatewayId: target.gatewayId,
        gatewayClass: target.gatewayClass,
        builderSlug,
        requestedAt: now,
        requestedBy: opts.createdBy,
        reason: opts.reason && opts.reason.length > 0 ? opts.reason : "builder-activity",
    };
    if (plan.ok.action === "already-active") {
        const committed = await commitActivationPlan({
            db,
            action: plan.ok.action,
            target,
            uid,
            builderSlug,
            userRef,
            userPatch: {
                "provisioning.openclaw.activationLease": {
                    ...leaseBase,
                    status: "active",
                    activeAt: now,
                },
            },
        });
        const conflict = activationCommitConflict(committed, target.gatewayId);
        if (conflict)
            return conflict;
        return {
            statusCode: 200,
            body: {
                uid,
                builderSlug,
                gatewayId: target.gatewayId,
                gatewayClass: target.gatewayClass,
                status: "active",
                alreadyActive: true,
            },
        };
    }
    if (plan.ok.action === "wake") {
        const committed = await commitActivationPlan({
            db,
            action: plan.ok.action,
            target,
            uid,
            builderSlug,
            userRef,
            userPatch: {
                "provisioning.openclaw.activationLease": {
                    ...leaseBase,
                    status: "waking",
                    targetStatus: plan.ok.status,
                },
            },
        });
        const conflict = activationCommitConflict(committed, target.gatewayId);
        if (conflict)
            return conflict;
        return {
            statusCode: 202,
            body: {
                uid,
                builderSlug,
                gatewayId: target.gatewayId,
                gatewayClass: target.gatewayClass,
                status: "waking",
                targetStatus: plan.ok.status,
                retryAfterMs: 15_000,
            },
        };
    }
    const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
    const operationId = opRef.id;
    const operationInput = {
        uid,
        ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
        toGatewayId: target.gatewayId,
        source: "builder-activation-lease",
        builderSlug,
        gatewayClass: target.gatewayClass,
        reason: leaseBase.reason,
    };
    const operationData = {
        kind: "migrate-customer",
        status: "pending",
        createdBy: opts.createdBy,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        input: operationInput,
        steps: [],
        gatewayId: target.gatewayId,
        inputUid: uid,
    };
    const committed = await commitActivationPlan({
        db,
        action: plan.ok.action,
        target,
        uid,
        builderSlug,
        userRef,
        operation: { ref: opRef, data: operationData },
        userPatch: {
            "provisioning.openclaw.activationLease": {
                ...leaseBase,
                status: "activating",
                operationId,
            },
        },
    });
    const conflict = activationCommitConflict(committed, target.gatewayId);
    if (conflict)
        return conflict;
    return {
        statusCode: 202,
        body: {
            uid,
            builderSlug,
            gatewayId: target.gatewayId,
            gatewayClass: target.gatewayClass,
            operationId,
            status: "activating",
        },
    };
}
export function activationLeaseMissCanMintTicket(result) {
    const code = result.body.code;
    return (code === "no-current-gateway-assignment" ||
        code === "no-owned-dedicated-activation-gateway" ||
        code === "multiple-owned-activation-gateways" ||
        code === "no-resolvable-builder-slug");
}
