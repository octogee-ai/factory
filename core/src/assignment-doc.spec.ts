import { describe, expect, it, vi } from "vitest";
import * as assignmentDoc from "./assignment-doc.js";
import {
  readAssignmentDoc,
  readAssignmentDocsForGateway,
} from "./assignment-doc.js";

// Firestore fake with a single gateways/{id}/assignments subcollection.
function mkAssignmentDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [key, data] of Object.entries(seed)) {
    const [gatewayId, uid] = key.split("/");
    (store[gatewayId] ??= {})[uid] = data;
  }
  const db = {
    collection: vi.fn((name: string) => {
      if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
      return {
        doc: (gatewayId: string) => ({
          collection: (sub: string) => {
            if (sub !== "assignments") throw new Error(`unexpected subcollection ${sub}`);
            return {
              doc: (uid: string) => ({
                get: async () => {
                  const data = store[gatewayId]?.[uid];
                  return { exists: !!data, data: () => data };
                },
              }),
              get: async () => ({
                docs: Object.entries(store[gatewayId] ?? {}).map(([uid, data]) => ({
                  id: uid,
                  data: () => data,
                })),
              }),
            };
          },
        }),
      };
    }),
  };
  return { db, store };
}

const ASSIGNMENT = {
  uid: "uid-alice",
  slug: "alice",
  gatewayId: "default",
  source: "migrate-customer",
  state: "quiescing",
  epoch: 4,
  createdAt: 90,
  updatedAt: 100,
  updatedByOperationId: "op-1",
};

describe("readAssignmentDocsForGateway", () => {
  it("retains a bound forward marker and rejects malformed or mismatched authority", async () => {
    const marker = { operationId: "op-1", targetPodUid: "target-1", receivingPodUid: "target-1" };
    const { db } = mkAssignmentDb({ "default/uid-alice": { ...ASSIGNMENT, sharedSurgeForwardRecovery: marker } });
    expect(await readAssignmentDocsForGateway(db as never, "default")).toEqual([{ ...ASSIGNMENT, sharedSurgeForwardRecovery: marker }]);
    for (const bad of [{ operationId: "op-2", targetPodUid: "target-1" }, { operationId: "op-1", targetPodUid: "" }]) {
      expect(() => assignmentDoc.parseAssignmentDoc("u1", { ...ASSIGNMENT, sharedSurgeForwardRecovery: bad })).toThrow("invalid Shared surge");
    }
  });

  it("returns parsed assignment docs for the gateway", async () => {
    const { db } = mkAssignmentDb({ "default/uid-alice": ASSIGNMENT });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([ASSIGNMENT]);
  });

  it("dates a legacy doc without createdAt from its updatedAt", async () => {
    const { createdAt: _createdAt, ...legacy } = ASSIGNMENT;
    const { db } = mkAssignmentDb({ "default/uid-alice": legacy });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([{ ...ASSIGNMENT, createdAt: 100 }]);
  });

  it("returns [] for a gateway with no assignments", async () => {
    const { db } = mkAssignmentDb();
    expect(await readAssignmentDocsForGateway(db as never, "default")).toEqual([]);
  });

  it("skips malformed docs (missing slug or unknown source)", async () => {
    const { db } = mkAssignmentDb({
      "default/uid-bad": { gatewayId: "default", source: "onboarding" },
      "default/uid-retired-source": { ...ASSIGNMENT, source: "rollout" },
      "default/uid-alice": ASSIGNMENT,
    });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([ASSIGNMENT]);
  });

  it("ignores stray revision-era fields on a legacy doc — never drops it", async () => {
    const { db } = mkAssignmentDb({
      "default/uid-alice": { ...ASSIGNMENT, revisionId: "default-r2", release: 2 },
    });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([ASSIGNMENT]);
  });

  it("defaults a doc with no state/epoch to serving at epoch 0 — never drops it", async () => {
    const { uid: _uid, state: _s, epoch: _e, ...bare } = ASSIGNMENT;
    const { db } = mkAssignmentDb({ "default/uid-alice": bare });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([{ ...ASSIGNMENT, state: "serving", epoch: 0 }]);
  });

  it("normalizes junk state/epoch values to the safe defaults", async () => {
    const { db } = mkAssignmentDb({
      "default/uid-alice": { ...ASSIGNMENT, state: "draining", epoch: -3 },
    });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([{ ...ASSIGNMENT, state: "serving", epoch: 0 }]);
  });
});

describe("parseAssignmentDoc handoff progress", () => {
  const base = { slug: "alice", gatewayId: "shared-0", source: "onboarding", state: "quiescing" };
  const record = { phase: "gate-source", status: "running", at: 1_000, migrationId: "surge-shared-0-pod", slug: "alice", source: "pod-old" };

  it("keeps well-formed handoff progress records and drops malformed entries", () => {
    const parsed = assignmentDoc.parseAssignmentDoc("u1", { ...base, handoffProgress: [record, { phase: "x" }, "junk"] });
    expect(parsed?.handoffProgress).toEqual([record]);
  });

  it("omits the field when the document has none", () => {
    expect(assignmentDoc.parseAssignmentDoc("u1", base)).not.toHaveProperty("handoffProgress");
  });
});

describe("readAssignmentDoc", () => {
  it("reads a single assignment by uid", async () => {
    const { db } = mkAssignmentDb({ "default/uid-alice": ASSIGNMENT });
    expect(await readAssignmentDoc(db as never, "default", "uid-alice")).toEqual(ASSIGNMENT);
  });

  it("returns null when absent", async () => {
    const { db } = mkAssignmentDb();
    expect(await readAssignmentDoc(db as never, "default", "uid-alice")).toBeNull();
  });
});

describe("assignment write surface", () => {
  it("does not export the superseded non-atomic writer", () => {
    expect("writeAssignmentDoc" in assignmentDoc).toBe(false);
  });
});
