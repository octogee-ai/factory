import { advancePhase, nextMigrationStep, rollbackPlan, } from "./fleet-migration.js";
import { isDefinitiveConfigRpcRejection, isDefinitiveFreezeRejection, isFreezeOwnerConflict, MigrationRpcError, } from "./fleet-migration-client.js";
async function releaseConfigFreeze(input, deps) {
    await report(deps, { name: "unfreeze-config", status: "running" });
    try {
        const response = await deps.client.unfreezeConfig({
            migrationId: input.migrationId,
            gatewayId: input.fromGatewayId,
            transportId: input.fromTransportId ?? input.fromGatewayId,
            slug: input.slug,
        });
        if (!response.unfrozen) {
            throw new Error("config unfreeze was not confirmed");
        }
        await report(deps, { name: "unfreeze-config", status: "done" });
        return { kind: "released" };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await report(deps, { name: "unfreeze-config", status: "skipped", error: message });
        return isDefinitiveConfigRpcRejection(error)
            ? { kind: "definitive-rejection", error: message }
            : { kind: "ambiguous", error: message };
    }
}
function pendingConfigCleanup(input, completeSourceUnmount, resume) {
    return {
        migrationId: input.migrationId,
        slug: input.slug,
        sourceGatewayId: input.fromGatewayId,
        sourceTransportId: input.fromTransportId ?? input.fromGatewayId,
        completeSourceUnmount,
        resume,
    };
}
function cleanupPendingError(reason) {
    if (!reason)
        return "config unfreeze cleanup pending";
    return `config unfreeze cleanup pending: ${reason}`;
}
async function executeStep(params) {
    const { step, deps, migrationId, slug, restoreSnapshot, includeActivationManifest, fromTransportId, toTransportId, crossGateway, cutoverRevision, rollFence, } = params;
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
                ...(rollFence ? { rollFence } : {}),
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
    const execution = createMigrationExecution(input, deps);
    const preparationFailure = await prepareSystemConfig(execution);
    if (preparationFailure)
        return preparationFailure;
    while (true) {
        const result = await runNextMigrationStep(execution);
        if (result)
            return result;
    }
}
function createMigrationExecution(input, deps) {
    const preAcquiredConfigCheckpoint = input.preAcquiredConfigCheckpoint;
    return {
        input,
        deps,
        fromTransportId: input.fromTransportId ?? input.fromGatewayId,
        toTransportId: input.toTransportId ?? input.toGatewayId,
        crossGateway: input.crossGateway ?? input.fromGatewayId !== input.toGatewayId,
        toRevision: input.toRevision ?? null,
        fromRevision: input.fromRevision ?? null,
        systemConfigMigrationMode: input.systemConfigMigrationMode ?? "none",
        preAcquiredConfigCheckpoint,
        quiescingMarked: false,
        configFrozen: false,
        configCheckpoint: undefined,
        configProof: undefined,
        cutoverRollFence: input.rollFence
            ? {
                ...input.rollFence,
                ...(preAcquiredConfigCheckpoint
                    ? { sourceConfigCheckpoint: preAcquiredConfigCheckpoint }
                    : {}),
            }
            : null,
        state: {
            phase: "initial",
            slug: input.slug,
            uid: input.uid,
            fromGatewayId: input.fromGatewayId,
            toGatewayId: input.toGatewayId,
        },
    };
}
function initialFailure(error) {
    return {
        success: false,
        finalPhase: "initial",
        errorAt: { phase: "initial", error },
        rolledBack: false,
    };
}
function configPreparationError(execution) {
    const { input, deps, systemConfigMigrationMode, preAcquiredConfigCheckpoint } = execution;
    if (systemConfigMigrationMode === "checkpoint-and-restore") {
        const restoreReady = [
            input.fromRevision,
            input.toRevision,
            deps.acceptConfigProof,
            typeof input.toTransportId === "string" && input.toTransportId.length > 0,
        ].every(Boolean);
        if (!restoreReady) {
            return "checkpoint-and-restore requires source/target revisions, target transport identity, and revision status persistence";
        }
    }
    if (preAcquiredConfigCheckpoint &&
        (systemConfigMigrationMode !== "checkpoint-and-restore" || !input.rollFence)) {
        return "pre-acquired config checkpoint requires a checkpoint-and-restore release roll";
    }
    return null;
}
async function prepareSystemConfig(execution) {
    if (execution.systemConfigMigrationMode === "none")
        return null;
    const validationError = configPreparationError(execution);
    if (validationError)
        return initialFailure(validationError);
    const checkpoint = execution.preAcquiredConfigCheckpoint;
    if (checkpoint) {
        execution.configCheckpoint = {
            checkpointCommit: checkpoint.checkpointCommit,
            configHash: checkpoint.configHash,
        };
        return null;
    }
    return freezeSystemConfig(execution);
}
async function requestConfigCheckpoint(execution) {
    const { input, deps, fromTransportId } = execution;
    const request = () => deps.client.freezeConfig({
        migrationId: input.migrationId,
        gatewayId: input.fromGatewayId,
        transportId: fromTransportId,
        slug: input.slug,
    });
    try {
        return await request();
    }
    catch (error) {
        if (!isFreezeOwnerConflict(error) || !deps.recoverConfigFreezeOwner)
            throw error;
        const recovered = await recoverConfigFreezeOwner(execution, error);
        if (!recovered)
            throw error;
        return request();
    }
}
async function recoverConfigFreezeOwner(execution, error) {
    const { input, deps, fromTransportId, toTransportId } = execution;
    try {
        return await deps.recoverConfigFreezeOwner({
            ownerMigrationId: error.ownerMigrationId,
            requestedMigrationId: input.migrationId,
            uid: input.uid,
            slug: input.slug,
            sourceGatewayId: input.fromGatewayId,
            sourceTransportId: fromTransportId,
            targetGatewayId: input.toGatewayId,
            targetTransportId: toTransportId,
            ...(input.rollFence ? { rollOperationId: input.rollFence.rollOperationId } : {}),
        });
    }
    catch (recoveryError) {
        const detail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new MigrationRpcError(`config freeze owner recovery rejected: ${detail}`, {
            status: 409,
            code: error.code,
            ownerMigrationId: error.ownerMigrationId,
            slug: error.slug,
        });
    }
}
async function freezeSystemConfig(execution) {
    const { deps } = execution;
    await report(deps, { name: "freeze-config", status: "running" });
    try {
        const checkpoint = await requestConfigCheckpoint(execution);
        execution.configFrozen = true;
        execution.configCheckpoint = {
            checkpointCommit: checkpoint.checkpointCommit,
            configHash: checkpoint.configHash,
        };
        await report(deps, { name: "freeze-config", status: "done" });
        return null;
    }
    catch (error) {
        return freezeFailure(execution, error);
    }
}
async function freezeFailure(execution, error) {
    const { input, deps } = execution;
    const message = error instanceof Error ? error.message : String(error);
    await report(deps, { name: "freeze-config", status: "failed", error: message });
    if (isDefinitiveFreezeRejection(error))
        return initialFailure(message);
    const release = await releaseConfigFreeze(input, deps);
    if (release.kind !== "ambiguous")
        return initialFailure(message);
    return {
        ...initialFailure(cleanupPendingError(message)),
        configCleanup: pendingConfigCleanup(input, false, {
            success: false,
            rolledBack: false,
            error: message,
        }),
    };
}
async function markSourceQuiescing(execution, step) {
    if (step.action !== "quiesce-source" || !execution.fromRevision)
        return;
    const { input, deps } = execution;
    if (!deps.setAssignmentState) {
        throw new Error("revision drain requires deps.setAssignmentState (roster quiesce gate)");
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
        restoreSnapshot: input.restoreSnapshot,
        includeActivationManifest: input.includeActivationManifest,
        fromTransportId: execution.fromTransportId,
        toTransportId: execution.toTransportId,
        direction: "forward",
        crossGateway: execution.crossGateway,
        cutoverRevision: execution.toRevision,
        rollFence: execution.cutoverRollFence,
    });
}
function shouldProveRestore(execution, step) {
    return step.action === "restore-target" &&
        execution.configCheckpoint !== undefined &&
        execution.systemConfigMigrationMode === "checkpoint-and-restore";
}
function assertRestoreProofCurrent(execution, proof) {
    const checkpoint = execution.configCheckpoint;
    if (proof.restoredCommit !== checkpoint.checkpointCommit) {
        throw new Error(`target restored commit ${proof.restoredCommit} does not match source checkpoint ${checkpoint.checkpointCommit}`);
    }
    const current = [
        proof.configReady === true,
        proof.observedRevisionId === execution.toTransportId,
        Number.isFinite(proof.restoreProvenAt),
        Number.isFinite(proof.configReadyAt),
        proof.configReadyAt >= proof.restoreProvenAt,
        proof.runtimeConfigHash,
    ].every(Boolean);
    if (!current)
        throw new Error("target config readiness is stale or belongs to another revision");
}
async function proveConfigRestore(execution) {
    const { input, deps, preAcquiredConfigCheckpoint } = execution;
    const reportName = "prove-config-restore";
    await report(deps, { name: reportName, status: "running" });
    const migrationId = preAcquiredConfigCheckpoint?.migrationId ?? input.migrationId;
    const proof = await deps.client.proveConfigRestore({
        migrationId,
        gatewayId: input.toGatewayId,
        transportId: execution.toTransportId,
        slug: input.slug,
        checkpointCommit: execution.configCheckpoint.checkpointCommit,
    });
    assertRestoreProofCurrent(execution, proof);
    execution.configProof = {
        restoredCommit: proof.restoredCommit,
        acceptedCommit: proof.acceptedCommit,
        configHash: proof.configHash,
        configReady: proof.configReady,
        observedRevisionId: proof.observedRevisionId,
        restoreProvenAt: proof.restoreProvenAt,
        configReadyAt: proof.configReadyAt,
        runtimeConfigHash: proof.runtimeConfigHash,
    };
    updateCutoverConfigProof(execution, proof);
    if (!deps.acceptConfigProof)
        throw new Error("revision status persistence unavailable");
    await deps.acceptConfigProof({
        migrationId,
        slug: input.slug,
        sourceRevisionId: input.fromRevision.revisionId,
        targetRevisionId: input.toRevision.revisionId,
        checkpoint: execution.configCheckpoint,
        proof: execution.configProof,
    });
    await report(deps, { name: reportName, status: "done" });
}
function updateCutoverConfigProof(execution, proof) {
    if (!execution.cutoverRollFence)
        return;
    execution.cutoverRollFence = {
        ...execution.cutoverRollFence,
        configReady: {
            observedRevisionId: proof.observedRevisionId,
            acceptedCommit: proof.acceptedCommit,
            configReadyAt: proof.configReadyAt,
            runtimeConfigHash: proof.runtimeConfigHash,
        },
    };
}
function shouldReleaseAfterCutover(execution, step) {
    return step.action === "cutover-firestore" &&
        execution.configFrozen &&
        (execution.crossGateway || execution.systemConfigMigrationMode === "checkpoint-only");
}
async function releaseAfterCutover(execution, step) {
    if (!shouldReleaseAfterCutover(execution, step))
        return null;
    const release = await releaseConfigFreeze(execution.input, execution.deps);
    if (release.kind === "released") {
        execution.configFrozen = false;
        return null;
    }
    const error = release.kind === "definitive-rejection"
        ? `config cleanup terminal: ${release.error}`
        : cleanupPendingError();
    return {
        success: false,
        finalPhase: "cutover-done",
        errorAt: { phase: "cutover-done", error },
        rolledBack: false,
        ...(execution.configCheckpoint ? { configCheckpoint: execution.configCheckpoint } : {}),
        ...(execution.configProof ? { configProof: execution.configProof } : {}),
        configCleanup: pendingConfigCleanup(execution.input, true, {
            success: true,
            rolledBack: false,
            ...(execution.configCheckpoint ? { configCheckpoint: execution.configCheckpoint } : {}),
            ...(execution.configProof ? { configProof: execution.configProof } : {}),
        }),
    };
}
function migrationComplete(execution) {
    const { input, deps } = execution;
    deps.log(`[migration-runner] ✅ migration complete migrationId=${input.migrationId} slug=${input.slug} ${input.fromGatewayId} → ${input.toGatewayId}`);
    return {
        success: true,
        finalPhase: "done",
        rolledBack: false,
        ...(execution.configCheckpoint ? { configCheckpoint: execution.configCheckpoint } : {}),
        ...(execution.configProof ? { configProof: execution.configProof } : {}),
    };
}
async function runNextMigrationStep(execution) {
    const step = nextMigrationStep(execution.state);
    if (step.action === "complete")
        return migrationComplete(execution);
    const phaseAtStart = execution.state.phase;
    const name = reportName(step);
    let activeReportName = name;
    await report(execution.deps, { name, status: "running" });
    try {
        await markSourceQuiescing(execution, step);
        await executeForwardStep(execution, step);
        await report(execution.deps, { name, status: "done" });
        if (shouldProveRestore(execution, step)) {
            activeReportName = "prove-config-restore";
            await proveConfigRestore(execution);
        }
        const releaseFailure = await releaseAfterCutover(execution, step);
        if (releaseFailure)
            return releaseFailure;
        advanceExecution(execution, name, phaseAtStart);
        return null;
    }
    catch (error) {
        return handleStepFailure(execution, {
            step,
            name,
            activeReportName,
            phaseAtStart,
            error,
        });
    }
}
function advanceExecution(execution, name, phaseAtStart) {
    const nextPhase = advancePhase(execution.state.phase);
    execution.deps.log(`[migration-runner] ${name} ok migrationId=${execution.input.migrationId} slug=${execution.input.slug} (phase ${phaseAtStart} → ${nextPhase})`);
    execution.state = { ...execution.state, phase: nextPhase };
}
function releaseFailureMessage(release, original) {
    if (release.kind === "ambiguous")
        return cleanupPendingError(original);
    if (release.kind === "definitive-rejection")
        return `config cleanup terminal: ${release.error}`;
    return original;
}
async function releaseAfterFailure(execution) {
    if (!execution.configFrozen)
        return { kind: "released" };
    const release = await releaseConfigFreeze(execution.input, execution.deps);
    if (release.kind === "released")
        execution.configFrozen = false;
    return release;
}
async function handleStepFailure(execution, failure) {
    const { step, name, activeReportName, phaseAtStart, error } = failure;
    const { input, deps } = execution;
    const message = error instanceof Error ? error.message : String(error);
    if (isPostCutoverSourceCleanup(execution.state, step)) {
        await report(deps, { name, status: "skipped", error: message });
        deps.log(`[migration-runner] ⚠ ${name} cleanup failed after durable cutover migrationId=${input.migrationId} slug=${input.slug}: ${message} — target remains serving`);
        execution.state = { ...execution.state, phase: advancePhase(execution.state.phase) };
        return null;
    }
    await report(deps, { name: activeReportName, status: "failed", error: message });
    deps.log(`[migration-runner] ❌ ${name} failed at phase=${phaseAtStart}: ${message}`);
    const rolledBack = await rollbackExecution(execution);
    const release = await releaseAfterFailure(execution);
    return failedMigrationResult(execution, phaseAtStart, message, rolledBack, release);
}
function rollbackServingTarget(execution) {
    if (!execution.quiescingMarked)
        return null;
    return { gatewayId: execution.input.fromGatewayId, uid: execution.input.uid };
}
function rollbackExecution(execution) {
    const { input, deps } = execution;
    return tryRollback(execution.state, deps, input.migrationId, {
        fromTransportId: execution.fromTransportId,
        toTransportId: execution.toTransportId,
        crossGateway: execution.crossGateway,
        fromRevision: execution.fromRevision,
        restoreServing: rollbackServingTarget(execution),
    });
}
function failedMigrationResult(execution, phaseAtStart, message, rolledBack, release) {
    const cleanupRequired = release.kind !== "released";
    return {
        success: false,
        finalPhase: execution.state.phase,
        errorAt: { phase: phaseAtStart, error: releaseFailureMessage(release, message) },
        rolledBack,
        ...(execution.configCheckpoint ? { configCheckpoint: execution.configCheckpoint } : {}),
        ...(execution.configProof ? { configProof: execution.configProof } : {}),
        ...(cleanupRequired
            ? {
                configCleanup: pendingConfigCleanup(execution.input, false, {
                    success: false,
                    rolledBack,
                    error: message,
                    ...(execution.configCheckpoint
                        ? { configCheckpoint: execution.configCheckpoint }
                        : {}),
                    ...(execution.configProof ? { configProof: execution.configProof } : {}),
                }),
            }
            : {}),
    };
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
                rollFence: null,
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
