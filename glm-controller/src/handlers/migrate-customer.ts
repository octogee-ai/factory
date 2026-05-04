import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { MigrationClient } from "../../../scripts/lib/fleet-migration-client.js";
import {
  runMigration,
  type ReportedStep,
} from "../../../scripts/lib/fleet-migration-runner.js";

export interface UserGatewayInfo {
  slug: string;
  currentGatewayId: string;
}

export interface MigrateCustomerDeps {
  /** Reads users/{uid}; returns null if the doc doesn't exist or is missing required fields. */
  readUser: (uid: string) => Promise<UserGatewayInfo | null>;
  /** Writes users/{uid}.provisioning.openclaw.gatewayId = toGatewayId. */
  cutoverFirestore: (uid: string, toGatewayId: string) => Promise<void>;
  /**
   * Resolves a gatewayId to its in-cluster URL by reading authoritative
   * glmGateways state. Throws on missing/incomplete docs — refuses to
   * route via guesswork. Async because Firestore.
   */
  resolveGatewayUrl: (gatewayId: string) => Promise<string>;
  /**
   * Builds a per-op MigrationClient. Caller passes a sync URL resolver
   * pre-populated for the (from, to) pair this op needs; the handler
   * pre-resolves before invoking. Tests can ignore the resolver and
   * return a mock.
   */
  buildClient: (resolveSync: (gatewayId: string) => string) => MigrationClient;
  /** Migration id (correlates the four RPCs in logs); injected for tests. */
  genMigrationId: () => string;
  /** Wall clock; injected for tests. */
  now: () => number;
  log: (msg: string) => void;
}

interface MigrateCustomerInput {
  uid?: unknown;
  toGatewayId?: unknown;
}

function reportedToOperationStep(rep: ReportedStep, now: number): OperationStep {
  const status: StepStatus =
    rep.status === "running" ? "running" : rep.status === "done" ? "done" : "failed";
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
  };
}
