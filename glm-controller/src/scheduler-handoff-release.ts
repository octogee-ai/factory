import { FieldValue, type DocumentData, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, type SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { SchedulerMigrationRequestBody } from "@octogee/shared/types/fleet-controller";
import { builderActivationSourceRecoveryPending } from "./legacy-migration-recovery.js";
import type { Operation } from "@octogee/shared/types/glm";

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
  if (operation && builderActivationSourceRecoveryPending(operation as Operation)) return true;
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

function committedOwnerMatches(op: DocumentData, user: DocumentData | undefined, handoff: SchedulerHandoffState): boolean {
  return op.kind === "migrate-customer" && op.input?.uid === handoff.uid &&
    op.input.fromGatewayId === handoff.fromGatewayId && op.input.toGatewayId === handoff.toGatewayId &&
    user?.provisioning?.openclaw?.gatewayId === handoff.toGatewayId;
}

async function retryCommittedHandoff(deps: SchedulerHandoffReleaseDeps, doc: QueryDocumentSnapshot): Promise<boolean> {
  return deps.db.runTransaction(async tx => {
    const current = await tx.get(doc.ref);
    if (!current.exists || !current.updateTime?.isEqual(doc.updateTime)) return false;
    const op = current.data()!, handoff = op.schedulerHandoff as SchedulerHandoffState;
    const user = await tx.get(deps.db.collection("users").doc(handoff.uid));
    const matches = op.status === "failed" && op.schedulerHandoffReleased === false && op.cancellationRequestedAt === undefined &&
      committedOwnerMatches(op, user.data(), handoff);
    if (!matches) return false;
    tx.update(doc.ref, { status: "pending", startedAt: null, completedAt: null, nextAttemptAt: deps.now(), expireAt: FieldValue.delete() });
    return true;
  });
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

async function acknowledgeCurrentHandoff(
  deps: SchedulerHandoffReleaseDeps,
  doc: QueryDocumentSnapshot,
): Promise<boolean> {
  const update = {
    schedulerHandoffReleased: true,
    schedulerHandoffReleasedAt: deps.now(),
  };
  return deps.db.runTransaction(async (txn) => {
    const current = await txn.get(doc.ref);
    if (!current.exists || !current.updateTime?.isEqual(doc.updateTime)) return false;
    txn.update(doc.ref, update);
    return true;
  });
}

function sourceRecoveryOwns(operation: DocumentData, id: string): boolean {
  return builderActivationSourceRecoveryPending({ ...operation, id } as Operation) ||
    operation.input?.recoverSourceOnly === true && typeof operation.cutoverCommittedAt !== "number";
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
    const operation = doc.data();
    if (sourceRecoveryOwns(operation, doc.id)) continue;
    const handoff = operation.schedulerHandoff;
    if (!isHandoff(handoff)) {
      deps.log(`[scheduler-handoff-release] ⚠ ${doc.id} has no valid scheduler handoff; leaving it pending`);
      continue;
    }
    const progress = handoffProgress(operation);
    if (progress === "cut-over") {
      const queued = await retryCommittedHandoff(deps, doc);
      deps.log(`[scheduler-handoff-release] ${doc.id} committed handoff ${queued ? "queued for claimed recovery" : "changed authority; recovery withheld"}`);
      continue;
    }
    try {
      if (progress !== "never-held") await rollBackHandoff(deps, handoff, progress);
    } catch (error) {
      deps.log(
        `[scheduler-handoff-release] ⚠ ${doc.id} ${handoff.migrationId} not released; source stays closed until the next pass: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!await acknowledgeCurrentHandoff(deps, doc)) {
      deps.log(`[scheduler-handoff-release] ${doc.id} changed during rollback release; acknowledgment withheld`);
      continue;
    }
    deps.log(
      `[scheduler-handoff-release] released (${progress}) ${handoff.migrationId} slug=${handoff.slug} ` +
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
