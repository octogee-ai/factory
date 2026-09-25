import type { DocumentData, DocumentReference, Firestore } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, type SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { SchedulerMigrationRequestBody } from "@octogee/shared/types/fleet-controller";

export interface SchedulerHandoffReleaseDeps {
  db: Firestore;
  gatewayExists: (gatewayId: string) => Promise<boolean>;
  scheduler: (
    gatewayId: string,
    request: Pick<SchedulerMigrationRequestBody, "migrationId" | "slug" | "phase" | "agentIds" | "snapshot" | "retainNonportable">,
  ) => Promise<{ agentIds: string[]; snapshot?: unknown }>;
  log: (msg: string) => void;
  now: () => number;
}

function isHandoff(value: unknown): value is SchedulerHandoffState {
  if (!value || typeof value !== "object") return false;
  const handoff = value as Record<string, unknown>;
  return ["migrationId", "fromGatewayId", "toGatewayId", "uid", "slug"]
    .every((key) => typeof handoff[key] === "string" && handoff[key] !== "");
}

const UNSETTLED_OPERATION_STATUSES: ReadonlySet<unknown> = new Set(["pending", "running", "failed"]);

export function schedulerHandoffAwaitingRelease(operation: DocumentData | undefined): boolean {
  return operation?.schedulerHandoffReleased === false &&
    UNSETTLED_OPERATION_STATUSES.has(operation.status) &&
    isHandoff(operation.schedulerHandoff);
}

type HandoffProgress = "never-held" | "held" | "staged" | "cut-over";

function handoffProgress(operation: DocumentData): HandoffProgress {
  if (typeof operation.cutoverCommittedAt === "number") return "cut-over";
  const steps = Array.isArray(operation.steps) ? operation.steps as Array<{ name?: unknown; status?: unknown }> : [];
  if (!steps.some((step) => step.name === "quiesce-source")) return "never-held";
  if ((operation.schedulerHandoff as SchedulerHandoffState).stageAfterCutover) return "held";
  return steps.some((step) => step.name === "final-sync-state" || step.name === "stage-scheduler") ? "staged" : "held";
}

async function stageOnReleasedTarget(
  deps: SchedulerHandoffReleaseDeps,
  ref: DocumentReference,
  handoff: SchedulerHandoffState,
): Promise<boolean> {
  if (!handoff.stageAfterCutover || handoff.stagedAt !== undefined) return true;
  const request = { migrationId: handoff.migrationId, slug: handoff.slug };
  const missing = [];
  for (const gatewayId of [handoff.fromGatewayId, handoff.toGatewayId]) {
    if (!await deps.gatewayExists(gatewayId)) missing.push(gatewayId);
  }
  if (missing.length > 0) {
    deps.log(
      `[scheduler-handoff-release] ❌ ${handoff.migrationId} slug=${handoff.slug}: ${missing.join(", ")} gone before the post-cutover stage; ` +
        `the schedules exported on ${handoff.fromGatewayId} are lost`,
    );
    return false;
  }
  const exported = await deps.scheduler(handoff.fromGatewayId, { ...request, phase: "export" });
  await deps.scheduler(handoff.toGatewayId, {
    ...request, phase: "stage", agentIds: exported.agentIds, snapshot: exported.snapshot, retainNonportable: true,
  });
  await ref.update({ "schedulerHandoff.stagedAt": deps.now() });
  return true;
}

async function completeHandoff(
  deps: SchedulerHandoffReleaseDeps,
  ref: DocumentReference,
  handoff: SchedulerHandoffState,
): Promise<void> {
  const request = { migrationId: handoff.migrationId, slug: handoff.slug };
  const staged = await stageOnReleasedTarget(deps, ref, handoff);
  if (await deps.gatewayExists(handoff.fromGatewayId)) await deps.scheduler(handoff.fromGatewayId, { ...request, phase: "retire" });
  if (staged && await deps.gatewayExists(handoff.toGatewayId)) await deps.scheduler(handoff.toGatewayId, { ...request, phase: "activate" });
}

async function rollBackHandoff(
  deps: SchedulerHandoffReleaseDeps,
  handoff: SchedulerHandoffState,
  progress: "held" | "staged",
): Promise<void> {
  const request = { migrationId: handoff.migrationId, slug: handoff.slug };
  if (progress === "staged" && await deps.gatewayExists(handoff.toGatewayId)) {
    await deps.scheduler(handoff.toGatewayId, { ...request, phase: "abort" });
  }
  if (await deps.gatewayExists(handoff.fromGatewayId)) await deps.scheduler(handoff.fromGatewayId, { ...request, phase: "resume" });
}

export async function releaseAbandonedSchedulerHandoffs(
  deps: SchedulerHandoffReleaseDeps,
): Promise<{ released: number }> {
  const pending = await deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "failed")
    .where("schedulerHandoffReleased", "==", false)
    .get();
  let released = 0;
  for (const doc of pending.docs) {
    const handoff = doc.data().schedulerHandoff;
    if (!isHandoff(handoff)) {
      deps.log(`[scheduler-handoff-release] ⚠ ${doc.id} has no valid scheduler handoff; leaving it pending`);
      continue;
    }
    const progress = handoffProgress(doc.data());
    try {
      if (progress === "cut-over") await completeHandoff(deps, doc.ref, handoff);
      else if (progress !== "never-held") await rollBackHandoff(deps, handoff, progress);
    } catch (error) {
      deps.log(
        `[scheduler-handoff-release] ⚠ ${doc.id} ${handoff.migrationId} not released; source stays closed until the next pass: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    await doc.ref.update({ schedulerHandoffReleased: true, schedulerHandoffReleasedAt: deps.now() });
    deps.log(
      `[scheduler-handoff-release] ${progress === "cut-over" ? "completed" : "released"} (${progress}) ${handoff.migrationId} slug=${handoff.slug} ` +
        `source=${handoff.fromGatewayId} target=${handoff.toGatewayId} op=${doc.id}`,
    );
    released += 1;
  }
  return { released };
}

export function startSchedulerHandoffRelease(
  deps: SchedulerHandoffReleaseDeps & { intervalMs: number },
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    releaseAbandonedSchedulerHandoffs(deps)
      .catch((error: unknown) => deps.log(`[scheduler-handoff-release] ⚠ pass failed: ${String(error)}`))
      .finally(() => { running = false; });
  }, deps.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
