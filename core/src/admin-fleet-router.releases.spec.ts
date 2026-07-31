import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import request from "supertest";

import { addAdminFleetRoutes } from "./admin-fleet-router.js";
import { ReleaseDigestAliasError } from "./artifact-registry.js";
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

function applyDottedPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      const current = cursor[part];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (value === FieldValue.delete()) delete cursor[key];
    else cursor[key] = value;
  }
}

interface TestRouterOptions {
  synchronizeFirstTwoReadsOf?: string;
  failTransactions?: boolean;
  beforeFirstTransaction?: (store: Map<string, Record<string, unknown>>) => void;
  failFirstTransactionReadOf?: string;
  releaseEnvironment?: "test" | "prod" | null;
  releaseAuthority?: Record<string, unknown>;
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
      __path: path,
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
        applyDottedPatch(store.get(path)!, data);
      },
      delete: async () => {
        store.delete(path);
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
  let failedTransactionRead = false;
  async function runTransaction<T>(
    body: (txn: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      create: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown) => void;
      set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => void;
      update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => void;
      delete: (ref: { delete: () => Promise<void> }) => void;
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
        get: (ref: { get: () => Promise<unknown>; __path?: string }) => {
          if (
            !failedTransactionRead &&
            opts.failFirstTransactionReadOf &&
            ref.__path === opts.failFirstTransactionReadOf
          ) {
            failedTransactionRead = true;
            throw new Error(`simulated transaction read failure: ${ref.__path}`);
          }
          return ref.get();
        },
        create: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown) => {
          writes.push(async () => {
            await ref.set(data);
          });
        },
        set: (ref: { set: (d: unknown, o?: unknown) => Promise<void> }, data: unknown, opts?: unknown) => {
          writes.push(() => ref.set(data, opts));
        },
        update: (ref: { update: (d: unknown) => Promise<void> }, data: unknown) => {
          writes.push(() => ref.update(data));
        },
        delete: (ref: { delete: () => Promise<void> }) => {
          writes.push(() => ref.delete());
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
  const releaseConfig = opts?.releaseAuthority && seed?.["config/orchestrator"] === undefined
    ? { "config/orchestrator": { defaultGatewayId: "default", sharedGatewayIds: ["default"] } }
    : {};
  const { db, store } = makeDb({ ...releaseConfig, ...seed }, opts);
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
    releaseEnvironment: opts?.releaseEnvironment ?? "test",
    releaseAuthority: opts?.releaseAuthority,
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
  });
  return { app, store };
}

function opsIn(store: Map<string, Record<string, unknown>>, kind: string) {
  return [...store.entries()]
    .filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`))
    .map(([, data]) => data)
    .filter((d) => d.kind === kind);
}

function auditsIn(store: Map<string, Record<string, unknown>>) {
  return [...store.entries()]
    .filter(([path]) => path.startsWith(`${GLM_OPERATIONS_COLLECTION}/`))
    .map(([, data]) => data)
    .filter((data) => data.recordType === "audit");
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
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    coOwnerUids: [],
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
      desiredStatus: "running",
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

describe("normal fleet mutation admission", () => {
  it("rejects a frozen gateway restart before it creates an audit or operation", async () => {
    const seed = {
      ...seedNewSchemaGateway("beta", sharedPayload()),
      "config/glmMaintenance": { mode: "frozen", reason: "incident" },
    };
    const { app, store } = mkApp(seed);

    await request(app).post("/gateways/beta/restart").expect(409).expect({
      error: "maintenance freeze blocks fleet mutation: incident",
    });

    expect(auditsIn(store)).toHaveLength(0);
    expect(opsIn(store, "restart-gateway")).toHaveLength(0);
  });

  it("journals a gateway restart with its pre-action state", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));

    await request(app).post("/gateways/beta/restart").expect(202);

    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      actor: "unknown",
      forced: false,
      what: "restart gateway",
      why: "Admin fleet request",
      target: { gatewayId: "beta" },
      preActionStatus: { desiredStatus: "running", desiredRelease: 1 },
      mutation: { kind: "restart-gateway", gatewayId: "beta" },
    }));
  });
});

describe("POST /releases/cut and POST /releases/:version/promote", () => {
  const sourceSha = "a".repeat(40);
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  const gatewayDigest = `sha256:${"c".repeat(64)}`;
  const operatorDigest = `sha256:${"d".repeat(64)}`;
  const edgeDigest = `sha256:${"e".repeat(64)}`;

  function releaseManifest(overrides: Partial<{
    sourceSha: string;
    manifestDigest: string;
  }> = {}) {
    return {
      sourceSha: overrides.sourceSha ?? sourceSha,
      manifestDigest: overrides.manifestDigest ?? manifestDigest,
      openclawVersion: "2026.7.1",
      repository: "us-central1-docker.pkg.dev/octogee/octogee",
      surfaces: {
        gateway: {
          "gateway-edge": edgeDigest,
          "octogee-gateway": gatewayDigest,
          "octogee-gateway-operator": operatorDigest,
        },
        platform: {
          "artifact-worker": `sha256:${"1".repeat(64)}`,
          "glm-controller": `sha256:${"2".repeat(64)}`,
          "octogee-api": `sha256:${"3".repeat(64)}`,
          "octogee-ops-agent": `sha256:${"4".repeat(64)}`,
        },
      },
    };
  }

  function releaseAuthority(manifest = releaseManifest()) {
    return {
      resolveManifest: vi.fn(async () => manifest),
      resolveTestManifest: vi.fn(async () => manifest),
      aliasesFor: vi.fn(() => [{
        alias: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway:aaaaaaa-oc2026.7.1",
        intendedTarget: `us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway@${gatewayDigest}`,
      }]),
      testRecordAlias: vi.fn(() => ({
        alias: "us-central1-docker.pkg.dev/octogee/octogee/release-digest-manifest:test-v0.4.0",
        intendedTarget: `us-central1-docker.pkg.dev/octogee/octogee/release-digest-manifest@${manifestDigest}`,
      })),
      ensureAliases: vi.fn(async (aliases: Array<{ alias: string; intendedTarget: string }>) =>
        aliases.map((alias) => ({
          alias: alias.alias,
          status: "applied",
          observedTarget: alias.intendedTarget,
        })),
      ),
    };
  }

  it("cuts a CENTRAL TEST release from the exact manifest, journals aliases, and records TEST authority", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp(seedNewSchemaGateway("default", sharedPayload()), {
      releaseAuthority: authority,
    });

    const response = await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha })
      .expect(202);

    expect(response.body).toMatchObject({
      version: "v0.4.0",
      sourceSha,
      gatewayId: "default",
      release: 2,
    });
    expect((store.get("gateways/default/releases/2")?.payload as ReleasePayload)).toEqual({
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: `aaaaaaa-oc2026.7.1@${gatewayDigest}`,
      profileImages: {
        operator: {
          imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-operator",
          imageTag: `aaaaaaa-oc2026.7.1@${operatorDigest}`,
        },
      },
      gatewayEdgeImage: {
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
        imageTag: `aaaaaaa-oc2026.7.1@${edgeDigest}`,
      },
    });
    expect(opsIn(store, "rollout")).toHaveLength(1);
    expect(authority.ensureAliases).toHaveBeenCalledTimes(2);
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      what: "cut CENTRAL TEST release",
      testProvenance: expect.objectContaining({ environment: "test", sourceCommit: sourceSha }),
    }));
  });

  it("rolls every non-retired gateway when the CENTRAL TEST scope is all", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp({
      ...seedNewSchemaGateway("default", sharedPayload()),
      ...seedNewSchemaGateway("shared-blue", sharedPayload()),
      ...seedNewSchemaGateway("paused", sharedPayload(), { desiredStatus: "paused" }),
      ...seedNewSchemaGateway("retired", sharedPayload(), { desiredStatus: "retired" }),
    }, { releaseAuthority: authority });

    const response = await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha, gatewayScope: "all" })
      .expect(202);

    expect(response.body.rollouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewayId: "default", release: 2 }),
      expect.objectContaining({ gatewayId: "shared-blue", release: 2 }),
      expect.objectContaining({ gatewayId: "paused", release: 2 }),
    ]));
    expect(response.body.rollouts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewayId: "retired" }),
    ]));
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 2, desiredRelease: 1 });
    expect(store.get("gateways/shared-blue")).toMatchObject({
      latestRelease: 2,
      desiredRelease: 1,
    });
    expect(store.get("gateways/paused")).toMatchObject({ latestRelease: 2, desiredRelease: 1 });
    expect(store.get("gateways/retired")).toMatchObject({ desiredRelease: 1 });
    expect(auditsIn(store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ what: "cut CENTRAL TEST release" }),
      expect.objectContaining({ what: "cut CENTRAL TEST gateway rollout", target: { gatewayId: "shared-blue", gatewayScope: "all", version: "v0.4.0", sourceSha } }),
    ]));
  });

  it("fans a CENTRAL TEST shared release to every configured pool member and excludes isolated gateways", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp({
      "config/orchestrator": {
        defaultGatewayId: "default",
        sharedGatewayIds: ["default", "default-b"],
      },
      ...seedNewSchemaGateway("default", sharedPayload()),
      ...seedNewSchemaGateway("default-b", sharedPayload()),
      ...seedNewSchemaGateway("isolated", sharedPayload()),
    }, { releaseAuthority: authority });

    const response = await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha })
      .expect(202);

    expect(response.body.rollouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewayId: "default", release: 2 }),
      expect.objectContaining({ gatewayId: "default-b", release: 2 }),
    ]));
    expect(response.body.rollouts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewayId: "isolated" }),
    ]));
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 2, desiredRelease: 1 });
    expect(store.get("gateways/default-b")).toMatchObject({
      latestRelease: 2,
      desiredRelease: 1,
    });
    expect(store.get("gateways/isolated")).toMatchObject({ desiredRelease: 1 });
    expect(opsIn(store, "rollout")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        input: expect.objectContaining({ gatewayId: "default", targetRelease: 2 }),
      }),
      expect.objectContaining({
        input: expect.objectContaining({ gatewayId: "default-b", targetRelease: 2 }),
      }),
    ]));
  });

  it("queues a newer CENTRAL release behind an active rollout reservation", async () => {
    const authority = releaseAuthority();
    const seed = seedNewSchemaGateway("default", sharedPayload(), {
      latestRelease: 2,
      desiredRelease: 2,
      liveRelease: 1,
    });
    seed[`${GLM_OPERATIONS_COLLECTION}/rollout-v0.4.13`] = {
      kind: "rollout",
      status: "running",
      input: { gatewayId: "default", targetRelease: 2, imageTag: "old-release" },
    };
    const { app, store } = mkApp(seed, { releaseAuthority: authority });

    const response = await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.1", sourceSha })
      .expect(202);

    expect(response.body).toMatchObject({ release: 3 });
    expect(store.get("gateways/default")).toMatchObject({
      latestRelease: 3,
      desiredRelease: 2,
      liveRelease: 1,
    });
    expect(opsIn(store, "rollout")).toEqual(expect.arrayContaining([
      expect.objectContaining({ input: expect.objectContaining({ targetRelease: 2 }) }),
      expect.objectContaining({ input: expect.objectContaining({ targetRelease: 3 }) }),
    ]));
  });

  it("rejects a non-rollout gateway conflict even when an active rollout is read first", async () => {
    const authority = releaseAuthority();
    const seed = seedNewSchemaGateway("default", sharedPayload());
    seed[`${GLM_OPERATIONS_COLLECTION}/rollout-first`] = {
      kind: "rollout",
      status: "running",
      input: { gatewayId: "default", targetRelease: 2, imageTag: "old-release" },
    };
    seed[`${GLM_OPERATIONS_COLLECTION}/restart-second`] = {
      kind: "restart-gateway",
      status: "pending",
      input: { gatewayId: "default" },
    };
    const { app, store } = mkApp(seed, { releaseAuthority: authority });

    await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.1", sourceSha })
      .expect(409)
      .expect({
        error: "another operation is already pending or running for this gateway",
        gatewayId: "default",
        operationId: "restart-second",
        kind: "restart-gateway",
      });

    expect(authority.ensureAliases).not.toHaveBeenCalled();
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 1, desiredRelease: 1 });
    expect(store.get("centralReleaseFanouts/v0.4.1")).toBeUndefined();
    expect(opsIn(store, "rollout")).toHaveLength(1);
  });

  it("rejects a CENTRAL release before fanout when a customer migration owns a member", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp({
      "config/orchestrator": {
        defaultGatewayId: "default",
        sharedGatewayIds: ["default", "default-b"],
      },
      ...seedNewSchemaGateway("default", sharedPayload()),
      ...seedNewSchemaGateway("default-b", sharedPayload()),
      [`${GLM_OPERATIONS_COLLECTION}/migration-live`]: {
        kind: "migrate-customer",
        status: "running",
        input: { fromGatewayId: "other", toGatewayId: "elsewhere" },
        customerMigrationV2: {
          sourceGatewayId: "default-b",
          targetGatewayId: "elsewhere",
        },
      },
    }, { releaseAuthority: authority });

    await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.1", sourceSha })
      .expect(409)
      .expect(({ body }) => expect(body.error).toMatch(/customer migration.*in flight/i));

    expect(authority.ensureAliases).not.toHaveBeenCalled();
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 1, desiredRelease: 1 });
    expect(store.get("gateways/default-b")).toMatchObject({ latestRelease: 1, desiredRelease: 1 });
    expect(store.get("centralReleaseFanouts/v0.4.1")).toBeUndefined();
    expect(opsIn(store, "rollout")).toHaveLength(0);
  });

  it("rejects a CENTRAL release when any configured shared member is not running", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp({
      "config/orchestrator": {
        defaultGatewayId: "default",
        sharedGatewayIds: ["default", "default-b"],
      },
      ...seedNewSchemaGateway("default", sharedPayload()),
      ...seedNewSchemaGateway("default-b", sharedPayload(), { desiredStatus: "paused" }),
    }, { releaseAuthority: authority });

    await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha })
      .expect(409)
      .expect({
        error: "configured shared gateway must be running to cut a release",
        gatewayId: "default-b",
      });

    expect(store.get("gateways/default")).toMatchObject({ desiredRelease: 1 });
    expect(store.get("gateways/default-b")).toMatchObject({ desiredRelease: 1 });
  });

  it("rejects a conflicting durable TEST version before aliases or desired state change", async () => {
    const conflictingSourceSha = "f".repeat(40);
    const authority = releaseAuthority(releaseManifest({ sourceSha: conflictingSourceSha }));
    const { app, store } = mkApp({
      ...seedNewSchemaGateway("default", sharedPayload()),
      "centralReleaseFanouts/v0.4.0": {
        version: "v0.4.0",
        sourceSha,
        manifestDigest,
        environment: "test",
        gatewayScope: "shared",
        gatewayIds: ["default"],
        status: "complete",
        rollouts: {
          default: { release: 2, rolloutOperationId: "rollout-existing" },
        },
      },
    }, { releaseAuthority: authority });

    await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha: conflictingSourceSha })
      .expect(409)
      .expect({
        error: "CENTRAL release version v0.4.0 is already reserved for a different pool or manifest",
      });

    expect(authority.ensureAliases).not.toHaveBeenCalled();
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 1, desiredRelease: 1 });
    expect(opsIn(store, "rollout")).toHaveLength(0);
  });

  it("reuses a matching durable TEST version without changing desired state", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp({
      ...seedNewSchemaGateway("default", sharedPayload()),
      "centralReleaseFanouts/v0.4.0": {
        version: "v0.4.0",
        sourceSha,
        manifestDigest,
        environment: "test",
        gatewayScope: "shared",
        gatewayIds: ["default"],
        status: "complete",
        rollouts: {
          default: { release: 2, rolloutOperationId: "rollout-existing" },
        },
      },
    }, { releaseAuthority: authority });

    const response = await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha })
      .expect(202);

    expect(response.body).toMatchObject({ release: 2, operationId: "rollout-existing" });
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 1, desiredRelease: 1 });
    expect(opsIn(store, "rollout")).toHaveLength(0);
    expect(authority.ensureAliases).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent matching TEST cuts through one durable reservation", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp(seedNewSchemaGateway("default", sharedPayload()), {
      releaseAuthority: authority,
      synchronizeFirstTwoReadsOf: "centralReleaseFanouts/v0.4.0",
    });

    const [first, second] = await Promise.all([
      request(app).post("/releases/cut").send({ version: "v0.4.0", sourceSha }),
      request(app).post("/releases/cut").send({ version: "v0.4.0", sourceSha }),
    ]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect([first.body.release, second.body.release]).toEqual([2, 2]);
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 2, desiredRelease: 1 });
    expect(store.get("centralReleaseFanouts/v0.4.0")).toMatchObject({
      sourceSha,
      manifestDigest,
      status: "complete",
      rollouts: {
        default: { release: 2 },
      },
    });
    expect(opsIn(store, "rollout")).toHaveLength(1);
  });

  it("journals aliases as partial when maintenance freezes before desired state append", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp(seedNewSchemaGateway("default", sharedPayload()), {
      releaseAuthority: authority,
    });
    authority.ensureAliases.mockImplementationOnce(async (aliases: Array<{ alias: string; intendedTarget: string }>) => {
      store.set("config/glmMaintenance", { mode: "frozen", reason: "incident" });
      return aliases.map((alias) => ({
        alias: alias.alias,
        status: "applied",
        observedTarget: alias.intendedTarget,
      }));
    });

    await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha })
      .expect(409)
      .expect({ error: "maintenance freeze blocks fleet mutation: incident" });

    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 1, desiredRelease: 1 });
    expect(opsIn(store, "rollout")).toHaveLength(0);
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      lifecycleStage: "action-partial",
      outcome: "partial",
      aliasOutcomes: expect.arrayContaining([expect.objectContaining({ status: "applied" })]),
      partialOutcome: expect.any(Object),
    }));
  });

  it("journals completed aliases and rollout when the TEST authorization marker fails", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp(seedNewSchemaGateway("default", sharedPayload()), {
      releaseAuthority: authority,
    });
    authority.ensureAliases
      .mockResolvedValueOnce([{
        alias: "source-alias",
        status: "applied",
        observedTarget: "source-target",
      }])
      .mockRejectedValueOnce(new ReleaseDigestAliasError([{
        alias: "test-record-alias",
        status: "failed",
        error: "marker collision",
      }], new Error("marker collision")));

    await request(app)
      .post("/releases/cut")
      .send({ version: "v0.4.0", sourceSha })
      .expect(500);

    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 2, desiredRelease: 1 });
    expect(store.get("centralReleaseFanouts/v0.4.0")).toMatchObject({
      status: "pending",
      rollouts: { default: { release: 2 } },
    });
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      lifecycleStage: "action-partial",
      outcome: "partial",
      aliasOutcomes: [
        expect.objectContaining({ alias: "source-alias", status: "applied" }),
        expect.objectContaining({ alias: "test-record-alias", status: "failed" }),
      ],
      releaseRollout: expect.objectContaining({ releaseId: "default/2" }),
      partialOutcome: expect.objectContaining({
        details: expect.objectContaining({ failedStep: "test-record" }),
      }),
    }));
  });

  it("retries a partial TEST marker with the deterministic cut key without another desired release", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp(seedNewSchemaGateway("default", sharedPayload()), {
      releaseAuthority: authority,
    });
    const idempotencyKey = `release-cut:v0.4.0:${sourceSha}`;
    authority.ensureAliases
      .mockResolvedValueOnce([{
        alias: "source-alias",
        status: "applied",
        observedTarget: "source-target",
      }])
      .mockRejectedValueOnce(new ReleaseDigestAliasError([{
        alias: "test-record-alias",
        status: "failed",
        error: "marker collision",
      }], new Error("marker collision")))
      .mockResolvedValueOnce([{
        alias: "source-alias",
        status: "already-applied",
        observedTarget: "source-target",
      }])
      .mockResolvedValueOnce([{
        alias: "test-record-alias",
        status: "applied",
        observedTarget: "test-record-target",
      }]);

    await request(app)
      .post("/releases/cut")
      .set("Idempotency-Key", idempotencyKey)
      .send({ version: "v0.4.0", sourceSha })
      .expect(500);

    const retry = await request(app)
      .post("/releases/cut")
      .set("Idempotency-Key", idempotencyKey)
      .send({ version: "v0.4.0", sourceSha })
      .expect(202);

    expect(retry.body).toEqual(expect.objectContaining({ release: 2 }));
    expect(store.get("gateways/default")).toMatchObject({ latestRelease: 2, desiredRelease: 1 });
    expect(opsIn(store, "rollout")).toHaveLength(1);
    expect(auditsIn(store)).toHaveLength(2);
  });

  it.each(["v01.2.3", "v1.02.3", "v1.2.03", "v1.2.3-01", "v1.2.3-alpha.01"])(
    "rejects non-semver release version %s before CENTRAL authority calls",
    async (version) => {
      const authority = releaseAuthority();
      const { app } = mkApp(seedNewSchemaGateway("default", sharedPayload()), {
        releaseAuthority: authority,
      });

      await request(app)
        .post("/releases/cut")
        .send({ version, sourceSha })
        .expect(400);

      expect(authority.resolveManifest).not.toHaveBeenCalled();
    },
  );

  it("requires an identical durable TEST manifest record before a CENTRAL PROD promotion", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp(seedNewSchemaGateway("default", sharedPayload()), {
      releaseEnvironment: "prod",
      releaseAuthority: authority,
    });

    await request(app).post("/releases/v0.4.0/promote").send({}).expect(202);

    expect(authority.resolveTestManifest).toHaveBeenCalledWith("v0.4.0");
    expect((store.get("gateways/default/releases/2")?.payload as ReleasePayload).imageTag)
      .toBe(`aaaaaaa-oc2026.7.1@${gatewayDigest}`);
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      what: "promote CENTRAL release",
      testProvenance: expect.objectContaining({ environment: "test", sourceCommit: sourceSha }),
    }));
  });

  it("fans CENTRAL PROD promotion to the configured shared pool and excludes isolated gateways", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp({
      "config/orchestrator": {
        defaultGatewayId: "default",
        sharedGatewayIds: ["default", "default-b"],
      },
      ...seedNewSchemaGateway("default", sharedPayload()),
      ...seedNewSchemaGateway("default-b", sharedPayload()),
      ...seedNewSchemaGateway("isolated", sharedPayload()),
    }, {
      releaseEnvironment: "prod",
      releaseAuthority: authority,
    });

    const response = await request(app).post("/releases/v0.4.0/promote").send({}).expect(202);

    expect(response.body).toMatchObject({ gatewayScope: "shared" });
    expect(response.body.rollouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewayId: "default", release: 2 }),
      expect.objectContaining({ gatewayId: "default-b", release: 2 }),
    ]));
    expect(response.body.rollouts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewayId: "isolated" }),
    ]));
    expect(store.get("gateways/default-b")).toMatchObject({
      latestRelease: 2,
      desiredRelease: 1,
    });
    expect(store.get("gateways/isolated")).toMatchObject({ desiredRelease: 1 });
    expect(auditsIn(store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ what: "promote CENTRAL PROD gateway rollout" }),
    ]));
  });

  it("resumes an interrupted PROD pool fanout without cutting another primary release", async () => {
    const authority = releaseAuthority();
    const { app, store } = mkApp({
      "config/orchestrator": {
        defaultGatewayId: "default",
        sharedGatewayIds: ["default", "default-b"],
      },
      ...seedNewSchemaGateway("default", sharedPayload()),
      ...seedNewSchemaGateway("default-b", sharedPayload()),
    }, {
      releaseEnvironment: "prod",
      releaseAuthority: authority,
      failFirstTransactionReadOf: "gateways/default-b",
    });

    await request(app).post("/releases/v0.4.0/promote").send({}).expect(500);

    expect(store.get("gateways/default")).toMatchObject({
      latestRelease: 2,
      desiredRelease: 1,
    });
    expect(store.get("gateways/default-b")).toMatchObject({
      latestRelease: 1,
      desiredRelease: 1,
    });
    expect(store.get("centralReleaseFanouts/v0.4.0")).toMatchObject({
      status: "pending",
      rollouts: { default: { release: 2 } },
    });

    const resumed = await request(app)
      .post("/releases/v0.4.0/promote")
      .send({})
      .expect(202);

    expect(resumed.body.rollouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewayId: "default", release: 2, reused: true }),
      expect.objectContaining({ gatewayId: "default-b", release: 2 }),
    ]));
    expect(store.get("gateways/default")).toMatchObject({
      latestRelease: 2,
      desiredRelease: 1,
    });
    expect(store.get("gateways/default-b")).toMatchObject({
      latestRelease: 2,
      desiredRelease: 1,
    });
    expect(store.get("centralReleaseFanouts/v0.4.0")).toMatchObject({
      status: "complete",
      rollouts: {
        default: { release: 2 },
        "default-b": { release: 2 },
      },
    });
    expect(opsIn(store, "rollout")).toHaveLength(2);
  });
});

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
  };
  seed[`${GLM_GATEWAYS_COLLECTION}/${id}`] = {
    docKind: "runtime",
    gatewayId: id,
    release: 1,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    helm: {},
    heartbeat,
    lastError: { message: null, at: null },
  };
  return seed;
}

function builderUser(gatewayId: string | null, managedBy = "cowboy"): Record<string, unknown> {
  return {
    username: "alice",
    provisioning: {
      openclaw: {
        slug: "alice",
        ...(gatewayId ? {
          gatewayId,
          gatewayAssignedAt: 1,
          gatewayProfile: "standard",
          shellsEnabled: true,
        } : {}),
        managedBy,
      },
    },
  };
}

describe("PATCH /customers/:uid/placement", () => {
  it("rejects malformed placement commands before journaling or writing", async () => {
    const { app, store } = mkApp({ "users/uid-alice": builderUser("source") });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator" })
      .expect(400);
    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "cowboy", gatewayId: null })
      .expect(400);
    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target", unexpected: true })
      .expect(400);
    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "a/../b" })
      .expect(400)
      .expect({ error: "placement gatewayId must be a valid gateway id" });

    expect(store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(auditsIn(store)).toHaveLength(0);
  });

  it("atomically marks an assigned Builder operator-managed and queues its explicit migration", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      ...seedServingGateway("target", sharedPayload()),
    });

    const response = await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(202);

    expect(response.body).toMatchObject({
      uid: "uid-alice",
      gatewayId: "target",
      operationId: expect.any(String),
    });
    expect(store.get("users/uid-alice")).toMatchObject({
      provisioning: { openclaw: { gatewayId: "source", managedBy: "operator" } },
    });
    expect(store.get(`glmOperations/${response.body.operationId}`)).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      origin: "operator",
      inputUid: "uid-alice",
      gatewayId: "target",
      input: {
        uid: "uid-alice",
        builderSlug: "alice",
        fromGatewayId: "source",
        toGatewayId: "target",
        source: "operator-builder-evict",
      },
    });
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      target: { uid: "uid-alice", gatewayId: "target" },
      mutation: {
        kind: "evict-builder-to-gateway",
        uid: "uid-alice",
        fromGatewayId: "source",
        toGatewayId: "target",
      },
    }));
  });

  it("repairs a missing serving assignment while taking ownership on the current target", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("target"),
      ...seedServingGateway("target", sharedPayload()),
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(200)
      .expect({
        uid: "uid-alice",
        gatewayId: "target",
        managedBy: "operator",
        repaired: true,
      });

    expect(store.get("users/uid-alice")).toMatchObject({
      provisioning: { openclaw: { gatewayId: "target", managedBy: "operator" } },
    });
    expect(store.get("gateways/target/assignments/uid-alice")).toMatchObject({
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "target",
      source: "repair",
      state: "serving",
    });
    expect(opsIn(store, "migrate-customer")).toHaveLength(0);
  });

  it("rejects ownership transfer while the current target assignment is mid-migration", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("target"),
      ...seedServingGateway("target", sharedPayload()),
      "gateways/target/assignments/uid-alice": {
        uid: "uid-alice",
        slug: "alice",
        gatewayId: "target",
        source: "migrate-customer",
        state: "quiescing",
        epoch: 2,
      },
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(409);

    expect(store.get("users/uid-alice")).toEqual(builderUser("target"));
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("rejects ownership transfer for a serving assignment with foreign identity", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("target"),
      ...seedServingGateway("target", sharedPayload()),
      "gateways/target/assignments/uid-alice": {
        uid: "uid-alice",
        slug: "somebody-else",
        gatewayId: "other",
        source: "repair",
        state: "serving",
        epoch: 2,
      },
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(409);

    expect(store.get("users/uid-alice")).toEqual(builderUser("target"));
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("rejects an eviction while another migration owns the Builder", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      "glmOperations/migration-1": {
        kind: "migrate-customer",
        status: "pending",
        inputUid: "uid-alice",
      },
      ...seedServingGateway("target", sharedPayload()),
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(409);

    expect(store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(opsIn(store, "migrate-customer")).toHaveLength(1);
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("places an unassigned Builder directly while atomically taking operator ownership", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser(null),
      ...seedServingGateway("target", sharedPayload()),
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(202);

    expect(store.get("users/uid-alice")).toMatchObject({
      provisioning: {
        openclaw: {
          gatewayId: "target",
          gatewayProfile: "standard",
          shellsEnabled: false,
          managedBy: "operator",
        },
      },
    });
    expect(store.get("gateways/target/assignments/uid-alice")).toMatchObject({
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "target",
      source: "repair",
      state: "serving",
    });
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      mutation: { kind: "evict-builder-to-gateway", uid: "uid-alice", toGatewayId: "target" },
    }));
  });

  it("rejects an eviction when the target is deleted after preflight", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      ...seedServingGateway("target", sharedPayload()),
    }, {
      beforeFirstTransaction: (store) => store.delete("gateways/target"),
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(404)
      .expect({ error: "gateway not found", gatewayId: "target" });

    expect(store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(opsIn(store, "migrate-customer")).toHaveLength(0);
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("rejects an eviction when the target runtime fails after preflight", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      ...seedServingGateway("target", sharedPayload()),
    }, {
      beforeFirstTransaction: (store) => {
        store.set(`${GLM_GATEWAYS_COLLECTION}/target`, {
          ...store.get(`${GLM_GATEWAYS_COLLECTION}/target`)!,
          lifecycle: "failed",
        });
      },
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(409)
      .expect({ error: "target gateway not ready", gatewayId: "target", status: "failed" });

    expect(store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(opsIn(store, "migrate-customer")).toHaveLength(0);
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("rejects an unassigned Builder eviction when a migration starts after preflight", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser(null),
      ...seedServingGateway("target", sharedPayload()),
    }, {
      beforeFirstTransaction: (store) => {
        store.set("glmOperations/migration-1", {
          kind: "migrate-customer",
          status: "pending",
          inputUid: "uid-alice",
        });
      },
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(409)
      .expect({
        error: "a migration for this customer is pending or running",
        operationId: "migration-1",
        uid: "uid-alice",
      });

    expect(store.get("users/uid-alice")).toEqual(builderUser(null));
    expect(store.get("gateways/target/assignments/uid-alice")).toBeUndefined();
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("parks atomically with operator ownership after deleting the serving assignment", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      "gateways/source/assignments/uid-alice": {
        uid: "uid-alice",
        slug: "alice",
        gatewayId: "source",
        source: "repair",
        state: "serving",
        epoch: 0,
      },
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: null })
      .expect(200)
      .expect({ uid: "uid-alice", parked: true });

    expect(store.get("users/uid-alice")).toMatchObject({
      provisioning: { openclaw: { managedBy: "operator" } },
    });
    const openclaw = (store.get("users/uid-alice")?.provisioning as Record<string, unknown>)
      .openclaw as Record<string, unknown>;
    expect(openclaw).not.toHaveProperty("gatewayId");
    expect(openclaw).not.toHaveProperty("gatewayAssignedAt");
    expect(openclaw).not.toHaveProperty("gatewayProfile");
    expect(openclaw).not.toHaveProperty("shellsEnabled");
    expect(store.get("gateways/source/assignments/uid-alice")).toBeUndefined();
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      mutation: { kind: "park-builder", uid: "uid-alice", gatewayId: "source" },
    }));
  });

  it("rejects a park while a migration owns the Builder", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      "glmOperations/migration-1": {
        kind: "migrate-customer",
        status: "running",
        inputUid: "uid-alice",
      },
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: null })
      .expect(409);

    expect(store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("rejects a missing or not-ready target before journaling or changing placement", async () => {
    const missing = mkApp({ "users/uid-alice": builderUser("source") });

    await request(missing.app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "missing" })
      .expect(404);

    expect(missing.store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(auditsIn(missing.store)).toHaveLength(0);

    const notReady = mkApp({
      "users/uid-alice": builderUser("source"),
      ...seedNewSchemaGateway("target", sharedPayload()),
    });

    await request(notReady.app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(409);

    expect(notReady.store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(auditsIn(notReady.store)).toHaveLength(0);
  });

  it("releases a parked Builder to Cowboy without waiting for live placement", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser(null, "operator"),
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "cowboy" })
      .expect(200)
      .expect({ uid: "uid-alice", managedBy: "cowboy" });

    expect(store.get("users/uid-alice")).toMatchObject({
      provisioning: { openclaw: { managedBy: "cowboy" } },
    });
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      mutation: { kind: "place-builder", uid: "uid-alice" },
    }));
  });

  it("rejects release to Cowboy while an explicit migration is active", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source", "operator"),
      "glmOperations/migration-1": {
        kind: "migrate-customer",
        status: "pending",
        inputUid: "uid-alice",
      },
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "cowboy" })
      .expect(409);

    expect(store.get("users/uid-alice")).toEqual(builderUser("source", "operator"));
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("reports missing Builders for park and place without creating a journal row", async () => {
    const { app, store } = mkApp();

    await request(app)
      .patch("/customers/uid-missing/placement")
      .send({ managedBy: "operator", gatewayId: null })
      .expect(404)
      .expect({ error: "user not found", uid: "uid-missing" });
    await request(app)
      .patch("/customers/uid-missing/placement")
      .send({ managedBy: "cowboy" })
      .expect(404)
      .expect({ error: "user not found", uid: "uid-missing" });

    expect(auditsIn(store)).toHaveLength(0);
  });

  it("blocks a frozen eviction before journaling or mutating Builder placement", async () => {
    const { app, store } = mkApp({
      "config/glmMaintenance": { mode: "frozen", reason: "incident" },
      "users/uid-alice": builderUser("source"),
      ...seedServingGateway("target", sharedPayload()),
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "target" })
      .expect(409)
      .expect({ error: "maintenance freeze blocks fleet mutation: incident" });

    expect(store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(opsIn(store, "migrate-customer")).toHaveLength(0);
    expect(auditsIn(store)).toHaveLength(0);
  });
});

describe("PATCH /customers/:uid/placement", () => {
  it("rejects direct owner placement without creating a migration", async () => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      ...seedServingGateway("legacy-owner", sharedPayload(), readyHeartbeat(), {
        gatewayClass: "operator",
        ownerUid: "uid-alice",
        builderSlug: "alice",
      }),
    });

    await request(app)
      .patch("/customers/uid-alice/placement")
      .send({ managedBy: "operator", gatewayId: "legacy-owner" })
      .expect(400)
      .expect({
        error: "owner-only gateway placement is managed by the disposable lifecycle",
        gatewayId: "legacy-owner",
      });

    expect(store.get("users/uid-alice")).toEqual(builderUser("source"));
    expect(opsIn(store, "migrate-customer")).toHaveLength(0);
  });
});

describe("manual gateway migrations", () => {
  it.each([
    ["/customers/uid-alice/migrate", { to: "legacy-owner" }],
    ["/gateway-migrations/bulk", { uids: ["uid-alice"], toGatewayId: "legacy-owner" }],
  ])("rejects an owner runtime target for %s", async (path, body) => {
    const { app, store } = mkApp({
      "users/uid-alice": builderUser("source"),
      ...seedServingGateway("legacy-owner", sharedPayload(), readyHeartbeat(), {
        gatewayClass: "operator",
        ownerUid: "uid-alice",
        builderSlug: "alice",
      }),
    });

    await request(app)
      .post(path)
      .send(body)
      .expect(400)
      .expect({
        error: "manual migration target must be a shared gateway",
        gatewayId: "legacy-owner",
      });

    expect(opsIn(store, "migrate-customer")).toHaveLength(0);
  });
});

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
    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "completed",
      what: "add gateway",
      target: { gatewayId: "alpha" },
    }));
  });

  it("records a failed audit when gateway secret provisioning fails", async () => {
    const { app, store } = mkApp({}, {
      provisionGatewayAuthSecret: async () => {
        throw new Error("secret manager unavailable");
      },
    });

    await request(app)
      .post("/gateways")
      .send({ gatewayId: "alpha", imageRepository: REPO, imageTag: "abc1234" })
      .expect(502);

    expect(auditsIn(store)).toContainEqual(expect.objectContaining({
      status: "failed",
      what: "add gateway",
      error: "secret manager unavailable",
    }));
    expect(store.get("gateways/alpha")).toBeUndefined();
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

  it("rejects a manual owner-only gateway before provisioning any runtime state", async () => {
    const { app, store } = mkApp();
    const res = await request(app).post("/gateways").send({
      gatewayId: "operator",
      imageRepository: REPO,
      imageTag: "abc1234",
      gatewayClass: "operator",
      imageProfile: "operator",
      ownerUid: "uid-owner",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disposable lifecycle/);
    expect(store.get("gateways/operator")).toBeUndefined();
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

  it("rejects a manual owner-only target so the disposable lifecycle owns placement", async () => {
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
      .send({ gatewayId: "operator" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disposable lifecycle/);
    expect(store.get("gateways/operator/assignments/uid-alice")).toBeUndefined();
  });

  it("does not use a legacy bare heartbeat doc when no runtime realization exists", async () => {
    const seed = seedNewSchemaGateway("target", sharedPayload());
    seed["gateways/target"] = {
      ...seed["gateways/target"],
      liveRelease: 1,
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

  it("stages release 2 and queues the exact rollout without advancing desiredRelease", async () => {
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
    expect(gw).toMatchObject({ latestRelease: 2, desiredRelease: 1 });

    expect(opsIn(store, "rollout")).toHaveLength(1);
    expect(opsIn(store, "rollout")[0]).toMatchObject({
      input: { gatewayId: "beta", targetRelease: 2, imageTag: "deadbee" },
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

  it("rejects direct ownership PATCHes so they cannot create a standing owner gateway", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("bench", sharedPayload()));

    const res = await request(app)
      .patch("/gateways/bench")
      .send({ gatewayClass: "operator", ownerUid: "uid-new", builderSlug: "new" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disposable lifecycle/);
    expect(res.body.fields).toEqual(["gatewayClass", "ownerUid", "builderSlug"]);
    expect(store.get("gateways/bench")).toMatchObject({ gatewayClass: "shared" });
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
    expect(store.get("gateways/gamma")).toMatchObject({ latestRelease: 3, desiredRelease: 2 });
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
    expect(store.get("gateways/race")).toMatchObject({ latestRelease: 2, desiredRelease: 1 });
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
    expect(store.get("gateways/rb")).toMatchObject({ latestRelease: 3, desiredRelease: 2 });
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
    expect(res.body.releases[0]).toMatchObject({ note: "bump" });
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

  it.each(["operator", "cowboy"] as const)(
    "persists managedBy=%s on the durable root and journals the completed mutation",
    async (managedBy) => {
      const { app, store } = mkApp(seedNewSchemaGateway("zeta", sharedPayload()));

      await request(app)
        .patch("/gateways/zeta")
        .send({ managedBy })
        .expect(202)
        .expect({ gatewayId: "zeta", updated: ["managedBy"] });

      expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zeta`)).toBeUndefined();
      expect(store.get("gateways/zeta")?.managedBy).toBe(managedBy);
      expect(auditsIn(store)).toEqual([
        expect.objectContaining({
          status: "completed",
          forced: false,
          what: "update gateway desired configuration",
          target: { gatewayId: "zeta" },
          preActionStatus: {
            desiredStatus: "running",
            desiredRelease: 1,
            managedBy: "cowboy",
          },
          mutation: {
            kind: "patch-gateway",
            gatewayId: "zeta",
            patch: { managedBy },
          },
        }),
      ]);
    },
  );

  it("rejects an invalid managedBy value before it writes or journals", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("zeta", sharedPayload()));

    await request(app)
      .patch("/gateways/zeta")
      .send({ managedBy: "manual" })
      .expect(400)
      .expect({ error: "managedBy must be operator or cowboy" });

    expect(store.get("gateways/zeta")?.managedBy).toBeUndefined();
    expect(auditsIn(store)).toHaveLength(0);
  });

  it("does not mutate or journal managedBy while maintenance is frozen", async () => {
    const seed = {
      ...seedNewSchemaGateway("zeta", sharedPayload()),
      "config/glmMaintenance": { mode: "frozen", reason: "incident" },
    };
    const { app, store } = mkApp(seed);

    await request(app)
      .patch("/gateways/zeta")
      .send({ managedBy: "operator" })
      .expect(409)
      .expect({ error: "maintenance freeze blocks fleet mutation: incident" });

    expect(store.get("gateways/zeta")?.managedBy).toBeUndefined();
    expect(auditsIn(store)).toHaveLength(0);
  });

  it("refuses a malformed durable root rather than mutating it", async () => {
    const seed = seedNewSchemaGateway("zeta", sharedPayload());
    seed["gateways/zeta"] = { ...seed["gateways/zeta"], gatewayId: "other" };
    const { app, store } = mkApp(seed);

    const res = await request(app).patch("/gateways/zeta").send({ sizingTier: "m" });

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
        .send({ sizingTier: "m" });

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
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/zed`)).not.toMatchObject({ desiredStatus: expect.anything() });
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
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/back`)).not.toMatchObject({ desiredStatus: expect.anything() });
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

  it("refuses retirement while the desired release has not converged to live", async () => {
    const seed = seedServingGateway("rolling", sharedPayload());
    seed["gateways/rolling"] = {
      ...seed["gateways/rolling"],
      desiredRelease: 2,
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).delete("/gateways/rolling").expect(409);

    expect(res.body.error).toMatch(/not converged to live/i);
    expect(store.get("gateways/rolling")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("rejects when a new release lands after retirement preflight but before its transactional claim", async () => {
    const { app, store } = mkApp(seedServingGateway("racing-roll", sharedPayload()), {
      beforeFirstTransaction: (state) => {
        state.set("gateways/racing-roll", {
          ...state.get("gateways/racing-roll"),
          desiredRelease: 2,
        });
      },
    });

    await request(app).delete("/gateways/racing-roll").expect(409);

    expect(store.get("gateways/racing-roll")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });

  it("refuses retirement when a running root has no runtime realization", async () => {
    const seed = seedNewSchemaGateway("missing-live", sharedPayload());
    seed["gateways/missing-live"] = {
      ...seed["gateways/missing-live"],
      liveRelease: 1,
    };
    seed[`${GLM_GATEWAYS_COLLECTION}/missing-live`] = {
      gatewayId: "missing-live",
      heartbeat: { status: "ready", mountedCustomers: ["alice"] },
    };
    const { app, store } = mkApp(seed);

    const res = await request(app).delete("/gateways/missing-live").expect(409);

    expect(res.body.error).toContain("runtime telemetry");
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

  it("leaves disposable termination exclusively to the Builder runtime lifecycle", async () => {
    const seed = seedServingGateway("run-alice", sharedPayload(), readyHeartbeat(), {
      profile: "operator",
      gatewayClass: "operator",
      imageProfile: "operator",
      ownerUid: "uid-alice",
      builderSlug: "alice",
      operatorAccess: { shellsEnabled: true },
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-1",
        generation: 3,
        claimedByUid: "uid-alice",
      },
    });
    const { app, store } = mkApp(seed);

    const response = await request(app).delete("/gateways/run-alice").send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Builder runtime lifecycle/i);
    expect(store.get("gateways/run-alice")?.desiredStatus).toBe("running");
    expect(opsIn(store, "retire-gateway")).toHaveLength(0);
  });
});

// P1-2: a payload-affecting PATCH on a new-schema gateway must not silently
// diverge legacy desired from the latest release; it is rejected toward the
// release-cutting endpoint. Legacy-only gateways keep the direct-PATCH path.
describe("PATCH /gateways/:id — payload fields on a new-schema gateway route through releases", () => {
  it("updates sizingTier directly on the durable root without cutting a release", async () => {
    const { app, store } = mkApp(seedNewSchemaGateway("beta", sharedPayload()));
    const res = await request(app).patch("/gateways/beta").send({ sizingTier: "m" }).expect(202);
    expect(res.body.updated).toContain("sizingTier");
    expect(store.get(`${GLM_GATEWAYS_COLLECTION}/beta`)?.sizingTier).toBeUndefined();
    expect(store.get("gateways/beta")?.sizingTier).toBe("m");
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
    const res = await request(app).patch("/gateways/leg").send({ sizingTier: "m" });
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
      seedNewSchemaGateway("beta", sharedPayload(), { sizingTier: "l" }),
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
