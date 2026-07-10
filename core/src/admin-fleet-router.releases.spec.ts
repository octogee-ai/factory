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
import { releasePayloadFromCreate } from "./gateway-release-cut.js";

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

function makeDb(
  seed: Record<string, Record<string, unknown>> = {},
  opts: { synchronizeFirstTwoReadsOf?: string } = {},
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
  async function runTransaction<T>(
    body: (txn: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => void;
      update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const run = txnLock.then(async () => {
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
  opts?: { synchronizeFirstTwoReadsOf?: string },
) {
  const { db, store } = makeDb(seed, opts);
  const app = express();
  app.use(express.json());
  addAdminFleetRoutes(app, {
    db,
    logger: { info: vi.fn(), warn: vi.fn() },
    workspaceSlugsForUser: (data) => (data.username ? [data.username] : []),
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
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

// Seeds a gateway already on the new schema: legacy glmGateways desired doc +
// GatewayDoc + release 1 (payload).
function seedNewSchemaGateway(
  id: string,
  payload: ReleasePayload,
  gatewayOverrides: Record<string, unknown> = {},
): Record<string, Record<string, unknown>> {
  return {
    [`${GLM_GATEWAYS_COLLECTION}/${id}`]: {
      gatewayId: id,
      gateway: id,
      imageRepository: payload.imageRepository,
      imageTag: payload.imageTag,
      gatewayClass: payload.gatewayClass,
      imageProfile: payload.imageProfile,
      desiredStatus: "running",
    },
    [`gateways/${id}`]: {
      gatewayId: id,
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      desiredStatus: "running",
      roll: null,
      ...gatewayOverrides,
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
  return releasePayloadFromCreate({
    imageRepository: REPO,
    imageTag: "abc1234",
    gatewayClass: "shared",
    imageProfile: "standard",
    ...overrides,
  });
}

beforeEach(() => vi.stubEnv("GATEWAY_SERVICE_ACCOUNT", "gw@octogee.iam.gserviceaccount.com"));
afterEach(() => vi.unstubAllEnvs());

describe("POST /gateways — dual-writes new gateways+release docs AND the legacy glmGateways desired doc", () => {
  it("writes gateways/{id}, release 1, the legacy desired doc, and an add-gateway op", async () => {
    const { app, store } = mkApp();

    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha", imageRepository: REPO, imageTag: "abc1234" })
      .expect(202);
    expect(res.body).toMatchObject({ gatewayId: "alpha" });

    // Legacy desired doc (Cowboy still reconciles this in PR2).
    const legacy = store.get(`${GLM_GATEWAYS_COLLECTION}/alpha`);
    expect(legacy).toMatchObject({ gatewayId: "alpha", imageTag: "abc1234", desiredStatus: "running" });

    // New durable identity.
    const gw = store.get("gateways/alpha");
    expect(gw).toMatchObject({
      gatewayId: "alpha",
      latestRelease: 1,
      desiredRelease: 1,
      desiredStatus: "running",
      roll: null,
    });

    // Immutable release 1.
    const rel = store.get(`gateways/alpha/${GATEWAY_RELEASES_SUBCOLLECTION}/1`);
    expect(rel).toMatchObject({ release: 1, sourceRelease: null });
    expect((rel?.payload as ReleasePayload).imageTag).toBe("abc1234");
    expect(rel?.payloadHash).toBe(releasePayloadHash(sharedPayload()));

    // Legacy converge op.
    expect(opsIn(store, "add-gateway")).toHaveLength(1);
  });

  it("rejects an invalid new gatewayId (reserved -blue/-green) via isValidNewGatewayId", async () => {
    const { app } = mkApp();
    const res = await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha-blue", imageRepository: REPO, imageTag: "abc1234" });
    expect(res.status).toBe(400);
  });
});

describe("POST /gateways/:id/releases — cut release n+1 from prev + patch", () => {
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

  it("rejects a release for a retired gateway", async () => {
    const { app } = mkApp(
      seedNewSchemaGateway("beta", sharedPayload(), { desiredStatus: "retired" }),
    );
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ imageTag: "deadbee" });
    expect(res.status).toBe(409);
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

  it("converges a non-image change in place (glmGateways mirror, no rollout op)", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ modelBrokerLimits: { spendWindowUsd: 25 } })
      .expect(202);
    expect(res.body).toMatchObject({ gatewayId: "beta", release: 2, operationId: null });
    expect(opsIn(store, "rollout")).toHaveLength(0);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/beta`)).toMatchObject({
      modelBrokerLimits: { spendWindowUsd: 25 },
    });
    expect(
      (store.get(`gateways/beta/${GATEWAY_RELEASES_SUBCOLLECTION}/2`)?.payload as ReleasePayload)
        .modelBrokerLimits,
    ).toEqual({ spendWindowUsd: 25 });
  });

  it("rejects a negative model-broker limit", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ modelBrokerLimits: { spendWindowUsd: -1 } });
    expect(res.status).toBe(400);
  });

  it("404s when a builder release names a non-existent owner uid", async () => {
    const { app } = mkApp(
      seedNewSchemaGateway(
        "bench",
        sharedPayload({ gatewayClass: "builder", ownerUid: "uid-old" }),
      ),
    );
    const res = await request(app)
      .post("/gateways/bench/releases")
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
  it("rejects one of two concurrent disjoint patches instead of appending a stale payload", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("race", sharedPayload()), {
      synchronizeFirstTwoReadsOf: "gateways/race",
    });

    const [a, b] = await Promise.all([
      request(app).post("/gateways/race/releases").send({ modelBrokerLimits: { spendWindowUsd: 25 } }),
      request(app).post("/gateways/race/releases").send({ modelBrokerLimits: { spendWindowUsd: 50 } }),
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
    expect((rel2?.payload as ReleasePayload).modelBrokerLimits?.spendWindowUsd).toBe(
      accepted === a ? 25 : 50,
    );
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/race`)?.modelBrokerLimits).toEqual(
      (rel2?.payload as ReleasePayload).modelBrokerLimits,
    );
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
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/orphan`)?.imageTag).toBe("abc1234");
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
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/epsilon`)?.imageTag).toBe("abc1234");

    // New schema recorded the roll as release 2.
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

  it("PATCH imageTag on a legacy mounted gateway is still refused toward rollout", async () => {
    const { app } = mkApp({
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
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rollout/);
  });

  it("rolling out a legacy gateway (no GatewayDoc) stays pure-legacy: op only, no release docs", async () => {
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
      .send({ imageTag: "deadbee" })
      .expect(202);
    expect(res.body.release).toBeUndefined();
    expect(opsIn(store, "rollout")).toHaveLength(1);
    expect(store.get(`gateways/legacy/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeUndefined();
  });
});

describe("PATCH /gateways/:id — mirrors desiredStatus lifecycle onto the GatewayDoc", () => {
  it("pauses the legacy desired doc and mirrors desiredStatus to gateways/{id}", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("zeta", sharedPayload()));
    await request(app).patch("/gateways/zeta").send({ desiredStatus: "paused" }).expect(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zeta`)?.desiredStatus).toBe("paused");
    expect(store.get("gateways/zeta")?.desiredStatus).toBe("paused");
  });
});

// P1-1: retire must mark the durable GatewayDoc retired and RETAIN release
// history — never leave the new docs orphaned for the legacy cleanup to nuke.
describe("DELETE /gateways/:id — retire marks the GatewayDoc, retains releases", () => {
  it("marks gateways/{id} desiredStatus retired and leaves the release subcollection intact", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("zed", sharedPayload()));
    const res = await request(app).delete("/gateways/zed");
    expect(res.status).toBe(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zed`)?.desiredStatus).toBe("retired");
    expect(store.get("gateways/zed")?.desiredStatus).toBe("retired");
    // Release history is durable — retire never deletes it.
    expect(store.get(`gateways/zed/${GATEWAY_RELEASES_SUBCOLLECTION}/1`)).toBeDefined();
  });

  it("still retires a legacy-only gateway without a GatewayDoc", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/leg`]: { gatewayId: "leg", imageTag: "abc1234" },
      "gateways/leg": { gatewayId: "leg", status: "ready", mountedCustomers: [] },
    });
    const res = await request(app).delete("/gateways/leg");
    expect(res.status).toBe(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/leg`)?.desiredStatus).toBe("retired");
  });

  it("retires a backfilled gateway that has a GatewayDoc but NO bare glmGateways doc (does not 404)", async () => {
    const { app, store } = mkApp({
      "gateways/back": {
        gatewayId: "back",
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: 1,
        desiredStatus: "running",
        roll: null,
      },
      [`gateways/back/${GATEWAY_RELEASES_SUBCOLLECTION}/1`]: { release: 1 },
    });
    const res = await request(app).delete("/gateways/back");
    expect(res.status).toBe(202);
    // Marked retired on the durable doc; the bare glmGateways doc is NOT created.
    expect(store.get("gateways/back")?.desiredStatus).toBe("retired");
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/back`)).toBeUndefined();
    // A retire-gateway op is queued for the controller.
    expect(opsIn(store, "retire-gateway")).toHaveLength(1);
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
  it("rejects a sizingTier PATCH on a gateway with a GatewayDoc and does not touch glmGateways", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app).patch("/gateways/beta").send({ sizingTier: "medium" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/release/);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/beta`)?.sizingTier).toBeUndefined();
  });

  it("rejects an imageTag PATCH on a gateway with a GatewayDoc", async () => {
    const { app } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app).patch("/gateways/beta").send({ imageTag: "deadbee" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/release/);
  });

  it("still applies a sizingTier PATCH directly on a legacy-only gateway (live ChangeTierModal path)", async () => {
    const { app, store } = mkApp({
      [`${GLM_GATEWAYS_COLLECTION}/leg`]: {
        gatewayId: "leg",
        imageTag: "abc1234",
        gatewayClass: "shared",
      },
      "gateways/leg": { gatewayId: "leg", status: "ready" },
    });
    const res = await request(app).patch("/gateways/leg").send({ sizingTier: "medium" });
    expect(res.status).toBe(202);
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/leg`)?.sizingTier).toBe("medium");
  });
});

// P1-3: the legacy mirror must be COMPLETE — every release-payload field with a
// glmGateways equivalent, including explicit null-clears — because Cowboy reads
// legacy during PR2-6.
describe("release cut — complete legacy glmGateways mirror", () => {
  it("mirrors operatorAccess, securityContext, and carried ownership to glmGateways", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway(
        "bench",
        sharedPayload({ gatewayClass: "builder", ownerUid: "uid-1", builderSlug: "chris" }),
      ),
    );
    const res = await request(app)
      .post("/gateways/bench/releases")
      .send({
        operatorAccess: { shellsEnabled: true, reason: "debug" },
        gatewayContainerSecurityContext: { runAsNonRoot: true },
      });
    expect(res.status).toBe(202);
    const legacy = store.get(`${GLM_GATEWAYS_COLLECTION}/bench`) as Record<string, unknown>;
    expect(legacy.operatorAccess).toEqual({ shellsEnabled: true, reason: "debug" });
    expect(legacy.gatewayContainerSecurityContext).toEqual({ runAsNonRoot: true });
    // Ownership carried from the previous release is mirrored too.
    expect(legacy.ownerUid).toBe("uid-1");
    expect(legacy.builderSlug).toBe("chris");
  });

  it("mirrors an explicit null-clear of a field to glmGateways", async () => {
    const { app, store } = mkApp(
      seedNewSchemaGateway("beta", sharedPayload({ sizingTier: "small" })),
    );
    const res = await request(app)
      .post("/gateways/beta/releases")
      .send({ sizingTier: null });
    expect(res.status).toBe(202);
    const legacy = store.get(`${GLM_GATEWAYS_COLLECTION}/beta`) as Record<string, unknown>;
    expect(legacy.sizingTier).toBeNull();
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
