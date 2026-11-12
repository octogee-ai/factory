import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import { isPermanentSchedulerRefusal } from "./fleet-migration-runner.js";
const HELD = /Cron agent (\S+) is held for migration ([A-Za-z0-9][A-Za-z0-9_.:-]*)/;
const NOT_RETAINED = /on the target was not retained by a retired migration/;
const RELEASE = /^mig-(.+):release:[a-z0-9][a-z0-9_-]*$/;
const SCHEDULER_HOLD = /^mig-(.+):scheduler:\d+:claim:\d+$/;
const TERMINAL = ["succeeded", "failed", "rolled-back"];
export function heldSchedulerMigration(error) {
    const match = HELD.exec(error);
    return match ? { agentId: match[1], migrationId: match[2] } : null;
}
export function schedulerReleaseId(operationId, agentId) {
    return `mig-${operationId}:release:${agentId}`;
}
export async function releaseSchedulerCustody(deps, scope, agentIds) {
    const outcomes = [];
    for (const agentId of [...new Set(agentIds)].sort())
        outcomes.push(await releaseAgent(deps, scope, agentId));
    return outcomes;
}
async function releaseAgent(deps, scope, agentId) {
    let holder = null;
    let migrationId = schedulerReleaseId(scope.operationId, agentId);
    for (;;) {
        await deps.assertOwner();
        const refusal = await stageThenActivate(deps, scope, migrationId, agentId);
        if (refusal === null) {
            deps.log(`[scheduler-custody] ${scope.slug}: released the scheduler custody of ${agentId} on ${scope.gatewayId}${heldBy(holder)} with ${migrationId} op=${scope.operationId}`);
            return { agentId, outcome: "released", holder };
        }
        if (NOT_RETAINED.test(refusal.text))
            return { agentId, outcome: "clear" };
        const held = heldSchedulerMigration(refusal.text);
        if (held === null || held.agentId !== agentId || holder !== null)
            return failed(agentId, holder, refusal);
        holder = held.migrationId;
        const verdict = await classify(deps, scope, holder);
        if (verdict.act === "keep") {
            deps.log(`[scheduler-custody] ⚠ ${scope.slug}: kept the scheduler fence of ${agentId} on ${scope.gatewayId} held by ${holder}: ` +
                `${verdict.reason} op=${scope.operationId}`);
            return { agentId, outcome: "kept", holder, reason: verdict.reason };
        }
        if (verdict.act === "complete") {
            migrationId = holder;
            continue;
        }
        const retiring = holder;
        await deps.assertOwner();
        const retireRefusal = await attempt(() => deps.scheduler({ gatewayId: scope.gatewayId, slug: scope.slug, migrationId: retiring, phase: "retire" }));
        if (retireRefusal !== null)
            return failed(agentId, retiring, retireRefusal);
    }
}
async function attempt(work) {
    try {
        await work();
        return null;
    }
    catch (error) {
        return { error, text: errorText(error) };
    }
}
function failed(agentId, holder, refusal) {
    return { agentId, outcome: "failed", holder, error: refusal.text, transient: !isPermanentSchedulerRefusal(refusal.error) };
}
function heldBy(holder) {
    return holder === null ? "" : ` held by ${holder}`;
}
async function stageThenActivate(deps, scope, migrationId, agentId) {
    const target = { gatewayId: scope.gatewayId, slug: scope.slug, migrationId };
    const snapshot = { version: 1, operationId: migrationId, agentIds: [agentId], jobs: [], scratch: [] };
    const stageRefusal = await attempt(() => deps.scheduler({ ...target, phase: "stage", agentIds: [agentId], snapshot, retainNonportable: true }));
    if (stageRefusal !== null)
        return stageRefusal;
    try {
        await deps.assertOwner();
    }
    catch (error) {
        deps.log(`[scheduler-custody] ❌ ${scope.slug}: stopped before activating ${migrationId} on ${scope.gatewayId}: ${errorText(error)} op=${scope.operationId}`);
        throw error;
    }
    return attempt(() => deps.scheduler({ ...target, phase: "activate" }));
}
async function classify(deps, scope, holder) {
    const releasing = RELEASE.exec(holder)?.[1];
    if (releasing !== undefined)
        return classifyRelease(deps, scope, releasing);
    const operationId = SCHEDULER_HOLD.exec(holder)?.[1];
    if (operationId === undefined || readSchedulerMigrationIdentity(operationId, holder) === null) {
        return { act: "keep", reason: `${holder} names no operation` };
    }
    if (operationId === scope.operationId)
        return { act: "keep", reason: `${holder} belongs to ${operationId} itself` };
    const owner = await deps.readOperation(operationId);
    if (owner === null)
        return { act: "keep", reason: `${holder} is not retired and ${operationId} has left the journal` };
    return classifyHoldOwner(scope, operationId, owner);
}
async function classifyRelease(deps, scope, releasing) {
    if (releasing === scope.operationId)
        return { act: "complete" };
    const owner = await deps.readOperation(releasing);
    return owner !== null && !TERMINAL.includes(owner.status)
        ? { act: "keep", reason: `${releasing} is still ${owner.status}` }
        : { act: "complete" };
}
function classifyHoldOwner(scope, operationId, owner) {
    if (!TERMINAL.includes(owner.status))
        return { act: "keep", reason: `${operationId} is still ${owner.status}` };
    const movedOff = owner.kind === "migrate-customer" && owner.input?.uid === scope.uid &&
        owner.input.fromGatewayId === scope.gatewayId && typeof owner.cutoverCommittedAt === "number";
    if (!movedOff)
        return { act: "keep", reason: `${operationId} ${owner.status} without moving the user off ${scope.gatewayId}` };
    if (typeof owner.completedAt !== "number" || owner.completedAt > scope.ownedSince) {
        return {
            act: "keep",
            reason: `${operationId} ${owner.status} at ${owner.completedAt ?? "an unrecorded time"}, after ${scope.gatewayId} took the user back at ${scope.ownedSince}`,
        };
    }
    return { act: "retire" };
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
