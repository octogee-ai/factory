import type { Firestore } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, type Operation } from "../../shared/types/glm.js";

export interface ResumeOrphanedOpsDeps {
  db: Firestore;
  log: (msg: string) => void;
  // Kinds safe to re-drive idempotently after a controller restart. The blue/green
  // rollout is the one that spans minutes and, if abandoned after its pre-migrate
  // repoint, leaves a split pool — so it must survive a restart.
  resumableKinds: ReadonlySet<string>;
  // Re-adopt the orphaned running op (bump heartbeat + resumeCount) and re-run its
  // handler from persisted progress. Supplied by the controller wiring.
  redrive: (op: Operation, ref: FirebaseFirestore.DocumentReference) => Promise<void>;
}

export interface ResumeOrphanedOpsResult {
  scanned: number;
  resumed: number;
}

// On boot the controller is the sole replica, so any op still marked `running` was
// orphaned by the previous instance exiting mid-op (deploy/restart/crash) — the
// `running` glmOperations record outlived the process driving it. For resumable
// kinds, re-drive it instead of leaving it for the stuck-op reaper: a reaped roll
// that already repointed the shared pointer at its (still-empty) target strands the
// customers on the source pool. Re-driving is safe because the orchestrator is
// idempotent (spawn=set, migrate reads the shrinking source-assignment, repoint=set,
// retire=ensure-gone).
export async function resumeOrphanedRunningOps(
  deps: ResumeOrphanedOpsDeps,
): Promise<ResumeOrphanedOpsResult> {
  const snap = await deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "running")
    .get();
  let resumed = 0;
  for (const doc of snap.docs) {
    const data = doc.data() as Operation | undefined;
    if (!data) continue;
    const op = { ...data, id: doc.id } as Operation;
    if (!deps.resumableKinds.has(op.kind)) continue;
    deps.log(
      `[resume-orphaned-ops] re-driving orphaned running op=${op.id} kind=${op.kind} (controller restarted mid-op)`,
    );
    try {
      await deps.redrive(op, doc.ref);
      resumed += 1;
    } catch (err) {
      deps.log(
        `[resume-orphaned-ops] ⚠ re-drive op=${op.id} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { scanned: snap.docs.length, resumed };
}
