import { describe, expect, it, vi } from "vitest";
import * as assignmentDoc from "./assignment-doc.js";
import {
  mountsOnRevision,
  readAssignmentDoc,
  readAssignmentDocsForGateway,
  readLiveRevisionId,
  resolvePlacementRevision,
  deleteAssignmentDoc,
} from "./assignment-doc.js";
import type { GatewayDoc } from "@octogee/shared/types/gateway-releases";

// Firestore fake with a single gateways/{id}/assignments subcollection.
function mkAssignmentDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [key, data] of Object.entries(seed)) {
    const [gatewayId, uid] = key.split("/");
    (store[gatewayId] ??= {})[uid] = data;
  }
  const sets: Array<{ gatewayId: string; uid: string; data: Record<string, unknown> }> = [];
  const deletes: Array<{ gatewayId: string; uid: string }> = [];
  const db = {
    collection: vi.fn((name: string) => {
      if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
      return {
        doc: (gatewayId: string) => ({
          collection: (sub: string) => {
            if (sub !== "assignments") throw new Error(`unexpected subcollection ${sub}`);
            const bucket = () => (store[gatewayId] ??= {});
            return {
              doc: (uid: string) => ({
                get: async () => {
                  const data = store[gatewayId]?.[uid];
                  return { exists: !!data, data: () => data };
                },
                set: async (data: Record<string, unknown>) => {
                  bucket()[uid] = data;
                  sets.push({ gatewayId, uid, data });
                },
                delete: async () => {
                  delete store[gatewayId]?.[uid];
                  deletes.push({ gatewayId, uid });
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
  return { db, store, sets, deletes };
}

const ASSIGNMENT = {
  uid: "uid-alice",
  slug: "alice",
  gatewayId: "default",
  revisionId: "default-r2",
  release: 2,
  source: "rollout",
  state: "quiescing",
  epoch: 4,
  updatedAt: 100,
  updatedByOperationId: "op-1",
};

describe("readAssignmentDocsForGateway", () => {
  it("returns parsed assignment docs for the gateway", async () => {
    const { db } = mkAssignmentDb({ "default/uid-alice": ASSIGNMENT });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([ASSIGNMENT]);
  });

  it("returns [] for a gateway with no assignments", async () => {
    const { db } = mkAssignmentDb({});
    await expect(readAssignmentDocsForGateway(db as never, "default")).resolves.toEqual([]);
  });

  it("skips malformed docs (missing revisionId)", async () => {
    const { db } = mkAssignmentDb({
      "default/uid-alice": ASSIGNMENT,
      "default/uid-broken": { uid: "uid-broken", slug: "b", gatewayId: "default" },
    });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs.map((d) => d.uid)).toEqual(["uid-alice"]);
  });

  it("defaults a pre-PR7 doc (no state/epoch) to serving at epoch 0 — never drops it", async () => {
    const { state: _s, epoch: _e, ...preRoster } = ASSIGNMENT;
    const { db } = mkAssignmentDb({ "default/uid-alice": preRoster });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs).toEqual([{ ...preRoster, state: "serving", epoch: 0 }]);
  });

  it("normalizes junk state/epoch values to the safe defaults", async () => {
    const { db } = mkAssignmentDb({
      "default/uid-alice": { ...ASSIGNMENT, state: "draining", epoch: "9" },
    });
    const docs = await readAssignmentDocsForGateway(db as never, "default");
    expect(docs[0]).toMatchObject({ state: "serving", epoch: 0 });
  });
});

describe("readAssignmentDoc", () => {
  it("reads a single assignment by uid", async () => {
    const { db } = mkAssignmentDb({ "default/uid-alice": ASSIGNMENT });
    await expect(readAssignmentDoc(db as never, "default", "uid-alice")).resolves.toEqual(ASSIGNMENT);
  });

  it("returns null when absent", async () => {
    const { db } = mkAssignmentDb({});
    await expect(readAssignmentDoc(db as never, "default", "uid-alice")).resolves.toBeNull();
  });
});

describe("assignment write surface", () => {
  it("does not export the superseded non-atomic writer", () => {
    expect(assignmentDoc).not.toHaveProperty("writeAssignmentDoc");
  });
});

describe("deleteAssignmentDoc", () => {
  it("removes the assignment", async () => {
    const { db, store } = mkAssignmentDb({ "default/uid-alice": ASSIGNMENT });
    await deleteAssignmentDoc(db as never, "default", "uid-alice");
    expect(store.default["uid-alice"]).toBeUndefined();
  });
});

function gatewayDoc(overrides: Partial<GatewayDoc>): GatewayDoc {
  return {
    gatewayId: "default",
    createdAt: 0,
    createdBy: "op",
    updatedAt: 0,
    updatedBy: "op",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    liveRevisionId: "default-r1",
    trafficRevisionId: "default-r1",
    desiredStatus: "running",
    roll: null,
    ...overrides,
  };
}

describe("resolvePlacementRevision", () => {
  it("resolves to liveRevisionId when there is no active roll", () => {
    const res = resolvePlacementRevision({
      gateway: gatewayDoc({}),
      isRevisionReady: () => true,
    });
    expect(res).toEqual({ ok: true, revisionId: "default-r1", release: 1 });
  });

  it("resolves to the roll target when the roll is accepting new assignments", () => {
    const res = resolvePlacementRevision({
      gateway: gatewayDoc({
        roll: {
          operationId: "op-roll",
          status: "migrating",
          fromRelease: 1,
          toRelease: 2,
          sourceRevisionId: "default-r1",
          targetRevisionId: "default-r2",
          acceptingNewAssignments: true,
          startedAt: 0,
          updatedAt: 0,
          error: null,
        },
      }),
      isRevisionReady: () => true,
    });
    expect(res).toEqual({ ok: true, revisionId: "default-r2", release: 2 });
  });

  it("resolves to liveRevisionId while a roll is warming (not yet accepting)", () => {
    const res = resolvePlacementRevision({
      gateway: gatewayDoc({
        roll: {
          operationId: "op-roll",
          status: "warming",
          fromRelease: 1,
          toRelease: 2,
          sourceRevisionId: "default-r1",
          targetRevisionId: "default-r2",
          acceptingNewAssignments: false,
          startedAt: 0,
          updatedAt: 0,
          error: null,
        },
      }),
      isRevisionReady: () => true,
    });
    expect(res).toEqual({ ok: true, revisionId: "default-r1", release: 1 });
  });

  it("rejects when the gateway has no live revision", () => {
    const res = resolvePlacementRevision({
      gateway: gatewayDoc({ liveRevisionId: null, liveRelease: null }),
      isRevisionReady: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "no-live-revision" });
  });

  it("rejects when the resolved revision is not ready", () => {
    const res = resolvePlacementRevision({
      gateway: gatewayDoc({}),
      isRevisionReady: () => false,
    });
    expect(res).toEqual({ ok: false, reason: "revision-not-ready" });
  });
});

describe("mountsOnRevision", () => {
  it("legacy pod (no revision env) mounts every approved user — byte-identical to today", () => {
    expect(mountsOnRevision({ podRevisionId: "", liveRevisionId: null, assignmentRevisionId: null })).toBe(true);
    expect(mountsOnRevision({ podRevisionId: "", liveRevisionId: "default-r1", assignmentRevisionId: "default-r9" })).toBe(true);
  });

  it("an assigned user mounts ONLY on their assignment's revision", () => {
    expect(mountsOnRevision({ podRevisionId: "default-r1", liveRevisionId: "default-r1", assignmentRevisionId: "default-r1" })).toBe(true);
    expect(mountsOnRevision({ podRevisionId: "default-r2", liveRevisionId: "default-r1", assignmentRevisionId: "default-r1" })).toBe(false);
  });

  it("a gap user (no assignment doc) mounts ONLY on the live revision, never both", () => {
    expect(mountsOnRevision({ podRevisionId: "default-r1", liveRevisionId: "default-r1", assignmentRevisionId: null })).toBe(true);
    expect(mountsOnRevision({ podRevisionId: "default-r2", liveRevisionId: "default-r1", assignmentRevisionId: null })).toBe(false);
  });

  it("a gap user mounts when the live revision is unknown (pre-backfill safety = today)", () => {
    expect(mountsOnRevision({ podRevisionId: "default-r1", liveRevisionId: null, assignmentRevisionId: null })).toBe(true);
  });

  // Single-revision preservation: R == liveRevisionId, so assigned + gap both mount.
  it("single-revision gateway: assigned AND gap users both mount", () => {
    const R = "default-r1";
    expect(mountsOnRevision({ podRevisionId: R, liveRevisionId: R, assignmentRevisionId: R })).toBe(true);
    expect(mountsOnRevision({ podRevisionId: R, liveRevisionId: R, assignmentRevisionId: null })).toBe(true);
  });
});

describe("readLiveRevisionId", () => {
  function mkGatewayDocDb(doc: Record<string, unknown> | undefined) {
    return {
      collection: (name: string) => {
        if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
        return {
          doc: (_id: string) => ({
            get: async () => ({ exists: !!doc, data: () => doc }),
          }),
        };
      },
    };
  }

  it("returns the gateway's liveRevisionId", async () => {
    const db = mkGatewayDocDb({ gatewayId: "default", desiredRelease: 1, latestRelease: 1, desiredStatus: "running", liveRevisionId: "default-r1" });
    await expect(readLiveRevisionId(db as never, "default")).resolves.toBe("default-r1");
  });

  it("returns null when the gateway doc is absent (pre-backfill)", async () => {
    const db = mkGatewayDocDb(undefined);
    await expect(readLiveRevisionId(db as never, "default")).resolves.toBeNull();
  });
});
