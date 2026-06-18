import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { MigrationClient } from "../../../scripts/lib/fleet-migration-client.js";
import {
  runMigration,
  type ReportedStep,
} from "../../../scripts/lib/fleet-migration-runner.js";

export const MAX_CONCURRENT_MIGRATIONS_PER_TARGET = 1;

const inFlightPerTarget = new Map<string, number>();

export function _resetMigrationConcurrencyForTests(): void {
  inFlightPerTarget.clear();
}

function tryAcquireTargetSlot(gatewayId: string): boolean {
  const count = inFlightPerTarget.get(gatewayId) ?? 0;
  if (count >= MAX_CONCURRENT_MIGRATIONS_PER_TARGET) return false;
  inFlightPerTarget.set(gatewayId, count + 1);
  return true;
}

function releaseTargetSlot(gatewayId: string): void {
  const count = inFlightPerTarget.get(gatewayId) ?? 0;
  if (count <= 1) inFlightPerTarget.delete(gatewayId);
  else inFlightPerTarget.set(gatewayId, count - 1);
}

export interface UserGatewayInfo {
  slug: string;
  currentGatewayId: string;
}

export interface MigrateCustomerDeps {
  
  readUser: (uid: string) => Promise<UserGatewayInfo | null>;
  
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
}

function reportedStatusToStepStatus(reported: ReportedStep["status"]): StepStatus {
  if (reported === "running") return "running";
  if (reported === "done") return "done";
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

    if (!tryAcquireTargetSlot(toGatewayId)) {
      return {
        steps: [],
        success: false,
        error: `concurrency limit: target gateway ${toGatewayId} already has ${MAX_CONCURRENT_MIGRATIONS_PER_TARGET} migration(s) in-flight; retry after the current one completes`,
      };
    }

    try {
      const migrationId = deps.genMigrationId();
      let fromUrl: string;
      let toUrl: string;
      try {
        fromUrl = await deps.resolveGatewayUrl(user.currentGatewayId);
        toUrl = await deps.resolveGatewayUrl(toGatewayId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { steps: [], success: false, error: message };
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
          includeActivationManifest: true,
        },
        {
          client,
          cutoverFirestore: deps.cutoverFirestore,
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
    } finally {
      releaseTargetSlot(toGatewayId);
    }
  };
}
