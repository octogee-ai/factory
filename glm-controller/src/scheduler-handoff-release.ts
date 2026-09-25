import type { Firestore } from "firebase-admin/firestore";
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

async function userGatewayId(db: Firestore, uid: string): Promise<string | null> {
  const user = (await db.collection("users").doc(uid).get()).data();
  const gatewayId = user?.provisioning?.openclaw?.gatewayId;
  return typeof gatewayId === "string" ? gatewayId : null;
}

async function releaseHandoff(
  deps: SchedulerHandoffReleaseDeps,
  handoff: SchedulerHandoffState,
  cutOver: boolean,
): Promise<void> {
  const request = { migrationId: handoff.migrationId, slug: handoff.slug };
  const [closing, closePhase, owner, ownerPhase] = cutOver
    ? [handoff.fromGatewayId, "retire", handoff.toGatewayId, "activate"] as const
    : [handoff.toGatewayId, "abort", handoff.fromGatewayId, "resume"] as const;
  if (await deps.gatewayExists(closing)) {
    await deps.scheduler(closing, { ...request, phase: closePhase });
  }
  await deps.scheduler(owner, { ...request, phase: ownerPhase });
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
    const cutOver = await userGatewayId(deps.db, handoff.uid) === handoff.toGatewayId;
    try {
      await releaseHandoff(deps, handoff, cutOver);
    } catch (error) {
      deps.log(
        `[scheduler-handoff-release] ⚠ ${doc.id} ${handoff.migrationId} not released; source stays closed until the next pass: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    await doc.ref.update({ schedulerHandoffReleased: true, schedulerHandoffReleasedAt: deps.now() });
    deps.log(
      `[scheduler-handoff-release] ${cutOver ? "completed" : "released"} ${handoff.migrationId} slug=${handoff.slug} ` +
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
