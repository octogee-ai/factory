import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  GATEWAY_CREDENTIAL_TOKEN_HEADER,
} from "@octogee/core/internal-fetch";
import { createGatewayCredentialAuth } from "../middleware/gateway-credential-auth.js";
import { GATEWAY_CREDENTIAL_ROUTES } from "../index.js";
import { InMemoryNpmCacheCapabilityStore } from "../lib/npm-cache-capabilities.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "builder-alice";
const POD_NAME = "octogee-gateway-builder-alice-abc123";
const POD_UID = "pod-uid-alice";
const SA_NAME = "octogee-gw-builder-alice";
const JWT = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
const TOKEN = "n".repeat(43);
const SOURCE_GATEWAY_ID = "shared-a";
const LEASE_ID = "lease-alice";
const LEASE_GENERATION = 2;
const SOURCE_ASSIGNMENT_EPOCH = 7;

function gatewayDoc() {
  return {
    gatewayId: GATEWAY_ID,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "builder",
    gatewayClass: "builder",
    imageProfile: "builder",
    sizingTier: null,
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

function database(assignedSlug = "alice") {
  const assignments = [{
    id: "uid-alice",
    data: () => ({
      slug: assignedSlug,
      gatewayId: GATEWAY_ID,
      source: "onboarding",
      state: "serving",
      epoch: 1,
      updatedAt: 1,
      updatedByOperationId: null,
    }),
  }];
  return {
    collection: vi.fn((name: string) => {
      if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
      return {
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({ exists: true, data: gatewayDoc })),
          collection: vi.fn(() => ({ get: vi.fn(async () => ({ docs: assignments })) })),
        })),
      };
    }),
  };
}

function preCutoverGatewayDoc(overrides: Record<string, unknown> = {}) {
  return {
    ...gatewayDoc(),
    allocation: {
      kind: "disposable-builder",
      schemaVersion: 1,
      leaseId: LEASE_ID,
      generation: LEASE_GENERATION,
      claimedByUid: "uid-alice",
    },
    ...overrides,
  };
}

function preCutoverUserDoc(input: {
  lease?: Record<string, unknown>;
  openclaw?: Record<string, unknown>;
  user?: Record<string, unknown>;
} = {}) {
  return {
    username: "alice",
    builderSubscription: { tier: "hobby", status: "active" },
    provisioning: {
      openclaw: {
        gatewayId: SOURCE_GATEWAY_ID,
        slug: "alice",
        activationLease: {
          leaseId: LEASE_ID,
          generation: LEASE_GENERATION,
          status: "provisioning",
          targetGatewayId: GATEWAY_ID,
          builderSlug: "alice",
          sourceGatewayId: SOURCE_GATEWAY_ID,
          sourceAssignmentEpoch: SOURCE_ASSIGNMENT_EPOCH,
          provisionedAt: Date.parse("2026-08-30T11:55:00.000Z"),
          ...input.lease,
        },
        ...input.openclaw,
      },
    },
    ...input.user,
  };
}

function sourceAssignmentDoc(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-alice",
    slug: "alice",
    gatewayId: SOURCE_GATEWAY_ID,
    source: "onboarding",
    state: "serving",
    epoch: SOURCE_ASSIGNMENT_EPOCH,
    updatedAt: 1,
    updatedByOperationId: null,
    ...overrides,
  };
}

function activationOperation(
  status: string = "running",
  inputOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: "migrate-customer",
    status,
    origin: "automatic",
    createdBy: "glm-controller-placement-policy",
    gatewayId: GATEWAY_ID,
    inputUid: "uid-alice",
    input: {
      uid: "uid-alice",
      builderSlug: "alice",
      fromGatewayId: SOURCE_GATEWAY_ID,
      toGatewayId: GATEWAY_ID,
      source: "builder-activation-lease",
      ...inputOverrides,
    },
    ...overrides,
  };
}

function preCutoverDatabase(input: {
  gateway?: Record<string, unknown>;
  user?: Record<string, unknown>;
  sourceAssignment?: Record<string, unknown> | null;
  operation?: Record<string, unknown> | null;
} = {}) {
  const targetGateway = input.gateway ?? preCutoverGatewayDoc();
  const user = input.user ?? preCutoverUserDoc();
  const sourceAssignment = input.sourceAssignment === undefined
    ? sourceAssignmentDoc()
    : input.sourceAssignment;
  const operation = input.operation === undefined ? null : input.operation;
  const snapshot = (data: Record<string, unknown> | null | undefined) => ({
    exists: data != null,
    data: () => data ?? undefined,
  });
  return {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id: string) => {
        if (name === "users") {
          return { get: vi.fn(async () => snapshot(id === "uid-alice" ? user : null)) };
        }
        if (name === "glmOperations") {
          return { get: vi.fn(async () => snapshot(operation)) };
        }
        if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
        return {
          get: vi.fn(async () => snapshot(id === GATEWAY_ID ? targetGateway : null)),
          collection: vi.fn((subcollection: string) => {
            if (subcollection !== "assignments") {
              throw new Error(`unexpected subcollection ${subcollection}`);
            }
            return {
              get: vi.fn(async () => ({ docs: [] })),
              doc: vi.fn((uid: string) => ({
                get: vi.fn(async () => snapshot(
                  id === SOURCE_GATEWAY_ID && uid === "uid-alice" ? sourceAssignment : null,
                )),
              })),
            };
          }),
        };
      }),
    })),
  };
}

function brokerOptions(
  store = new InMemoryNpmCacheCapabilityStore(() => TOKEN),
  extra: Record<string, unknown> = {},
) {
  return {
    db: database() as never,
    npmCacheCapabilities: store,
    npmCacheRegistryUrl: "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/",
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    ...extra,
  };
}

function builderApp(options = brokerOptions()) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = {
      kind: "gateway",
      gatewayId: GATEWAY_ID,
      ownerUid: "uid-alice",
      saName: SA_NAME,
      podName: POD_NAME,
      podUid: POD_UID,
    };
    next();
  }) as RequestHandler);
  app.use(createGatewayCredentialAuth({
    reviewer: vi.fn(async () => ({
      authenticated: true as const,
      saName: SA_NAME,
      namespace: "octogee-test",
      audiences: [GATEWAY_CREDENTIAL_TOKEN_AUDIENCE],
      podName: POD_NAME,
      podUid: POD_UID,
    })),
    namespace: "octogee-test",
    mapIdentity: async () => ({ kind: "gateway", gatewayId: GATEWAY_ID }),
    logger: { warn: vi.fn() },
  }));
  app.use("/internal/fleet", createFleetBrokerRoutes(options as never));
  return app;
}

function proxyApp(options: ReturnType<typeof brokerOptions>) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "platform", actor: "npm-cache-proxy" };
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes(options as never));
  return app;
}

async function requestBuilderCapability(db: ReturnType<typeof preCutoverDatabase>) {
  const options = brokerOptions();
  options.db = db as never;
  return request(builderApp(options))
    .post("/internal/fleet/npm-registry-credentials")
    .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
    .send({ gatewayId: GATEWAY_ID, slug: "alice" });
}

describe("npm cache capability broker", () => {
  it("requires the second purpose-audience KSA credential", async () => {
    expect(GATEWAY_CREDENTIAL_ROUTES.has("/internal/fleet/npm-registry-credentials"))
      .toBe(true);
    const response = await request(builderApp())
      .post("/internal/fleet/npm-registry-credentials")
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(403);
  });

  it("issues only to the exact assigned Builder pod and marks the response no-store", async () => {
    const response = await request(builderApp())
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      registryUrl: "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/",
      token: TOKEN,
      expiresAt: "2026-08-30T12:10:00.000Z",
    });
  });

  it("issues to the exact disposable Builder during its fenced pre-cutover activation", async () => {
    const response = await requestBuilderCapability(preCutoverDatabase());

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      registryUrl: "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/",
      token: TOKEN,
      expiresAt: "2026-08-30T12:10:00.000Z",
    });
  });

  it("continues issuance while the exact activation migration is live", async () => {
    const response = await requestBuilderCapability(preCutoverDatabase({
      user: preCutoverUserDoc({
        lease: {
          status: "activating",
          activationOperationId: `builder-activate-${GATEWAY_ID}`,
        },
      }),
      sourceAssignment: sourceAssignmentDoc({ state: "quiescing" }),
      operation: activationOperation(),
    }));

    expect(response.status).toBe(200);
  });

  it.each([
    {
      name: "stale source assignment epoch",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ lease: { sourceAssignmentEpoch: 6 } }),
      }),
    },
    {
      name: "failed activation lease",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ lease: { status: "failed" } }),
      }),
    },
    {
      name: "wrong Builder slug",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ openclaw: { slug: "mallory" } }),
      }),
    },
    {
      name: "wrong target gateway",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ lease: { targetGatewayId: "builder-mallory" } }),
      }),
    },
    {
      name: "wrong allocation generation",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ lease: { generation: LEASE_GENERATION + 1 } }),
      }),
    },
    {
      name: "wrong allocation lease",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ lease: { leaseId: "stale-lease" } }),
      }),
    },
    {
      name: "wrong source mirror",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ openclaw: { gatewayId: "shared-b" } }),
      }),
    },
    {
      name: "invalid source gateway identity",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({
          lease: { sourceGatewayId: "shared/a" },
          openclaw: { gatewayId: "shared/a" },
        }),
      }),
    },
    {
      name: "wrong source assignment owner",
      db: () => preCutoverDatabase({
        sourceAssignment: sourceAssignmentDoc({ uid: "uid-mallory" }),
      }),
    },
    {
      name: "non-serving source before migration",
      db: () => preCutoverDatabase({
        sourceAssignment: sourceAssignmentDoc({ state: "quiescing" }),
      }),
    },
    {
      name: "suspended Builder",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ user: { accountLifecycle: { status: "suspended" } } }),
      }),
    },
    {
      name: "Builder entitlement ended",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({ user: { builderSubscription: null } }),
      }),
    },
    {
      name: "wrong configured owner",
      db: () => preCutoverDatabase({
        gateway: preCutoverGatewayDoc({
          ownerUid: "uid-mallory",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: LEASE_ID,
            generation: LEASE_GENERATION,
            claimedByUid: "uid-mallory",
          },
        }),
      }),
    },
    {
      name: "retired target",
      db: () => preCutoverDatabase({
        gateway: preCutoverGatewayDoc({ desiredStatus: "retired" }),
      }),
    },
    {
      name: "activating lease without its operation",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({
          lease: {
            status: "activating",
            activationOperationId: `builder-activate-${GATEWAY_ID}`,
          },
        }),
      }),
    },
    {
      name: "failed activation operation",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({
          lease: {
            status: "activating",
            activationOperationId: `builder-activate-${GATEWAY_ID}`,
          },
        }),
        operation: activationOperation("failed"),
      }),
    },
    {
      name: "succeeded activation operation before canonical cutover",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({
          lease: {
            status: "activating",
            activationOperationId: `builder-activate-${GATEWAY_ID}`,
          },
        }),
        operation: activationOperation("succeeded"),
      }),
    },
    {
      name: "activation operation for another source",
      db: () => preCutoverDatabase({
        user: preCutoverUserDoc({
          lease: {
            status: "activating",
            activationOperationId: `builder-activate-${GATEWAY_ID}`,
          },
        }),
        operation: activationOperation("running", { fromGatewayId: "shared-b" }),
      }),
    },
  ])("rejects a pre-cutover capability for $name", async ({ db }) => {
    const response = await requestBuilderCapability(db());
    expect(response.status).toBe(403);
  });

  it("rejects a slug that is not the gateway assignment", async () => {
    const options = brokerOptions();
    options.db = database("mallory") as never;
    const response = await request(builderApp(options))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(403);
  });

  it("lets only the npm proxy actor authorize the opaque capability", async () => {
    const store = new InMemoryNpmCacheCapabilityStore(() => TOKEN);
    const options = brokerOptions(store);
    await request(builderApp(options))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" })
      .expect(200);

    const authorized = await request(proxyApp(options))
      .post("/internal/fleet/npm-cache-authorize")
      .send({ token: TOKEN });
    expect(authorized.status).toBe(200);
    expect(authorized.headers["cache-control"]).toBe("no-store");
    expect(authorized.body.authorization).toMatchObject({
      gatewayId: GATEWAY_ID,
      uid: "uid-alice",
      slug: "alice",
      podUid: POD_UID,
      audience: "octogee-npm-cache-proxy",
    });
  });

  it("redacts an issuance failure from both the response and report", async () => {
    const report = vi.fn();
    const store = {
      issue: () => { throw new Error("upstream secret capability-token-value"); },
      authorize: () => null,
    };
    const response = await request(builderApp(brokerOptions(store as never, {
      reportNpmCacheCapabilityFailure: report,
    })))
      .post("/internal/fleet/npm-registry-credentials")
      .set(GATEWAY_CREDENTIAL_TOKEN_HEADER, JWT)
      .send({ gatewayId: GATEWAY_ID, slug: "alice" });

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("capability-token-value");
    expect(report).toHaveBeenCalledWith({ gatewayId: GATEWAY_ID, reason: "unexpected-error" });
    expect(JSON.stringify(report.mock.calls)).not.toContain("capability-token-value");
  });
});
