import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Firestore } from "firebase-admin/firestore";

import { addAdminFleetRoutes } from "./admin-fleet-router.js";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

// ── Path-based in-memory Firestore ─────────────────────────────────────────
// Supports the exact surface the release endpoints touch: doc get/set(merge)/
// update, subcollections, collection get/where("in")/orderBy/add, and auto-ids.
function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

interface TestRouterOptions {
  synchronizeFirstTwoReadsOf?: string;
  failTransactions?: boolean;
  beforeFirstTransaction?: (store: Map<string, Record<string, unknown>>) => void;
  provisionGatewayAuthSecret?: (input: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => Promise<unknown>;
}

function makeDb(
  seed: Record<string, Record<string, unknown>> = {},
  opts: TestRouterOptions = {},
) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
  let auto = 0;
  let synchronizedReads = 0;
  let releaseSynchronizedReads: (() => void) | null = null;
  const synchronizedReadsReady = new Promise<void>((resolve) => {
    releaseSynchronizedReads = resolve;
  });

  function childrenOf(prefix: string) {
    const out: Array<{ id: string; path: string }> = [];
    for (const path of store.keys()) {
      if (!path.startsWith(`${prefix}/`)) continue;
      const rest = path.slice(prefix.length + 1);
      if (rest.includes("/")) continue;
      out.push({ id: rest, path });
    }
    return out;
  }

  function docRef(path: string): Record<string, unknown> {
    const id = path.split("/").pop() as string;
    return {
      id,
      get: async () => {
        if (path === opts.synchronizeFirstTwoReadsOf && synchronizedReads < 2) {
          synchronizedReads += 1;
          if (synchronizedReads === 2) releaseSynchronizedReads?.();
          await synchronizedReadsReady;
        }
        return {
          id,
          exists: store.has(path),
          data: () => store.get(path),
        };
      },
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        if (opts?.merge && store.has(path)) {
          store.set(path, { ...store.get(path), ...data });
        } else {
          store.set(path, { ...data });
        }
      },
      update: async (data: Record<string, unknown>) => {
        if (!store.has(path)) throw new Error(`update of non-existent doc ${path}`);
        store.set(path, { ...store.get(path), ...data });
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
    };
  }

  function collectionRef(prefix: string): Record<string, unknown> {
    function query(
      filters: Array<{ field: string; op: string; value: unknown }>,
      order: { field: string; dir: string } | null,
    ): Record<string, unknown> {
      return {
        where: (field: string, op: string, value: unknown) =>
          query([...filters, { field, op, value }], order),
        orderBy: (field: string, dir = "asc") => query(filters, { field, dir }),
        limit: () => query(filters, order),
        get: async () => {
          let docs = childrenOf(prefix).map((c) => ({
            id: c.id,
            exists: true,
            data: () => store.get(c.path),
          }));
          for (const f of filters) {
            docs = docs.filter((d) => {
              const v = valueAtPath(d.data() ?? {}, f.field);
              if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
              return v === f.value;
            });
          }
          if (order) {
            docs.sort((a, b) => {
              const av = (a.data() ?? {})[order.field] as number;
              const bv = (b.data() ?? {})[order.field] as number;
              const cmp = av < bv ? -1 : av > bv ? 1 : 0;
              return order.dir === "desc" ? -cmp : cmp;
            });
          }
          return { docs, size: docs.length };
        },
        add: async (data: Record<string, unknown>) => {
          const gid = `auto-${++auto}`;
          store.set(`${prefix}/${gid}`, { ...data });
          return { id: gid };
        },
        doc: (docId?: string) => docRef(`${prefix}/${docId ?? `auto-${++auto}`}`),
      };
    }
    return query([], null);
  }

  // Serialized, buffered transactions — emulates Firestore's serializable
  // isolation for conflicting commits (the outcome an optimistic retry produces):
  // bodies run one at a time, and buffered writes apply only if the body
  // completes (a throw leaves the store untouched — all-or-nothing).
  let txnLock: Promise<unknown> = Promise.resolve();
  let firstTransactionStarted = false;
  async function runTransaction<T>(
    body: (txn: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => void;
      update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const run = txnLock.then(async () => {
      if (opts.failTransactions) {
        throw new Error("simulated transaction failure");
      }
      if (!firstTransactionStarted) {
        firstTransactionStarted = true;
        opts.beforeFirstTransaction?.(store);
      }
      const writes: Array<() => Promise<void>> = [];
      const txn = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => {
          writes.push(() => ref.set(data, opts));
        },
        update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => {
          writes.push(() => ref.update(data));
        },
      };
      const result = await body(txn as never);
      for (const w of writes) await w();
      return result;
    });
    txnLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const db = {
    collection: (name: string) => collectionRef(name),
    doc: (path: string) => docRef(path),
    runTransaction,
    batch: () => {
      const ops: Array<() => Promise<void>> = [];
      const b = {
        set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => {
          ops.push(() => ref.set(data, opts));
          return b;
        },
        update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => {
          ops.push(() => ref.update(data));
          return b;
        },
        commit: async () => {
          for (const op of ops) await op();
        },
      };
      return b;
    },
  } as unknown as Firestore;

  return { db, store };
}

function mkApp(
  seed?: Record<string, Record<string, unknown>>,
  opts?: TestRouterOptions,
) {
  const { db, store } = makeDb(seed, opts);
  const app = express();
  app.use(express.json());
  addAdminFleetRoutes(app, {
    db,
    logger: { info: vi.fn(), warn: vi.fn() },
    workspaceSlugsForUser: (data) => (data.username ? [data.username] : []),
    provisionGatewayAuthSecret: opts?.provisionGatewayAuthSecret
      ? vi.fn((input) => opts.provisionGatewayAuthSecret!(input))
      : vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    deleteAuthUserTolerantOfMissing: vi.fn(async () => undefined),
  });
  return { app, store };
}

function opsIn(store: Map<string, Record<string, unknown>>, kind: string) {
  return [...store.entries()]
    .filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`))
    .map(([, data]) => data)
    .filter((d) => d.kind === kind);
}

// Seeds a gateway already on the durable root + immutable release schema.
function seedNewSchemaGateway(
  id: string,
  payload: ReleasePayload,
  gatewayOverrides: Record<string, unknown> = {},
): Record<string, Record<string, unknown>> {
  const config = {
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...gatewayOverrides,
  };
  return {
    [`gateways/${id}`]: {
      gatewayId: id,
      createdAt: 1000,
      createdBy: "op",
      updatedAt: 1000,
      updatedBy: "op",
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      liveRevisionId: null,
      trafficRevisionId: null,
      desiredStatus: "running",
      roll: null,
      ...config,
    },
    [`gateways/${id}/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]: {
      gatewayId: id,
      release: 1,
      createdAt: 1000,
      createdBy: "op",
      sourceRelease: null,
      note: null,
      payloadHash: releasePayloadHash(payload),
      payload,
    },
  };
}

function sharedPayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: REPO,
    imageTag: "abc1234",
    ...overrides,
  };
}

function readyHeartbeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const observedAt = Date.now();
  return {
    status: "ready",
    lastHeartbeatAt: observedAt,
    version: "abc1234",
    openclawVersion: "2026.7.1",
    startedAt: observedAt - 1_000,
    mountedCustomers: [],
    configStatus: {
      controlProtocol: {
        protocol: "durable-openclaw-config",
        version: 2,
      },
      observedAt,
      runtimeReady: true,
      openclawVersion: "2026.7.1",
      freezeState: "unfrozen",
      bootRole: "normal",
      controlOwner: null,
      candidateCommit: null,
      candidateHash: null,
    },
    ...overrides,
  };
}

function seedServingGateway(
  id: string,
  payload: ReleasePayload,
  heartbeat: Record<string, unknown> = readyHeartbeat(),
  gatewayOverrides: Record<string, unknown> = {},
): Record<string, Record<string, unknown>> {
  const seed = seedNewSchemaGateway(id, payload, gatewayOverrides);
  seed[`gateways/${id}`] = {
    ...seed[`gateways/${id}`],
    liveRelease: 1,
    liveRevisionId: `${id}-r1`,
    trafficRevisionId: `${id}-r1`,
  };
  seed[`${GLM_GATEWAYS_COLLECTION}/${id}-r1`] = {
    docKind: "revision",
    revisionId: `${id}-r1`,
    gateway: id,
    release: 1,
    rollRole: "serving",
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    retiredAt: null,
    retireReason: null,
    helm: {},
    heartbeat,
    lastError: { message: null, at: null },
  };
  return seed;
}

beforeEach(() => vi.stubEnv("GATEWAY_SERVICE_ACCOUNT", "gw@octogee.iam.gserviceaccount.com"));
afterEach(() => vi.unstubAllEnvs());

describe("POST /gateways — creates only the durable root and immutable release", () => {
  it("rejects an invalid artifact tag before creating a durable release", async () => {
    const { app, store } = mkApp();

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha", imageRepository: REPO, imageTag: "latest" })
      .expect(400);

    expect(store.get("gateways/alpha")).toBeUndefined();
    expect(store.get(`gateways/alpha/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
  });

  it("writes gateways/{id}, release 1, and an add-gateway op without a bare glm desired doc", async () => {
    const { app, store } = mkApp();

    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha", imageRepository: REPO, imageTag: "abc1234" })
      .expect(202);
    expect(res.body).toMatchObject({ gatewayId: "alpha" });

    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/alpha`)).toBeUndefined();

    // New durable identity.
    const gw = store.get("gateways/alpha");
    expect(gw).toMatchObject({
      gatewayId: "alpha",
      latestRelease: 1,
      desiredRelease: 1,
      desiredStatus: "running",
      roll: null,
      legacyBackfill: null,
      configSchemaVersion: 1,
      gatewayClass: "shared",
      sizingTier: null,
    });

    // Immutable release 1.
    const rel = store.get(`gateways/alpha/${GATEWAY_RELEASES_SUBCOLLECTION}/1`);
    expect(rel).toMatchObject({ release: 1, sourceRelease: null });
    expect(rel?.payload).toEqual({
      imageRepository: REPO,
      imageTag: "abc1234",
    });
    expect(rel?.payloadHash).toBe(releasePayloadHash(rel?.payload as ReleasePayload));

    expect(opsIn(store, "add-gateway")).toHaveLength(1);
  });

  it("does not leave a bare desired doc when durable-root creation fails atomically", async () => {
    const { app, store } = mkApp({}, { failTransactions: true });

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha", imageRepository: REPO, imageTag: "abc1234" })
      .expect(500);

    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/alpha`)).toBeUndefined();
    expect(store.get("gateways/alpha")).toBeUndefined();
    expect(store.get(`gateways/alpha/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
  });

  it("rejects an invalid new gatewayId (reserved -blue/-green) via isValidNewGatewayId", async () => {
    const { app } = mkApp();
    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha-blue", imageRepository: REPO, imageTag: "abc1234" });
    expect(res.status).toBe(400);
  });

  it("rejects gateway-scoped BYOSUB input instead of persisting credentials with a release", async () => {
    const { app } = mkApp();
    const res = await request(app).post("/gateways").send({
      gatewayId: "alpha",
      imageRepository: REPO,
      imageTag: "abc1234",
      byosub: { openai: { secretName: "forbidden" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/credential|BYOSUB/i);
  });
});

describe("POST /operator-gateway-reservations/:uid/fulfill", () => {
  it("rejects an invalid artifact tag before provisioning an operator gateway", async () => {
    const { app, store } = mkApp({
      "operatorGatewayReservations/uid-bender": {
        uid: "uid-bender",
        builderSlug: "bender",
        requestedSizingTier: "small",
        requestedAt: 1,
        status: "requested",
        billingStatus: "active",
      },
      "users/uid-bender": { username: "bender" },
    });

    await request(app)
      .post("/operator-gateway-reservations/uid-bender/fulfill")
      .send({ gatewayId: "bender", imageRepository: REPO, imageTag: "latest" })
      .expect(400);

    expect(store.get("gateways/bender")).toBeUndefined();
    expect(store.get(`gateways/bender/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
  });

  it("creates the durable root and artifact release in the fulfillment batch", async () => {
    const { app, store } = mkApp({
      "operatorGatewayReservations/uid-bender": {
        uid: "uid-bender",
        builderSlug: "bender",
        requestedSizingTier: "small",
        requestedAt: 1,
        status: "requested",
        billingStatus: "active",
      },
      "users/uid-bender": { username: "bender" },
    });

    await request(app)
      .post("/operator-gateway-reservations/uid-bender/fulfill")
      .send({ gatewayId: "bender", imageRepository: REPO, imageTag: "abc1234" })
      .expect(202);

    expect(store.get("gateways/bender")).toMatchObject({
      gatewayId: "bender",
      configSchemaVersion: 1,
      gatewayClass: "operator",
      ownerUid: "uid-bender",
      desiredStatus: "running",
    });
    expect(store.get(`gateways/bender/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)?.payload).toEqual({
      imageRepository: REPO,
      imageTag: "abc1234",
    });
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/bender`)).toBeUndefined();
  });

  it("preserves the reservation when auth-secret provisioning fails", async () => {
    const provisionGatewayAuthSecret = vi.fn(async () => {
      throw new Error("secret unavailable");
    });
    const { app, store } = mkApp({
      "operatorGatewayReservations/uid-bender": {
        uid: "uid-bender",
        builderSlug: "bender",
        requestedSizingTier: "small",
        requestedAt: 1,
        status: "requested",
        billingStatus: "active",
      },
      "users/uid-bender": { username: "bender" },
    }, { provisionGatewayAuthSecret });

    await request(app)
      .post("/operator-gateway-reservations/uid-bender/fulfill")
      .send({ gatewayId: "bender", imageRepository: REPO, imageTag: "abc1234" })
      .expect(502);

    expect(provisionGatewayAuthSecret).toHaveBeenCalledWith({
      gatewayId: "bender",
      gatewayServiceAccount: "gw@octogee.iam.gserviceaccount.com",
    });
    expect(store.get("gateways/bender")).toBeUndefined();
    expect(store.get(`gateways/bender/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
    expect(store.get("operatorGatewayReservations/uid-bender")).toMatchObject({
      status: "requested",
    });
  });

  it("does not overwrite release 1 when create wins the fulfillment preflight race", async () => {
    let releaseFulfillmentSecret!: () => void;
    const fulfillmentSecretReleased = new Promise<void>((resolve) => {
      releaseFulfillmentSecret = resolve;
    });
    let markFulfillmentSecretStarted!: () => void;
    const fulfillmentSecretStarted = new Promise<void>((resolve) => {
      markFulfillmentSecretStarted = resolve;
    });
    let provisionCount = 0;
    const provisionGatewayAuthSecret = vi.fn(async () => {
      provisionCount += 1;
      if (provisionCount === 1) {
        markFulfillmentSecretStarted();
        await fulfillmentSecretReleased;
      }
      return {};
    });
    const { app, store } = mkApp({
      "operatorGatewayReservations/uid-bender": {
        uid: "uid-bender",
        builderSlug: "bender",
        requestedSizingTier: "small",
        requestedAt: 1,
        status: "requested",
        billingStatus: "active",
      },
      "users/uid-bender": { username: "bender" },
    }, { provisionGatewayAuthSecret });

    const fulfillment = request(app)
      .post("/operator-gateway-reservations/uid-bender/fulfill")
      .send({ gatewayId: "bender", imageRepository: REPO, imageTag: "c0ffee1" })
      .then((response) => response);
    await fulfillmentSecretStarted;

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "bender", imageRepository: REPO, imageTag: "deadbee" })
      .expect(202);
    releaseFulfillmentSecret();

    await expect(fulfillment).resolves.toMatchObject({ status: 409 });

    expect(provisionGatewayAuthSecret).toHaveBeenCalledTimes(2);
    expect(store.get("gateways/bender")).toMatchObject({ gatewayClass: "shared" });
    expect(store.get(`gateways/bender/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)?.payload).toEqual({
      imageRepository: REPO,
      imageTag: "deadbee",
    });
    expect(store.get("operatorGatewayReservations/uid-bender")).toMatchObject({
      status: "requested",
    });
    expect(store.get("users/uid-bender")?.operatorGatewayReservation).toBeUndefined();
    expect(opsIn(store, "add-gateway")).toHaveLength(1);
  });
});

describe("admin target resolution", () => {
  it("rejects manual assignment when only a bare glm desired doc claims readiness", async () => {
    const { app } = mkApp({
      "users/uid-alice": { username: "alice" },
      [`${GLM_GATEWAYS_COLLECTION}/legacy`]: {
        gatewayId: "legacy",
        desiredStatus: "running",
        heartbeat: { status: "ready" },
      },
    });

    const res = await request(app)
      .post("/customers/uid-alice/assign")
      .send({ gatewayId: "legacy" });
    expect(res.status).toBe(404);
  });

  it("uses the durable root class and its exact live revision for manual assignment", async () => {
    const { app, store } = mkApp({
      ...seedServingGateway(
        "operator",
        sharedPayload(),
        undefined,
        {
          profile: "operator",
          gatewayClass: "operator",
          imageProfile: "operator",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          operatorAccess: { shellsEnabled: true, reason: "owned-runtime-gateway" },
        },
      ),
      "users/uid-alice": { username: "alice" },
    });

    const res = await request(app)
      .post("/customers/uid-alice/assign")
      .send({ gatewayId: "operator" })
      .expect(202);

    expect(res.body).toMatchObject({ gatewayProfile: "operator" });
    expect(store.get("gateways/operator/assignments/uid-alice")).toMatchObject({
      revisionId: "operator-r1",
      gatewayId: "operator",
    });
  });

  it("does not use a bare gateway heartbeat when the root's live revision is unavailable", async () => {
    const seed = seedNewSchemaGateway("target", sharedPayload());
    seed["gateways/target"] = {
      ...seed["gateways/target"],
      liveRelease: 1,
      liveRevisionId: "target-r1",
      trafficRevisionId: "target-r1",
    };
    seed[`${GLM_GATEWAYS_COLLECTION}/target`] = {
      gatewayId: "target",
      heartbeat: { status: "ready" },
    };
    seed["users/uid-alice"] = { username: "alice" };
    const { app } = mkApp(seed);

    const res = await request(app)
      .post("/customers/uid-alice/assign")
      .send({ gatewayId: "target" })
      .expect(409);

    expect(res.body).toMatchObject({ error: "target gateway not ready", status: "unknown" });
  });

  it("rejects operator activation when only a bare glm desired doc exists", async () => {
    const { app } = mkApp({
      "users/uid-alice": { username: "alice" },
      "operatorGatewayReservations/uid-alice": {
        uid: "uid-alice",
        builderSlug: "alice",
        gatewayId: "operator",
        status: "provisioning",
        billingStatus: "active",
      },
      [`${GLM_GATEWAYS_COLLECTION}/operator`]: {
        gatewayId: "operator",
        gatewayClass: "operator",
        ownerUid: "uid-alice",
        builderSlug: "alice",
        heartbeat: { status: "ready" },
      },
    });

    await request(app)
      .post("/operator-gateway-reservations/uid-alice/activate")
      .expect(404);
  });
});

describe("POST /gateways/:id/releases — cut release n+1 from prev + patch", () => {
  it.each(["source", "target"])(
    "refuses to mutate a %s gateway root while an ordinary customer migration owns it",
    async (gatewayRole) => {
      const seed = seedNewSchemaGateway("beta", sharedPayload());
      seed[`${GLM_OPERATIONS_COLLECTION}/migration-live`] = {
        kind: "migrate-customer",
        status: "running",
        input: { fromGatewayId: "source", toGatewayId: "target" },
      };
      const gatewayId = gatewayRole;
      Object.assign(seed, seedNewSchemaGateway(gatewayId, sharedPayload()));
      const { app, store } = mkApp(seed);

      const res = await request(app)
        .post(`/gateways/${gatewayId}/releases`)
        .send({ imageTag: "deadbee" })
        .expect(409);

      expect(res.body.error).toMatch(/customer migration.*in flight/i);
      expect(store.get(`gateways/${gatewayId}`)).toMatchObject({
        latestRelease: 1,
        desiredRelease: 1,
      });
      expect(store.get(`gateways/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
      expect(opsIn(store, "rollout")).toHaveLength(0);
    },
  );

  it("refuses a source release while a pending migration is still pre-initialization", async () => {
    const seed = seedNewSchemaGateway("source", sharedPayload());
    seed[`${GLM_OPERATIONS_COLLECTION}/migration-pending`] = {
      kind: "migrate-customer",
      status: "pending",
      input: { fromGatewayId: "source", toGatewayId: "target" },
    };
    const { app, store } = mkApp(seed);

    await request(app)
      .post("/gateways/source/releases")
      .send({ imageTag: "deadbee" })
      .expect(409);

    expect(store.get("gateways/source")).toMatchObject({ latestRelease: 1, desiredRelease: 1 });
    expect(store.get(`gateways/source/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
    expect(opsIn(store, "rollout")).toHaveLength(0);
  });

  it("refuses a release while a durable unassigned-live migration owns the gateway", async () => {
    const seed = seedNewSchemaGateway("source", sharedPayload());
    seed[`${GLM_OPERATIONS_COLLECTION}/migration-live`] = {
      kind: "migrate-customer",
      status: "running",
      input: { toGatewayId: "target" },
      customerMigrationV2: {
        sourceGatewayId: "source",
        sourceRevisionId: "source-r1",
        sourceAssignmentMode: "unassigned-live",
        targetGatewayId: "target",
        targetRevisionId: "target-r1",
      },
    };
    const { app, store } = mkApp(seed);

    await request(app)
      .post("/gateways/source/releases")
      .send({ imageTag: "deadbee" })
      .expect(409);

    expect(store.get("gateways/source")).toMatchObject({
      latestRelease: 1,
      desiredRelease: 1,
    });
    expect(store.get(`gateways/source/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
    expect(opsIn(store, "rollout")).toHaveLength(0);
  });

  it("cuts release 2 on an image change, bumps desiredRelease, and queues a rollout op (legacy converge)", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));

    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "deadbee" })
      .expect(202);
    expect(res.body).toMatchObject({ gatewayId: "beta", release: 2 });
    expect(res.body.operationId).toBeTruthy();

    const rel2 = store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`);
    expect((rel2?.payload as ReleasePayload).imageTag).toBe("deadbee");
    expect(rel2).toMatchObject({ sourceRelease: 1, release: 2 });

    const gw = store.get("gateways/beta");
    expect(gw).toMatchObject({ latestRelease: 2, desiredRelease: 2 });

    expect(opsIn(store, "rollout")).toHaveLength(1);
    expect(opsIn(store, "rollout")[0]).toMatchObject({
      input: { gatewayId: "beta", imageTag: "deadbee" },
    });
  });

  it("rejects a no-op release (payload identical to the current release)", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "abc1234" })
      .expect(409);
    expect(res.body.error).toMatch(/no-op/);
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });

  it("refuses to cut from a legacy payload carrying mutable policy", async () => {
    const seed = seedNewSchemaGateway("beta", sharedPayload());
    const current = seed[`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]!;
    current.payload = { ...sharedPayload(), gatewayClass: "shared" };
    current.payloadHash = releasePayloadHash(current.payload as ReleasePayload);
    const { app, store } = mkApp(seed);

    await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "deadbee" })
      .expect(409)
      .expect(({ body }) => expect(body.error).toMatch(/invalid current release artifact/i));
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });

  it("rejects an invalid image tag (validation)", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "NOT VALID" });
    expect(res.status).toBe(400);
  });

  it("rejects a persistence spec outright (PVC gateways dropped)", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "deadbee", persistence: { enabled: true } });
    expect(res.status).toBe(400);
  });

  it("rejects credential state and unknown fields instead of silently dropping them", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const credential = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "deadbee", byosub: { provider: "openai" } });
    expect(credential.status).toBe(400);
    expect(credential.body.error).toMatch(/byosub/i);

    const unknown = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "deadbee", unexpected: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ fields: ["unexpected"] });
  });

  it("rejects a release for a retired gateway", async () => {
    const { app } = mkApp(
      seedNewSchemaGateway("beta", sharedPayload(), { desiredStatus: "retired" }),
    );
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "deadbee" });
    expect(res.status).toBe(409);
  });

  it("rejects when retirement wins after release preflight but before transactional append", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("retiring", sharedPayload()), {
      beforeFirstTransaction: (state) => {
        state.set("gateways/retiring", {
          ...state.get("gateways/retiring"),
          desiredStatus: "retired",
          retirementClaim: { operationId: "retire-1", version: 1 },
        });
      },
    });

    const res = await request(app)
      .post("/gateways/retiring/releases")
      .send({ imageTag: "deadbee" })
      .expect(409);

    expect(res.body.error).toMatch(/retir/i);
    expect(store.get(`gateways/retiring/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
    expect(opsIn(store, "rollout")).toHaveLength(0);
  });

  it("404s for a legacy gateway that has no GatewayDoc yet (not backfilled)", async () => {
    const { app } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/legacy`]: { gatewayId: "legacy", imageTag: "abc1234" },
      "gateways/legacy": { gatewayId: "legacy", status: "ready", mountedCustomers: [] },
    });
    const res = await request(app)
      .post("/gateways/legacy/releases")
      .send({ imageTag: "deadbee" });
    expect(res.status).toBe(404);
  });

  it("rejects config on the artifact endpoint and applies it with a root-only PATCH", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ modelBrokerLimits: { spendWindowUsd: 25 } })
      .expect(400);
    expect(res.body.error).toMatch(/PATCH/);
    await request(app)
      .patch("/gateways/beta")
      .send({ modelBrokerLimits: { spendWindowUsd: 25 } })
      .expect(202);
    expect(opsIn(store, "rollout")).toHaveLength(0);
    expect(store.get("gateways/beta")).toMatchObject({
      modelBrokerLimits: { spendWindowUsd: 25 },
    });
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/beta`)?.modelBrokerLimits).toBeUndefined();
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });

  it("rejects a negative model-broker limit", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ modelBrokerLimits: { spendWindowUsd: -1 } });
    expect(res.status).toBe(400);
  });

  it("404s when a root config PATCH names a non-existent builder owner uid", async () => {
    const { app } = mkApp(
      seedNewSchemaGateway(
        "bench",
        sharedPayload(),
        { gatewayClass: "builder", ownerUid: "uid-old" },
      ),
    );
    const res = await request(app)
      .patch("/gateways/bench")
      .send({ ownerUid: "uid-ghost" });
    expect(res.status).toBe(404);
  });
});

describe("POST /gateways/:id/releases/:n/rollback — cut a NEW release from release n's payload", () => {
  it("cuts release 3 whose payload equals release 1, never mutating history", async () => {
    // Seed gateway at release 2 (tag deadbee), with release 1 = abc1234 retained.
    const seed = seedNewSchemaGateway("gamma", sharedPayload({ imageTag: "deadbee" }));
    seed["gateways/gamma"].latestRelease = 2;
    seed["gateways/gamma"].desiredRelease = 2;
    seed[`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "gamma",
      release: 2,
      sourceRelease: 1,
      note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "deadbee" })),
      payload: sharedPayload({ imageTag: "deadbee" }),
    };
    seed[`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/1`] = {
      gatewayId: "gamma",
      release: 1,
      sourceRelease: null,
      note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "abc1234" })),
      payload: sharedPayload({ imageTag: "abc1234" }),
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).post("/gateways/gamma/releases/1/rollback").send({}).expect(202);
    expect(res.body).toMatchObject({ gatewayId: "gamma", release: 3, rolledBackFrom: 1 });

    const rel3 = store.get(`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/3`);
    expect((rel3?.payload as ReleasePayload).imageTag).toBe("abc1234");
    expect(rel3).toMatchObject({ sourceRelease: 1 });
    expect(rel3?.note).toMatch(/rollback to release 1/);

    // History untouched: release 1 and 2 unchanged.
    expect(
      (store.get(`gateways/gamma/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)?.payload as ReleasePayload)
        .imageTag,
    ).toBe("abc1234");
    expect(store.get("gateways/gamma")).toMatchObject({ latestRelease: 3, desiredRelease: 3 });
    expect(opsIn(store, "rollout")).toHaveLength(1);
  });

  it("rejects rolling back to the payload the gateway is already on (no-op)", async () => {
    const { app } = mkApp(seedNewSchemaGateway("gamma", sharedPayload()));
    const res = await request(app).post("/gateways/gamma/releases/1/rollback").send({});
    expect(res.status).toBe(409);
  });

  it("404s for an unknown release number", async () => {
    const { app } = mkApp(seedNewSchemaGateway("gamma", sharedPayload()));
    const res = await request(app).post("/gateways/gamma/releases/9/rollback").send({});
    expect(res.status).toBe(404);
  });
});

describe("release cut — transactional append + pointer advance (P1-A)", () => {
  it("rejects one of two concurrent artifact releases instead of appending a stale artifact", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("race", sharedPayload()), {
      synchronizeFirstTwoReadsOf: "gateways/race",
    });

    const [a, b] = await Promise.all([
      request(app).post("/gateways/race/releases").send({ imageTag: "deadbee" }),
      request(app).post("/gateways/race/releases").send({ imageTag: "c0ffee1" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const accepted = a.status === 202 ? a : b;
    const rejected = a.status === 409 ? a : b;
    expect(rejected.body.error).toMatch(/changed while this release was being cut/);

    const rel2 = store.get(`gateways/race/${GATEWAY_RELEASES_SUBCOLLECTION}/2`);
    const rel3 = store.get(`gateways/race/${GATEWAY_RELEASES_SUBCOLLECTION}/3`);
    expect(rel2).toBeDefined();
    expect(rel3).toBeUndefined();
    expect(rel2).toMatchObject({ sourceRelease: 1 });
    expect((rel2?.payload as ReleasePayload).imageTag).toBe(
      accepted === a ? "deadbee" : "c0ffee1",
    );
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/race`)).toBeUndefined();
    expect(store.get("gateways/race")).toMatchObject({ latestRelease: 2, desiredRelease: 2 });
  });

  it("refuses to overwrite an existing release doc (orphan-immunity)", async () => {
    const seed = seedNewSchemaGateway("orphan", sharedPayload());
    seed[`gateways/orphan/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "orphan",
      release: 2,
      sourceRelease: 1,
      note: "pre-existing",
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "0000001" })),
      payload: sharedPayload({ imageTag: "0000001" }),
    };
    const { app, store } = mkApp(seed);
    const res = await request(app).post("/gateways/orphan/releases").send({ imageTag: "deadbee" });
    expect(res.status).toBe(500);
    // The orphan is untouched and the pointer never advanced.
    expect(store.get(`gateways/orphan/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)?.note).toBe("pre-existing");
    expect(store.get("gateways/orphan")).toMatchObject({ latestRelease: 1 });
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/orphan`)).toBeUndefined();
  });

  it("rollback still cuts a NEW release through the transaction", async () => {
    const seed = seedNewSchemaGateway("rb", sharedPayload({ imageTag: "deadbee" }));
    seed["gateways/rb"].latestRelease = 2;
    seed["gateways/rb"].desiredRelease = 2;
    seed[`gateways/rb/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "rb",
      release: 2,
      sourceRelease: 1,
      note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "deadbee" })),
      payload: sharedPayload({ imageTag: "deadbee" }),
    };
    seed[`gateways/rb/${GATEWAY_RELEASES_SUBCOLLECTION}/1`] = {
      gatewayId: "rb",
      release: 1,
      sourceRelease: null,
      note: null,
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "abc1234" })),
      payload: sharedPayload({ imageTag: "abc1234" }),
    };
    const { app, store } = mkApp(seed);
    const res = await request(app).post("/gateways/rb/releases/1/rollback").send({}).expect(202);
    expect(res.body).toMatchObject({ release: 3, rolledBackFrom: 1 });
    expect(store.get("gateways/rb")).toMatchObject({ latestRelease: 3, desiredRelease: 3 });
    // History 1 and 2 untouched.
    expect((store.get(`gateways/rb/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)?.payload as ReleasePayload).imageTag).toBe("deadbee");
  });
});

describe("GET /gateways/:id/releases — lists retained release docs", () => {
  it("returns releases newest-first with gateway release bookkeeping", async () => {
    const seed = seedNewSchemaGateway("delta", sharedPayload());
    seed["gateways/delta"].latestRelease = 2;
    seed["gateways/delta"].desiredRelease = 2;
    seed[`gateways/delta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`] = {
      gatewayId: "delta",
      release: 2,
      createdAt: 2000,
      createdBy: "op",
      sourceRelease: 1,
      note: "bump",
      payloadHash: releasePayloadHash(sharedPayload({ imageTag: "deadbee" })),
      payload: sharedPayload({ imageTag: "deadbee" }),
    };
    const { app } = mkApp(seed);

    const res = await request(app).get("/gateways/delta/releases").expect(200);
    expect(res.body).toMatchObject({ gatewayId: "delta", latestRelease: 2, desiredRelease: 2 });
    expect(res.body.releases.map((r: { release: number }) => r.release)).toEqual([2, 1]);
    expect(res.body.releases[0]).toMatchObject({ revisionId: "delta-r2", note: "bump" });
  });

  it("404s for a gateway with no GatewayDoc", async () => {
    const { app } = mkApp();
    const res = await request(app).get("/gateways/nope/releases");
    expect(res.status).toBe(404);
  });
});

describe("POST /gateways/:id/rollout — compatibility wrapper (mounted-customer image rollout)", () => {
  it("upgrades the retired Mac artifact field before cutting the rollout release", async () => {
    const legacyPayload = {
      ...sharedPayload(),
      macOpsTokenProtocol: { version: 1 },
    };
    const seed = seedNewSchemaGateway("epsilon", sharedPayload());
    seed[`gateways/epsilon/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]!.payload = legacyPayload;
    seed[`gateways/epsilon/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]!.payloadHash =
      releasePayloadHash(legacyPayload as never);
    const { app, store } = mkApp(seed);

    await request(app)
      .post("/gateways/epsilon/rollout")
      .send({ imageTag: "deadbee" })
      .expect(202);

    expect(store.get(`gateways/epsilon/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toMatchObject({
      payload: sharedPayload(),
      payloadHash: releasePayloadHash(sharedPayload()),
    });
  });

  it("returns a typed conflict when the current artifact schema cannot be upgraded", async () => {
    const unsupportedPayload = { ...sharedPayload(), futureField: true };
    const seed = seedNewSchemaGateway("epsilon", sharedPayload());
    seed[`gateways/epsilon/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]!.payload = unsupportedPayload;
    seed[`gateways/epsilon/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]!.payloadHash =
      releasePayloadHash(unsupportedPayload as never);
    const { app } = mkApp(seed);

    const response = await request(app)
      .post("/gateways/epsilon/rollout")
      .send({ imageTag: "deadbee" })
      .expect(409);

    expect(response.body).toEqual({
      error: "release artifact schema is unsupported",
      code: "release-artifact-schema-unsupported",
      gatewayId: "epsilon",
      release: 1,
      reason: "unsupported-payload-schema",
    });
  });

  it("queues a rollout op AND cuts a release for a new-schema gateway with mounted customers", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway("epsilon", sharedPayload(), {
        status: "ready",
        mountedCustomers: ["chris"],
      }),
    );

    const res = await request(app)
      .post("/gateways/epsilon/rollout")
      .send({ imageTag: "deadbee" })
      .expect(202);
    expect(res.body).toMatchObject({ gatewayId: "epsilon", release: 2 });
    expect(res.body.operationId).toBeTruthy();

    // Legacy blue/green preserved: exactly one rollout op, NOT a direct imageTag
    // write onto glmGateways (which would poison desired state for mounted pods).
    expect(opsIn(store, "rollout")).toHaveLength(1);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/epsilon`)).toBeUndefined();

    // New schema recorded the roll as release 2.
    expect(
      (store.get(`gateways/epsilon/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)?.payload as ReleasePayload)
        .imageTag,
    ).toBe("deadbee");
  });

  it("cuts a release when the durable gateway has no legacy glm desired doc", async () => {
    const seed = seedNewSchemaGateway("epsilon", sharedPayload());
    delete seed[`${GLM_GATEWAYS_COLLECTION}/epsilon`];
    const { app, store } = mkApp(seed);

    const res = await request(app)
      .post("/gateways/epsilon/rollout")
      .send({ imageTag: "deadbee" })
      .expect(202);

    expect(res.body).toMatchObject({ gatewayId: "epsilon", release: 2 });
    expect(opsIn(store, "rollout")).toHaveLength(1);
    expect(
      (store.get(`gateways/epsilon/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)?.payload as ReleasePayload)
        .imageTag,
    ).toBe("deadbee");
  });

  it("PATCH imageTag on a new-schema gateway is refused toward release-cutting (P1-2)", async () => {
    const { app } = mkApp(
      seedNewSchemaGateway("epsilon", sharedPayload(), {
        status: "ready",
        mountedCustomers: ["chris"],
      }),
    );
    const res = await request(app)
      .patch("/gateways/epsilon")
      .send({ imageTag: "deadbee" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/release/);
  });

  it("rejects a config PATCH when only a legacy desired doc exists", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/legmount`]: {
        gatewayId: "legmount",
        imageTag: "abc1234",
        gatewayClass: "shared",
      },
      "gateways/legmount": {
        gatewayId: "legmount",
        status: "ready",
        mountedCustomers: ["chris"],
      },
    });
    const res = await request(app)
      .patch("/gateways/legmount")
      .send({ imageTag: "deadbee" });
    expect(res.status).toBe(404);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/legmount`)?.imageTag).toBe("abc1234");
  });

  it("rejects a rollout when only a legacy desired doc exists", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/legacy`]: {
        gatewayId: "legacy",
        imageRepository: REPO,
        imageTag: "abc1234",
        gatewayClass: "shared",
      },
      "gateways/legacy": { gatewayId: "legacy", status: "ready", mountedCustomers: [] },
    });
    const res = await request(app)
      .post("/gateways/legacy/rollout")
      .send({ imageTag: "deadbee" });
    expect(res.status).toBe(404);
    expect(opsIn(store, "rollout")).toHaveLength(0);
    expect(store.get(`gateways/legacy/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
  });
});

describe("PATCH /gateways/:id — updates durable lifecycle", () => {
  it("pauses only the durable root", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("zeta", sharedPayload()));
    await request(app).patch("/gateways/zeta").send({ desiredStatus: "paused" }).expect(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zeta`)).toBeUndefined();
    expect(store.get("gateways/zeta")?.desiredStatus).toBe("paused");
  });

  it("refuses a malformed durable root rather than mutating it", async () => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    seed["gateways/zeta"] = { ...seed["gateways/zeta"], gatewayId: "other" };
    const { app, store } = mkApp(seed);

    const res = await request(app).patch("/gateways/zeta").send({ sizingTier: "medium" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "gateway durable root is invalid", gatewayId: "zeta" });
    expect(store.get("gateways/zeta")?.sizingTier).toBeNull();
  });

  it.each(["pending", "running"])(
    "refuses root config mutation while a %s customer migration owns the gateway",
    async (status) => {
      const seed = seedNewSchemaGateway("zeta", sharedPayload());
      seed[`${GLM_OPERATIONS_COLLECTION}/migration-live`] = {
        kind: "migrate-customer",
        status,
        input: { fromGatewayId: "source", toGatewayId: "zeta" },
      };
      const { app, store } = mkApp(seed);

      const response = await request(app)
        .patch("/gateways/zeta")
        .send({ sizingTier: "medium" });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/customer migration.*in flight/i);
      expect(store.get("gateways/zeta")?.sizingTier).toBeNull();
    },
  );

  it("does not overwrite a retirement claim that lands after the route reads the root", async () => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    const { app, store } = mkApp(seed, {
      beforeFirstTransaction: (current) => {
        current.set("gateways/zeta", {
          ...current.get("gateways/zeta"),
          desiredStatus: "retired",
          retirementVersion: 1,
          retirementClaim: { operationId: "retire-1", version: 1 },
        });
      },
    });

    const response = await request(app)
      .patch("/gateways/zeta")
      .send({ desiredStatus: "paused" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "gateway has a current retirement claim",
      gatewayId: "zeta",
    });
    expect(store.get("gateways/zeta")?.desiredStatus).toBe("retired");
  });
});

describe("DELETE /gateways/:id — retirement claim", () => {
  it("atomically marks the root retired, binds the intent, and retains release history", async () => {
    const { app, store } = mkApp(seedServingGateway("zed", sharedPayload()));
    const res = await request(app).delete("/gateways/zed");
    expect(res.status).toBe(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zed`)).toBeUndefined();
    expect(store.get("gateways/zed")).toMatchObject({
      desiredStatus: "retired",
      retirementVersion: 1,
      retirementClaim: { operationId: "auto-1", version: 1 },
    });
    expect(opsIn(store, "retire-gateway")[0]?.input).toMatchObject({
      retirementClaimVersion: 1,
    });
    expect(store.get(`gateways/zed/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeDefined();
  });

  it.each(["pending", "running"])(
    "refuses retirement while a %s customer migration owns the empty target",
    async (status) => {
      const seed = seedServingGateway("target", sharedPayload());
      seed[`${GLM_OPERATIONS_COLLECTION}/migration-live`] = {
        kind: "migrate-customer",
        status,
        input: { fromGatewayId: "source", toGatewayId: "target" },
      };
      const { app, store } = mkApp(seed);

      const response = await request(app).delete("/gateways/target");

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/customer migration.*in flight/i);
      expect(store.get("gateways/target")?.desiredStatus).toBe("running");
      expect(opsIn(store, "retire-gateway")).toHaveLength(0);
    },
  );

  it("rejects a legacy-only gateway without a durable root", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/leg`]: { gatewayId: "leg", imageTag: "abc1234" },
      "gateways/leg": { gatewayId: "leg", status: "ready", mountedCustomers: [] },
    });
    const res = await request(app).delete("/gateways/leg");
    expect(res.status).toBe(404);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/leg`)?.desiredStatus).toBeUndefined();
  });

  it("retires a strict durable root with no bare glm desired doc", async () => {
    const { app, store } = mkApp(seedServingGateway("back", sharedPayload()));
    const res = await request(app).delete("/gateways/back");
    expect(res.status).toBe(202);
    expect(store.get("gateways/back")).toMatchObject({
      desiredStatus: "retired",
      retirementClaim: { version: 1 },
    });
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/back`)).toBeUndefined();
    // A retire-gateway op is queued for the controller.
    expect(opsIn(store, "retire-gateway")).toHaveLength(1);
  });

  it("refuses retirement when the root's exact live revision still mounts customers", async () => {
    const { app, store } = mkApp(
      seedServingGateway("mounted", sharedPayload(), {
        status: "ready",
        mountedCustomers: ["alice"],
      }),
    );

    const res = await request(app).delete("/gateways/mounted").expect(409);

    expect(res.body.mountedCustomers).toEqual(["alice"]);
    expect(store.get("gateways/mounted")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("refuses retirement while the durable root carries an unfinished release roll", async () => {
    const seed = seedServingGateway("rolling", sharedPayload());
    seed["gateways/rolling"] = {
      ...seed["gateways/rolling"],
      desiredRelease: 2,
      roll: {
        operationId: "roll-1",
        status: "migrating",
        fromRelease: 1,
        toRelease: 2,
        sourceRevisionId: "rolling-r1",
        targetRevisionId: "rolling-r2",
        acceptingNewAssignments: false,
        startedAt: 10,
        updatedAt: 10,
        error: null,
        flippedAt: null,
      },
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).delete("/gateways/rolling").expect(409);

    expect(res.body.error).toMatch(/release roll.*config obligation/i);
    expect(store.get("gateways/rolling")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("refuses retirement while the live revision reports an orphaned config-control obligation", async () => {
    const seed = seedServingGateway("frozen", sharedPayload(), {
      status: "ready",
      mountedCustomers: [],
      configStatus: {
        freezeState: "frozen",
        bootRole: "source-frozen",
        controlOwner: {
          migrationId: "roll-config-roll-1",
          sourceRevisionId: "frozen-r1",
          targetRevisionId: "frozen-r2",
        },
      },
    });
    const { app, store } = mkApp(seed);

    const res = await request(app).delete("/gateways/frozen").expect(409);

    expect(res.body.error).toMatch(/config-control obligation/i);
    expect(store.get("gateways/frozen")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("rejects when a roll starts after retirement preflight but before its transactional claim", async () => {
    const { app, store } = mkApp(seedServingGateway("racing-roll", sharedPayload()), {
      beforeFirstTransaction: (state) => {
        state.set("gateways/racing-roll", {
          ...state.get("gateways/racing-roll"),
          roll: { operationId: "roll-racing", systemConfigRoll: { phase: "freezing" } },
        });
      },
    });

    await request(app).delete("/gateways/racing-roll").expect(409);

    expect(store.get("gateways/racing-roll")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("rejects when config freeze starts after retirement preflight but before its transactional claim", async () => {
    const { app, store } = mkApp(seedServingGateway("racing-freeze", sharedPayload()), {
      beforeFirstTransaction: (state) => {
        const path = `${GLM_GATEWAYS_COLLECTION}/racing-freeze-r1`;
        const revision = state.get(path)!;
        state.set(path, {
          ...revision,
          heartbeat: {
            ...(revision.heartbeat as Record<string, unknown>),
            configStatus: { freezeState: "frozen", bootRole: "source-frozen" },
          },
        });
      },
    });

    await request(app).delete("/gateways/racing-freeze").expect(409);

    expect(store.get("gateways/racing-freeze")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("refuses retirement when a root points at missing live-revision telemetry", async () => {
    const seed = seedNewSchemaGateway("missing-live", sharedPayload());
    seed["gateways/missing-live"] = {
      ...seed["gateways/missing-live"],
      liveRelease: 1,
      liveRevisionId: "missing-live-r1",
      trafficRevisionId: "missing-live-r1",
    };
    seed[`${GLM_GATEWAYS_COLLECTION}/missing-live`] = {
      gatewayId: "missing-live",
      heartbeat: { status: "ready", mountedCustomers: ["alice"] },
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).delete("/gateways/missing-live").expect(409);

    expect(res.body.error).toContain("live revision telemetry");
    expect(store.get("gateways/missing-live")?.desiredStatus).toBe("running");
  });

  it("refuses (409) with the assigned slugs while assignment docs still exist", async () => {
    const { app, store } = mkApp({
      ...seedNewSchemaGateway("assn", sharedPayload()),
      "gateways/assn/assignments/u1": {
        uid: "u1",
        slug: "alice",
        gatewayId: "assn",
        revisionId: "assn-r1",
        release: 1,
        source: "onboarding",
      },
    });
    const res = await request(app).delete("/gateways/assn");
    expect(res.status).toBe(409);
    expect(res.body.assignedCustomers).toEqual(["alice"]);
    // Nothing was marked retired and no op was queued.
    expect(store.get("gateways/assn")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });
});

// P1-2: a payload-affecting PATCH on a new-schema gateway must not silently
// diverge legacy desired from the latest release; it is rejected toward the
// release-cutting endpoint. Legacy-only gateways keep the direct-PATCH path.
describe("PATCH /gateways/:id — payload fields on a new-schema gateway route through releases", () => {
  it("updates sizingTier directly on the durable root without cutting a release", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app).patch("/gateways/beta").send({ sizingTier: "medium" }).expect(202);
    expect(res.body.updated).toContain("sizingTier");
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/beta`)?.sizingTier).toBeUndefined();
    expect(store.get("gateways/beta")?.sizingTier).toBe("medium");
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });

  it("rejects an imageTag PATCH on a gateway with a GatewayDoc", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app).patch("/gateways/beta").send({ imageTag: "deadbee" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/release/);
  });

  it("rejects a sizingTier PATCH on a legacy-only gateway", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/leg`]: {
        gatewayId: "leg",
        imageTag: "abc1234",
        gatewayClass: "shared",
      },
      "gateways/leg": { gatewayId: "leg", status: "ready" },
    });
    const res = await request(app).patch("/gateways/leg").send({ sizingTier: "medium" });
    expect(res.status).toBe(404);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/leg`)?.sizingTier).toBeUndefined();
  });
});

describe("durable config PATCHes", () => {
  it("updates operator access and security context on the root without changing a legacy desired doc", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway(
        "bench",
        sharedPayload(),
        { gatewayClass: "builder", ownerUid: "uid-1", builderSlug: "chris" },
      ),
    );
    const res = await request(app)
      .patch("/gateways/bench")
      .send({
        operatorAccess: { shellsEnabled: true, reason: "debug" },
        gatewayContainerSecurityContext: { runAsNonRoot: true },
      });
    expect(res.status).toBe(202);
    const root = store.get("gateways/bench") as Record<string, unknown>;
    expect(root.operatorAccess).toEqual({ shellsEnabled: true, reason: "debug" });
    expect(root.gatewayContainerSecurityContext).toEqual({ runAsNonRoot: true });
    expect(root.ownerUid).toBe("uid-1");
    expect(root.builderSlug).toBe("chris");
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/bench`)?.operatorAccess).toBeUndefined();
  });

  it("applies explicit null-clears to the root without a release", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway("beta", sharedPayload(), { sizingTier: "small" }),
    );
    const res = await request(app)
      .patch("/gateways/beta")
      .send({ sizingTier: null });
    expect(res.status).toBe(202);
    const root = store.get("gateways/beta") as Record<string, unknown>;
    expect(root.sizingTier).toBeNull();
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });
});

// P1-5: endpoint gaps — create rejects persistence, and the rollout wrapper
// refuses a retired gateway.
describe("P1-5 endpoint gaps", () => {
  it("POST /gateways rejects a submitted persistence spec outright", async () => {
    const { app } = mkApp();
    const res = await request(app).post("/gateways").send({
      gatewayId: "pvc",
      imageRepository: REPO,
      imageTag: "abc1234",
      persistence: { enabled: true },
    });
    expect(res.status).toBe(400);
  });

  it("POST /gateways/:id/rollout refuses a retired new-schema gateway (no op, no release)", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway("beta", sharedPayload(), { desiredStatus: "retired" }),
    );
    const res = await request(app).post("/gateways/beta/rollout").send({ imageTag: "deadbee" });
    expect(res.status).toBe(409);
    expect(opsIn(store, "rollout")).toHaveLength(0);
    expect(store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)).toBeUndefined();
  });
});
