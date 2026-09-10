import type { Firestore } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import type { SurgePod } from "./surge-customer-handoff.js";

export const CRASH_LOOP_EVICTION_BUDGET = 3;

export interface CrashLoopEvictionClaim {
  allowed: boolean;
  count: number;
  budget: number;
}

export function crashLoopEvictionDecision(record: unknown, imageTag: string): { allowed: boolean; count: number } {
  const current = record && typeof record === "object" && !Array.isArray(record)
    ? (record as { imageTag?: unknown; count?: unknown })
    : undefined;
  const spent = current?.imageTag === imageTag && typeof current.count === "number" && Number.isFinite(current.count)
    ? current.count
    : 0;
  return spent < CRASH_LOOP_EVICTION_BUDGET ? { allowed: true, count: spent + 1 } : { allowed: false, count: spent };
}

export async function claimCrashLoopEviction(
  db: Pick<Firestore, "collection" | "runTransaction">,
  input: { gatewayId: string; imageTag: string; pod: SurgePod; now: number },
): Promise<CrashLoopEvictionClaim> {
  const ref = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const record = (snapshot.data() as { surgeCrashLoopEvictions?: unknown } | undefined)?.surgeCrashLoopEvictions;
    const decision = crashLoopEvictionDecision(record, input.imageTag);
    if (decision.allowed) {
      transaction.set(ref, {
        surgeCrashLoopEvictions: { imageTag: input.imageTag, count: decision.count, lastAt: input.now, lastPod: input.pod.name },
      }, { merge: true });
    }
    return { ...decision, budget: CRASH_LOOP_EVICTION_BUDGET };
  });
}
