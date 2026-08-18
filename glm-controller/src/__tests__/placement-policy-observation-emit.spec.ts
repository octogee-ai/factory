import { describe, expect, it, vi } from "vitest";
import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

import { persistKubernetesObservations } from "../placement-policy-reconciler.js";

const RS = { uid: "rs-live", name: "octogee-gateway-shared-a-98d6b8cd7", desiredReplicas: 1, observedReplicas: 0 };

function runtimeDoc(kubernetes: Record<string, unknown>) {
  return {
    docKind: "runtime",
    gatewayId: "shared-a",
    release: 1,
    lifecycle: "serving",
    heartbeat: { status: "ready", mountedCustomers: [] },
    kubernetes,
  };
}

// firebase-admin re-invokes the transaction callback on contention. The
// callback must therefore be free of side effects: the structured record feeds
// a DELTA log metric that would count every retry as another loss.
function contendedFirestore(stored: Record<string, unknown>, attempts: number) {
  const writes: unknown[] = [];
  const ref = { path: "glmGateways/shared-a" };
  const db = {
    runTransaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
      let result: unknown = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        result = await callback({
          get: async () => ({ exists: true, data: () => stored }),
          set: (_ref: unknown, value: unknown) => writes.push(value),
        });
      }
      return result;
    }),
  };
  const snapshot = { id: "shared-a", ref, data: () => stored };
  return {
    db: db as unknown as Firestore,
    documents: [snapshot as unknown as QueryDocumentSnapshot],
    writes,
  };
}

describe("persistKubernetesObservations — emission is outside the transaction", () => {
  it("emits exactly one record for a lost pod even when the transaction callback is retried", async () => {
    const { db, documents, writes } = contendedFirestore(runtimeDoc({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      observedAt: 20_000,
      pods: [{
        uid: "uid-a",
        name: "octogee-gateway-shared-a-98d6b8cd7-uid-a",
        replicaSetUid: RS.uid,
        nodeName: "node-1",
        instanceId: "111",
        nodePool: "nap-1dx2tv8d",
      }],
    }), 3);
    const emitted: unknown[] = [];
    const log = vi.fn();

    await persistKubernetesObservations(db, documents, {
      "shared-a": { status: "missing", totalPods: 0, readyPods: 0, pods: [], replicaSets: [RS] },
    }, 25_000, { emitReplacement: (record) => emitted.push(record), log, namespace: "octogee-test" });

    expect(writes).toHaveLength(3);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ vacatedPodUid: "uid-a", instanceId: "111", total: 1 });
    expect(log.mock.calls.filter(([line]) => /lost pod/.test(String(line)))).toHaveLength(1);
  });

  it("emits nothing when the transaction never commits an observation", async () => {
    const { db, documents } = contendedFirestore(runtimeDoc({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      observedAt: 90_000,
      pods: [{ uid: "uid-a", name: "pod-a", replicaSetUid: RS.uid, nodeName: null, instanceId: null, nodePool: null }],
    }), 1);
    const emitted: unknown[] = [];

    await persistKubernetesObservations(db, documents, {
      "shared-a": { status: "missing", totalPods: 0, readyPods: 0, pods: [], replicaSets: [RS] },
    }, 20_000, { emitReplacement: (record) => emitted.push(record) });

    expect(emitted).toEqual([]);
  });
});
