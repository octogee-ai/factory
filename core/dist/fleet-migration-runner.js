import { advancePhase, nextMigrationStep, rollbackPlan, } from "./fleet-migration.js";
async function executeStep(params) {
    const { step, deps, migrationId, slug, projectCheckoutScope, includeActivationManifest, crossGateway, } = params;
    switch (step.action) {
        case "quiesce-source":
            await deps.client.quiesce({
                migrationId,
                gatewayId: step.gateway,
                slug: step.slug,
            });
            return;
        case "flush-source":
            await deps.client.flushGateway({
                migrationId,
                gatewayId: step.gateway,
                slug: step.slug,
                reason: "migration-final",
            });
            return;
        case "sync-state":
            await deps.client.transferState({
                migrationId,
                fromGatewayId: step.from,
                toGatewayId: step.to,
                slug: step.slug,
                mode: step.mode,
                includeActivationManifest: step.mode === "final" && includeActivationManifest,
                projectCheckoutScope,
            });
            return;
        case "verify-target":
            await deps.client.verifyTarget({
                migrationId,
                gatewayId: step.gateway,
                slug: step.slug,
            });
            return;
        case "cutover-firestore":
            // ONE atomic commit — the mirror move (when the bare gateway changed)
            // before unmount-source. If it throws, nothing lands, so the rollback
            // from target-verified has no half-state to reverse.
            await deps.commitCutover({
                uid: step.uid,
                slug,
                toGatewayId: step.to,
                fromGatewayId: step.from,
                flipMirror: crossGateway,
            });
            return;
        case "unmount-gateway":
            await deps.client.unmount({
                migrationId,
                gatewayId: step.gateway,
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
    const execution = createMigrationExecution(input, deps);
    while (true) {
        const result = await runNextMigrationStep(execution);
        if (result)
            return result;
    }
}
function createMigrationExecution(input, deps) {
    return {
        input,
        deps,
        crossGateway: input.crossGateway ?? input.fromGatewayId !== input.toGatewayId,
        quiescingMarked: false,
        state: {
            phase: "initial",
            slug: input.slug,
            uid: input.uid,
            fromGatewayId: input.fromGatewayId,
            toGatewayId: input.toGatewayId,
        },
    };
}
async function markSourceQuiescing(execution, step) {
    if (step.action !== "quiesce-source" || execution.input.gateAssignment !== true)
        return;
    const { input, deps } = execution;
    if (!deps.setAssignmentState) {
        throw new Error("assignment-gated migration requires deps.setAssignmentState");
    }
    await deps.setAssignmentState({
        gatewayId: input.fromGatewayId,
        uid: input.uid,
        state: "quiescing",
    });
    execution.quiescingMarked = true;
}
function executeForwardStep(execution, step) {
    const { input, deps } = execution;
    return executeStep({
        step,
        deps,
        migrationId: input.migrationId,
        slug: input.slug,
        projectCheckoutScope: input.projectCheckoutScope,
        includeActivationManifest: input.includeActivationManifest,
        crossGateway: execution.crossGateway,
    });
}
function migrationComplete(execution) {
    const { input, deps } = execution;
    deps.log(`[migration-runner] ✅ migration complete migrationId=${input.migrationId} slug=${input.slug} ${input.fromGatewayId} → ${input.toGatewayId}`);
    return {
        success: true,
        finalPhase: "done",
        rolledBack: false,
    };
}
async function runNextMigrationStep(execution) {
    const step = nextMigrationStep(execution.state);
    if (step.action === "complete")
        return migrationComplete(execution);
    const phaseAtStart = execution.state.phase;
    const name = reportName(step);
    await report(execution.deps, { name, status: "running" });
    try {
        await markSourceQuiescing(execution, step);
        await executeForwardStep(execution, step);
        await report(execution.deps, { name, status: "done" });
        advanceExecution(execution, name, phaseAtStart);
        return null;
    }
    catch (error) {
        return handleStepFailure(execution, { step, name, phaseAtStart, error });
    }
}
function advanceExecution(execution, name, phaseAtStart) {
    const nextPhase = advancePhase(execution.state.phase);
    execution.deps.log(`[migration-runner] ${name} ok migrationId=${execution.input.migrationId} slug=${execution.input.slug} (phase ${phaseAtStart} → ${nextPhase})`);
    execution.state = { ...execution.state, phase: nextPhase };
}
async function handleStepFailure(execution, failure) {
    const { step, name, phaseAtStart, error } = failure;
    const { input, deps } = execution;
    const message = error instanceof Error ? error.message : String(error);
    if (isPostCutoverSourceCleanup(execution.state, step)) {
        await report(deps, { name, status: "skipped", error: message });
        deps.log(`[migration-runner] ⚠ ${name} cleanup failed after durable cutover migrationId=${input.migrationId} slug=${input.slug}: ${message} — target remains serving`);
        execution.state = { ...execution.state, phase: advancePhase(execution.state.phase) };
        return null;
    }
    await report(deps, { name, status: "failed", error: message });
    deps.log(`[migration-runner] ❌ ${name} failed at phase=${phaseAtStart}: ${message}`);
    const rolledBack = await rollbackExecution(execution);
    return {
        success: false,
        finalPhase: execution.state.phase,
        errorAt: { phase: phaseAtStart, error: message },
        rolledBack,
    };
}
function rollbackServingTarget(execution) {
    if (!execution.quiescingMarked)
        return null;
    return { gatewayId: execution.input.fromGatewayId, uid: execution.input.uid };
}
function rollbackExecution(execution) {
    const { input, deps } = execution;
    return tryRollback(execution.state, deps, input.migrationId, {
        crossGateway: execution.crossGateway,
        restoreServing: rollbackServingTarget(execution),
    });
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
                projectCheckoutScope: undefined,
                includeActivationManifest: undefined,
                // Rollback's cutover-firestore restores the SOURCE: flip the mirror
                // back when the migration crossed gateways.
                crossGateway: transports.crossGateway,
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
    if (state.phase !== "keys-synced") {
        await deps.client.resume({ migrationId, gatewayId: state.fromGatewayId, slug: state.slug });
    }
    return true;
}
// Revert the pre-quiesce "quiescing" roster mark so the customer keeps serving
// on the source after a pre-cutover rollback. Failure here is LOUD (the edge
// keeps 503ing the customer until a retry re-drives the migration or the
// operator repairs the assignment).
async function restoreSourceServing(deps, target) {
    if (!target || !deps.setAssignmentState)
        return;
    try {
        await deps.setAssignmentState({ ...target, state: "serving" });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(`[migration-runner] ❌ FAILED to restore assignment serving for uid=${target.uid} on ${target.gatewayId}: ${msg} — ` +
            `the customer stays quiescing (edge answers 503) until the next retry or an operator repair`);
        throw err;
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
