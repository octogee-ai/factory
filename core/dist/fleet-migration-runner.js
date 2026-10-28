import { withLogContext } from "@octogee/shared/server/service-logger";
import { advancePhase, nextMigrationStep, rollbackPlan, } from "./fleet-migration.js";
import { MigrationDrainPendingError, MigrationRpcError } from "./fleet-migration-client.js";
const QUIESCE_SOURCE = "quiesce-source";
const WAIT_FOR_ACTIVE_WORK = "wait-for-active-work";
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 2_000;
const TARGET_SCHEDULER_READY_TIMEOUT_MS = 120_000;
const RELEASED_TARGET_SCHEDULER_READY_TIMEOUT_MS = 300_000;
const TARGET_SCHEDULER_READY_POLL_MS = 5_000;
const TARGET_SCHEDULER_NOT_READY = /workspace identities are not initialized for this boot/;
export function isTargetSchedulerNotReady(error) {
    return TARGET_SCHEDULER_NOT_READY.test(error instanceof Error ? error.message : String(error));
}
async function handOffSchedules(params) {
    const { deps, slug } = params;
    const clock = deps.now ?? Date.now;
    const exportStartedAt = clock();
    const schedules = await deps.client.scheduler({ migrationId: params.schedulerMigrationId, slug, gatewayId: params.from, phase: "export" });
    const schedulerExportMs = clock() - exportStartedAt;
    if (params.stageSchedulesAfterCutover) {
        params.targetScheduler.exported = schedules;
        return { schedulerExportMs };
    }
    const stageStartedAt = clock();
    params.targetScheduler.mayHoldStage = true;
    try {
        await callTargetScheduler(deps, {
            migrationId: params.schedulerMigrationId, slug, gatewayId: params.to, phase: "stage",
            agentIds: schedules.agentIds, snapshot: schedules.snapshot,
            ...(params.acceptRetainedTargetJobs ? { retainNonportable: true } : {}),
        });
    }
    catch (error) {
        if (error instanceof TargetSchedulerNotReadyError)
            params.targetScheduler.mayHoldStage = false;
        throw error;
    }
    return { schedulerExportMs, schedulerStageMs: clock() - stageStartedAt };
}
async function convergeTargetSystemConfig(input) {
    const { deps } = input;
    const expectedSystemConfigCommit = input.systemConfig.convergeTarget === "source-commit"
        ? input.systemConfig.sourceCommit
        : await deps.readTargetSystemConfigCommit?.(input.targetGatewayId);
    if (!expectedSystemConfigCommit) {
        const holder = input.systemConfig.convergeTarget === "source-commit" ? "source" : `target ${input.targetGatewayId}`;
        throw new Error(`${holder} has no accepted system config commit to converge ${input.slug} on`);
    }
    const converge = await deps.client.flushGateway({
        migrationId: input.migrationId,
        gatewayId: input.targetGatewayId,
        slug: input.slug,
        reason: "migration-converge",
        expectedSystemConfigCommit,
    });
    if (!converge.ok) {
        throw new Error(`target ${input.targetGatewayId} did not converge system config for ${input.slug}`);
    }
}
async function convergeTargetAfterFinalCopy(input) {
    if (input.step.mode !== "final" || !input.systemConfig.convergeTarget)
        return;
    await convergeTargetSystemConfig({
        deps: input.deps,
        migrationId: input.migrationId,
        slug: input.step.slug,
        targetGatewayId: input.step.to,
        systemConfig: input.systemConfig,
    });
}
async function executeStep(params) {
    const { step, deps, migrationId, slug, projectCheckoutScope, includeActivationManifest, crossGateway, } = params;
    const clock = deps.now ?? Date.now;
    switch (step.action) {
        case QUIESCE_SOURCE:
            await deps.client.quiesce({
                migrationId,
                gatewayId: step.gateway,
                slug: step.slug,
                schedulerHandoff: crossGateway,
                schedulerMigrationId: params.schedulerMigrationId,
            });
            return;
        case "flush-source": {
            const flush = await deps.client.flushGateway({
                migrationId,
                gatewayId: step.gateway,
                slug: step.slug,
                reason: "migration-final",
            });
            params.systemConfig.sourceCommit = flush.systemConfigCommit;
            return;
        }
        case "sync-state": {
            const timings = crossGateway && step.mode === "final"
                ? await handOffSchedules({ ...params, from: step.from, to: step.to })
                : {};
            const transferStartedAt = clock();
            await deps.client.transferState({
                migrationId,
                fromGatewayId: step.from,
                toGatewayId: step.to,
                slug: step.slug,
                mode: step.mode,
                includeActivationManifest: step.mode !== "keys" && includeActivationManifest,
                projectCheckoutScope,
            });
            timings.transferMs = clock() - transferStartedAt;
            await convergeTargetAfterFinalCopy({ deps, migrationId, step, systemConfig: params.systemConfig });
            return timings;
        }
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
            if (crossGateway && step.role === "source") {
                await finalizeSchedulerHandoff({ ...params, sourceGatewayId: step.gateway });
            }
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
class SchedulerHandoffPendingError extends Error {
}
class TargetSchedulerNotReadyError extends Error {
    retryable = true;
}
export function callReleasedTargetScheduler(deps, request) {
    return callTargetScheduler(deps, request, { waitForReady: true, timeoutMs: RELEASED_TARGET_SCHEDULER_READY_TIMEOUT_MS });
}
function callTargetScheduler(deps, request, options = { waitForReady: true }) {
    return untilTargetSchedulerReady(deps, request.gatewayId, request.phase, async () => {
        await deps.client.scheduler(request);
    }, options);
}
async function untilTargetSchedulerReady(deps, gatewayId, purpose, call, options = { waitForReady: true }) {
    const clock = deps.now ?? Date.now;
    const wait = deps.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    const timeoutMs = options.timeoutMs ?? TARGET_SCHEDULER_READY_TIMEOUT_MS;
    const deadline = clock() + timeoutMs;
    while (true) {
        try {
            await call();
            return;
        }
        catch (error) {
            if (!isTargetSchedulerNotReady(error))
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            if (!options.waitForReady || clock() >= deadline) {
                throw new TargetSchedulerNotReadyError(`target gateway ${gatewayId} scheduler did not become ready within ${timeoutMs}ms: ${message}`);
            }
            deps.log(`[migration-runner] ⏳ target gateway ${gatewayId} scheduler not ready for ${purpose}; retrying: ${message}`);
            await wait(TARGET_SCHEDULER_READY_POLL_MS);
        }
    }
}
async function stageOnReleasedTarget(params) {
    const { deps, targetScheduler } = params;
    if (!targetScheduler.exported)
        throw new Error(`no exported scheduler snapshot for ${params.schedulerMigrationId}`);
    if (!deps.recordSchedulesStaged)
        throw new Error("a post-cutover scheduler stage requires deps.recordSchedulesStaged");
    await callReleasedTargetScheduler(deps, {
        migrationId: params.schedulerMigrationId, slug: params.slug, gatewayId: params.targetGatewayId, phase: "stage",
        agentIds: targetScheduler.exported.agentIds, snapshot: targetScheduler.exported.snapshot,
        ...(params.acceptRetainedTargetJobs ? { retainNonportable: true } : {}),
    });
    await deps.recordSchedulesStaged();
}
async function finalizeSchedulerHandoff(params) {
    const { deps: { client }, schedulerMigrationId: migrationId, slug } = params;
    try {
        if (params.stageSchedulesAfterCutover)
            await stageOnReleasedTarget(params);
        await client.scheduler({ migrationId, slug, gatewayId: params.sourceGatewayId, phase: "retire" });
        await client.scheduler({ migrationId, slug, gatewayId: params.targetGatewayId, phase: "activate" });
    }
    catch (error) {
        throw new SchedulerHandoffPendingError(`scheduler handoff cleanup pending: ${error instanceof Error ? error.message : String(error)}`);
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
    return withLogContext({ builderSlug: input.slug, operationId: input.migrationId, category: "migration", sourceGateway: input.fromGatewayId, targetGateway: input.toGatewayId }, async () => {
        const execution = createMigrationExecution(input, deps);
        while (true) {
            const result = await runNextMigrationStep(execution);
            if (result)
                return result;
        }
    });
}
function createMigrationExecution(input, deps) {
    if (input.stageSchedulesAfterCutover && !deps.recordSchedulesStaged) {
        throw new Error("stageSchedulesAfterCutover requires deps.recordSchedulesStaged");
    }
    return {
        input,
        deps,
        crossGateway: input.crossGateway ?? input.fromGatewayId !== input.toGatewayId,
        forwardOnly: input.resumeForwardRecovery !== undefined,
        quiescingMarked: input.resumeForwardRecovery !== undefined,
        quiesceStarted: input.resumeForwardRecovery !== undefined,
        preDrainStarted: false,
        targetScheduler: { mayHoldStage: false },
        systemConfig: { convergeTarget: input.convergeTargetSystemConfig, sourceCommit: input.resumeForwardRecovery?.sourceSystemConfigCommit },
        state: {
            phase: input.resumeForwardRecovery ? "source-flushed" : "initial",
            slug: input.slug,
            uid: input.uid,
            fromGatewayId: input.fromGatewayId,
            toGatewayId: input.toGatewayId,
        },
    };
}
async function markSourceQuiescing(execution, step) {
    if (step.action !== QUIESCE_SOURCE || execution.input.gateAssignment !== true)
        return;
    const { input, deps } = execution;
    if (!deps.setAssignmentState) {
        throw new Error("assignment-gated migration requires deps.setAssignmentState");
    }
    await deps.setMigrationPhase?.("transferring");
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
        targetGatewayId: input.toGatewayId,
        schedulerMigrationId: schedulerMigrationId(input),
        acceptRetainedTargetJobs: input.acceptRetainedTargetJobs === true,
        stageSchedulesAfterCutover: input.stageSchedulesAfterCutover === true,
        targetScheduler: execution.targetScheduler,
        systemConfig: execution.systemConfig,
    });
}
function schedulerMigrationId(input) {
    return input.schedulerMigrationId ?? input.migrationId;
}
const TARGET_SCHEDULER_READY_STEP = "target-scheduler-ready";
async function awaitTargetSchedulerReady(execution) {
    const { input, deps } = execution;
    await report(deps, { name: TARGET_SCHEDULER_READY_STEP, status: "running" });
    try {
        await untilTargetSchedulerReady(deps, input.toGatewayId, "readiness", () => deps.client.schedulerReady({ migrationId: input.migrationId, gatewayId: input.toGatewayId, slug: input.slug }));
    }
    catch (error) {
        if (!(error instanceof MigrationRpcError && error.status === 404))
            throw error;
        deps.log(`[migration-runner] target gateway ${input.toGatewayId} predates the scheduler readiness endpoint; migrating without the readiness gate`);
        await report(deps, { name: TARGET_SCHEDULER_READY_STEP, status: "skipped", error: error.message });
        return;
    }
    await report(deps, { name: TARGET_SCHEDULER_READY_STEP, status: "done" });
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
    if (step.action === QUIESCE_SOURCE && execution.crossGateway && !execution.input.stageSchedulesAfterCutover) {
        try {
            await awaitTargetSchedulerReady(execution);
        }
        catch (error) {
            return handleStepFailure(execution, { step, name: TARGET_SCHEDULER_READY_STEP, phaseAtStart, error });
        }
    }
    const name = reportName(step);
    if (step.action === QUIESCE_SOURCE) {
        const deferred = await awaitActiveWorkDrained(execution, step, phaseAtStart);
        if (deferred)
            return deferred;
    }
    await report(execution.deps, { name, status: "running" });
    try {
        if (step.action === "sync-state" && step.mode === "keys")
            await execution.deps.setMigrationPhase?.("preparing");
        if (step.action === "verify-target")
            await execution.deps.setMigrationPhase?.("connecting");
        await markSourceQuiescing(execution, step);
        if (step.action === QUIESCE_SOURCE)
            execution.quiesceStarted = true;
        await persistFinalTransferFence(execution, step);
        const timings = await executeForwardStep(execution, step);
        await report(execution.deps, { name, status: "done" });
        advanceExecution(execution, name, phaseAtStart, timings);
        return null;
    }
    catch (error) {
        return handleStepFailure(execution, { step, name, phaseAtStart, error });
    }
}
async function persistFinalTransferFence(execution, step) {
    if (step.action !== "sync-state" || step.mode !== "final" || !execution.deps.persistForwardRecovery)
        return;
    execution.forwardOnly = true;
    await execution.deps.persistForwardRecovery({
        ...(execution.systemConfig.sourceCommit ? { sourceSystemConfigCommit: execution.systemConfig.sourceCommit } : {}),
    });
}
async function awaitActiveWorkDrained(execution, step, phaseAtStart) {
    await report(execution.deps, { name: WAIT_FOR_ACTIVE_WORK, status: "running" });
    try {
        await execution.deps.setMigrationPhase?.("waiting");
        execution.preDrainStarted = true;
        await execution.deps.client.quiesce({ migrationId: execution.input.migrationId, gatewayId: step.gateway, slug: step.slug, timeoutMs: 30_000, stopMattermost: false });
    }
    catch (error) {
        return handleStepFailure(execution, { step, name: WAIT_FOR_ACTIVE_WORK, phaseAtStart, error });
    }
    await report(execution.deps, { name: WAIT_FOR_ACTIVE_WORK, status: "done" });
    return null;
}
function formatTimings(timings) {
    if (!timings)
        return "";
    return Object.entries(timings).map(([key, value]) => ` ${key}=${value}`).join("");
}
function advanceExecution(execution, name, phaseAtStart, timings) {
    const nextPhase = advancePhase(execution.state.phase);
    execution.deps.log(`[migration-runner] ${name} ok migrationId=${execution.input.migrationId} slug=${execution.input.slug} (phase ${phaseAtStart} → ${nextPhase})${formatTimings(timings)}`);
    execution.state = { ...execution.state, phase: nextPhase };
}
async function handleStepFailure(execution, failure) {
    const { step, name, phaseAtStart, error } = failure;
    const { input, deps } = execution;
    const message = error instanceof Error ? error.message : String(error);
    if (step.action === QUIESCE_SOURCE && error instanceof MigrationDrainPendingError) {
        if (execution.crossGateway && execution.quiesceStarted)
            await deps.client.scheduler({ migrationId: schedulerMigrationId(input), gatewayId: input.fromGatewayId, slug: input.slug, phase: "resume" });
        await deps.client.resume({ migrationId: input.migrationId, gatewayId: input.fromGatewayId, slug: input.slug });
        if (execution.quiescingMarked)
            await deps.setAssignmentState({ gatewayId: input.fromGatewayId, uid: input.uid, state: "serving" });
        await deps.setMigrationPhase?.("waiting");
        await report(deps, { name, status: "skipped", error: message });
        return { success: false, finalPhase: execution.state.phase, rolledBack: false, waitingForBuilderIdle: true };
    }
    if (isPostCutoverSourceCleanup(execution.state, step) && error instanceof SchedulerHandoffPendingError) {
        await report(deps, { name, status: "failed", error: message });
        return { success: false, finalPhase: execution.state.phase, errorAt: { phase: phaseAtStart, error: message }, rolledBack: false };
    }
    if (isPostCutoverSourceCleanup(execution.state, step)) {
        await report(deps, { name, status: "skipped", error: message });
        deps.log(`[migration-runner] ⚠ ${name} cleanup failed after durable cutover migrationId=${input.migrationId} slug=${input.slug}: ${message} — target remains serving`);
        execution.state = { ...execution.state, phase: advancePhase(execution.state.phase) };
        return null;
    }
    if (execution.forwardOnly) {
        await report(deps, { name, status: "failed", error: message });
        deps.log(`[migration-runner] forward recovery pending migrationId=${input.migrationId}: ${message}`);
        return { success: false, finalPhase: execution.state.phase, rolledBack: false,
            errorAt: { phase: phaseAtStart, error: `migration forward recovery pending: status 503: ${message}` } };
    }
    await resumeUnquiescedPreDrain(execution);
    await report(deps, { name, status: "failed", error: message });
    deps.log(`[migration-runner] ❌ ${name} failed at phase=${phaseAtStart}: ${message}`);
    const rollback = await rollbackExecution(execution);
    if (rollback.error) {
        deps.log(`[migration-runner] ❌ rollback incomplete migrationId=${input.migrationId} slug=${input.slug}: ${rollback.error}`);
    }
    return {
        success: false,
        finalPhase: execution.state.phase,
        errorAt: {
            phase: phaseAtStart,
            error: rollback.error ? `${message} — ${rollback.error}` : message,
        },
        rolledBack: rollback.rolledBack,
    };
}
async function resumeUnquiescedPreDrain(execution) {
    if (!execution.preDrainStarted || execution.quiesceStarted)
        return;
    const { input, deps } = execution;
    await deps.client.resume({ migrationId: input.migrationId, gatewayId: input.fromGatewayId, slug: input.slug });
}
function rollbackServingTarget(execution) {
    if (!execution.quiescingMarked)
        return null;
    return { gatewayId: execution.input.fromGatewayId, uid: execution.input.uid };
}
function rollbackExecution(execution) {
    const { input, deps } = execution;
    return tryRollback(execution.state, deps, input.migrationId, {
        schedulerMigrationId: schedulerMigrationId(input),
        crossGateway: execution.crossGateway,
        stageSchedulesAfterCutover: execution.input.stageSchedulesAfterCutover === true,
        restoreServing: rollbackServingTarget(execution),
        quiesceStarted: execution.quiesceStarted,
        targetScheduler: execution.targetScheduler,
    });
}
async function confirmRelease(deps, name, release) {
    const wait = deps.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    await report(deps, { name, status: "running" });
    let lastError = "";
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
        try {
            await release();
            await report(deps, { name, status: "done" });
            return null;
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            deps.log(`[migration-runner] ⚠ ${name} attempt ${attempt}/${RELEASE_ATTEMPTS} failed: ${lastError}`);
            if (attempt < RELEASE_ATTEMPTS)
                await wait(RELEASE_RETRY_DELAY_MS);
        }
    }
    await report(deps, { name, status: "failed", error: lastError });
    return lastError;
}
async function releaseSource(state, deps, migrationId, transports) {
    const unreleased = [];
    if (transports.crossGateway) {
        const error = await confirmRelease(deps, "rollback:scheduler-resume", () => deps.client.scheduler({ migrationId: transports.schedulerMigrationId, gatewayId: state.fromGatewayId, slug: state.slug, phase: "resume" }));
        if (error)
            unreleased.push(`scheduler fence ${transports.schedulerMigrationId} on ${state.fromGatewayId} not released: ${error}`);
    }
    const error = await confirmRelease(deps, "rollback:resume-ingress", () => deps.client.resume({ migrationId, gatewayId: state.fromGatewayId, slug: state.slug }));
    if (error)
        unreleased.push(`source ingress on ${state.fromGatewayId} not resumed: ${error}`);
    return unreleased;
}
async function abortTargetScheduler(state, deps, transports) {
    if (!transports.crossGateway || transports.stageSchedulesAfterCutover)
        return null;
    const name = "rollback:scheduler-abort";
    await report(deps, { name, status: "running" });
    const mayHoldStage = transports.targetScheduler.mayHoldStage;
    try {
        await callTargetScheduler(deps, { migrationId: transports.schedulerMigrationId, gatewayId: state.toGatewayId, slug: state.slug, phase: "abort" }, { waitForReady: mayHoldStage });
        await report(deps, { name, status: "done" });
        return null;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TargetSchedulerNotReadyError && !mayHoldStage) {
            await report(deps, { name, status: "skipped", error: message });
            deps.log(`[migration-runner] target ${state.toGatewayId} never received a stage for ${transports.schedulerMigrationId}; nothing to abort`);
            return null;
        }
        await report(deps, { name, status: "failed", error: message });
        return `target scheduler abort unconfirmed on ${state.toGatewayId}, source left closed: ${message}`;
    }
}
async function tryRollback(state, deps, migrationId, transports) {
    let plan;
    try {
        plan = rollbackPlan(state);
    }
    catch (planErr) {
        const msg = planErr instanceof Error ? planErr.message : String(planErr);
        deps.log(`[migration-runner] ⚠ cannot rollback from phase=${state.phase}: ${msg} — operator must intervene`);
        return { rolledBack: false };
    }
    if (plan.length === 0) {
        await restoreSourceServing(deps, transports.restoreServing);
        deps.log(`[migration-runner] no rollback needed at phase=${state.phase} (source still owns)`);
        return { rolledBack: false };
    }
    const abortUnconfirmed = transports.quiesceStarted ? await abortTargetScheduler(state, deps, transports) : null;
    if (abortUnconfirmed)
        return { rolledBack: false, error: abortUnconfirmed };
    const failures = [];
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
                targetGatewayId: state.toGatewayId,
                schedulerMigrationId: transports.schedulerMigrationId,
                acceptRetainedTargetJobs: false,
                stageSchedulesAfterCutover: false,
                targetScheduler: transports.targetScheduler,
                systemConfig: {},
            });
            await report(deps, { name: rbName, status: "done" });
            deps.log(`[migration-runner] rollback ${step.action} ok`);
        }
        catch (rbErr) {
            const msg = rbErr instanceof Error ? rbErr.message : String(rbErr);
            failures.push(`${rbName}: ${msg}`);
            await report(deps, { name: rbName, status: "failed", error: msg });
            deps.log(`[migration-runner] ⚠ rollback warn: ${step.action} failed: ${msg}`);
        }
    }
    if (failures.length > 0)
        return { rolledBack: false, error: failures.join("; ") };
    if (transports.quiesceStarted) {
        const unreleased = await releaseSource(state, deps, migrationId, transports);
        if (unreleased.length > 0)
            return { rolledBack: false, error: [...failures, ...unreleased].join("; ") };
    }
    await restoreSourceServing(deps, transports.restoreServing);
    return {
        rolledBack: failures.length === 0 || !state.fromGatewayId.startsWith("shared-"),
        ...(failures.length > 0 ? { error: failures.join("; ") } : {}),
    };
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
