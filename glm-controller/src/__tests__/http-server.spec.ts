import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer, type HttpServerDeps } from "../http-server";
import { OPERATOR_GATEWAY_RESERVATIONS_COLLECTION } from "@octogee/shared/types/glm";

interface FakeStore {
  users: Record<string, Record<string, unknown>>;
  configs: Record<string, { role?: string }>;
  gateways: Record<string, Record<string, unknown>>;
  glmGateways: Record<string, Record<string, unknown>>;
  glmOperations: Array<{ id: string; data: Record<string, unknown> }>;
}

function emptyStore(): FakeStore {
  return {
    users: {},
    configs: {},
    gateways: {},
    glmGateways: {},
    glmOperations: [],
  };
}

function applyPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
}

function makeQuery(
  collectionName: string,
  store: FakeStore,
  filters: Array<{ field: string; value: unknown }> = [],
) {
  const matches = (data: Record<string, unknown>): boolean =>
    filters.every((f) => {
      const v = data[f.field];
      if (Array.isArray(f.value))
        return (f.value as unknown[]).includes(v);
      return v === f.value;
    });
  return {
    where: (field: string, _op: string, value: unknown) =>
      makeQuery(collectionName, store, [...filters, { field, value }]),
    orderBy: () => makeQuery(collectionName, store, filters),
    limit: () => makeQuery(collectionName, store, filters),
    get: async () => {
      if (collectionName === "gateways") {
        const docs = Object.entries(store.gateways)
          .filter(([, d]) => matches(d))
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs, size: docs.length };
      }
      if (collectionName === "users") {
        const docs = Object.entries(store.users)
          .filter(([, d]) => matches(d))
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs, size: docs.length };
      }
      if (collectionName === "glmOperations") {
        const docs = store.glmOperations
          .filter((o) => matches(o.data))
          .map((o) => ({ id: o.id, data: () => o.data }));
        return { docs, size: docs.length };
      }
      if (collectionName === "glmGateways") {
        const docs = Object.entries(store.glmGateways)
          .filter(([, d]) => matches(d))
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs, size: docs.length };
      }
      return { docs: [], size: 0 };
    },
  };
}

function buildDb(store: FakeStore) {
  let docSeq = 0;
  return {
    batch: () => {
      const writes: Array<() => Promise<void>> = [];
      return {
        update: (
          ref: { update: (patch: Record<string, unknown>) => Promise<void> },
          patch: Record<string, unknown>,
        ) => {
          writes.push(() => ref.update(patch));
        },
        set: (
          ref: { set: (data: Record<string, unknown>) => Promise<void> },
          data: Record<string, unknown>,
        ) => {
          writes.push(() => ref.set(data));
        },
        commit: async () => {
          for (const write of writes) await write();
        },
      };
    },
    runTransaction: async <T,>(
      fn: (txn: {
        get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
        update: (
          ref: { update: (patch: Record<string, unknown>) => Promise<void> },
          patch: Record<string, unknown>,
        ) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      const queued: Array<() => Promise<void>> = [];
      const txn = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        update: (
          ref: { update: (patch: Record<string, unknown>) => Promise<void> },
          patch: Record<string, unknown>,
        ) => {
          queued.push(() => ref.update(patch));
        },
      };
      const result = await fn(txn);
      for (const w of queued) await w();
      return result;
    },
    collection: (name: string): unknown => ({
      doc: (id?: string) => {
        const docId = id ?? `auto-${++docSeq}`;
        return {
          id: docId,
          get: async () => {
            if (name === "users") {
              const data = store.users[docId];
              return { exists: data !== undefined, data: () => data };
            }
            if (name === "gateways") {
              const data = store.gateways[docId];
              return { exists: data !== undefined, data: () => data };
            }
            if (name === "glmGateways") {
              const data = store.glmGateways[docId];
              return { exists: data !== undefined, data: () => data };
            }
            if (name === "glmOperations") {
              const op = store.glmOperations.find((o) => o.id === docId);
              return {
                exists: op !== undefined,
                data: () => op?.data,
              };
            }
            return { exists: false, data: () => undefined };
          },
          update: async (patch: Record<string, unknown>) => {
            if (name === "users" && store.users[docId]) {
              applyPatch(store.users[docId], patch);
              return;
            }
            if (name === "gateways" && store.gateways[docId]) {
              applyPatch(store.gateways[docId], patch);
              return;
            }
            if (name === "glmGateways" && store.glmGateways[docId]) {
              applyPatch(store.glmGateways[docId], patch);
            }
          },
          set: async (data: Record<string, unknown>) => {
            if (name === "users") {
              store.users[docId] = data;
              return;
            }
            if (name === "gateways") {
              store.gateways[docId] = data;
              return;
            }
            if (name === "glmGateways") {
              store.glmGateways[docId] = data;
              return;
            }
            if (name === "glmOperations") {
              const index = store.glmOperations.findIndex((o) => o.id === docId);
              if (index === -1) store.glmOperations.push({ id: docId, data });
              else store.glmOperations[index] = { id: docId, data };
            }
          },
          collection: (sub: string) => ({
            doc: (subId: string) => ({
              get: async () => {
                if (
                  name === "users" &&
                  sub === "system" &&
                  subId === "config"
                ) {
                  const data = store.configs[docId];
                  return { exists: data !== undefined, data: () => data };
                }
                return { exists: false, data: () => undefined };
              },
            }),
          }),
        };
      },
      where: (field: string, _op: string, value: unknown) =>
        makeQuery(name, store, [{ field, value }]),
      orderBy: () => makeQuery(name, store),
      limit: () => makeQuery(name, store),
      onSnapshot: (next: (snap: { docs: unknown[] }) => void) => {
        const unsubscribe = vi.fn();
        queueMicrotask(() => {
          next({ docs: [] });
          next({ docs: [] });
        });
        return unsubscribe;
      },
      get: async () => {
        if (name === "gateways") {
          const docs = Object.entries(store.gateways).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "users") {
          const docs = Object.entries(store.users).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "glmGateways") {
          const docs = Object.entries(store.glmGateways).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        return { docs: [], size: 0 };
      },
    }),
  };
}

function buildDeps(store: FakeStore, overrides: Partial<HttpServerDeps> = {}): HttpServerDeps {
  return {
    db: buildDb(store) as any,
    log: vi.fn(),
    verifyIdToken: vi.fn(async (token: string) => {
      if (token === "admin-token") return { uid: "admin-uid" };
      if (token === "user-token") return { uid: "user-uid" };
      throw new Error("invalid token");
    }),
    workspaceSlugsForUser: (data) => {
      const slug =
        typeof data?.username === "string" && data.username.length > 0
          ? data.username
          : null;
      return slug ? [slug] : [];
    },
    provisionGatewayAuthSecret: vi.fn(async () => ({
      secretName: "stub",
      created: true,
    })),
    listGatewayBuilds: vi.fn(async () => []),
    deleteAuthUserTolerantOfMissing: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("createHttpServer — admin gateway routes", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = emptyStore();
    store.users["admin-uid"] = { email: "admin@octogee.com" };
    store.configs["admin-uid"] = { role: "admin" };
    store.users["user-uid"] = { email: "user@octogee.com" };
    store.configs["user-uid"] = { role: "operator" };
  });

  it("/healthz responds without auth", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "glm-controller" });
  });

  it("sets CORS headers for allowed origins (admin UI fetches from app[-test].web.app)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://app-octogee-test.web.app");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app-octogee-test.web.app");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toContain("Origin");
  });

  it("answers OPTIONS preflight with 204 + CORS headers (no auth needed)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .options("/api/admin/customers")
      .set("Origin", "https://app-octogee-test.web.app")
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app-octogee-test.web.app");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("allows PATCH in the preflight — pause/resume + change-tier hit PATCH /api/admin/gateways/:id; omitting it makes the browser block them", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .options("/api/admin/gateways/gw-test")
      .set("Origin", "https://app-octogee-test.web.app")
      .set("Access-Control-Request-Method", "PATCH");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
  });

  it("does not set CORS headers for disallowed origins", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin tokens with 403", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer user-token");
    expect(res.status).toBe(403);
  });

  it("serves /api/admin/gateways for admins (empty fleet)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.gateways).toEqual([]);
    expect(res.body.stats.gateways).toEqual({
      total: 0,
      ready: 0,
      unreachable: 0,
    });
  });

  it("streams server-driven fleet invalidation events after admin auth", async () => {
    const app = createHttpServer(buildDeps(store));

    const res = await request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: ready");
    expect(res.text).toContain("event: changed");
    expect(res.text).toMatch(/"collection":"(users|gateways|glmGateways|glmOperations|operatorGatewayReservations)"/);
  });

  it("subscribes fleet invalidation events to admin data dependencies", async () => {
    const db = buildDb(store) as { collection: (name: string) => unknown };
    const originalCollection = db.collection.bind(db);
    const watchedCollections: string[] = [];
    db.collection = (name: string) => {
      watchedCollections.push(name);
      return originalCollection(name);
    };
    const app = createHttpServer(buildDeps(store, { db: db as any }));

    const res = await request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(watchedCollections).toContain("users");
    expect(watchedCollections).toContain(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION);
  });

  it("serves /api/admin/gateways with populated fleet stats", async () => {
    store.gateways["gw-blue"] = {
      gatewayId: "gw-blue",
      status: "ready",
      version: "abc1234",
      mountedCustomers: ["alice", "bob"],
      lastHeartbeatAt: Date.now() - 2_000,
    };
    store.gateways["gw-stale"] = {
      gatewayId: "gw-stale",
      status: "unreachable",
      version: "def5678",
      mountedCustomers: [],
      lastHeartbeatAt: Date.now() - 5 * 60_000,
    };
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.gateways).toHaveLength(2);
    expect(res.body.stats.gateways).toEqual({
      total: 2,
      ready: 1,
      unreachable: 1,
    });
    expect(res.body.stats.customersMounted).toBe(2);
  });

  it("includes Cowboy pod diagnostics in the gateway summaries when available", async () => {
    store.gateways["bender"] = {
      gatewayId: "bender",
      status: "ready",
      version: "8507a63",
      mountedCustomers: [],
      lastHeartbeatAt: Date.now(),
    };
    const readGatewayPodDiagnostics = vi.fn(async (_gatewayId: string) => ({
      status: "ready" as const,
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 2,
      pods: [
        {
          name: "octogee-gateway-bender-abc",
          phase: "Running",
          readyContainers: 2,
          totalContainers: 2,
          restarts: 2,
          reason: null,
          nodeName: "gke-node-1",
          ageMs: 125_000,
        },
      ],
    }));
    const app = createHttpServer(buildDeps(store, { readGatewayPodDiagnostics }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(readGatewayPodDiagnostics).toHaveBeenCalledWith("bender");
    expect(res.body.gateways[0].podDiagnostics).toMatchObject({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 2,
      pods: [{ name: "octogee-gateway-bender-abc", nodeName: "gke-node-1" }],
    });
  });

  it("serves gateways requested by Cowboy before their heartbeat docs exist", async () => {
    store.glmGateways["canary"] = {
      gatewayId: "canary",
      desiredStatus: "running",
      imageTag: "8507a63-oc2026.6.10",
      sizingTier: "micro",
    };
    const readGatewayPodDiagnostics = vi.fn(async (_gatewayId: string) => ({
      status: "not-ready" as const,
      totalPods: 1,
      readyPods: 0,
      totalRestarts: 1,
      pods: [
        {
          name: "octogee-gateway-canary-abc",
          phase: "Pending",
          readyContainers: 0,
          totalContainers: 2,
          restarts: 1,
          reason: "ContainerCreating",
          nodeName: "gke-node-1",
          ageMs: 30_000,
        },
      ],
    }));
    const app = createHttpServer(buildDeps(store, { readGatewayPodDiagnostics }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(readGatewayPodDiagnostics).toHaveBeenCalledWith("canary");
    expect(res.body.gateways).toHaveLength(1);
    expect(res.body.gateways[0]).toMatchObject({
      gatewayId: "canary",
      status: "booting",
      desiredStatus: "running",
      imageTag: "8507a63-oc2026.6.10",
      openclawVersion: "2026.6.10",
      mountedCustomers: [],
      heartbeatAgeMs: null,
      podDiagnostics: {
        status: "not-ready",
        readyPods: 0,
        totalRestarts: 1,
      },
    });
    expect(res.body.stats.gateways).toEqual({
      total: 1,
      ready: 0,
      unreachable: 0,
    });
  });

  it("derives OpenClaw from Cowboy image tags when heartbeat reports unknown", async () => {
    store.gateways["bender"] = {
      gatewayId: "bender",
      status: "ready",
      version: "5b287cb",
      openclawVersion: "unknown",
      mountedCustomers: [],
      lastHeartbeatAt: Date.now(),
    };
    store.glmGateways["bender"] = {
      gatewayId: "bender",
      desiredStatus: "running",
      imageTag: "5b287cb-oc2026.6.10",
    };
    const app = createHttpServer(buildDeps(store));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.gateways[0]).toMatchObject({
      gatewayId: "bender",
      imageTag: "5b287cb",
      openclawVersion: "2026.6.10",
    });
  });

  it("serves /api/admin/operations as paginated list", async () => {
    store.glmOperations.push({
      id: "op-1",
      data: {
        kind: "add-gateway",
        status: "succeeded",
        createdAt: 100,
        input: { gatewayId: "gw-blue" },
      },
    });
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/operations")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(1);
    expect(res.body.operations[0]).toMatchObject({
      id: "op-1",
      kind: "add-gateway",
      status: "succeeded",
    });
  });

  it("queues a builder activation lease migration when the owned builder gateway is ready", async () => {
    store.users["uid-alice"] = {
      approved: true,
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    store.glmGateways["gw-alice"] = {
      ownerUid: "uid-alice",
      builderSlug: "alice",
      gatewayClass: "builder",
      desiredStatus: "running",
    };
    store.gateways["gw-alice"] = {
      gatewayId: "gw-alice",
      status: "ready",
      mountedCustomers: [],
    };

    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/activation-lease")
      .set("Authorization", "Bearer admin-token")
      .send({ reason: "conversation-start" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      uid: "uid-alice",
      builderSlug: "alice",
      gatewayId: "gw-alice",
      gatewayClass: "builder",
      operationId: "auto-1",
      status: "activating",
    });
    expect(store.glmOperations).toHaveLength(1);
    expect(store.glmOperations[0]).toMatchObject({
      id: "auto-1",
      data: {
        kind: "migrate-customer",
        status: "pending",
        gatewayId: "gw-alice",
        inputUid: "uid-alice",
        input: {
          uid: "uid-alice",
          toGatewayId: "gw-alice",
          source: "builder-activation-lease",
          builderSlug: "alice",
          gatewayClass: "builder",
          reason: "conversation-start",
        },
      },
    });
    expect(store.users["uid-alice"].provisioning).toMatchObject({
      openclaw: {
        activationLease: {
          gatewayId: "gw-alice",
          gatewayClass: "builder",
          builderSlug: "alice",
          status: "activating",
          operationId: "auto-1",
        },
      },
    });
  });

  it("wakes a paused builder gateway without queuing migration until it is ready", async () => {
    store.users["uid-alice"] = {
      approved: true,
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    store.glmGateways["gw-alice"] = {
      ownerUid: "uid-alice",
      builderSlug: "alice",
      gatewayClass: "builder",
      desiredStatus: "paused",
    };

    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/activation-lease")
      .set("Authorization", "Bearer admin-token")
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      uid: "uid-alice",
      gatewayId: "gw-alice",
      status: "waking",
      targetStatus: "missing",
      retryAfterMs: 15_000,
    });
    expect(store.glmGateways["gw-alice"].desiredStatus).toBe("running");
    expect(store.glmOperations).toHaveLength(0);
    expect(store.users["uid-alice"].provisioning).toMatchObject({
      openclaw: {
        activationLease: {
          gatewayId: "gw-alice",
          gatewayClass: "builder",
          builderSlug: "alice",
          status: "waking",
          targetStatus: "missing",
        },
      },
    });
  });

it("mounts addAdminCustomerRoutes and returns 404 for unknown customer (factory wired)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/customer/does-not-exist")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found" });
  });

});
