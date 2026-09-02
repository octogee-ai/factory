import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";

interface OpenClawBootInput {
  gatewayId: string;
  podUid: string;
  releaseKey: string;
}

export interface OpenClawBootSentinelStore {
  claim(input: OpenClawBootInput): Promise<{ action: "doctor" | "start" } | null>;
  complete(input: OpenClawBootInput): Promise<boolean>;
}

export function createOpenClawBootSentinelStore(
  db: Firestore,
  now: () => number,
): OpenClawBootSentinelStore {
  return {
    async claim(input) {
      const runtimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
      return db.runTransaction(async (txn) => {
        const runtimeSnap = await txn.get(runtimeRef);
        if (!runtimeSnap.exists) return null;
        const sentinel = runtimeSnap.data()?.openclawBootSentinel as
          | Record<string, unknown>
          | undefined;
        if (sentinel?.releaseKey === input.releaseKey && sentinel.state === "starting") {
          txn.update(runtimeRef, {
            openclawBootSentinel: {
              releaseKey: input.releaseKey,
              state: "doctor-attempted",
              podUid: input.podUid,
              updatedAt: now(),
            },
          });
          return { action: "doctor" };
        }
        if (sentinel?.releaseKey !== input.releaseKey) {
          txn.update(runtimeRef, {
            openclawBootSentinel: {
              releaseKey: input.releaseKey,
              state: "starting",
              podUid: input.podUid,
              updatedAt: now(),
            },
          });
        } else if (
          sentinel.state === "doctor-attempted"
          && sentinel.podUid !== input.podUid
        ) {
          txn.update(runtimeRef, {
            "openclawBootSentinel.podUid": input.podUid,
            "openclawBootSentinel.updatedAt": now(),
          });
        }
        return { action: "start" };
      });
    },
    async complete(input) {
      const runtimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
      return db.runTransaction(async (txn) => {
        const runtimeSnap = await txn.get(runtimeRef);
        if (!runtimeSnap.exists) return false;
        const sentinel = runtimeSnap.data()?.openclawBootSentinel as
          | Record<string, unknown>
          | undefined;
        if (
          sentinel?.releaseKey === input.releaseKey
          && sentinel.podUid === input.podUid
        ) {
          txn.update(runtimeRef, { openclawBootSentinel: FieldValue.delete() });
        }
        return true;
      });
    },
  };
}
