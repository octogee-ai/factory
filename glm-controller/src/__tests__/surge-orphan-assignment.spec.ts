import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { pruneSurgeOrphanAssignments } from "../surge-orphan-assignment.js";
import type { SurgeAssignment } from "../surge-customer-handoff.js";

type Data = Record<string, unknown>;

function assignment(uid: string, slug: string): SurgeAssignment {
  return {
    uid,
    slug,
    state: "serving",
    epoch: 4,
    updatedByOperationId: null,
  };
}

function runtime(now: number, mountedCustomers: string[]): Data {
  return {
    gatewayId: "shared-a",
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: now - 1_000,
      mountedCustomers,
    },
  };
}

function fakeDb(seed: Record<string, Data>) {
  const store = new Map(Object.entries(seed));
  const ref = (path: string): any => ({
    path,
    collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }),
  });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (body: (transaction: any) => Promise<unknown>) => body({
      get: async (document: { path: string }) => ({
        exists: store.has(document.path),
        data: () => store.get(document.path),
      }),
      delete: (document: { path: string }) => store.delete(document.path),
      set: (document: { path: string }, data: Data) => store.set(document.path, data),
    }),
  } as unknown as Firestore;
  return { db, store };
}

describe("surge orphan assignment repair", () => {
  const now = 500_000;
  const orphan = assignment("uid-orphan", "smoke-dave-smoke");
  const valid = assignment("uid-valid", "alice");
  const orphanPath = "gateways/shared-a/assignments/uid-orphan";
  const validPath = "gateways/shared-a/assignments/uid-valid";
  const journalPath = "glmOperations/surge-prune-orphan-shared-a-uid-orphan-4";

  it.each([null, { phase: "dispatched" }])("retains an orphan assignment while restore is unresolved: %j", async (restoreFence) => {
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      "users/uid-orphan": { provisioning: { openclaw: { gatewayId: "shared-b", restoreFence } } },
      "glmGateways/shared-a": runtime(now, []),
    });
    const log = vi.fn();
    await expect(pruneSurgeOrphanAssignments({ db, gatewayId: "shared-a", assignments: [orphan], users: [], now, log })).resolves.toEqual([orphan]);
    expect(store.has(orphanPath)).toBe(true);
    expect(store.has(journalPath)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("restore"));
  });

  it.each([null, { phase: "dispatched" }])("retains an orphan assignment while source transfer is unresolved: %j", async (sourceTransferFence) => {
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      "users/uid-orphan": { provisioning: { openclaw: { gatewayId: "shared-b", sourceTransferFence } } },
      "glmGateways/shared-a": runtime(now, []),
    });
    const log = vi.fn();
    await expect(pruneSurgeOrphanAssignments({ db, gatewayId: "shared-a", assignments: [orphan], users: [], now, log })).resolves.toEqual([orphan]);
    expect(store.has(orphanPath)).toBe(true);
    expect(store.has(journalPath)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("restore"));
  });

  it("atomically removes and journals only the unmounted assignment whose user is absent", async () => {
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      [validPath]: { ...valid, gatewayId: "shared-a" },
      "users/uid-valid": { username: "alice" },
      "glmGateways/shared-a": runtime(now, []),
    });
    const log = vi.fn();

    await expect(pruneSurgeOrphanAssignments({
      db,
      gatewayId: "shared-a",
      assignments: [orphan, valid],
      users: [{ uid: "uid-valid", slug: "alice" }],
      now,
      log,
    })).resolves.toEqual([valid]);

    expect(store.has(orphanPath)).toBe(false);
    expect(store.get(validPath)).toMatchObject({ slug: "alice" });
    expect(store.get(journalPath)).toMatchObject({
      kind: "deprovision-customer",
      status: "succeeded",
      origin: "automatic",
      input: {
        uid: "uid-orphan",
        slug: "smoke-dave-smoke",
        gatewayId: "shared-a",
        epoch: 4,
        reason: "user-not-authoritative-runtime-unmounted",
      },
      output: { assignmentDeleted: true },
    });
    expect(log).toHaveBeenCalledOnce();
  });

  it("keeps an assignment if the user reappears before the repair transaction", async () => {
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      "users/uid-orphan": {
        username: "smoke-dave-smoke",
        provisioning: {
          openclaw: { gatewayId: "shared-a", slug: "smoke-dave-smoke" },
        },
      },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      db,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(store.has(orphanPath)).toBe(true);
    expect(store.has(journalPath)).toBe(false);
  });

  it("removes a stale source assignment after the user mirror moved elsewhere", async () => {
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      "users/uid-orphan": {
        username: "smoke-dave-smoke",
        provisioning: {
          openclaw: { gatewayId: "shared-b", slug: "smoke-dave-smoke" },
        },
      },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      db,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([]);

    expect(store.has(orphanPath)).toBe(false);
    expect(store.get(journalPath)).toMatchObject({
      status: "succeeded",
      input: { reason: "user-not-authoritative-runtime-unmounted" },
    });
  });

  it("removes an unmounted assignment when the authoritative slug changed", async () => {
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      "users/uid-orphan": {
        username: "dave-renamed",
        provisioning: {
          openclaw: { gatewayId: "shared-a", slug: "dave-renamed" },
        },
      },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      db,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [{ uid: "uid-orphan", slug: "dave-renamed" }],
      now,
      log: vi.fn(),
    })).resolves.toEqual([]);

    expect(store.has(orphanPath)).toBe(false);
    expect(store.get(journalPath)).toMatchObject({ status: "succeeded" });
  });

  it("keeps an orphan assignment while runtime telemetry still mounts its slug", async () => {
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      "glmGateways/shared-a": runtime(now, ["smoke-dave-smoke"]),
    });

    await expect(pruneSurgeOrphanAssignments({
      db,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(store.has(orphanPath)).toBe(true);
    expect(store.has(journalPath)).toBe(false);
  });

  it("keeps an unmounted orphan when the runtime proof is stale", async () => {
    const stale = runtime(now, []);
    (stale.heartbeat as Data).lastHeartbeatAt = 1;
    const { db, store } = fakeDb({
      [orphanPath]: { ...orphan, gatewayId: "shared-a" },
      "glmGateways/shared-a": stale,
    });

    await expect(pruneSurgeOrphanAssignments({
      db,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(store.has(orphanPath)).toBe(true);
    expect(store.has(journalPath)).toBe(false);
  });

  it("keeps a malformed assignment without throwing or journaling a deletion", async () => {
    const { db, store } = fakeDb({
      [orphanPath]: { malformed: true },
      "glmGateways/shared-a": runtime(now, []),
    });

    await expect(pruneSurgeOrphanAssignments({
      db,
      gatewayId: "shared-a",
      assignments: [orphan],
      users: [],
      now,
      log: vi.fn(),
    })).resolves.toEqual([orphan]);

    expect(store.has(orphanPath)).toBe(true);
    expect(store.has(journalPath)).toBe(false);
  });
});
