import { projectAgentId } from "@octogee/shared/types/identity";
import { projectAgentConfigured } from "@octogee/shared/types/project";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { managementExportMatches, managementUserMatches, managementPodIdentity } from "./shared-source-management-recovery.js";
import { isDeepStrictEqual } from "node:util";
import { operationAuditMutationFingerprint } from "./operation-audit.js";
export class SharedSourceRecoveryConflict extends Error {
}
const UNMATCHED_ROUTE_AGENT_ID = "octogee-unmatched-route";
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
const SUPERSEDED_DETACH_ENTRY = new RegExp("^\\[release:(octogee-[a-z0-9][a-z0-9_-]*-coach)\\] agents\\.detach failed for \\1 \\(" +
    "Agent configuration was saved but its application to the active Gateway was not confirmed \\(superseded\\); " +
    "run config\\.get, then apply the saved config or restart the Gateway\\.\\)$");
function supersededDetachAgentIds(message) {
    if (typeof message !== "string")
        return [];
    const entries = message.split("; [release:").map((entry, index) => index === 0 ? entry : `[release:${entry}`);
    const agentIds = entries.map(entry => SUPERSEDED_DETACH_ENTRY.exec(entry)?.[1]);
    return agentIds.every((agentId) => agentId !== undefined) ? agentIds : [];
}
function supersededDetachExportError(error, gatewayId, slug) {
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
    const agentIds = supersededDetachAgentIds(body?.message);
    return body?.error === "push-rsync-state failed" && agentIds.length > 0 && agentIds.every(agentId => agentIdBelongsToSlug(agentId, slug));
}
function schema24Export(row, identity, gatewayId, steps) {
    return schema24ExportError(row.error, gatewayId, identity.agentId) &&
        steps.some(step => step.name === "pre-sync-state" && step.status === "failed" && step.error === row.error) &&
        steps.some(step => step.name === "rollback:unmount-target" && step.status === "done") &&
        !steps.some(step => step.name === "quiesce-source" || step.name === "final-sync-state");
}
function supersededDetachExport(row, identity, gatewayId, steps) {
    return row.rolledBack === true && supersededDetachExportError(row.error, gatewayId, identity.slug) &&
        steps.some(step => step.name === "final-sync-state" && step.status === "failed" && step.error === row.error) &&
        ["scheduler-abort", "unmount-target", "scheduler-resume", "resume-ingress"].every(name => steps.some(step => step.name === `rollback:${name}` && step.status === "done"));
}
function postgresMaintenanceImportErrorMatches(error, target, slug) {
    const prefix = `/finish-rsync-import/${target}: 500 `;
    if (typeof error !== "string" || !error.startsWith(prefix))
        return false;
    let body;
    try {
        body = JSON.parse(error.slice(prefix.length));
    }
    catch {
        return false;
    }
    const messagePrefix = `[import:${slug}] agents.create failed for `;
    const message = body?.message;
    const messageSuffix = [
        " (AgentDatabaseMaintenanceRequiredError: Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.)",
        " (AgentDatabaseMaintenanceRequiredError: Agent database migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.)",
    ].find(suffix => typeof message === "string" && message.endsWith(suffix));
    return body?.error === "import failed" && typeof message === "string" && message.startsWith(messagePrefix) && messageSuffix !== undefined &&
        agentIdBelongsToSlug(message.slice(messagePrefix.length, -messageSuffix.length), slug);
}
export function postgresImportMaintenanceFailureMatches(row, operationId, identity, gatewayId) {
    const target = row.input?.toGatewayId;
    if (typeof target !== "string" || !target || target === gatewayId)
        return false;
    if (!postgresMaintenanceImportErrorMatches(row.error, target, identity.slug))
        return false;
    const steps = Array.isArray(row.steps) ? row.steps : [];
    const done = (name) => steps.filter(step => step.name === name).length === 1 && steps.some(step => step.name === name && step.status === "done");
    return [row.kind === "migrate-customer", row.status === "failed", row.origin === "automatic", row.createdBy === "glm-controller-placement-policy",
        row.input?.source === "continuous-placement-policy", row.input?.uid === identity.uid, row.input?.builderSlug === identity.slug,
        row.input?.fromGatewayId === gatewayId, row.rolledBack === true, row.attempts === 1,
        Array.isArray(row.attemptHistory) && row.attemptHistory.length === 1 && row.attemptHistory[0].attempt === 1 &&
            ["startedAt", "completedAt", "error", "steps"].every(key => isDeepStrictEqual(row.attemptHistory[0][key], row[key])),
        Number.isSafeInteger(row.startedAt), row.startedAt > 0, Number.isSafeInteger(row.completedAt), row.completedAt >= row.startedAt,
        isDeepStrictEqual(row.schedulerHandoff, { migrationId: `mig-${operationId}:scheduler:1:claim:${row.startedAt}`,
            fromGatewayId: gatewayId, toGatewayId: target, uid: identity.uid, slug: identity.slug }),
        ["cancellationRequestedAt", "cutoverCommittedAt", "restoreAttempt", "customerMigrationV2", "sourceTransferExecution"].every(key => row[key] === undefined),
        ["keys-sync-state", "pre-sync-state", "target-scheduler-ready", "wait-for-active-work", "quiesce-source", "flush-source",
            "rollback:scheduler-abort", "rollback:unmount-target", "rollback:scheduler-resume", "rollback:resume-ingress"].every(done),
        steps.filter(step => step.name === "final-sync-state").length === 1,
        steps.some(step => step.name === "final-sync-state" && step.status === "failed" && step.error === row.error),
        !steps.some(step => ["cutover-firestore", "verify-target"].includes(step.name))].every(Boolean);
}
export async function readPostgresSourceAgentStores(db, tx, assignments) {
    const stores = [];
    for (const identity of assignments) {
        const [records, projects] = await Promise.all([
            tx.get(db.collection("users").doc(identity.uid).collection("agentStores")),
            tx.get(db.collection("workspaces").doc(identity.slug).collection("projects")),
        ]);
        const required = [identity.agentId, ...projects.docs.filter(project => {
                const data = project.data();
                return projectAgentConfigured(data.agent) && data.commercialLifecycle?.status !== "archived";
            }).map(project => projectAgentId(identity.slug, project.id))];
        const owned = records.docs.filter(record => record.id !== "_gateway-state" &&
            !(record.id === UNMATCHED_ROUTE_AGENT_ID && record.data().agentId === UNMATCHED_ROUTE_AGENT_ID)).map(record => {
            const row = record.data();
            if (row.agentId !== record.id || !agentIdBelongsToSlug(record.id, identity.slug) || row.gatewayId !== identity.assignment.gatewayId ||
                row.assignmentEpoch !== identity.assignmentEpoch || typeof row.storeId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.storeId) ||
                typeof row.schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(row.schema))
                conflict("source recovery PostgreSQL anchor custody changed");
            return { uid: identity.uid, slug: identity.slug, assignmentEpoch: identity.assignmentEpoch,
                agentId: record.id, storeId: row.storeId, schema: row.schema };
        });
        if (required.some(agentId => !owned.some(store => store.agentId === agentId)))
            conflict("source recovery PostgreSQL roster is incomplete");
        stores.push(...owned);
    }
    if (new Set(stores.map(store => store.agentId)).size !== stores.length || new Set(stores.map(store => store.storeId)).size !== stores.length ||
        new Set(stores.map(store => store.schema)).size !== stores.length)
        conflict("source recovery PostgreSQL anchor ownership is ambiguous");
    return stores.sort((a, b) => a.agentId.localeCompare(b.agentId));
}
function failedExportMatches(row, operationId, identity, gatewayId) {
    const steps = Array.isArray(row.steps) ? row.steps : [];
    return [row.kind === "migrate-customer", row.status === "failed", row.cancellationRequestedAt === undefined,
        Number.isSafeInteger(row.startedAt), row.startedAt > 0, Number.isSafeInteger(row.completedAt), row.completedAt >= row.startedAt,
        row.input?.uid === identity.uid, row.input?.fromGatewayId === gatewayId,
        typeof row.input?.toGatewayId === "string", row.input?.toGatewayId !== gatewayId,
        row.cutoverCommittedAt === undefined, row.restoreAttempt === undefined,
        schema24Export(row, identity, gatewayId, steps) || supersededDetachExport(row, identity, gatewayId, steps) || postgresImportMaintenanceFailureMatches(row, operationId, identity, gatewayId)].every(Boolean);
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
async function assertNoSourceTransferTask(db, tx, gatewayId) {
    const tasks = await tx.get(db.collection('glmMigrationTransferTasks').where('status', 'in', ['pending', 'running']));
    if (tasks.docs.some(row => [row.data().sourceGatewayId, row.data().targetGatewayId].includes(gatewayId)))
        conflict('source recovery transfer task is active');
}
async function capturePostgresRecoveryEvidence(input) {
    const { db, tx, gatewayId, assignments, failedExports, failedDocuments } = input;
    const postgres = failedExports.some(row => postgresImportMaintenanceFailureMatches(failedDocuments.find(doc => doc.id === row.operationId).data(), row.operationId, assignments.find(identity => identity.uid === row.input.uid), gatewayId));
    if (!postgres)
        return {};
    await assertNoSourceTransferTask(db, tx, gatewayId);
    return { postgresAgentStores: await readPostgresSourceAgentStores(db, tx, assignments) };
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
    const fenced = [ownOperationId, predecessorId].some(owner => ownedSourceFence(root, owner, assignments));
    if (active.docs.some(row => row.id !== ownOperationId && (operationTouchesSource(row.data(), gatewayId) || sourceUids.has(row.data().input?.uid)) &&
        !(fenced && pristineOutbound(row.data(), gatewayId, sourceUids)))) {
        conflict("another source operation is active");
    }
    const users = await Promise.all(assignments.map(row => tx.get(db.doc(`users/${row.uid}`))));
    const managementFailures = assignments.map(identity => {
        const matched = failed.docs.filter(row => managementExportMatches(row.data(), row.id, identity, gatewayId))
            .sort((a, b) => b.data().completedAt - a.data().completedAt)[0];
        return matched ? { operationId: matched.id, receipt: matched.data() } : undefined;
    });
    if (root.desiredStatus === "draining" && managementFailures.every(row => row !== undefined)) {
        if (active.docs.some(row => row.id !== ownOperationId && (operationTouchesSource(row.data(), gatewayId) || sourceUids.has(row.data().input?.uid))))
            conflict("another source operation is active");
        await assertNoSourceTransferTask(db, tx, gatewayId);
        const failures = managementFailures;
        if (users.some((user, index) => !managementUserMatches(user.data() ?? {}, assignments[index], failures[index], gatewayId)))
            conflict("source recovery customer authority changed");
        const runtime = await tx.get(db.doc(`glmGateways/${gatewayId}`));
        let pod;
        try {
            pod = managementPodIdentity(runtime.data() ?? {}, assignments, fenced);
        }
        catch {
            return conflict("source management runtime custody is unavailable");
        }
        return { root: rootIdentity(root), assignments,
            failedExports: failures.map(({ operationId, receipt: row }) => ({ operationId, input: row.input, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: row.steps })),
            managementRecovery: { ...pod, failures, users: users.map((user, index) => ({ uid: assignments[index].uid,
                    migration: user.data().provisioning.openclaw.migration ?? null })) } };
    }
    if (users.some((user, index) => !userMatches(user.data() ?? {}, assignments[index], gatewayId)))
        conflict("source recovery customer authority changed");
    const failedExports = assignments.map(identity => {
        const matched = failed.docs.filter(row => failedExportMatches(row.data(), row.id, identity, gatewayId))
            .sort((a, b) => b.data().completedAt - a.data().completedAt)[0];
        if (!matched)
            return conflict(`source recovery lacks a rolled-back recoverable export for ${identity.slug}`);
        const row = matched.data();
        return { operationId: matched.id, input: row.input, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: row.steps };
    });
    const postgresEvidence = await capturePostgresRecoveryEvidence({ db, tx, gatewayId, assignments, failedExports, failedDocuments: failed.docs });
    return { root: rootIdentity(root), assignments, failedExports, ...postgresEvidence };
}
export function assertSharedSourceRecoveryUnchanged(current, captured) {
    if (!isDeepStrictEqual(current, { root: captured.root, assignments: captured.assignments, failedExports: captured.failedExports, ...(captured.managementRecovery ? { managementRecovery: captured.managementRecovery } : {}), ...(captured.postgresAgentStores ? { postgresAgentStores: captured.postgresAgentStores } : {}) })) {
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
function startedDoctorMatches(row, fence) {
    const doctor = fence.doctor ?? {}, proof = fence.installedImage ?? {}, target = fence.target ?? {}, gatewayImage = target.images?.gateway;
    return [doctor.error === undefined,
        Number.isSafeInteger(doctor.startedAt), doctor.startedAt > 0, typeof doctor.releaseKey === "string", Boolean(doctor.releaseKey),
        Number.isSafeInteger(fence.startedAt), fence.startedAt >= row.startedAt,
        Number.isSafeInteger(proof.verifiedAt), proof.verifiedAt >= fence.startedAt, proof.verifiedAt <= doctor.startedAt,
        doctor.startedAt <= row.completedAt, proof.podUid === target.podUid,
        typeof gatewayImage === "string" && /@sha256:[a-f0-9]{64}$/.test(gatewayImage),
        typeof proof.gatewayImageId === "string" && proof.gatewayImageId.endsWith(`@${String(gatewayImage).split("@")[1]}`)].every(Boolean);
}
function spentDoctorMatches(row, fence) {
    const doctor = fence.doctor ?? {};
    return Object.keys(doctor).length === 3 && doctor.completedAt === undefined && doctor.verifiedAgentIds === undefined && startedDoctorMatches(row, fence);
}
function completedPostgresDoctorMatches(row, fence, source) {
    const doctor = fence.doctor ?? {}, agentIds = source.postgresAgentStores?.map(store => store.agentId);
    return [Array.isArray(agentIds) && agentIds.length > 0, Object.keys(doctor).length === 5,
        Number.isSafeInteger(doctor.completedAt), doctor.completedAt >= doctor.startedAt, doctor.completedAt <= row.completedAt,
        typeof doctor.releaseKey === "string" && doctor.releaseKey.trim() === doctor.releaseKey && doctor.releaseKey.length <= 512,
        isDeepStrictEqual(doctor.verifiedAgentIds, agentIds), startedDoctorMatches(row, fence)].every(Boolean);
}
function predecessorDoctorMatches(row, fence, source) {
    if (row.error === "another source operation is active") {
        return Object.keys(fence.doctor ?? {}).length === 1 && row.input?.sourceRecovery?.supersede === undefined;
    }
    return row.error === "source repair is not ready; outcome remains fenced" &&
        (spentDoctorMatches(row, fence) || completedPostgresDoctorMatches(row, fence, source));
}
function predecessorFenceMatches(request) {
    const { operationId, source } = request, fence = request.fence ?? {}, input = request.input ?? {}, doctor = fence.doctor ?? {}, target = fence.target ?? {};
    return [ownedSourceFence({ ...source.root, runtimeRestartFence: fence }, operationId, source.assignments), fence.phase === "dispatched",
        typeof target.podUid === "string", Boolean(target.podUid), typeof target.podName === "string", Boolean(target.podName),
        predecessorDoctorMatches(request.row, fence, source), doctor.requestId === operationId,
        target.sourceSha === input.sourceSha, isDeepStrictEqual(target.images, input.images),
        isDeepStrictEqual(target.failedExportOperationIds, source.failedExports.map(r => r.operationId))].every(Boolean);
}
export function assertSharedSourceRecoveryPredecessor(request) {
    const { gatewayId, operationId, row, fence, source } = request, input = row.input?.sourceRecovery;
    if (!failedPredecessorMatches(row, gatewayId) || !predecessorFenceMatches({ fence, operationId, source, input, row })) {
        conflict("source recovery predecessor is unavailable");
    }
    assertSharedSourceRecoveryUnchanged({ root: source.root, assignments: source.assignments, failedExports: source.failedExports,
        ...(source.managementRecovery ? { managementRecovery: source.managementRecovery } : {}),
        ...(source.postgresAgentStores ? { postgresAgentStores: source.postgresAgentStores } : {}) }, input);
    const capturedInput = { ...row.input, sourceRecovery: { ...input } };
    delete capturedInput.sourceRecovery.supersede;
    return { operationId, input: capturedInput, inputFingerprint: operationAuditMutationFingerprint(row.input),
        startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, fence };
}
export async function readSharedSourceRecoverySupersession(db, tx, gatewayId, operationId) {
    const [root, prior, source] = await Promise.all([tx.get(db.doc(`gateways/${gatewayId}`)), tx.get(db.doc(`glmOperations/${operationId}`)),
        readSharedSourceRecoveryAuthority(db, tx, gatewayId, operationId)]);
    return { source, supersede: assertSharedSourceRecoveryPredecessor({ gatewayId, operationId,
            row: prior.data() ?? {}, fence: root.data()?.runtimeRestartFence, source }) };
}
