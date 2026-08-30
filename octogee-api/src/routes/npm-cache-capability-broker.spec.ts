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
