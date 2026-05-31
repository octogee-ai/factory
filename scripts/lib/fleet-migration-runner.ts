

import {
  advancePhase,
  nextMigrationStep,
  rollbackPlan,
  type MigrationPhase,
  type MigrationState,
  type MigrationStep,
} from "./fleet-migration.js";
import type { MigrationClient } from "./fleet-migration-client.js";

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
  includeActivationManifest?: boolean;
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
  slug: string,
  includeActivationManifest: boolean | undefined,
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
        includeActivationManifest,
      });
      return;
    case "cutover-firestore":
      await deps.cutoverFirestore(step.uid, step.to, slug);
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
    await report(deps, { name: step.action, status: "running" });
    try {
      await executeStep(
        step,
        deps,
        input.migrationId,
        input.slug,
        input.includeActivationManifest,
      );
      await report(deps, { name: step.action, status: "done" });
      deps.log(
        `[migration-runner] ${step.action} ok migrationId=${input.migrationId} slug=${input.slug} (phase ${phaseAtStart} → ${advancePhase(state.phase)})`,
      );
      state = { ...state, phase: advancePhase(state.phase) };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await report(deps, { name: step.action, status: "failed", error: errMsg });
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
    const rbName = `rollback:${step.action}`;
    await report(deps, { name: rbName, status: "running" });
    try {
      await executeStep(step, deps, migrationId, state.slug, undefined);
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
