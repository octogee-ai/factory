import express, { Router } from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

import { addAdminFleetRoutes } from "./admin-fleet-router.js";
import type { CentralReleaseAuthority, ReleaseDigestManifest } from "./artifact-registry.js";
import { createDocumentFixtureStore } from "./testing/journal-store.js";

type Seed = Record<string, Record<string, unknown>>;

const SOURCE_SHA = "a".repeat(40);
const MANIFEST: ReleaseDigestManifest = {
  sourceSha: SOURCE_SHA,
  manifestDigest: `sha256:${"b".repeat(64)}`,
  openclawVersion: "2026.8.1",
  openclawSourceSha: "f".repeat(40),
  repository: "registry.example/platform",
  surfaces: {
    gateway: {
      "octogee-gateway": `sha256:${"c".repeat(64)}`,
      "octogee-gateway-builder": `sha256:${"d".repeat(64)}`,
      "gateway-edge": `sha256:${"e".repeat(64)}`,
    },
    platform: {},
  },
};
const PAYLOAD: ReleasePayload = { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "abc1234" };

function gatewayRoot(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "operator",
    updatedAt: 1,
    updatedBy: "operator",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    coOwnerUids: [],
    ...overrides,
  };
}

function release(gatewayId: string, number: number, payload: ReleasePayload = PAYLOAD): Seed {
  return {
    [`gateways/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/${number}`]: {
      gatewayId,
      release: number,
      createdAt: 1,
      createdBy: "operator",
      sourceRelease: null,
      note: null,
      payloadHash: releasePayloadHash(payload),
      payload,
    },
  };
}

function servingSharedGateway(gatewayId: string): Seed {
  const observedAt = Date.now();
  return {
    [`gateways/${gatewayId}`]: gatewayRoot(gatewayId, { liveRelease: 1 }),
    ...release(gatewayId, 1),
    [`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`]: {
      docKind: "runtime",
      gatewayId,
      release: 1,
      lifecycle: "serving",
      createdAt: 1,
      createdByOperationId: null,
      helm: {},
      heartbeat: {
        status: "ready",
        lastHeartbeatAt: observedAt,
        version: "abc1234",
        startedAt: observedAt - 1_000,
        mountedCustomers: [],
      },
      lastError: { message: null, at: null },
    },
  };
}

function isolatedGateway(gatewayId: string, ownerUid: string, slug: string): Seed {
  return {
    [`gateways/${gatewayId}`]: gatewayRoot(gatewayId, {
      gatewayClass: "builder",
      imageProfile: "builder",
      profile: "builder",
      sizingTier: "s",
      ownerUid,
      builderSlug: slug,
      latestRelease: 2,
      desiredRelease: 2,
    }),
    ...release(gatewayId, 1),
    ...release(gatewayId, 2, { ...PAYLOAD, imageTag: "deadbee" }),
  };
}

function placedUser(uid: string, slug: string, gatewayId: string): Seed {
  return {
    [`users/${uid}`]: {
      username: slug,
      provisioning: { status: "complete", openclaw: { slug, gatewayId, status: "complete" } },
    },
    [`gateways/${gatewayId}/assignments/${uid}`]: {
      uid,
      slug,
      gatewayId,
      source: "onboarding",
      state: "serving",
      epoch: 1,
      createdAt: 1,
      updatedAt: 1,
      updatedByOperationId: null,
    },
  };
}

function operation(id: string, row: Record<string, unknown>): Seed {
  return { [`${GLM_OPERATIONS_COLLECTION}/${id}`]: row };
}

const FLEET: Seed = {
  "config/orchestrator": { defaultGatewayId: "shared-a", sharedGatewayIds: ["shared-a", "shared-b"] },
  ...servingSharedGateway("shared-a"),
  ...servingSharedGateway("shared-b"),
  ...isolatedGateway("iso-ada", "uid-ada", "ada"),
  "gateways/idle": gatewayRoot("idle"),
  "gateways/gone": gatewayRoot("gone", { desiredStatus: "retired" }),
  ...placedUser("uid-ada", "ada", "shared-a"),
};

function sourceRecoveryFleet(): Seed {
  const seed: Seed = {
    "gateways/shared-0": gatewayRoot("shared-0", { desiredStatus: "draining", liveRelease: 1 }),
    ...release("shared-0", 1),
  };
  for (const [index, slug] of ["jdog99", "oct01"].entries()) {
    const uid = `source-user-${index}`;
    const agentId = `octogee-${slug}-coach`;
    seed[`users/${uid}`] = { username: slug, provisioning: { openclaw: { gatewayId: "shared-0", status: "complete" } } };
    seed[`gateways/shared-0/assignments/${uid}`] = {
      uid, slug, gatewayId: "shared-0", source: "onboarding", state: "serving", epoch: index + 1,
      createdAt: 1, updatedAt: 1, updatedByOperationId: null,
    };
    seed[`users/${uid}/agentStores/${agentId}`] = {
      agentId, gatewayId: "shared-0", assignmentEpoch: index + 1,
      storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, schema: `source_${index}`, recordedAt: 1,
    };
  }
  return seed;
}

function restoreRecoveryFleet(): Seed {
  const receipt = { uid: "u", attemptId: "retained-1", gatewayId: "shared-0", assignmentEpoch: 3, claimStartedAt: 200, dispatchedAt: 100 };
  return {
    "gateways/shared-0": gatewayRoot("shared-0"),
    ...release("shared-0", 1),
    ...operation("return-1", { restoreAttempt: receipt }),
  };
}

function harness(seed: Seed = FLEET) {
  const records = new Map<string, Record<string, unknown>>(Object.entries(structuredClone(seed)));
  const effects = {
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
    requestNativeReturnSourceRecovery: vi.fn(async () => false),
    createAccount: vi.fn(async (account: { userId: string }) => ({ kind: "created" as const, userId: account.userId })),
    setChatPassword: vi.fn(async () => undefined),
    setGitPassword: vi.fn(async () => "ws-ada"),
  };
  const releaseAuthority: CentralReleaseAuthority = {
    resolveManifest: vi.fn(async () => MANIFEST),
    aliasesFor: vi.fn(() => []),
    keepTagsFor: vi.fn(() => []),
    ensureAliases: vi.fn(async () => []),
  };
  const router = Router();
  addAdminFleetRoutes(router, {
    db: {} as Firestore,
    store: createDocumentFixtureStore(records),
    logger: { info: vi.fn(), warn: vi.fn() },
    computerReplacementEnabled: true,
    listGatewayBuilds: vi.fn(async () => []),
    releaseEnvironment: "test",
    releaseAuthority,
    provisionGatewayAuthSecret: effects.provisionGatewayAuthSecret,
    suspendAuthUser: effects.suspendAuthUser,
    revokeConnectorGrantsForUser: effects.revokeConnectorGrantsForUser,
    requestNativeReturnSourceRecovery: effects.requestNativeReturnSourceRecovery,
    userAccounts: { create: effects.createAccount },
    userSignIn: {
      channels: { setUserPassword: effects.setChatPassword },
      git: { setUserPassword: effects.setGitPassword },
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { uid: "operator", isAdmin: true });
    next();
  });
  app.use(router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  const snapshot = () => JSON.stringify([...records.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return { app, router, records, effects, snapshot };
}

type Method = "post" | "patch" | "delete";

interface ChangingRequest {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}

function send(app: express.Express, call: ChangingRequest, dryRun: boolean) {
  const separator = call.path.includes("?") ? "&" : "?";
  const target = dryRun ? `${call.path}${separator}dryRun=true` : call.path;
  const pending = request(app)[call.method](target);
  return call.body === undefined ? pending : pending.send(call.body);
}

afterEach(() => vi.unstubAllEnvs());

describe("a dry run of a changing request", () => {
  it("plans a gateway restart with the state the journal would record", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "post", path: "/gateways/shared-b/restart" }, true).expect(200);

    expect(res.body).toEqual({
      dryRun: true,
      plans: [{
        what: "restart gateway",
        why: "Admin fleet request",
        kind: "restart-gateway",
        target: { gatewayId: "shared-b" },
        preActionStatus: { desiredStatus: "running", desiredRelease: 1 },
        mutation: { kind: "restart-gateway", gatewayId: "shared-b" },
        forced: false,
      }],
    });
    expect(h.snapshot()).toBe(before);
  });

  it("plans a deploy against the resolved build manifest", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "post", path: "/gateways/iso-ada/deploy", body: { sourceSha: SOURCE_SHA } }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "deploy build to gateway",
      kind: "deploy-gateway-build",
      target: { gatewayId: "iso-ada" },
      preActionStatus: { desiredStatus: "running", desiredRelease: 2, latestRelease: 2 },
      mutation: { kind: "deploy-gateway-build", gatewayId: "iso-ada", sourceSha: SOURCE_SHA, manifestDigest: MANIFEST.manifestDigest },
      forced: false,
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("plans a retirement with the retention flags it was asked for", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "delete", path: "/gateways/idle?retainData=true" }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "retire gateway",
      kind: "retire-gateway",
      target: { gatewayId: "idle" },
      preActionStatus: { desiredStatus: "running", desiredRelease: 1 },
      mutation: { kind: "retire-gateway", gatewayId: "idle", retainData: true },
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("plans a user migration from the user's current gateway", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-b" } }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "migrate user",
      target: { uid: "uid-ada", gatewayId: "shared-b" },
      preActionStatus: { gatewayId: "shared-a" },
      mutation: expect.objectContaining({ uid: "uid-ada", fromGatewayId: "shared-a", toGatewayId: "shared-b" }),
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("plans one migration per movable user of a bulk move and reports the rest", async () => {
    const h = harness({
      ...FLEET,
      ...placedUser("uid-bob", "bob", "shared-b"),
      ...placedUser("uid-cy", "cy", "shared-a"),
      ...operation("move-cy", { kind: "migrate-customer", status: "pending", inputUid: "uid-cy", input: { uid: "uid-cy", toGatewayId: "shared-b" } }),
    });
    const before = h.snapshot();

    const res = await send(h.app, {
      method: "post",
      path: "/gateway-migrations/bulk",
      body: { userIds: ["uid-ada", "uid-bob", "uid-cy", "uid-ghost"], toGatewayId: "shared-b" },
    }, true).expect(200);

    expect(res.body).toMatchObject({
      dryRun: true,
      targetGatewayId: "shared-b",
      sourceGatewayId: null,
      adopted: [{ uid: "uid-cy", operationId: "move-cy" }],
      rejected: [
        { uid: "uid-bob", reason: "already-on-target", currentGatewayId: "shared-b" },
        { uid: "uid-ghost", reason: "user-not-found" },
      ],
    });
    expect(res.body).not.toHaveProperty("enqueued");
    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "migrate user",
      target: { uid: "uid-ada", gatewayId: "shared-b" },
      preActionStatus: { gatewayId: "shared-a" },
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("answers a bulk move that would enqueue nothing as a dry run with no plans", async () => {
    const h = harness();

    const res = await send(h.app, {
      method: "post",
      path: "/gateway-migrations/bulk",
      body: { userIds: ["uid-ada"], toGatewayId: "shared-a" },
    }, true).expect(200);

    expect(res.body).toMatchObject({ dryRun: true, plans: [], rejected: [{ uid: "uid-ada", reason: "already-on-target" }] });
  });

  it("plans an activation lease request from the user's current placement", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await send(h.app, { method: "post", path: "/users/uid-ada/activation-lease" }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({
      what: "request user activation lease",
      kind: "request-activation-lease",
      target: { uid: "uid-ada" },
      preActionStatus: { gatewayId: "shared-a", assignmentEpoch: 1 },
    })]);
    expect(h.snapshot()).toBe(before);
  });

  it("marks a forced request as forced", async () => {
    const h = harness();

    const res = await send(h.app, {
      method: "post",
      path: "/users/uid-ada/vm/replace",
      body: { force: true, acceptBootDataLoss: true },
    }, true).expect(200);

    expect(res.body.plans).toEqual([expect.objectContaining({ what: "replace VM", forced: true })]);
  });

  const busyGateway = operation("busy", { kind: "restart-gateway", status: "running", input: { gatewayId: "shared-b" } });
  const movingAda = operation("move-ada", {
    kind: "migrate-customer", status: "pending", inputUid: "uid-ada", input: { uid: "uid-ada", toGatewayId: "shared-b" },
  });

  it.each<[string, number, ChangingRequest, Seed]>([
    ["restart of an unknown gateway", 404, { method: "post", path: "/gateways/nowhere/restart" }, FLEET],
    ["restart of a retired gateway", 409, { method: "post", path: "/gateways/gone/restart" }, FLEET],
    ["restart while an operation is in flight", 409, { method: "post", path: "/gateways/shared-b/restart" }, { ...FLEET, ...busyGateway }],
    ["deploy to an unknown gateway", 404, { method: "post", path: "/gateways/nowhere/deploy", body: { sourceSha: SOURCE_SHA } }, FLEET],
    ["deploy to a retired gateway", 409, { method: "post", path: "/gateways/gone/deploy", body: { sourceSha: SOURCE_SHA } }, FLEET],
    ["deploy to a shared gateway", 409, { method: "post", path: "/gateways/shared-b/deploy", body: { sourceSha: SOURCE_SHA } }, FLEET],
    ["retirement of an unknown gateway", 404, { method: "delete", path: "/gateways/nowhere" }, FLEET],
    ["retirement of a gateway with assigned users", 409, { method: "delete", path: "/gateways/shared-a" }, FLEET],
    ["migration to an unregistered gateway", 404, { method: "post", path: "/users/uid-ada/migrate", body: { to: "nowhere" } }, FLEET],
    ["migration to the user's current gateway", 409, { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-a" } }, FLEET],
    ["migration while another is in flight", 409, { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-b" } }, { ...FLEET, ...movingAda }],
    ["bulk move to an unregistered gateway", 404, { method: "post", path: "/gateway-migrations/bulk", body: { userIds: ["uid-ada"], toGatewayId: "nowhere" } }, FLEET],
    ["bulk move to a gateway that is not ready", 409, { method: "post", path: "/gateway-migrations/bulk", body: { userIds: ["uid-ada"], toGatewayId: "idle" } }, FLEET],
    ["activation lease request for an unknown user", 404, { method: "post", path: "/users/uid-ghost/activation-lease" }, FLEET],
  ])("refuses a %s exactly as the real request does", async (_label, status, call, seed) => {
    const h = harness(seed);
    const before = h.snapshot();

    const dry = await send(h.app, call, true);
    expect(h.snapshot()).toBe(before);
    const real = await send(h.app, call, false);

    expect(dry.status).toBe(status);
    expect(real.status).toBe(status);
    expect(dry.body).toEqual(real.body);
  });

  it("leaves the Idempotency-Key unused for the real request", async () => {
    const h = harness();
    const restart = (target: string) => request(h.app).post(target).set("Idempotency-Key", "restart-once");

    const dry = await restart("/gateways/shared-b/restart?dryRun=true");
    const real = await restart("/gateways/shared-b/restart");
    const repeated = await restart("/gateways/shared-b/restart");

    expect([dry.status, real.status, repeated.status]).toEqual([200, 202, 409]);
  });

  it("refuses a marker that is neither true nor false instead of applying the change", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await request(h.app).post("/gateways/shared-b/restart?dryRun=yes").expect(400);

    expect(res.body.error).toBe("dryRun must be true or false");
    expect(h.snapshot()).toBe(before);
  });

  it("applies the change when the marker is false", async () => {
    const h = harness();
    const before = h.snapshot();

    const res = await request(h.app).post("/gateways/shared-b/restart?dryRun=false").expect(202);

    expect(res.body).toMatchObject({ gatewayId: "shared-b", operationId: expect.any(String) });
    expect(h.snapshot()).not.toBe(before);
  });

  it("advertises dry-run support on every response so a client can require it first", async () => {
    const h = harness();

    const read = await request(h.app).get("/platform-runtime-config").expect(200);
    const refused = await request(h.app).post("/gateways/nowhere/restart").expect(404);

    expect(read.headers["admin-api-capabilities"]).toBe("dry-run");
    expect(refused.headers["admin-api-capabilities"]).toBe("dry-run");
  });
});

describe("every changing route", () => {
  const routes: Record<string, ChangingRequest & { seed?: () => Seed }> = {
    "PATCH /platform-runtime-config": { method: "patch", path: "/platform-runtime-config", body: { disposableGatewayIdleMs: 60_000 } },
    "PATCH /placement/autoscaling": { method: "patch", path: "/placement/autoscaling", body: { enabled: true, usersPerGateway: 40 } },
    "POST /gateway-migrations/bulk": { method: "post", path: "/gateway-migrations/bulk", body: { userIds: ["uid-ada"], toGatewayId: "shared-b" } },
    "POST /rollouts": { method: "post", path: "/rollouts", body: { gatewayId: "shared-b", targetRelease: 2, imageTag: "abc1234" } },
    "POST /gateways": {
      method: "post",
      path: "/gateways",
      body: { gatewayId: "shared-c", imageRepository: PAYLOAD.imageRepository, imageTag: "abc1234", gatewayClass: "shared" },
    },
    "PATCH /gateways/:id": { method: "patch", path: "/gateways/shared-b", body: { desiredStatus: "paused" } },
    "DELETE /gateways/:id": { method: "delete", path: "/gateways/idle" },
    "POST /gateways/:id/restart": { method: "post", path: "/gateways/shared-b/restart" },
    "POST /gateways/:id/deploy": { method: "post", path: "/gateways/iso-ada/deploy", body: { sourceSha: SOURCE_SHA } },
    "POST /gateways/:id/releases/:n/rollback": { method: "post", path: "/gateways/iso-ada/releases/1/rollback", body: {} },
    "POST /gateways/:id/recover-source": {
      method: "post", path: "/gateways/shared-0/recover-source", body: { sourceSha: SOURCE_SHA }, seed: sourceRecoveryFleet,
    },
    "POST /gateways/:id/recover-restore": {
      method: "post",
      path: "/gateways/shared-0/recover-restore",
      body: { sourceSha: SOURCE_SHA, operationId: "return-1", reauthorizeAttemptId: "retained-1" },
      seed: restoreRecoveryFleet,
    },
    "POST /gateways/:id/vm/replace": { method: "post", path: "/gateways/iso-ada/vm/replace", body: {} },
    "POST /users": { method: "post", path: "/users", body: { name: "lin", email: "lin@example.com" } },
    "POST /users/:uid/one-time-passwords": { method: "post", path: "/users/uid-ada/one-time-passwords" },
    "POST /users/:uid/delete": { method: "post", path: "/users/uid-ada/delete", body: { eraseNow: false } },
    "POST /users/:uid/assign": { method: "post", path: "/users/uid-ada/assign", body: { gatewayId: "shared-b" } },
    "POST /users/:uid/migrate": { method: "post", path: "/users/uid-ada/migrate", body: { to: "shared-b" } },
    "POST /users/:uid/unassign": { method: "post", path: "/users/uid-ada/unassign" },
    "PATCH /users/:uid/placement": { method: "patch", path: "/users/uid-ada/placement", body: { managedBy: "operator", gatewayId: null } },
    "POST /users/:uid/vm/replace": { method: "post", path: "/users/uid-ada/vm/replace", body: {} },
    "POST /users/:uid/activation-lease": { method: "post", path: "/users/uid-ada/activation-lease" },
    "POST /users/:uid/activation-lease/cancel": {
      method: "post", path: "/users/uid-ada/activation-lease/cancel", body: { leaseId: "lease-1", generation: 1 },
    },
    "POST /users/:uid/activation-lease/terminate": {
      method: "post", path: "/users/uid-ada/activation-lease/terminate", body: { leaseId: "lease-1", generation: 1 },
    },
    "POST /users/:uid/activation-lease/return": {
      method: "post", path: "/users/uid-ada/activation-lease/return", body: { leaseId: "lease-1", generation: 1 },
    },
    "POST /users/:uid/activation-lease/return/retry": {
      method: "post", path: "/users/uid-ada/activation-lease/return/retry", body: { operationId: "return-1" },
    },
  };

  function changingRoutes(router: Router): string[] {
    return router.stack.flatMap((layer) => {
      const route = layer.route as { path: string; methods: Record<string, boolean> } | undefined;
      if (!route) return [];
      return Object.keys(route.methods)
        .filter((method) => method !== "get")
        .map((method) => `${method.toUpperCase()} ${route.path}`);
    });
  }

  it("is listed here, so a new changing route cannot skip the dry run", () => {
    expect(changingRoutes(harness().router).sort()).toEqual(Object.keys(routes).sort());
  });

  it.each(Object.entries(routes))("%s answers a dry run with a plan and writes nothing", async (_route, call) => {
    vi.stubEnv("GATEWAY_SERVICE_ACCOUNT", "gateway@example.iam.gserviceaccount.com");
    const h = harness(call.seed?.() ?? FLEET);
    const before = h.snapshot();

    const res = await send(h.app, call, true);

    expect(res.body).toMatchObject({ dryRun: true, plans: [{ what: expect.any(String), forced: false }] });
    expect(res.status).toBe(200);
    expect(h.snapshot()).toBe(before);
    for (const effect of Object.values(h.effects)) expect(effect).not.toHaveBeenCalled();
  });

  it("refuses a dry run of a changing route that does not plan, instead of letting it apply", async () => {
    const h = harness();
    const applied = vi.fn();
    h.router.post("/later-changing-route", (_req, res) => {
      applied();
      res.status(202).json({ applied: true });
    });

    const res = await request(h.app).post("/later-changing-route?dryRun=true").expect(400);

    expect(res.body.error).toBe("this route does not answer dry runs");
    expect(applied).not.toHaveBeenCalled();
    await request(h.app).post("/later-changing-route").expect(202);
  });
});
