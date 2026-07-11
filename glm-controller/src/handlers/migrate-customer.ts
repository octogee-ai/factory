import type {
  Operation,
  OperationStep,
  StepStatus,
} from "@octogee/shared/types/glm";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { PlacementResolution } from "@octogee/core/assignment-doc";
import {
  runMigration,
  type CutoverCommit,
  type MigrationRunnerDeps,
  type ReportedStep,
} from "@octogee/core/fleet-migration-runner";

// At most one migration per target gateway at a time (mirrors the
// fleet-migration-runner's one-slot-per-target transfer capacity). Enforced
// durably, before this handler ever runs, by the operation queue in index.ts
// (operation-queue.ts scopes migrate-customer exclusivity by toGatewayId); a
// conflicting request is queued there, not rejected here.

export interface UserGatewayInfo {
  slug: string;
  currentGatewayId: string;
}

export interface SourceRevision {
  revisionId: string;
  release: number;
}

export interface MigrateCustomerDeps {

  readUser: (uid: string) => Promise<UserGatewayInfo | null>;

  readUserSnapshot: (uid: string) => Promise<FleetBrokerUserSnapshot | null>;

  commitCutover: (commit: CutoverCommit) => Promise<void>;

  resolveGatewayUrl: (revisionId: string) => Promise<string>;

  buildClient: (resolveSync: (revisionId: string) => string) => MigrationClient;

  resolveFromRevision: (uid: string, currentGatewayId: string) => Promise<SourceRevision | null>;
  resolvePlacement: (toGatewayId: string) => Promise<PlacementResolution | null>;

  setAssignmentState: (input: {
    gatewayId: string;
    uid: string;
    state: "serving" | "quiescing" | "migrating";
  }) => Promise<void>;

  genMigrationId: () => string;

  now: () => number;
  log: (msg: string) => void;
}

interface MigrateCustomerInput {
  uid?: unknown;
  toGatewayId?: unknown;
}

function reportedStatusToStepStatus(reported: ReportedStep["status"]): StepStatus {
  if (reported === "running") return "running";
  if (reported === "done") return "done";
  if (reported === "skipped") return "skipped";
  return "failed";
}

function reportedToOperationStep(rep: ReportedStep, now: number): OperationStep {
  const status = reportedStatusToStepStatus(rep.status);
  const step: OperationStep = { name: rep.name, status };
  if (rep.status === "running") step.startedAt = now;
  else step.completedAt = now;
  if (rep.error) step.error = rep.error;
  return step;
}

interface MigrationTargets {
  toRevisionId: string;
  toRelease: number | null;
  fromRevisionId: string;
  fromRelease: number;
  fromTransportId: string;
  toTransportId: string;
}

function alreadyOnTargetError(
  fromRevisionId: string,
  toRevisionId: string,
): string | null {
  return fromRevisionId === toRevisionId ? `customer already on ${toRevisionId}` : null;
}

async function resolveToRevision(
  deps: MigrateCustomerDeps,
  toGatewayId: string,
): Promise<{ revisionId: string; release: number | null } | { error: string }> {
  const placement = await deps.resolvePlacement(toGatewayId);
  if (placement === null) {
    return { error: `target gateway ${toGatewayId} has no durable placement` };
  }
  if (placement.ok === false) {
    return { error: `placement rejected for ${toGatewayId}: ${placement.reason}` };
  }
  return {
    revisionId: placement.revisionId,
    release: placement.release,
  };
}

async function resolveMigrationTargets(
  deps: MigrateCustomerDeps,
  uid: string,
  user: UserGatewayInfo,
  toGatewayId: string,
): Promise<{ targets: MigrationTargets } | { error: string }> {
  const fromRevision = await deps.resolveFromRevision(uid, user.currentGatewayId);
  if (!fromRevision) {
    return {
      error: `source gateway ${user.currentGatewayId} has no durable revision`,
    };
  }
  const to = await resolveToRevision(deps, toGatewayId);
  if ("error" in to) return { error: to.error };

  const rejected = alreadyOnTargetError(fromRevision.revisionId, to.revisionId);
  if (rejected) return { error: rejected };

  return {
    targets: {
      toRevisionId: to.revisionId,
      toRelease: to.release,
      fromRevisionId: fromRevision.revisionId,
      fromRelease: fromRevision.release,
      fromTransportId: fromRevision.revisionId,
      toTransportId: to.revisionId,
    },
  };
}

function buildRunnerDeps(
  deps: MigrateCustomerDeps,
  client: MigrationClient,
  ctx: OperationContext,
): MigrationRunnerDeps {
  const runnerDeps: MigrationRunnerDeps = {
    client,
    commitCutover: deps.commitCutover,
    log: deps.log,
    reportStep: async (rep: ReportedStep) => {
      const step = reportedToOperationStep(rep, deps.now());
      await ctx.reportStep(step);
    },
  };
  runnerDeps.setAssignmentState = deps.setAssignmentState;
  return runnerDeps;
}

export function createMigrateCustomerHandler(deps: MigrateCustomerDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as MigrateCustomerInput;
    const uid = typeof input.uid === "string" ? input.uid : undefined;
    const toGatewayId = typeof input.toGatewayId === "string" ? input.toGatewayId : undefined;

    if (!uid) {
      return { steps: [], success: false, error: "missing uid in op.input" };
    }
    if (!toGatewayId) {
      return { steps: [], success: false, error: "missing toGatewayId in op.input" };
    }

    const user = await deps.readUser(uid);
    if (!user) {
      return { steps: [], success: false, error: `user not found: ${uid}` };
    }

    const migrationId = deps.genMigrationId();
    let targets: MigrationTargets;
    let restoreSnapshot: FleetBrokerUserSnapshot | null;
    const urls = new Map<string, string>();
    try {
      const resolved = await resolveMigrationTargets(deps, uid, user, toGatewayId);
      if ("error" in resolved) {
        return { steps: [], success: false, error: resolved.error };
      }
      targets = resolved.targets;
      urls.set(targets.fromTransportId, await deps.resolveGatewayUrl(targets.fromTransportId));
      urls.set(targets.toTransportId, await deps.resolveGatewayUrl(targets.toTransportId));
      restoreSnapshot = await deps.readUserSnapshot(uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { steps: [], success: false, error: message };
    }
    if (!restoreSnapshot) {
      return { steps: [], success: false, error: `durable snapshot not found for ${uid}` };
    }
    const client = deps.buildClient((transportId) => {
      const url = urls.get(transportId);
      if (!url) {
        throw new Error(
          `migration client called with unexpected gatewayId: ${transportId}`,
        );
      }
      return url;
    });

    const result = await runMigration(
      {
        migrationId,
        uid,
        slug: user.slug,
        fromGatewayId: user.currentGatewayId,
        toGatewayId,
        fromTransportId: targets.fromTransportId,
        toTransportId: targets.toTransportId,
        crossGateway: user.currentGatewayId !== toGatewayId,
        toRevision: { revisionId: targets.toRevisionId, release: targets.toRelease ?? 0 },
        fromRevision: { revisionId: targets.fromRevisionId, release: targets.fromRelease },
        restoreSnapshot,
        includeActivationManifest: true,
      },
      buildRunnerDeps(deps, client, ctx),
    );

    return {
      steps: [],
      success: result.success,
      error: result.errorAt?.error,
      rolledBack: result.rolledBack,
    };
  };
}
