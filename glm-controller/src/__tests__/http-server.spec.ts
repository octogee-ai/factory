import request from "supertest";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHttpServer,
  type HttpServerDeps,
} from "../http-server";

interface FakeStore {
  users: Record<string, Record<string, unknown>>;
  configs: Record<string, Record<string, unknown>>;
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

function durableBuilderGateway(
  gatewayId: string,
  desiredStatus: "running" | "paused",
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus,
    roll: null,
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "builder",
    imageProfile: "standard",
    sizingTier: "m",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "uid-alice",
    builderSlug: "alice",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  };
}

function durableSharedGateway(gatewayId: string): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: "m",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  };
}

function servingRuntime(
  gatewayId: string,
  opts: {
    imageTag?: string;
    heartbeat?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const imageTag = opts.imageTag ?? "abc1234";
  return {
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    retiredAt: null,
    retireReason: null,
    helm: {
      releaseName: `octogee-gw-${gatewayId}-r1`,
      deploymentName: `octogee-gateway-${gatewayId}-r1`,
      gatewayServiceName: `gateway-${gatewayId}-r1`,
      gatewayEdgeServiceName: `gateway-edge-${gatewayId}-r1`,
      serviceAccountName: `octogee-gw-${gatewayId}`,
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
      imageTag,
      replicas: 1,
      availableReplicas: 1,
      lastAppliedAt: 1,
    },
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: null,
      version: null,
      openclawVersion: null,
      internalUrl: null,
      startedAt: null,
      mountedCustomers: [],
      migratingIn: [],
      ...opts.heartbeat,
    },
    lastError: { message: null, at: null },
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

interface WatchRegistry {
  attach(
    collection: string,
    filters: Array<{ field: string; value: unknown }>,
    next: (snap: { docs: unknown[] }) => void,
  ): () => void;
  attachCount(collection: string): number;
  filtersFor(collection: string): Array<{ field: string; value: unknown }> | undefined;
  activeCount(): number;
}

function createWatchRegistry(): WatchRegistry {
  const attachCounts = new Map<string, number>();
  const filtersByCollection = new Map<string, Array<{ field: string; value: unknown }>>();
  let active = 0;
  return {
    attach(collection, filters, next) {
      attachCounts.set(collection, (attachCounts.get(collection) ?? 0) + 1);
      filtersByCollection.set(collection, filters);
      active += 1;
      next({ docs: [] });
      const timer = setInterval(() => next({ docs: [] }), 5);
      timer.unref?.();
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        active -= 1;
        clearInterval(timer);
      };
    },
    attachCount: (collection) => attachCounts.get(collection) ?? 0,
    filtersFor: (collection) => filtersByCollection.get(collection),
    activeCount: () => active,
  };
}

function makeQuery(
  collectionName: string,
  store: FakeStore,
  filters: Array<{ field: string; value: unknown }> = [],
  watchRegistry?: WatchRegistry,
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
      makeQuery(collectionName, store, [...filters, { field, value }], watchRegistry),
    orderBy: () => makeQuery(collectionName, store, filters, watchRegistry),
    limit: () => makeQuery(collectionName, store, filters, watchRegistry),
    onSnapshot: (
      next: (snap: { docs: unknown[] }) => void,
      _onError?: (err: unknown) => void,
    ) => {
      if (watchRegistry) return watchRegistry.attach(collectionName, filters, next);
      const unsubscribe = vi.fn();
      queueMicrotask(() => {
        next({ docs: [] });
        next({ docs: [] });
      });
      return unsubscribe;
    },
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

function buildDb(store: FakeStore, watchRegistry?: WatchRegistry) {
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
        set: (
          ref: { set: (data: Record<string, unknown>) => Promise<void> },
          data: Record<string, unknown>,
        ) => void;
        create: (
          ref: {
            get: () => Promise<{ exists: boolean }>;
            set: (data: Record<string, unknown>) => Promise<void>;
          },
          data: Record<string, unknown>,
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
        set: (
          ref: { set: (data: Record<string, unknown>) => Promise<void> },
          data: Record<string, unknown>,
        ) => {
          queued.push(() => ref.set(data));
        },
        create: (
          ref: {
            get: () => Promise<{ exists: boolean }>;
            set: (data: Record<string, unknown>) => Promise<void>;
          },
          data: Record<string, unknown>,
        ) => {
          queued.push(async () => {
            if ((await ref.get()).exists) {
              throw new Error("fake transaction create requires a missing document");
            }
            await ref.set(data);
          });
        },
      };
      const result = await fn(txn);
      for (const w of queued) await w();
      return result;
    },
    doc: (path: string) => ({
      get: async () => {
        const [collection, id] = path.split("/");
        const data =
          collection === "users" && id
            ? store.users[id]
            : collection === "gateways" && id && path.split("/").length === 2
            ? store.gateways[id]
            : collection === "glmGateways" && id
              ? store.glmGateways[id]
              : store.configs[path];
        return { exists: data !== undefined, data: () => data };
      },
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        store.configs[path] = opts?.merge
          ? { ...(store.configs[path] ?? {}), ...data }
          : data;
      },
      update: async (patch: Record<string, unknown>) => {
        const [collection, id] = path.split("/");
        if (collection === "users" && id && store.users[id]) {
          applyPatch(store.users[id], patch);
          return;
        }
        const current = store.configs[path];
        if (!current) throw new Error(`missing fake document ${path}`);
        applyPatch(current, patch);
      },
    }),
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
              return;
            }
            if (name === "glmOperations") {
              const operation = store.glmOperations.find((candidate) => candidate.id === docId);
              if (!operation) throw new Error(`missing fake operation ${docId}`);
              applyPatch(operation.data, patch);
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
          delete: async () => {
            if (name === "users") delete store.users[docId];
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
        makeQuery(name, store, [{ field, value }], watchRegistry),
      orderBy: () => makeQuery(name, store, [], watchRegistry),
      limit: () => makeQuery(name, store, [], watchRegistry),
      onSnapshot: (next: (snap: { docs: unknown[] }) => void) => {
        if (watchRegistry) return watchRegistry.attach(name, [], next);
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
    collectionGroup: (name: string) => makeQuery(name, store),
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
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
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

  afterEach(() => vi.unstubAllEnvs());

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

  it("sets CORS headers for the isolated Build Week app", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://app-octogee-build-week.web.app");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app-octogee-build-week.web.app",
    );
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

  it("denies localhost CORS by default and admits it only for explicit local development", async () => {
    const app = createHttpServer(buildDeps(store));
    const denied = await request(app).get("/healthz").set("Origin", "http://localhost:4322");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();

    vi.stubEnv("OCTOGEE_ALLOW_LOCAL_ORIGINS", "true");
    const devApp = createHttpServer(buildDeps(store));
    const allowed = await request(devApp).get("/healthz").set("Origin", "http://localhost:4322");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:4322");
  });

  it("revokes connector grants on the live controller-owned account deletion route", async () => {
    store.users["delete-me"] = { email: "delete@example.com" };
    const order: string[] = [];
    const app = createHttpServer(buildDeps(store, {
      revokeConnectorGrantsForUser: vi.fn(async () => { order.push("revoke"); }),
      suspendAuthUser: vi.fn(async () => { order.push("suspend-auth"); }),
    }));

    const res = await request(app)
      .post("/api/admin/customer/delete-me/delete")
      .set("Authorization", "Bearer admin-token");

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(order).toEqual(["suspend-auth", "revoke"]);
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
      paused: 0,
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
    expect(res.text).toMatch(/"collection":"(users|gateways|config|glmGateways|glmOperations)"/);
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
    expect(watchedCollections).toContain("config");
    expect(watchedCollections).not.toContain("operatorGatewayReservations");
  });

  it("serves /api/admin/gateways with populated fleet stats", async () => {
    store.gateways["gw-blue"] = durableSharedGateway("gw-blue");
    store.glmGateways["gw-blue"] = servingRuntime("gw-blue", {
      heartbeat: {
        status: "ready",
        version: "abc1234",
        mountedCustomers: ["alice", "bob"],
        lastHeartbeatAt: Date.now() - 2_000,
      },
    });
    store.gateways["gw-stale"] = durableSharedGateway("gw-stale");
    store.glmGateways["gw-stale"] = servingRuntime("gw-stale", {
      heartbeat: {
        status: "unreachable",
        version: "def5678",
        mountedCustomers: [],
        lastHeartbeatAt: Date.now() - 5 * 60_000,
      },
    });
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.gateways).toHaveLength(2);
    expect(res.body.stats.gateways).toEqual({
      total: 2,
      ready: 1,
      paused: 0,
      unreachable: 1,
    });
    expect(res.body.stats.customersMounted).toBe(2);
  });

  it("reads only operations referenced by the Fleet projection", async () => {
    store.users["uid-alice"] = {
      username: "alice",
      provisioning: {
        openclaw: {
          slug: "alice",
          gatewayId: "shared-a",
          activationLease: {
            leaseId: "lease-1",
            generation: 1,
            status: "provisioning",
            sourceGatewayId: "shared-a",
            targetGatewayId: "alice-xs-12345678",
            activationOperationId: "activate-alice",
            requestedAt: Date.now() - 2_000,
          },
        },
      },
    };
    store.glmOperations.push({
      id: "activate-alice",
      data: { status: "running", steps: [{ name: "provision", status: "running" }] },
    });
    for (let index = 0; index < 100; index += 1) {
      store.glmOperations.push({
        id: `irrelevant-${index}`,
        data: { status: "succeeded" },
      });
    }
    const db = buildDb(store) as ReturnType<typeof buildDb>;
    const originalCollection = db.collection.bind(db);
    const fullOperationRead = vi.fn(async () => {
      throw new Error("Fleet must not scan glmOperations");
    });
    db.collection = ((name: string) => {
      const collection = originalCollection(name) as Record<string, unknown>;
      return name === "glmOperations"
        ? { ...collection, get: fullOperationRead }
        : collection;
    }) as typeof db.collection;
    const app = createHttpServer(buildDeps(store, { db: db as any }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status, res.text).toBe(200);
    expect(fullOperationRead).not.toHaveBeenCalled();
    expect(res.body.builderRuntimes).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        operationId: "activate-alice",
        operationStatus: "running",
        operationSteps: [{ name: "provision", status: "running" }],
      }),
    ]);
  });

  it("includes Cowboy pod diagnostics in the gateway summaries when available", async () => {
    store.gateways["bender"] = durableSharedGateway("bender");
    store.glmGateways["bender"] = servingRuntime("bender", {
      heartbeat: {
        status: "ready",
        version: "8507a63",
        mountedCustomers: [],
        lastHeartbeatAt: Date.now(),
      },
    });
    const readGatewayPodDiagnostics = vi.fn(async (_gatewayId: string) => ({
      status: "ready" as const,
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 2,
      spotPods: 1,
      onDemandPods: 0,
      unknownCapacityPods: 0,
      pods: [
        {
          name: "octogee-gateway-bender-abc",
          phase: "Running",
          readyContainers: 2,
          totalContainers: 2,
          restarts: 2,
          reason: null,
          nodeName: "gke-node-1",
          capacityType: "spot" as const,
          ageMs: 125_000,
        },
      ],
    }));
    const app = createHttpServer(buildDeps(store, { readGatewayPodDiagnostics }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.gateways).toHaveLength(1);
    expect(readGatewayPodDiagnostics).toHaveBeenCalledWith("bender");
    expect(res.body.gateways[0].podDiagnostics).toMatchObject({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      totalRestarts: 2,
      pods: [{ name: "octogee-gateway-bender-abc", nodeName: "gke-node-1" }],
    });
    expect(res.body.gateways[0]).toMatchObject({
      reservation: { type: "spot", source: "kubernetes" },
      sizing: { monthlyCostUsd: { pricingMode: "spot" } },
    });
  });

  it("batches pod diagnostics for every gateway into one fleet read", async () => {
    store.gateways["alpha"] = durableSharedGateway("alpha");
    store.glmGateways["alpha"] = servingRuntime("alpha");
    store.gateways["bravo"] = durableSharedGateway("bravo");
    store.glmGateways["bravo"] = servingRuntime("bravo");
    const readGatewayPodDiagnostics = vi.fn();
    const readGatewayPodDiagnosticsBatch = vi.fn(async () => ({
      alpha: {
        status: "ready" as const,
        totalPods: 1,
        readyPods: 1,
        totalRestarts: 0,
        spotPods: 0,
        onDemandPods: 1,
        unknownCapacityPods: 0,
        pods: [],
      },
      bravo: {
        status: "missing" as const,
        totalPods: 0,
        readyPods: 0,
        totalRestarts: 0,
        spotPods: 0,
        onDemandPods: 0,
        unknownCapacityPods: 0,
        pods: [],
      },
    }));
    const app = createHttpServer(buildDeps(store, {
      readGatewayPodDiagnostics,
      readGatewayPodDiagnosticsBatch,
    }));

    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(readGatewayPodDiagnosticsBatch).toHaveBeenCalledTimes(1);
    expect(readGatewayPodDiagnosticsBatch).toHaveBeenCalledWith(
      expect.arrayContaining(["alpha", "bravo"]),
    );
    expect(readGatewayPodDiagnostics).not.toHaveBeenCalled();
    expect(res.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: "alpha",
          podDiagnostics: expect.objectContaining({ status: "ready" }),
        }),
        expect.objectContaining({
          gatewayId: "bravo",
          podDiagnostics: expect.objectContaining({ status: "missing" }),
        }),
      ]),
    );
  });

  it("serves gateways requested by Cowboy before their heartbeat docs exist", async () => {
    store.glmGateways["canary"] = {
      gatewayId: "canary",
      desiredStatus: "running",
      imageTag: "8507a63-oc2026.6.10",
      sizingTier: "xs",
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
      paused: 0,
      unreachable: 0,
    });
  });

  it("derives OpenClaw from Cowboy image tags when heartbeat reports unknown", async () => {
    store.gateways["bender"] = durableSharedGateway("bender");
    store.glmGateways["bender"] = servingRuntime("bender", {
      imageTag: "5b287cb-oc2026.6.10",
      heartbeat: {
        status: "ready",
        version: "5b287cb",
        openclawVersion: "unknown",
        mountedCustomers: [],
        lastHeartbeatAt: Date.now(),
      },
    });
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

  it("records targetless Builder demand without queuing a migration", async () => {
    store.users["uid-alice"] = {
      username: "alice",
      builderSubscription: { tier: "pro", status: "active" },
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    store.configs["gateways/default/assignments/uid-alice"] = {
      uid: "uid-alice",
      gatewayId: "default",
      state: "serving",
      epoch: 4,
    };

    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/activation-lease")
      .set("Authorization", "Bearer admin-token")
      .send({ reason: "conversation-start" });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({
      generation: 1,
      sizingTier: "m",
      status: "requested",
    });
    expect(store.glmOperations).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          recordType: "audit",
          status: "completed",
          mutation: {
            kind: "request-activation-lease",
            uid: "uid-alice",
          },
        }),
      }),
    ]);
    expect(store.users["uid-alice"].provisioning).toMatchObject({
      openclaw: {
        activationLease: {
          builderSlug: "alice",
          sourceGatewayId: "default",
          sourceAssignmentEpoch: 4,
          status: "requested",
        },
      },
    });
    expect(
      (store.users["uid-alice"].provisioning as Record<string, any>)
        .openclaw.activationLease,
    ).not.toHaveProperty("targetGatewayId");
  });

  it("does not wake a legacy paused owner runtime when recording demand", async () => {
    store.users["uid-alice"] = {
      username: "alice",
      builderSubscription: { tier: "pro", status: "active" },
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    store.gateways["gw-alice"] = durableBuilderGateway("gw-alice", "paused");
    store.configs["gateways/default/assignments/uid-alice"] = {
      uid: "uid-alice",
      gatewayId: "default",
      state: "serving",
      epoch: 9,
    };

    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/activation-lease")
      .set("Authorization", "Bearer admin-token")
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "requested",
    });
    expect(store.gateways["gw-alice"].desiredStatus).toBe("paused");
    expect(store.glmOperations).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          recordType: "audit",
          status: "completed",
          mutation: {
            kind: "request-activation-lease",
            uid: "uid-alice",
          },
        }),
      }),
    ]);
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

describe("createHttpServer — fleet-events watcher sharing", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = emptyStore();
    store.users["admin-uid"] = { email: "admin@octogee.com" };
    store.configs["admin-uid"] = { role: "admin" };
  });

  const streamOnce = (app: Express) =>
    request(app)
      .get("/api/admin/fleet-events?once=1")
      .set("Authorization", "Bearer admin-token");

  it("shares one watcher set across concurrent stream connections", async () => {
    const registry = createWatchRegistry();
    const app = createHttpServer(
      buildDeps(store, { db: buildDb(store, registry) as any }),
    );

    const [first, second] = await Promise.all([streamOnce(app), streamOnce(app)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    for (const collection of ["users", "gateways", "config", "glmGateways", "glmOperations"]) {
      expect(registry.attachCount(collection), collection).toBe(1);
    }
  });

  it("keeps watchers warm across sequential reconnects", async () => {
    const registry = createWatchRegistry();
    const app = createHttpServer(
      buildDeps(store, { db: buildDb(store, registry) as any }),
    );

    expect((await streamOnce(app)).status).toBe(200);
    expect((await streamOnce(app)).status).toBe(200);

    expect(registry.attachCount("glmOperations")).toBe(1);
    expect(registry.activeCount()).toBe(5);
  });

  it("filters the glmOperations watch to active operations", async () => {
    const registry = createWatchRegistry();
    const app = createHttpServer(
      buildDeps(store, { db: buildDb(store, registry) as any }),
    );

    expect((await streamOnce(app)).status).toBe(200);

    expect(registry.filtersFor("glmOperations")).toEqual([
      { field: "status", value: ["pending", "running"] },
    ]);
  });

  it("tears down watchers after the last connection closes when linger is disabled", async () => {
    const registry = createWatchRegistry();
    const app = createHttpServer(
      buildDeps(store, {
        db: buildDb(store, registry) as any,
        fleetEventListenerLingerMs: 0,
      }),
    );

    expect((await streamOnce(app)).status).toBe(200);
    expect(registry.activeCount()).toBe(0);

    expect((await streamOnce(app)).status).toBe(200);
    expect(registry.attachCount("users")).toBe(2);
  });
});
