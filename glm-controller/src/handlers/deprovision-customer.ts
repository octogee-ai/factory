// Inaugural Cowboy lift — customer deprovision orchestrated by
// glm-controller, not the gateway. Works for orphans (no live gateway)
// AND for live-mounted customers (calls the gateway's /unmount RPC
// before running cloud-side cleanup). See
// docs/specs/ADMIN-DELETE-CUSTOMER-SPEC.md.

import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm.js";
import type {
  OperationContext,
  OperationHandler,
  OperationResult,
} from "../operation-router.js";
import type {
  NukeCloudCtx,
  NukeCloudDeps,
  NukeCloudStepResult,
} from "../lib/customer-ops/nuke-cloud.js";
import { nukeUserCloudSide } from "../lib/customer-ops/nuke-cloud.js";

export interface CustomerCleanupContext {
  uid: string;
  slug: string;
  email: string | null;
  giteaOrg: string;
  /** Repo names to delete: <slug>-workspace + <slug>-proj-<projectSlug>... */
  repoNames: string[];
  /**
   * Project slugs (NOT repo names). Drives Firebase Hosting site
   * deletion: each `octogee-<slug>-<projectSlug>` site lines up with
   * the project slug here. Sourced directly from
   * `workspaces/{slug}/projects/*` Firestore docs — never reverse-
   * engineered from repo names (which would yield `proj-<slug>`).
   */
  projectSlugs: string[];
  workspaceTeamId: string | null;
  mmUserId: string | null;
  mmCoachUserId: string | null;
  adminChannelId: string | null;
  /** Currently-mounted gateway, or null when orphan. */
  currentGatewayId: string | null;
}

export interface DeprovisionCustomerDeps {
  /** Build the cloud-cleanup ctx by reading Firestore + workspace projects. */
  loadCleanupContext: (uid: string) => Promise<CustomerCleanupContext | null>;
  /** Tell the gateway to unmount the customer (steps 1-2 of nukeSteps). Skipped for orphans. */
  unmountFromGateway: (gatewayId: string, slug: string) => Promise<void>;
  /** The cloud-cleanup deps the orchestrator needs (gitea + mm clients + Firestore/Storage/Auth callbacks). */
  cloudCleanup: NukeCloudDeps;
  /** ISO-now for step timestamps. */
  now: () => number;
  log: (msg: string) => void;
}

interface DeprovisionInput {
  uid?: unknown;
  /** Optional skips passed by the admin endpoint (e.g. operator wants to keep auth). */
  skipAuth?: unknown;
  skipHosting?: unknown;
}

export function createDeprovisionCustomerHandler(
  deps: DeprovisionCustomerDeps,
): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as DeprovisionInput;
    const uid = typeof input.uid === "string" ? input.uid : undefined;
    if (!uid) {
      return { steps: [], success: false, error: "missing uid in op.input" };
    }
    const skipAuth = input.skipAuth === true;
    const skipHosting = input.skipHosting === true;

    const cleanup = await deps.loadCleanupContext(uid);
    if (!cleanup) {
      return { steps: [], success: false, error: `user not found: ${uid}` };
    }
    if (!cleanup.slug) {
      return {
        steps: [],
        success: false,
        error: `user ${uid} has no slug — use the inline lite-delete path, not deprovision-customer`,
      };
    }

    // Step 1: unmount from gateway (if mounted). Best-effort; the cloud-
    // cleanup steps below are the source of truth for "gone."
    if (cleanup.currentGatewayId) {
      const startedAt = deps.now();
      await reportStep(ctx, { name: "unmount-gateway", status: "running", startedAt });
      try {
        await deps.unmountFromGateway(cleanup.currentGatewayId, cleanup.slug);
        await reportStep(ctx, {
          name: "unmount-gateway",
          status: "done",
          startedAt,
          completedAt: deps.now(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Don't abort — orphan-equivalent fallback. Operator gets the
        // step error in OperationsHistory; cloud cleanup proceeds.
        deps.log(`[deprovision] unmount RPC failed for ${cleanup.slug} on ${cleanup.currentGatewayId}: ${message}`);
        await reportStep(ctx, {
          name: "unmount-gateway",
          status: "failed",
          startedAt,
          completedAt: deps.now(),
          error: message,
        });
      }
    } else {
      await reportStep(ctx, {
        name: "unmount-gateway",
        status: "skipped",
        startedAt: deps.now(),
        completedAt: deps.now(),
      });
    }

    // Step 2..7: cloud-side nuke (gitea, mm, firestore, storage, hosting, auth)
    const nukeCtx: NukeCloudCtx = {
      uid: cleanup.uid,
      slug: cleanup.slug,
      email: cleanup.email,
      giteaOrg: cleanup.giteaOrg,
      repoNames: cleanup.repoNames,
      projectSlugs: cleanup.projectSlugs,
      workspaceTeamId: cleanup.workspaceTeamId,
      mmUserId: cleanup.mmUserId,
      mmCoachUserId: cleanup.mmCoachUserId,
      adminChannelId: cleanup.adminChannelId,
      skipAuth,
      skipHosting,
    };
    const stepResults = await nukeUserCloudSide(nukeCtx, deps.cloudCleanup);
    for (const r of stepResults) {
      await reportStep(ctx, stepResultToOperationStep(r, deps.now()));
    }

    const failed = stepResults.filter((r) => !r.ok && !r.skipped);
    if (failed.length > 0) {
      const summary = failed.map((r) => `${r.key}: ${r.error}`).join("; ");
      return { steps: [], success: false, error: `cloud cleanup partial failure — ${summary}` };
    }
    return { steps: [], success: true };
  };
}

function deriveStepStatus(r: NukeCloudStepResult): StepStatus {
  if (r.skipped) return "skipped";
  if (r.ok) return "done";
  return "failed";
}

function stepResultToOperationStep(r: NukeCloudStepResult, completedAt: number): OperationStep {
  const step: OperationStep = { name: r.key, status: deriveStepStatus(r), completedAt };
  if (r.error) step.error = r.error;
  return step;
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
