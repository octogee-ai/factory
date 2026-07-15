

import {
  advancePhase,
  nextMigrationStep,
  rollbackPlan,
  type MigrationPhase,
  type MigrationState,
  type MigrationStep,
} from "./fleet-migration.js";
import type { MigrationClient } from "./fleet-migration-client.js";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type {
  ConfigFreezeResponse,
  ConfigRestoreProofResponse,
} from "@octogee/shared/types/fleet-controller";

export interface ReportedStep {
  name: string;
  status: "running" | "done" | "failed" | "skipped";
  error?: string;
}

export interface CutoverAssignmentRevision {
  revisionId: string;
  release: number;
}

export interface MigrationRollFence {
  uid: string;
  gatewayId: string;
  rollOperationId: string;
  targetRevisionId: string;
  targetRelease: number;
  sourceRevisionId: string;
  sourceEpoch: number;
  configReady?: {
    observedRevisionId: string;
    acceptedCommit: string;
    configReadyAt: number;
    runtimeConfigHash: string;
  };
}

// The single cutover commit the runner drives. The implementation MUST write the
// mirror move (flipMirror) AND the assignment (revision) as ONE atomic Firestore
// operation — a crash leaves NEITHER, so there is never a half-state the rollback
// would have to reverse (GATEWAY-RELEASES-SPEC, PR5 review P0).
export interface CutoverCommit {
  uid: string;
  slug: string;
  toGatewayId: string;
  fromGatewayId: string;
  flipMirror: boolean;
  revision: CutoverAssignmentRevision | null;
  rollFence?: MigrationRollFence;
}

export interface MigrationRunnerDeps {
  client: MigrationClient;

  commitCutover: (commit: CutoverCommit) => Promise<void>;

  // Roster-state gate for revision-aware migrations (PR7). Written to
  // "quiescing" on the SOURCE assignment before the quiesce RPC — blocking the
  // source edge from serving this customer BEFORE the target ever does — and
  // restored to "serving" when a pre-cutover failure rolls the migration back.
  // Required whenever the input carries a fromRevision.
  setAssignmentState?: (input: {
    gatewayId: string;
    uid: string;
    state: "serving" | "quiescing" | "migrating";
  }) => Promise<void>;

  acceptConfigProof?: (input: {
    migrationId: string;
    slug: string;
    sourceRevisionId: string;
    targetRevisionId: string;
    checkpoint: Pick<ConfigFreezeResponse, "checkpointCommit" | "configHash">;
    proof: Pick<
      ConfigRestoreProofResponse,
      | "restoredCommit"
      | "acceptedCommit"
      | "configHash"
      | "configReady"
      | "observedRevisionId"
      | "restoreProvenAt"
      | "configReadyAt"
      | "runtimeConfigHash"
    >;
  }) => Promise<void>;

  log: (msg: string) => void;

  reportStep?: (step: ReportedStep) => Promise<void> | void;
}

export interface MigrationRunnerInput {
  migrationId: string;
  uid: string;
  slug: string;
  fromGatewayId: string;
  toGatewayId: string;
  // Transport targets for URL resolution (revision service names {gw}-r{n}).
  // Default to the bare gateway ids — legacy single-revision behavior. In a
  // same-gateway roll the tenant ids match but the transports differ, so source
  // and target resolve to distinct Service URLs (GATEWAY-RELEASES-SPEC).
  fromTransportId?: string;
  toTransportId?: string;
  // Assignment revisions written at cutover: forward cutover commits the target
  // revision; rollback restores the source revision. Absent = legacy migration
  // (no assignment write). The mirror flip is gated by crossGateway below —
  // false for a same-gateway revision drain, so only the assignment doc moves.
  toRevision?: CutoverAssignmentRevision | null;
  fromRevision?: CutoverAssignmentRevision | null;
  crossGateway?: boolean;
  restoreSnapshot: FleetBrokerUserSnapshot;
  includeActivationManifest?: boolean;
  configFence?: boolean;
  rollFence?: MigrationRollFence;
}

export interface ConfigCleanupObligation {
  migrationId: string;
  slug: string;
  sourceGatewayId: string;
  sourceTransportId: string;
  completeSourceUnmount: boolean;
  resume: {
    success: boolean;
    rolledBack: boolean;
    error?: string;
    configCheckpoint?: Pick<ConfigFreezeResponse, "checkpointCommit" | "configHash">;
    configProof?: Pick<
      ConfigRestoreProofResponse,
      | "restoredCommit"
      | "acceptedCommit"
      | "configHash"
      | "configReady"
      | "observedRevisionId"
      | "restoreProvenAt"
      | "configReadyAt"
      | "runtimeConfigHash"
    >;
  };
}

export interface MigrationRunnerResult {
  success: boolean;
  finalPhase: MigrationPhase;
  errorAt?: { phase: MigrationPhase; error: string };
  rolledBack: boolean;
  configCheckpoint?: Pick<ConfigFreezeResponse, "checkpointCommit" | "configHash">;
  configProof?: Pick<
    ConfigRestoreProofResponse,
    | "restoredCommit"
    | "acceptedCommit"
    | "configHash"
    | "configReady"
    | "observedRevisionId"
    | "restoreProvenAt"
    | "configReadyAt"
    | "runtimeConfigHash"
  >;
  configCleanup?: ConfigCleanupObligation;
}

async function releaseConfigFreeze(input: MigrationRunnerInput, deps: MigrationRunnerDeps): Promise<boolean> {
  await report(deps, { name: "unfreeze-config", status: "running" });
  try {
    const response = await deps.client.unfreezeConfig({
      migrationId: input.migrationId,
      gatewayId: input.fromGatewayId,
      transportId: input.fromTransportId ?? input.fromGatewayId,
      slug: input.slug,
    });
    if (response.unfrozen !== true) throw new Error("config unfreeze was not confirmed");
    await report(deps, { name: "unfreeze-config", status: "done" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await report(deps, { name: "unfreeze-config", status: "skipped", error: message });
    deps.log(`[migration-runner] config unfreeze failed migrationId=${input.migrationId}: ${message}`);
    return false;
  }
}

function pendingConfigCleanup(
  input: MigrationRunnerInput,
  completeSourceUnmount: boolean,
  resume: ConfigCleanupObligation["resume"],
): ConfigCleanupObligation {
  return {
    migrationId: input.migrationId,
    slug: input.slug,
    sourceGatewayId: input.fromGatewayId,
    sourceTransportId: input.fromTransportId ?? input.fromGatewayId,
    completeSourceUnmount,
    resume,
  };
}

function cleanupPendingError(reason?: string): string {
  return `config unfreeze cleanup pending${reason ? `: ${reason}` : ""}`;
}

async function executeStep(params: {
  step: MigrationStep;
  deps: MigrationRunnerDeps;
  migrationId: string;
  slug: string;
  restoreSnapshot: FleetBrokerUserSnapshot | null;
  includeActivationManifest: boolean | undefined;
  // Transport targets keyed by role. The step's gateway id is the bare TENANT id
  // (in-pod path); these resolve the revision Service URL.
  fromTransportId: string;
  toTransportId: string;
  // Cutover context: forward commits the target revision, rollback restores the
  // source. crossGateway gates the mirror flip (false = same-gateway drain).
  direction: "forward" | "rollback";
  crossGateway: boolean;
  cutoverRevision: CutoverAssignmentRevision | null;
  rollFence: MigrationRollFence | null;
}): Promise<void> {
  const {
    step,
    deps,
    migrationId,
    slug,
    restoreSnapshot,
    includeActivationManifest,
    fromTransportId,
    toTransportId,
    crossGateway,
    cutoverRevision,
    rollFence,
  } = params;
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

function reportName(step: MigrationStep): string {
  if (step.action === "sync-state") return `${step.mode}-sync-state`;
  if (step.action === "unmount-gateway") return `unmount-${step.role}`;
  return step.action;
}

function isPostCutoverSourceCleanup(
  state: MigrationState,
  step: MigrationStep,
): boolean {
  return (
    state.phase === "cutover-done" &&
    step.action === "unmount-gateway" &&
    step.role === "source"
  );
}

export async function runMigration(
  input: MigrationRunnerInput,
  deps: MigrationRunnerDeps,
): Promise<MigrationRunnerResult> {
  const fromTransportId = input.fromTransportId ?? input.fromGatewayId;
  const toTransportId = input.toTransportId ?? input.toGatewayId;
  const crossGateway = input.crossGateway ?? input.fromGatewayId !== input.toGatewayId;
  const toRevision = input.toRevision ?? null;
  const fromRevision = input.fromRevision ?? null;
  let quiescingMarked = false;
  let configFrozen = false;
  let configCheckpoint: MigrationRunnerResult["configCheckpoint"];
  let configProof: MigrationRunnerResult["configProof"];
  let cutoverRollFence = input.rollFence ?? null;
  let state: MigrationState = {
    phase: "initial",
    slug: input.slug,
    uid: input.uid,
    fromGatewayId: input.fromGatewayId,
    toGatewayId: input.toGatewayId,
  };

  if (input.configFence) {
    if (!input.fromRevision || !input.toRevision || !deps.acceptConfigProof) {
      return {
        success: false,
        finalPhase: "initial",
        errorAt: {
          phase: "initial",
          error: "config fence requires source/target revisions and revision status persistence",
        },
        rolledBack: false,
      };
    }
    await report(deps, { name: "freeze-config", status: "running" });
    try {
      const checkpoint = await deps.client.freezeConfig({
        migrationId: input.migrationId,
        gatewayId: input.fromGatewayId,
        transportId: fromTransportId,
        slug: input.slug,
      });
      configFrozen = true;
      configCheckpoint = {
        checkpointCommit: checkpoint.checkpointCommit,
        configHash: checkpoint.configHash,
      };
      await report(deps, { name: "freeze-config", status: "done" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await report(deps, { name: "freeze-config", status: "failed", error: message });
      const released = await releaseConfigFreeze(input, deps);
      return {
        success: false,
        finalPhase: "initial",
        errorAt: {
          phase: "initial",
          error: released ? message : cleanupPendingError(message),
        },
        rolledBack: false,
        ...(!released
          ? {
              configCleanup: pendingConfigCleanup(input, false, {
                success: false,
                rolledBack: false,
                error: message,
              }),
            }
          : {}),
      };
    }
  }

  while (true) {
    const step = nextMigrationStep(state);
    if (step.action === "complete") break;

    const phaseAtStart = state.phase;
    const name = reportName(step);
    let activeReportName = name;
    await report(deps, { name, status: "running" });
    try {
      // Gated quiesce (PR7): block the source edge from serving this customer
      // BEFORE the source pod is quiesced, so there is never a window where the
      // target serves while the source still accepts writes. Durable (roster
      // write), and reverted on any pre-cutover rollback below.
      if (step.action === "quiesce-source" && fromRevision) {
        if (!deps.setAssignmentState) {
          throw new Error(
            "revision drain requires deps.setAssignmentState (roster quiesce gate)",
          );
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
        rollFence: cutoverRollFence,
      });
      await report(deps, { name, status: "done" });
      if (step.action === "restore-target" && configCheckpoint) {
        activeReportName = "prove-config-restore";
        await report(deps, { name: activeReportName, status: "running" });
        const proof = await deps.client.proveConfigRestore({
          migrationId: input.migrationId,
          gatewayId: input.toGatewayId,
          transportId: toTransportId,
          slug: input.slug,
          checkpointCommit: configCheckpoint.checkpointCommit,
        });
        if (proof.restoredCommit !== configCheckpoint.checkpointCommit) {
          throw new Error(
            `target restored commit ${proof.restoredCommit} does not match source checkpoint ${configCheckpoint.checkpointCommit}`,
          );
        }
        if (
          proof.configReady !== true ||
          proof.observedRevisionId !== toTransportId ||
          !Number.isFinite(proof.restoreProvenAt) ||
          !Number.isFinite(proof.configReadyAt) ||
          proof.configReadyAt < proof.restoreProvenAt ||
          !proof.runtimeConfigHash
        ) {
          throw new Error("target config readiness is stale or belongs to another revision");
        }
        configProof = {
          restoredCommit: proof.restoredCommit,
          acceptedCommit: proof.acceptedCommit,
          configHash: proof.configHash,
          configReady: proof.configReady,
          observedRevisionId: proof.observedRevisionId,
          restoreProvenAt: proof.restoreProvenAt,
          configReadyAt: proof.configReadyAt,
          runtimeConfigHash: proof.runtimeConfigHash,
        };
        if (cutoverRollFence) {
          cutoverRollFence = {
            ...cutoverRollFence,
            configReady: {
              observedRevisionId: proof.observedRevisionId,
              acceptedCommit: proof.acceptedCommit,
              configReadyAt: proof.configReadyAt,
              runtimeConfigHash: proof.runtimeConfigHash,
            },
          };
        }
        if (!deps.acceptConfigProof) {
          throw new Error("revision status persistence unavailable");
        }
        await deps.acceptConfigProof({
          migrationId: input.migrationId,
          slug: input.slug,
          sourceRevisionId: input.fromRevision!.revisionId,
          targetRevisionId: input.toRevision!.revisionId,
          checkpoint: configCheckpoint,
          proof: configProof,
        });
        await report(deps, { name: activeReportName, status: "done" });
      }
      if (step.action === "cutover-firestore" && configFrozen && crossGateway) {
        const released = await releaseConfigFreeze(input, deps);
        if (!released) {
          const error = cleanupPendingError();
          return {
            success: false,
            finalPhase: "cutover-done",
            errorAt: { phase: "cutover-done", error },
            rolledBack: false,
            ...(configCheckpoint ? { configCheckpoint } : {}),
            ...(configProof ? { configProof } : {}),
            configCleanup: pendingConfigCleanup(input, true, {
              success: true,
              rolledBack: false,
              ...(configCheckpoint ? { configCheckpoint } : {}),
              ...(configProof ? { configProof } : {}),
            }),
          };
        }
        configFrozen = false;
      }
      deps.log(
        `[migration-runner] ${name} ok migrationId=${input.migrationId} slug=${input.slug} (phase ${phaseAtStart} → ${advancePhase(state.phase)})`,
      );
      state = { ...state, phase: advancePhase(state.phase) };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isPostCutoverSourceCleanup(state, step)) {
        await report(deps, { name, status: "skipped", error: errMsg });
        deps.log(
          `[migration-runner] ⚠ ${name} cleanup failed after durable cutover migrationId=${input.migrationId} slug=${input.slug}: ${errMsg} — target remains serving`,
        );
        state = { ...state, phase: advancePhase(state.phase) };
        continue;
      }
      await report(deps, { name: activeReportName, status: "failed", error: errMsg });
      deps.log(
        `[migration-runner] ❌ ${name} failed at phase=${phaseAtStart}: ${errMsg}`,
      );
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
      let released = true;
      if (configFrozen) {
        released = await releaseConfigFreeze(input, deps);
        if (released) configFrozen = false;
      }
      return {
        success: false,
        finalPhase: state.phase,
        errorAt: {
          phase: phaseAtStart,
          error: released ? errMsg : cleanupPendingError(errMsg),
        },
        rolledBack,
        ...(configCheckpoint ? { configCheckpoint } : {}),
        ...(configProof ? { configProof } : {}),
        ...(!released
          ? {
              configCleanup: pendingConfigCleanup(input, false, {
                success: false,
                rolledBack,
                error: errMsg,
                ...(configCheckpoint ? { configCheckpoint } : {}),
                ...(configProof ? { configProof } : {}),
              }),
            }
          : {}),
      };
    }
  }

  deps.log(
    `[migration-runner] ✅ migration complete migrationId=${input.migrationId} slug=${input.slug} ${input.fromGatewayId} → ${input.toGatewayId}`,
  );
  return {
    success: true,
    finalPhase: "done",
    rolledBack: false,
    ...(configCheckpoint ? { configCheckpoint } : {}),
    ...(configProof ? { configProof } : {}),
  };
}

async function tryRollback(
  state: MigrationState,
  deps: MigrationRunnerDeps,
  migrationId: string,
  transports: {
    fromTransportId: string;
    toTransportId: string;
    crossGateway: boolean;
    fromRevision: CutoverAssignmentRevision | null;
    restoreServing: { gatewayId: string; uid: string } | null;
  },
): Promise<boolean> {
  let plan: MigrationStep[];
  try {
    plan = rollbackPlan(state);
  } catch (planErr) {
    const msg = planErr instanceof Error ? planErr.message : String(planErr);
    deps.log(
      `[migration-runner] ⚠ cannot rollback from phase=${state.phase}: ${msg} — operator must intervene`,
    );
    return false;
  }
  if (plan.length === 0) {
    await restoreSourceServing(deps, transports.restoreServing);
    deps.log(
      `[migration-runner] no rollback needed at phase=${state.phase} (source still owns)`,
    );
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
    } catch (rbErr) {
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
async function restoreSourceServing(
  deps: MigrationRunnerDeps,
  target: { gatewayId: string; uid: string } | null,
): Promise<void> {
  if (!target || !deps.setAssignmentState) return;
  try {
    await deps.setAssignmentState({ ...target, state: "serving" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(
      `[migration-runner] ❌ FAILED to restore assignment serving for uid=${target.uid} on ${target.gatewayId}: ${msg} — ` +
        `the customer stays quiescing (edge answers 503) until the next roll retry or an operator repair`,
    );
  }
}

async function report(
  deps: MigrationRunnerDeps,
  step: ReportedStep,
): Promise<void> {
  if (!deps.reportStep) return;
  try {
    await deps.reportStep(step);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`[migration-runner] ⚠ reportStep threw — ignoring: ${msg}`);
  }
}
