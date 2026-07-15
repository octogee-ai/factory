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
        if (op !== "==") throw new Error(`unsupported query operator ${op}`);
        const docs = Object.entries(store)
          .filter(([path, data]) =>
            path.startsWith(`${name}/`) &&
            !path.slice(name.length + 1).includes("/") &&
            data?.[field] === value,
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

function v2CutoverSeed(observedAt: number): Record<string, Record<string, unknown>> {
  return {
    "gateways/default": {
      desiredRelease: 2,
      liveRevisionId: "default-r1",
      roll: {
        operationId: "roll-1",
        targetRevisionId: "default-r2",
        toRelease: 2,
        systemConfigRoll: {
          phase: "promoted",
          sourceRevisionId: "default-r1",
          targetRevisionId: "default-r2",
          migrationId: "roll-config-roll-1",
          checkpointCommit: "a".repeat(40),
          configHash: "b".repeat(64),
          freezeRef: "refs/octogee/system-config/freeze/default-r1",
          freezeObject: "e".repeat(40),
          candidateCommit: "c".repeat(40),
          candidateHash: "d".repeat(64),
          candidateRef: "refs/octogee/system-config/candidate/default-r2",
          runtimeConfigHash: "f".repeat(64),
          observedRevisionId: "default-r2",
          targetStartedAt: 80,
          imageTag: "release-2",
          buildSha: "build-2",
          openclawVersion: "2026.7.1",
          provenAt: 100,
          promotedCommit: "c".repeat(40),
          promotedAt: 110,
        },
      },
    },
    "glmGateways/default-r2": {
      docKind: "revision",
      gateway: "default",
      revisionId: "default-r2",
      release: 2,
      helm: { imageTag: "release-2" },
      heartbeat: {
        status: "ready",
        lastHeartbeatAt: observedAt,
        startedAt: 80,
        version: "build-2",
        configStatus: {
          controlProtocol: { protocol: "durable-openclaw-config", version: 2 },
          observedAt,
          runtimeReady: true,
          openclawVersion: "2026.7.1",
          bootRole: "target-candidate",
          controlOwner: {
            migrationId: "roll-config-roll-1",
            sourceRevisionId: "default-r1",
            targetRevisionId: "default-r2",
          },
          checkpointCommit: "a".repeat(40),
          configHash: "b".repeat(64),
          candidateCommit: "c".repeat(40),
          candidateHash: "d".repeat(64),
        },
      },
    },
    "gateways/default/assignments/uid-a": {
      uid: "uid-a",
      revisionId: "default-r1",
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
    toGatewayId: "default",
    fromGatewayId: "default",
    flipMirror: false,
    assignment: {
      revisionId: "default-r2",
      release: 2,
      source: "rollout",
      updatedByOperationId: "roll-1",
    },
    rollFence: {
      operationId: "roll-1",
      targetRevisionId: "default-r2",
      targetRelease: 2,
      sourceRevisionId: "default-r1",
      sourceEpoch: 4,
    },
  });
}

describe("installed @octogee/core runtime", () => {
  it("ships the ref-safe v2 identity and accepts its exact fresh target proof", async () => {
    const { db, store } = makeTxnDb(v2CutoverSeed(100_000));

    await cutover(db as unknown as FleetStateFirestore, 100_000);

    expect(store["gateways/default/assignments/uid-a"]).toMatchObject({
      revisionId: "default-r2",
      epoch: 5,
    });
  });

  it("rejects a target proof that is stale at the transaction boundary", async () => {
    const { db } = makeTxnDb(v2CutoverSeed(1));

    await expect(
      cutover(db as unknown as FleetStateFirestore, 1_000_000),
    ).rejects.toThrow(/target candidate proof changed/i);
  });

  it("rejects the old colon-bearing v2 migration identity", async () => {
    const seed = v2CutoverSeed(100_000);
    const root = seed["gateways/default"];
    const roll = root.roll as Record<string, unknown>;
    seed["gateways/default"] = {
      ...root,
      roll: {
        ...roll,
        systemConfigRoll: {
          ...(roll.systemConfigRoll as Record<string, unknown>),
          migrationId: "roll-config:roll-1",
        },
      },
    };
    const { db } = makeTxnDb(seed);

    await expect(
      cutover(db as unknown as FleetStateFirestore, 100_000),
    ).rejects.toThrow(/not durably promoted/i);
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
