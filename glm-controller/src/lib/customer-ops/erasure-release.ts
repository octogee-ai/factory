import type { Firestore } from "firebase-admin/firestore";
import { CUSTOMER_DELETION_JOBS_COLLECTION } from "@octogee/shared/types/account-lifecycle";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

export async function markSuspendedAndReleaseErasure(
  db: Firestore,
  deletionId: string,
  now: number,
): Promise<void> {
  const jobRef = db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId);
  await db.runTransaction(async (txn) => {
    const job = (await txn.get(jobRef)).data() as Record<string, unknown> | undefined;
    const erasureOperationId = job?.erasureOperationId;
    const eraseAfter = job?.eraseAfter;
    if (typeof erasureOperationId !== "string" || typeof eraseAfter !== "number") {
      throw new Error(`deletion job ${deletionId} has no erasure operation to release`);
    }
    const erasureRef = db.collection(GLM_OPERATIONS_COLLECTION).doc(erasureOperationId);
    const erasure = (await txn.get(erasureRef)).data() as { status?: unknown } | undefined;
    txn.set(jobRef, { status: "hibernating", suspendedAt: now, updatedAt: now }, { merge: true });
    if (erasure?.status === "pending") {
      txn.update(erasureRef, { nextAttemptAt: Math.max(now, eraseAfter) });
    }
  });
}
