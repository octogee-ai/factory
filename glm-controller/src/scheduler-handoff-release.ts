import type { DocumentData, Firestore } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, type SchedulerHandoffState } from "@octogee/shared/types/glm";

export interface SchedulerHandoffReleaseDeps {
  db: Firestore;
  gatewayExists: (gatewayId: string) => Promise<boolean>;
  scheduler: (
    gatewayId: string,
    request: { migrationId: string; slug: string; phase: "abort" | "resume" | "retire" | "activate" },
  ) => Promise<void>;
  log: (msg: string) => void;
  now: () => number;
}

function isHandoff(value: unknown): value is SchedulerHandoffState {
  if (!value || typeof value !== "object") return false;
  const handoff = value as Record<string, unknown>;
  return ["migrationId", "fromGatewayId", "toGatewayId", "uid", "slug"]
    .every((key) => typeof handoff[key] === "string" && handoff[key] !== "");
}

type HandoffProgress = "never-held" | "held" | "staged" | "cut-over";

function handoffProgress(operation: DocumentData): HandoffProgress {
  if (typeof operation.cutoverCommittedAt === "number") return "cut-over";
  const steps = Array.isArray(operation.steps) ? operation.steps as Array<{ name?: unknown; status?: unknown }> : [];
  if (!steps.some((step) => step.name === "quiesce-source")) return "never-held";
  return steps.some((step) => step.name === "final-sync-state" || step.name === "stage-scheduler") ? "staged" : "held";
}

async function releaseHandoff(
  deps: SchedulerHandoffReleaseDeps,
  handoff: SchedulerHandoffState,
  progress: Exclude<HandoffProgress, "never-held">,
): Promise<void> {
  const request = { migrationId: handoff.migrationId, slug: handoff.slug };
  const [closing, closePhase, owner, ownerPhase] = progress === "cut-over"
    ? [handoff.fromGatewayId, "retire", handoff.toGatewayId, "activate"] as const
    : [handoff.toGatewayId, "abort", handoff.fromGatewayId, "resume"] as const;
  if ((progress !== "held" || closePhase !== "abort") && await deps.gatewayExists(closing)) {
    await deps.scheduler(closing, { ...request, phase: closePhase });
  }
  if (await deps.gatewayExists(owner)) await deps.scheduler(owner, { ...request, phase: ownerPhase });
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
      if (progress !== "never-held") await releaseHandoff(deps, handoff, progress);
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
