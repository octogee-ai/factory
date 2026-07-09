import type {
  Operation,
  OperationStep,
  StepStatus,
} from "@octogee/shared/types/glm";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import {
  runMigration,
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

export interface MigrateCustomerDeps {
  
  readUser: (uid: string) => Promise<UserGatewayInfo | null>;

  readUserSnapshot: (uid: string) => Promise<FleetBrokerUserSnapshot | null>;

  cutoverFirestore: (uid: string, toGatewayId: string, slug: string) => Promise<void>;

resolveGatewayUrl: (gatewayId: string) => Promise<string>;

buildClient: (resolveSync: (gatewayId: string) => string) => MigrationClient;
  
  genMigrationId: () => string;
  
  now: () => number;
  log: (msg: string) => void;
}

interface MigrateCustomerInput {
  uid?: unknown;
  toGatewayId?: unknown;
  // Set by the blue/green orchestrator. A "rollout-bluegreen" migrate retires the
  // SOURCE, so its source-side steps are best-effort (the source can't veto the roll).
  source?: unknown;
}

const ROLLOUT_BLUEGREEN_SOURCE = "rollout-bluegreen";

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

export function createMigrateCustomerHandler(deps: MigrateCustomerDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as MigrateCustomerInput;
    const uid = typeof input.uid === "string" ? input.uid : undefined;
    const toGatewayId = typeof input.toGatewayId === "string" ? input.toGatewayId : undefined;
    const sourceDisposable = input.source === ROLLOUT_BLUEGREEN_SOURCE;

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
    if (user.currentGatewayId === toGatewayId) {
      return {
        steps: [],
        success: false,
        error: `customer already on ${toGatewayId}`,
      };
    }

    const migrationId = deps.genMigrationId();
    let fromUrl: string;
    let toUrl: string;
    let restoreSnapshot: FleetBrokerUserSnapshot | null;
    try {
      fromUrl = await deps.resolveGatewayUrl(user.currentGatewayId);
      toUrl = await deps.resolveGatewayUrl(toGatewayId);
      restoreSnapshot = await deps.readUserSnapshot(uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { steps: [], success: false, error: message };
    }
    if (!restoreSnapshot) {
      return { steps: [], success: false, error: `durable snapshot not found for ${uid}` };
    }
    const urls = new Map<string, string>([
      [user.currentGatewayId, fromUrl],
      [toGatewayId, toUrl],
    ]);
    const client = deps.buildClient((gatewayId) => {
      const url = urls.get(gatewayId);
      if (!url) {
        throw new Error(
          `migration client called with unexpected gatewayId: ${gatewayId}`,
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
        restoreSnapshot,
        includeActivationManifest: true,
        sourceDisposable,
      },
      {
        client,
        cutoverFirestore: async (uid, toGatewayId, slug) => {
          await deps.cutoverFirestore(uid, toGatewayId, slug);
        },
        log: deps.log,
        reportStep: async (rep: ReportedStep) => {
          const step = reportedToOperationStep(rep, deps.now());
          await ctx.reportStep(step);
        },
      },
    );

    return {
      steps: [],
      success: result.success,
      error: result.errorAt?.error,
      rolledBack: result.rolledBack,
    };
  };
}
