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

  // The ATOMIC cutover: mirror move (when the bare gateway changed) AND the
  // assignment revision commit as one Firestore transaction, inside the runner's
  // cutover step, before unmount-source. A crash leaves neither.
  commitCutover: (commit: CutoverCommit) => Promise<void>;

  // resolveGatewayUrl resolves a K8s Service URL from a TRANSPORT id — the bare
  // gateway id in the legacy path, or the revision id ({gw}-r{n}) once the
  // gateway is on the Step 2 assignment layer.
  resolveGatewayUrl: (gatewayId: string) => Promise<string>;

buildClient: (resolveSync: (gatewayId: string) => string) => MigrationClient;

  // Step 2 revision resolution (all optional — absent = legacy bare-gateway
  // migration). resolveFromRevision reads the customer's current assignment doc,
  // falling back to the source gateway's live revision when the customer has no
  // assignment doc yet (so a same-gateway drain still RUNS instead of no-op'ing).
  // resolvePlacement applies the placement rule to the destination gateway (null =
  // the gateway is not on the assignment layer yet). At claim time Cowboy resolves
  // both, so idle/preemption/reservation sweepers keep enqueuing bare targets.
  resolveFromRevision?: (uid: string, currentGatewayId: string) => Promise<SourceRevision | null>;
  resolvePlacement?: (toGatewayId: string) => Promise<PlacementResolution | null>;

  // Roster quiesce gate (PR7): the runner writes "quiescing" on the source
  // assignment before the quiesce RPC and restores "serving" on a pre-cutover
  // rollback. Required for any revision-aware migration.
  setAssignmentState?: (input: {
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

// Resolved revision targeting for one migration. Transport ids resolve the K8s
// Service (revision when known, else bare gateway); the tenant/path stays bare.
interface MigrationTargets {
  toRevisionId: string | null;
  toRelease: number | null;
  fromRevisionId: string | null;
  fromRelease: number | null;
  fromTransportId: string;
  toTransportId: string;
}

// The "already on target" rule: when both revisions resolve, compare REVISION
// ids (otherwise every same-gateway drain — the roll mechanism — is a no-op);
// else fall back to the bare gateway comparison (legacy).
function alreadyOnTargetError(
  fromRevisionId: string | null,
  toRevisionId: string | null,
  currentGatewayId: string,
  toGatewayId: string,
): string | null {
  if (fromRevisionId && toRevisionId) {
    return fromRevisionId === toRevisionId ? `customer already on ${toRevisionId}` : null;
  }
  return currentGatewayId === toGatewayId ? `customer already on ${toGatewayId}` : null;
}

// Apply the placement rule to the destination gateway. { error } on a
// not-ready/no-live-revision rejection; null revision = legacy (gateway not on
// the assignment layer).
async function resolveToRevision(
  deps: MigrateCustomerDeps,
  toGatewayId: string,
): Promise<{ revisionId: string | null; release: number | null } | { error: string }> {
  const placement: PlacementResolution | null = deps.resolvePlacement
    ? await deps.resolvePlacement(toGatewayId)
    : null;
  if (placement && placement.ok === false) {
    return { error: `placement rejected for ${toGatewayId}: ${placement.reason}` };
  }
  const ok = placement !== null && placement.ok;
  return {
    revisionId: ok ? placement.revisionId : null,
    release: ok ? placement.release : null,
  };
}

// Resolve from/to revisions and apply the "already on target" rule. Absent
// resolvers = legacy bare-gateway migration. Resolver throws propagate to the
// caller; business rejections come back as { error }.
async function resolveMigrationTargets(
  deps: MigrateCustomerDeps,
  uid: string,
  user: UserGatewayInfo,
  toGatewayId: string,
): Promise<{ targets: MigrationTargets } | { error: string }> {
  const fromRevision = deps.resolveFromRevision
    ? await deps.resolveFromRevision(uid, user.currentGatewayId)
    : null;
  const to = await resolveToRevision(deps, toGatewayId);
  if ("error" in to) return { error: to.error };
  const fromRevisionId = fromRevision?.revisionId ?? null;

  const rejected = alreadyOnTargetError(fromRevisionId, to.revisionId, user.currentGatewayId, toGatewayId);
  if (rejected) return { error: rejected };

  return {
    targets: {
      toRevisionId: to.revisionId,
      toRelease: to.release,
      fromRevisionId,
      fromRelease: fromRevision?.release ?? null,
      fromTransportId: fromRevisionId ?? user.currentGatewayId,
      toTransportId: to.revisionId ?? toGatewayId,
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
  if (deps.setAssignmentState) runnerDeps.setAssignmentState = deps.setAssignmentState;
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
        // The runner flips the mirror only when the bare gateway changed and
        // commits the assignment doc INSIDE the cutover step (atomic, before
        // unmount-source). Forward commits the target revision; rollback restores
        // the source revision.
        crossGateway: user.currentGatewayId !== toGatewayId,
        toRevision: targets.toRevisionId
          ? { revisionId: targets.toRevisionId, release: targets.toRelease ?? 0 }
          : null,
        fromRevision: targets.fromRevisionId
          ? { revisionId: targets.fromRevisionId, release: targets.fromRelease ?? 0 }
          : null,
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
