import { isDeepStrictEqual } from "node:util";
export class SharedSourceRecoveryConflict extends Error {
}
const conflict = (message) => { throw new SharedSourceRecoveryConflict(message); };
function rootIdentity(root) {
    return Object.fromEntries(["gatewayId", "gatewayClass", "ownerUid", "builderSlug", "desiredStatus", "desiredRelease", "liveRelease", "latestRelease"]
        .map(key => [key, root[key]]));
}
function validRoot(root, gatewayId) {
    return [root.gatewayId === gatewayId, root.gatewayClass === "shared", root.ownerUid === null, root.builderSlug === null,
        root.allocation == null, root.retirementClaim == null, ["running", "draining"].includes(root.desiredStatus),
        Number.isSafeInteger(root.liveRelease), root.liveRelease > 0, root.liveRelease === root.desiredRelease].every(Boolean);
}
function assignmentIdentity(uid, assignment, gatewayId) {
    const slug = assignment.slug;
    if (![assignment.uid === uid, assignment.gatewayId === gatewayId, assignment.state === "serving",
        typeof slug === "string", /^[a-z0-9][a-z0-9-]*$/.test(slug), Number.isSafeInteger(assignment.epoch), assignment.epoch >= 0].every(Boolean)) {
        conflict("source recovery assignment is unavailable");
    }
    return { uid, slug, agentId: `octogee-${slug}-coach`, assignmentEpoch: assignment.epoch, assignment };
}
function userMatches(user, identity, gatewayId) {
    const state = user.provisioning?.openclaw ?? {};
    return [user.username === identity.slug, state.gatewayId === gatewayId, state.status === "complete",
        state.migration === undefined, state.restoreFence === undefined, state.sourceTransferFence === undefined,
        state.nativeSharedContextRestore === undefined, state.runtimeRestartFence === undefined].every(Boolean);
}
function schema24ExportError(error, gatewayId, agentId) {
    const prefix = `/push-rsync-state/${gatewayId}: 500 `;
    if (typeof error !== "string" || !error.startsWith(prefix))
        return false;
    let body;
    try {
        body = JSON.parse(error.slice(prefix.length));
    }
    catch {
        return false;
    }
    const file = `/home/node/.openclaw/agents/${agentId}/agent/openclaw-agent.sqlite`;
    return body?.error === "push-rsync-state failed" && body.message ===
        `OpenClaw snapshot of ${agentId} failed: SQLite database cannot be snapshotted safely: ${file}. OpenClaw agent database ${file} uses schema version 24; run openclaw doctor --fix before compacting it.`;
}
function failedExportMatches(row, identity, gatewayId) {
    const steps = Array.isArray(row.steps) ? row.steps : [];
    return [row.kind === "migrate-customer", row.status === "failed", row.cancellationRequestedAt === undefined,
        Number.isSafeInteger(row.startedAt), row.startedAt > 0, Number.isSafeInteger(row.completedAt), row.completedAt >= row.startedAt,
        row.input?.uid === identity.uid, row.input?.fromGatewayId === gatewayId,
        typeof row.input?.toGatewayId === "string", row.input?.toGatewayId !== gatewayId,
        row.cutoverCommittedAt === undefined, row.restoreAttempt === undefined,
        schema24ExportError(row.error, gatewayId, identity.agentId),
        steps.some(step => step.name === "pre-sync-state" && step.status === "failed" && step.error === row.error),
        steps.some(step => step.name === "rollback:unmount-target" && step.status === "done"),
        !steps.some(step => step.name === "quiesce-source" || step.name === "final-sync-state")].every(Boolean);
}
function operationTouchesSource(row, gatewayId) {
    return [row.input?.gatewayId, row.input?.fromGatewayId, row.input?.toGatewayId].includes(gatewayId);
}
function ownedSourceFence(root, ownerId, assignments) {
    const fence = root.runtimeRestartFence, target = fence?.target;
    return Boolean(ownerId && fence?.kind === "source-recovery" && fence.attemptId === ownerId && fence.auditId === ownerId &&
        fence.gatewayId === root.gatewayId && ["reserved", "dispatched"].includes(fence.phase) && fence.doctor?.requestId === ownerId &&
        isDeepStrictEqual(target?.agents, assignments.map(({ uid, slug, agentId, assignmentEpoch }) => ({ uid, slug, agentId, assignmentEpoch }))));
}
function pristineOutbound(row, gatewayId, sourceUids) {
    return [row.kind === "migrate-customer", row.status === "pending", row.origin === "automatic",
        row.createdBy === "glm-controller-placement-policy", row.startedAt === null, row.completedAt === null,
        row.attempts === undefined || row.attempts === 0, Array.isArray(row.steps) && row.steps.length === 0,
        row.attemptHistory === undefined || (Array.isArray(row.attemptHistory) && row.attemptHistory.length === 0),
        row.input?.fromGatewayId === gatewayId, sourceUids.has(row.input?.uid), typeof row.input?.toGatewayId === "string",
        Boolean(row.input?.toGatewayId), row.input?.toGatewayId !== gatewayId,
        ["cancellationRequestedAt", "cutoverCommittedAt", "restoreAttempt", "schedulerHandoff", "customerMigrationV2", "sourceTransferExecution",
            "firstStartedAt", "lastProgressAt", "resumeCount", "lastResumedAt", "error", "output", "rolledBack"]
            .every(key => row[key] === undefined)].every(Boolean);
}
export async function readSharedSourceRecoveryAuthority(db, tx, gatewayId, ownOperationId, predecessorId) {
    const [rootSnap, roster, active, failed] = await Promise.all([
        tx.get(db.doc(`gateways/${gatewayId}`)), tx.get(db.collection(`gateways/${gatewayId}/assignments`)),
        tx.get(db.collection("glmOperations").where("status", "in", ["pending", "running"])),
        tx.get(db.collection("glmOperations").where("status", "==", "failed")),
    ]);
    const root = rootSnap.data() ?? {};
    if (!validRoot(root, gatewayId) || (!ownOperationId && root.runtimeRestartFence !== undefined))
        conflict("source recovery gateway authority is unavailable");
    const assignments = roster.docs.map(row => assignmentIdentity(row.id, row.data(), gatewayId)).sort((a, b) => a.uid.localeCompare(b.uid));
    if (!assignments.length || new Set(assignments.map(row => row.slug)).size !== assignments.length)
        conflict("source recovery roster is unavailable");
    const sourceUids = new Set(assignments.map(row => row.uid));
    const fenced = ownedSourceFence(root, ownOperationId, assignments) || ownedSourceFence(root, predecessorId, assignments);
    if (active.docs.some(row => row.id !== ownOperationId && (operationTouchesSource(row.data(), gatewayId) || sourceUids.has(row.data().input?.uid)) &&
        !(fenced && pristineOutbound(row.data(), gatewayId, sourceUids)))) {
        conflict("another source operation is active");
    }
    const users = await Promise.all(assignments.map(row => tx.get(db.doc(`users/${row.uid}`))));
    if (users.some((user, index) => !userMatches(user.data() ?? {}, assignments[index], gatewayId)))
        conflict("source recovery customer authority changed");
    const failedExports = assignments.map(identity => {
        const matched = failed.docs.filter(row => failedExportMatches(row.data(), identity, gatewayId))
            .sort((a, b) => b.data().completedAt - a.data().completedAt)[0];
        if (!matched)
            return conflict(`source recovery lacks a rolled-back schema24 export for ${identity.slug}`);
        const row = matched.data();
        return { operationId: matched.id, input: row.input, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: row.steps };
    });
    return { root: rootIdentity(root), assignments, failedExports };
}
export function assertSharedSourceRecoveryUnchanged(current, captured) {
    if (!isDeepStrictEqual(current, { root: captured.root, assignments: captured.assignments, failedExports: captured.failedExports })) {
        conflict("source recovery custody changed");
    }
}
function failedPredecessorMatches(row, gatewayId) {
    const input = row.input ?? {};
    return [row.kind === "restart-gateway", row.status === "failed", input.gatewayId === gatewayId,
        Number.isSafeInteger(row.startedAt), row.startedAt > 0,
        Number.isSafeInteger(row.completedAt), row.completedAt >= row.startedAt,
        row.cancellationRequestedAt === undefined, row.sourceRuntimeRecovery === undefined, row.sourceRecoverySupersededBy === undefined,
        input.sourceRecovery !== undefined, input.restoreRecovery === undefined].every(Boolean);
}
function spentDoctorMatches(row, fence) {
    const doctor = fence.doctor ?? {}, proof = fence.installedImage ?? {}, target = fence.target ?? {}, gatewayImage = target.images?.gateway;
    return [Object.keys(doctor).length === 3, doctor.completedAt === undefined, doctor.verifiedAgentIds === undefined, doctor.error === undefined,
        Number.isSafeInteger(doctor.startedAt), doctor.startedAt > 0, typeof doctor.releaseKey === "string", Boolean(doctor.releaseKey),
        Number.isSafeInteger(fence.startedAt), fence.startedAt >= row.startedAt,
        Number.isSafeInteger(proof.verifiedAt), proof.verifiedAt >= fence.startedAt, proof.verifiedAt <= doctor.startedAt,
        doctor.startedAt <= row.completedAt, proof.podUid === target.podUid,
        typeof gatewayImage === "string" && /@sha256:[a-f0-9]{64}$/.test(gatewayImage),
        typeof proof.gatewayImageId === "string" && proof.gatewayImageId.endsWith(`@${String(gatewayImage).split("@")[1]}`)].every(Boolean);
}
function predecessorDoctorMatches(row, fence) {
    if (row.error === "another source operation is active") {
        return Object.keys(fence.doctor ?? {}).length === 1 && row.input?.sourceRecovery?.supersede === undefined;
    }
    return row.error === "source repair is not ready; outcome remains fenced" && spentDoctorMatches(row, fence);
}
function predecessorFenceMatches(request) {
    const { operationId, source } = request, fence = request.fence ?? {}, input = request.input ?? {}, doctor = fence.doctor ?? {}, target = fence.target ?? {};
    return [ownedSourceFence({ ...source.root, runtimeRestartFence: fence }, operationId, source.assignments), fence.phase === "dispatched",
        typeof target.podUid === "string", Boolean(target.podUid), typeof target.podName === "string", Boolean(target.podName),
        predecessorDoctorMatches(request.row, fence), doctor.requestId === operationId,
        target.sourceSha === input.sourceSha, isDeepStrictEqual(target.images, input.images),
        isDeepStrictEqual(target.failedExportOperationIds, source.failedExports.map(r => r.operationId))].every(Boolean);
}
export function assertSharedSourceRecoveryPredecessor(request) {
    const { gatewayId, operationId, row, fence, source } = request, input = row.input?.sourceRecovery;
    if (!failedPredecessorMatches(row, gatewayId) || !predecessorFenceMatches({ fence, operationId, source, input, row })) {
        conflict("source recovery predecessor is unavailable");
    }
    assertSharedSourceRecoveryUnchanged({ root: source.root, assignments: source.assignments, failedExports: source.failedExports }, input);
    return { operationId, input: row.input, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, fence };
}
export async function readSharedSourceRecoverySupersession(db, tx, gatewayId, operationId) {
    const [root, prior, source] = await Promise.all([tx.get(db.doc(`gateways/${gatewayId}`)), tx.get(db.doc(`glmOperations/${operationId}`)),
        readSharedSourceRecoveryAuthority(db, tx, gatewayId, operationId)]);
    return { source, supersede: assertSharedSourceRecoveryPredecessor({ gatewayId, operationId,
            row: prior.data() ?? {}, fence: root.data()?.runtimeRestartFence, source }) };
}
