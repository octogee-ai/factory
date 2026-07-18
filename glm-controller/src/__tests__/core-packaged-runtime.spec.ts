import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  commitCutoverAtomic,
  type FleetStateDeps,
  type FleetStateFirestore,
} from "@octogee/core/fleet-state";
import {
  GatewayRetirementConflictError,
  claimGatewayRetirementAtomic,
} from "@octogee/core/gateway-retirement-claim";

function makeTxnDb(seed: Record<string, Record<string, unknown>>) {
  const store: Record<string, Record<string, unknown> | undefined> = { ...seed };
  const ref = (path: string) => ({
    __path: path,
    collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }),
  });
  const collection = (name: string) => ({
    doc: (id: string) => ref(`${name}/${id}`),
    where: (field: string, op: string, value: unknown) => ({
      __query: async () => {
        if (op !== "==" && op !== "in") throw new Error(`unsupported query operator ${op}`);
        const docs = Object.entries(store)
          .filter(([path, data]) =>
            path.startsWith(`${name}/`) &&
            !path.slice(name.length + 1).includes("/") &&
            (op === "=="
              ? data?.[field] === value
              : Array.isArray(value) && value.includes(data?.[field])),
          )
          .map(([path, data]) => ({
            id: path.slice(name.length + 1),
            exists: true,
            data: () => data,
          }));
        return { docs, size: docs.length };
      },
    }),
  });
  const db = {
    collection,
    runTransaction: async (body: (transaction: unknown) => Promise<unknown>) => {
      const writes: Array<() => void> = [];
      const transaction = {
        get: async (document: { __path?: string; __query?: () => Promise<unknown> }) => {
          if (document.__query) return document.__query();
          return {
            exists: store[document.__path!] !== undefined,
            data: () => store[document.__path!],
          };
        },
        set: (
          document: { __path: string },
          data: Record<string, unknown>,
          options?: { merge?: boolean },
        ) => writes.push(() => {
          store[document.__path] = options?.merge
            ? { ...store[document.__path], ...data }
            : { ...data };
        }),
        update: (document: { __path: string }, data: Record<string, unknown>) =>
          writes.push(() => {
            store[document.__path] = { ...store[document.__path], ...data };
          }),
        delete: (document: { __path: string }) =>
          writes.push(() => delete store[document.__path]),
      };
      const result = await body(transaction);
      for (const write of writes) write();
      return result;
    },
  };
  return { db, store };
}

function migrationCutoverSeed(): Record<string, Record<string, unknown>> {
  return {
    "users/uid-a": { provisioning: { openclaw: { gatewayId: "source" } } },
    "gateways/target": {
      gatewayId: "target",
      latestRelease: 2,
      desiredRelease: 2,
      liveRelease: 2,
      desiredStatus: "running",
    },
    "gateways/source/assignments/uid-a": {
      uid: "uid-a",
      slug: "alice",
      gatewayId: "source",
      state: "quiescing",
      epoch: 4,
    },
  };
}

function cutover(db: FleetStateFirestore, now: number) {
  const deps: FleetStateDeps = {
    db,
    serverTimestamp: () => now,
    now: () => new Date(now),
    log: vi.fn(),
  };
  return commitCutoverAtomic(deps, {
    uid: "uid-a",
    slug: "alice",
    toGatewayId: "target",
    fromGatewayId: "source",
    flipMirror: true,
    assignment: {
      source: "migrate-customer",
      updatedByOperationId: "op-1",
    },
  });
}

describe("installed @octogee/core runtime", () => {
  it("ships the lean atomic cutover: assignment move + epoch bump, no roll fence", async () => {
    const { db, store } = makeTxnDb(migrationCutoverSeed());

    await cutover(db as unknown as FleetStateFirestore, 100_000);

    expect(store["gateways/target/assignments/uid-a"]).toMatchObject({
      gatewayId: "target",
      state: "serving",
      epoch: 5,
      updatedByOperationId: "op-1",
    });
    expect(store["gateways/target/assignments/uid-a"]).not.toHaveProperty("revisionId");
    expect(store["gateways/source/assignments/uid-a"]).toBeUndefined();
    expect(store["users/uid-a"]).toMatchObject({
      "provisioning.openclaw.gatewayId": "target",
    });
  });

  it("refuses a cutover onto a retirement-claimed target at the transaction boundary", async () => {
    const seed = migrationCutoverSeed();
    seed["gateways/target"] = {
      ...seed["gateways/target"],
      retirementClaim: { operationId: "retire-1" },
    };
    const { db, store } = makeTxnDb(seed);

    await expect(
      cutover(db as unknown as FleetStateFirestore, 100_000),
    ).rejects.toThrow(/retirement claim/i);
    expect(store["gateways/source/assignments/uid-a"]).toMatchObject({ epoch: 4 });
  });

  it("ships the atomic retirement fence against candidate config obligations", async () => {
    const { db } = makeTxnDb({
      "gateways/bender": {
        gatewayId: "bender",
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: 1,
        liveRevisionId: "bender-r1",
        trafficRevisionId: "bender-r1",
        desiredStatus: "running",
        roll: null,
      },
      "glmGateways/bender-r1": {
        docKind: "revision",
        revisionId: "bender-r1",
        gateway: "bender",
        release: 1,
        lifecycle: "serving",
        heartbeat: {
          mountedCustomers: [],
          configStatus: { candidateCommit: "a".repeat(40) },
        },
      },
    });

    await expect(
      claimGatewayRetirementAtomic({
        db: db as unknown as Firestore,
        gatewayId: "bender",
        operationId: "retire-1",
        operation: { input: { gatewayId: "bender" } },
        now: 100,
        updatedBy: "operator",
      }),
    ).rejects.toBeInstanceOf(GatewayRetirementConflictError);
  });
});
