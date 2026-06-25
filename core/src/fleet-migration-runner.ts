

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

export interface ReportedStep {
  name: string;
  status: "running" | "done" | "failed";
  error?: string;
}

export interface MigrationRunnerDeps {
  client: MigrationClient;
  
  cutoverFirestore: (uid: string, toGatewayId: string, slug: string) => Promise<void>;
  log: (msg: string) => void;

reportStep?: (step: ReportedStep) => Promise<void> | void;
}

export interface MigrationRunnerInput {
  migrationId: string;
  uid: string;
  slug: string;
  fromGatewayId: string;
  toGatewayId: string;
  restoreSnapshot: FleetBrokerUserSnapshot;
  includeActivationManifest?: boolean;
  /**
   * The source instance is being RETIRED (a blue/green roll), so it must never be
   * able to veto the migration. With this set, a SOURCE-side step that fails
   * (quiesce-source, sync-state, unmount-source) degrades — log + continue toward
   * cutover — instead of rolling back. The customer's durable baseline already
   * lives on the target via restore-target (substrate), and the source is
   * disposable cattle; live-state transfer from it is a best-effort optimization.
   * TARGET/commit steps (restore-target, verify-target, cutover-firestore) stay
   * strict — we never cut over to a target we couldn't set up. Cross-pool
   * migrations (source survives) leave this unset and keep the strict contract.
   */
  sourceDisposable?: boolean;
}

// A step that operates on / pulls from the SOURCE. On a disposable source these
// degrade instead of rolling back the roll. Target/commit steps are excluded.
function isBestEffortSourceStep(step: MigrationStep): boolean {
  switch (step.action) {
    case "quiesce-source":
    case "sync-state":
      return true;
    case "unmount-gateway":
      return step.role === "source";
    default:
      return false;
  }
}

export interface MigrationRunnerResult {
  success: boolean;
  finalPhase: MigrationPhase;
  errorAt?: { phase: MigrationPhase; error: string };
  rolledBack: boolean;
}

async function executeStep(params: {
  step: MigrationStep;
  deps: MigrationRunnerDeps;
  migrationId: string;
  slug: string;
  restoreSnapshot: FleetBrokerUserSnapshot | null;
  includeActivationManifest: boolean | undefined;
}): Promise<void> {
  const {
    step,
    deps,
    migrationId,
    slug,
    restoreSnapshot,
    includeActivationManifest,
  } = params;
  switch (step.action) {
    case "restore-target":
      if (!restoreSnapshot) {
        throw new Error("restore-target requires a durable snapshot");
      }
      await deps.client.restoreTarget({
        migrationId,
        gatewayId: step.gateway,
        uid: step.uid,
        slug: step.slug,
        snapshot: restoreSnapshot,
      });
      return;
    case "quiesce-source":
      await deps.client.quiesce({
        migrationId,
        gatewayId: step.gateway,
        slug: step.slug,
      });
      return;
    case "sync-state":
      await deps.client.transferState({
        migrationId,
        fromGatewayId: step.from,
        toGatewayId: step.to,
        slug: step.slug,
        mode: step.mode,
        includeActivationManifest,
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
      await deps.cutoverFirestore(step.uid, step.to, slug);
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

function reportName(step: MigrationStep): string {
  if (step.action === "sync-state") return `${step.mode}-sync-state`;
  if (step.action === "unmount-gateway") return `unmount-${step.role}`;
  return step.action;
}

export async function runMigration(
  input: MigrationRunnerInput,
  deps: MigrationRunnerDeps,
): Promise<MigrationRunnerResult> {
  let state: MigrationState = {
    phase: "initial",
    slug: input.slug,
    uid: input.uid,
    fromGatewayId: input.fromGatewayId,
    toGatewayId: input.toGatewayId,
  };

  while (true) {
    const step = nextMigrationStep(state);
    if (step.action === "complete") break;

    const phaseAtStart = state.phase;
    const name = reportName(step);
    await report(deps, { name, status: "running" });
    try {
      await executeStep({
        step,
        deps,
        migrationId: input.migrationId,
        slug: input.slug,
        restoreSnapshot: input.restoreSnapshot,
        includeActivationManifest: input.includeActivationManifest,
      });
      await report(deps, { name, status: "done" });
      deps.log(
        `[migration-runner] ${name} ok migrationId=${input.migrationId} slug=${input.slug} (phase ${phaseAtStart} → ${advancePhase(state.phase)})`,
      );
      state = { ...state, phase: advancePhase(state.phase) };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await report(deps, { name, status: "failed", error: errMsg });
      deps.log(
        `[migration-runner] ❌ ${name} failed at phase=${phaseAtStart}: ${errMsg}`,
      );
      if (input.sourceDisposable && isBestEffortSourceStep(step)) {
        deps.log(
          `[migration-runner] ⚠ ${name} is best-effort on a disposable source (blue/green roll) — ` +
            `degrading to the target's substrate baseline + continuing, NOT rolling back ` +
            `(migrationId=${input.migrationId} slug=${input.slug})`,
        );
        state = { ...state, phase: advancePhase(state.phase) };
        continue;
      }
      const rolledBack = await tryRollback(state, deps, input.migrationId);
      return {
        success: false,
        finalPhase: state.phase,
        errorAt: { phase: phaseAtStart, error: errMsg },
        rolledBack,
      };
    }
  }

  deps.log(
    `[migration-runner] ✅ migration complete migrationId=${input.migrationId} slug=${input.slug} ${input.fromGatewayId} → ${input.toGatewayId}`,
  );
  return { success: true, finalPhase: "done", rolledBack: false };
}

async function tryRollback(
  state: MigrationState,
  deps: MigrationRunnerDeps,
  migrationId: string,
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
      });
      await report(deps, { name: rbName, status: "done" });
      deps.log(`[migration-runner] rollback ${step.action} ok`);
    } catch (rbErr) {
      const msg = rbErr instanceof Error ? rbErr.message : String(rbErr);
      await report(deps, { name: rbName, status: "failed", error: msg });
      deps.log(`[migration-runner] ⚠ rollback warn: ${step.action} failed: ${msg}`);
    }
  }
  return true;
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
