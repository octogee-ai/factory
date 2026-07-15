import { advancePhase, nextMigrationStep, rollbackPlan, } from "./fleet-migration.js";
async function executeStep(params) {
    const { step, deps, migrationId, slug, restoreSnapshot, includeActivationManifest, fromTransportId, toTransportId, crossGateway, cutoverRevision, } = params;
    switch (step.action) {
        case "restore-target":
            if (!restoreSnapshot) {
                throw new Error("restore-target requires a durable snapshot");
            }
            await deps.client.restoreTarget({
                migrationId,
                gatewayId: step.gateway,
                transportId: toTransportId,
                uid: step.uid,
                slug: step.slug,
                snapshot: restoreSnapshot,
            });
            return;
        case "quiesce-source":
            await deps.client.quiesce({
                migrationId,
                gatewayId: step.gateway,
                transportId: fromTransportId,
                slug: step.slug,
            });
            return;
        case "sync-state":
            await deps.client.transferState({
                migrationId,
                fromGatewayId: step.from,
                toGatewayId: step.to,
                fromTransportId,
                toTransportId,
                slug: step.slug,
                mode: step.mode,
                includeActivationManifest,
            });
            return;
        case "verify-target":
            await deps.client.verifyTarget({
                migrationId,
                gatewayId: step.gateway,
                transportId: toTransportId,
                slug: step.slug,
            });
            return;
        case "cutover-firestore":
            // ONE atomic commit — mirror move (when the bare gateway changed) AND the
            // assignment revision, before unmount-source. If it throws, neither lands,
            // so the rollback from target-verified has no half-state to reverse.
            await deps.commitCutover({
                uid: step.uid,
                slug,
                toGatewayId: step.to,
                fromGatewayId: step.from,
                flipMirror: crossGateway,
                revision: cutoverRevision,
            });
            return;
        case "unmount-gateway":
            await deps.client.unmount({
                migrationId,
                gatewayId: step.gateway,
                transportId: step.role === "source" ? fromTransportId : toTransportId,
                slug: step.slug,
            });
            return;
        case "complete":
            return;
    }
}
function reportName(step) {
    if (step.action === "sync-state")
        return `${step.mode}-sync-state`;
    if (step.action === "unmount-gateway")
        return `unmount-${step.role}`;
    return step.action;
}
function isPostCutoverSourceCleanup(state, step) {
    return (state.phase === "cutover-done" &&
        step.action === "unmount-gateway" &&
        step.role === "source");
}
export async function runMigration(input, deps) {
    const fromTransportId = input.fromTransportId ?? input.fromGatewayId;
    const toTransportId = input.toTransportId ?? input.toGatewayId;
    const crossGateway = input.crossGateway ?? input.fromGatewayId !== input.toGatewayId;
    const toRevision = input.toRevision ?? null;
    const fromRevision = input.fromRevision ?? null;
    let quiescingMarked = false;
    let state = {
        phase: "initial",
        slug: input.slug,
        uid: input.uid,
        fromGatewayId: input.fromGatewayId,
        toGatewayId: input.toGatewayId,
    };
    while (true) {
        const step = nextMigrationStep(state);
        if (step.action === "complete")
            break;
        const phaseAtStart = state.phase;
        const name = reportName(step);
        await report(deps, { name, status: "running" });
        try {
            // Gated quiesce (PR7): block the source edge from serving this customer
            // BEFORE the source pod is quiesced, so there is never a window where the
            // target serves while the source still accepts writes. Durable (roster
            // write), and reverted on any pre-cutover rollback below.
            if (step.action === "quiesce-source" && fromRevision) {
                if (!deps.setAssignmentState) {
                    throw new Error("revision drain requires deps.setAssignmentState (roster quiesce gate)");
                }
                await deps.setAssignmentState({
                    gatewayId: input.fromGatewayId,
                    uid: input.uid,
                    state: "quiescing",
                });
                quiescingMarked = true;
            }
            await executeStep({
                step,
                deps,
                migrationId: input.migrationId,
                slug: input.slug,
                restoreSnapshot: input.restoreSnapshot,
                includeActivationManifest: input.includeActivationManifest,
                fromTransportId,
                toTransportId,
                direction: "forward",
                crossGateway,
                cutoverRevision: toRevision,
            });
            await report(deps, { name, status: "done" });
            deps.log(`[migration-runner] ${name} ok migrationId=${input.migrationId} slug=${input.slug} (phase ${phaseAtStart} → ${advancePhase(state.phase)})`);
            state = { ...state, phase: advancePhase(state.phase) };
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (isPostCutoverSourceCleanup(state, step)) {
                await report(deps, { name, status: "skipped", error: errMsg });
                deps.log(`[migration-runner] ⚠ ${name} cleanup failed after durable cutover migrationId=${input.migrationId} slug=${input.slug}: ${errMsg} — target remains serving`);
                state = { ...state, phase: advancePhase(state.phase) };
                continue;
            }
            await report(deps, { name, status: "failed", error: errMsg });
            deps.log(`[migration-runner] ❌ ${name} failed at phase=${phaseAtStart}: ${errMsg}`);
            const rolledBack = await tryRollback(state, deps, input.migrationId, {
                fromTransportId,
                toTransportId,
                crossGateway,
                fromRevision,
                // A pre-cutover rollback must un-block the source: restore its roster
                // entry to serving. (Post-cutover failures never reach this rollback —
                // the source-cleanup skip path above completes the migration instead.)
                restoreServing: quiescingMarked
                    ? { gatewayId: input.fromGatewayId, uid: input.uid }
                    : null,
            });
            return {
                success: false,
                finalPhase: state.phase,
                errorAt: { phase: phaseAtStart, error: errMsg },
                rolledBack,
            };
        }
    }
    deps.log(`[migration-runner] ✅ migration complete migrationId=${input.migrationId} slug=${input.slug} ${input.fromGatewayId} → ${input.toGatewayId}`);
    return { success: true, finalPhase: "done", rolledBack: false };
}
async function tryRollback(state, deps, migrationId, transports) {
    let plan;
    try {
        plan = rollbackPlan(state);
    }
    catch (planErr) {
        const msg = planErr instanceof Error ? planErr.message : String(planErr);
        deps.log(`[migration-runner] ⚠ cannot rollback from phase=${state.phase}: ${msg} — operator must intervene`);
        return false;
    }
    if (plan.length === 0) {
        await restoreSourceServing(deps, transports.restoreServing);
        deps.log(`[migration-runner] no rollback needed at phase=${state.phase} (source still owns)`);
        return false;
    }
    for (const step of plan) {
        const rbName = `rollback:${reportName(step)}`;
        await report(deps, { name: rbName, status: "running" });
        try {
            await executeStep({
                step,
                deps,
                migrationId,
                slug: state.slug,
                restoreSnapshot: null,
                includeActivationManifest: undefined,
                fromTransportId: transports.fromTransportId,
                toTransportId: transports.toTransportId,
                // Rollback's cutover-firestore restores the SOURCE: flip the mirror back
                // (when cross-gateway) and restore the assignment to the source revision.
                direction: "rollback",
                crossGateway: transports.crossGateway,
                cutoverRevision: transports.fromRevision,
            });
            await report(deps, { name: rbName, status: "done" });
            deps.log(`[migration-runner] rollback ${step.action} ok`);
        }
        catch (rbErr) {
            const msg = rbErr instanceof Error ? rbErr.message : String(rbErr);
            await report(deps, { name: rbName, status: "failed", error: msg });
            deps.log(`[migration-runner] ⚠ rollback warn: ${step.action} failed: ${msg}`);
        }
    }
    await restoreSourceServing(deps, transports.restoreServing);
    return true;
}
// Revert the pre-quiesce "quiescing" roster mark so the customer keeps serving
// on the source after a pre-cutover rollback. Failure here is LOUD (the edge
// keeps 503ing the customer until the roll's level-triggered retry re-drives
// the migration or the operator repairs the assignment).
async function restoreSourceServing(deps, target) {
    if (!target || !deps.setAssignmentState)
        return;
    try {
        await deps.setAssignmentState({ ...target, state: "serving" });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(`[migration-runner] ❌ FAILED to restore assignment serving for uid=${target.uid} on ${target.gatewayId}: ${msg} — ` +
            `the customer stays quiescing (edge answers 503) until the next roll retry or an operator repair`);
    }
}
async function report(deps, step) {
    if (!deps.reportStep)
        return;
    try {
        await deps.reportStep(step);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(`[migration-runner] ⚠ reportStep threw — ignoring: ${msg}`);
    }
}
