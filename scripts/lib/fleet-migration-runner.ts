/**
 * Migration runner — executes the four-step state machine end to end.
 *
 * Drives `nextMigrationStep` from `fleet-migration.ts` until `done`,
 * dispatching each step to the migration HTTP client (or Firestore for
 * cutover). On any forward-step failure, builds the rollback plan for
 * the current phase and dispatches it best-effort. Rollback step
 * failures are logged as warnings — the operator's runbook situation
 * to investigate, not a thrown error from this runner.
 *
 * Caller pattern:
 *
 *   const result = await runMigration(
 *     { migrationId, uid, slug, fromGatewayId, toGatewayId },
 *     { client, cutoverFirestore, log },
 *   );
 *   if (!result.success) { … investigate result.errorAt … }
 */

import {
  advancePhase,
  nextMigrationStep,
  rollbackPlan,
  type MigrationPhase,
  type MigrationState,
  type MigrationStep,
} from "./fleet-migration.js";
import type { MigrationClient } from "./fleet-migration-client.js";

export interface MigrationRunnerDeps {
  client: MigrationClient;
  /** Writes `users/{uid}.provisioning.openclaw.gatewayId = toGatewayId`. */
  cutoverFirestore: (uid: string, toGatewayId: string) => Promise<void>;
  log: (msg: string) => void;
}

export interface MigrationRunnerInput {
  migrationId: string;
  uid: string;
  slug: string;
  fromGatewayId: string;
  toGatewayId: string;
}

export interface MigrationRunnerResult {
  success: boolean;
  finalPhase: MigrationPhase;
  errorAt?: { phase: MigrationPhase; error: string };
  rolledBack: boolean;
}

async function executeStep(
  step: MigrationStep,
  deps: MigrationRunnerDeps,
  migrationId: string,
): Promise<void> {
  switch (step.action) {
    case "quiesce-source":
      await deps.client.quiesce({
        migrationId,
        gatewayId: step.gateway,
        slug: step.slug,
      });
      return;
    case "transfer-state":
      await deps.client.transferState({
        migrationId,
        fromGatewayId: step.from,
        toGatewayId: step.to,
        slug: step.slug,
      });
      return;
    case "cutover-firestore":
      await deps.cutoverFirestore(step.uid, step.to);
      return;
    case "unmount-source":
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
    try {
      await executeStep(step, deps, input.migrationId);
      deps.log(
        `[migration-runner] ${step.action} ok migrationId=${input.migrationId} slug=${input.slug} (phase ${phaseAtStart} → ${advancePhase(state.phase)})`,
      );
      state = { ...state, phase: advancePhase(state.phase) };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.log(
        `[migration-runner] ❌ ${step.action} failed at phase=${phaseAtStart}: ${errMsg}`,
      );
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
    try {
      await executeStep(step, deps, migrationId);
      deps.log(`[migration-runner] rollback ${step.action} ok`);
    } catch (rbErr) {
      const msg = rbErr instanceof Error ? rbErr.message : String(rbErr);
      deps.log(`[migration-runner] ⚠ rollback warn: ${step.action} failed: ${msg}`);
      // Continue with the rest of the rollback plan — best effort.
    }
  }
  return true;
}
