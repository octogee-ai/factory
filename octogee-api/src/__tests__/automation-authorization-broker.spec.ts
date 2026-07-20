import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { Registry } from "prom-client";

import { createAutomationAuthorizationBrokerRoutes } from "../routes/automation-authorization-broker.js";
import {
  K8S_SA_TOKEN_HEADER,
  createTenantBindingMetrics,
  createTenantBindingMiddleware,
} from "../middleware/tenant-binding.js";
import { createTenantEnforcementMiddleware } from "../middleware/tenant-enforcement.js";
import type { Reviewer } from "../lib/token-review.js";
import { requireAuthenticatedUid } from "../../../gateway-edge/src/middleware/auth.js";

vi.mock("../../../gateway-edge/src/middleware/auth.js", () => ({
  requireAuthenticatedUid: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    req.uid = "hermetic-uid";
    next();
  },
}));

const WELL_FORMED_SA_TOKEN = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LWlkIn0",
  "eyJhdWQiOlsib2N0b2dlZS1hcGkiXSwiZXhwIjoxNzUyODAwMDAwLCJpc3MiOiJrOHMifQ",
  "c2lnbmF0dXJlLXNlZ21lbnQtZm9yLXRlc3RpbmctcHVycG9zZXMtb25seQ",
].join(".");

interface FakeDoc {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

function fakeDb(docs: Record<string, Record<string, unknown>>): Firestore {
  const snapshot = (docPath: string): FakeDoc => ({
    exists: Object.hasOwn(docs, docPath),
    data: () => docs[docPath],
  });
  return {
    doc: vi.fn((docPath: string) => ({
      get: vi.fn(async (): Promise<FakeDoc> => snapshot(docPath)),
    })),
    collection: vi.fn((collectionPath: string) => ({
      doc: (id: string) => ({ get: async () => snapshot(`${collectionPath}/${id}`) }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    })),
  } as unknown as Firestore;
}

function sharedGatewayRoot(): Record<string, unknown> {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: "default-r1",
    trafficRevisionId: "default-r1",
    desiredStatus: "running",
    roll: null,
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
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  };
}

function middlewareStackApp(saName: string) {
  const db = fakeDb({
    "gateways/default": sharedGatewayRoot(),
    "users/hermetic-uid": {
      username: "eggman",
      provisioning: { openclaw: { slug: "eggman", gatewayId: "default" } },
    },
    "workspaces/eggman": { ownerUid: "hermetic-uid" },
  });
  const reviewer: Reviewer = async () => ({
    authenticated: true,
    namespace: "octogee-test",
    saName,
    audiences: ["octogee-api"],
    podName: "octogee-gateway-default-abc123-def45",
    podUid: "pod-uid",
  });
  const app = express();
  app.use(express.json());
  app.use("/internal", createTenantBindingMiddleware({
    reviewer,
    db,
    namespace: "octogee-test",
    metrics: createTenantBindingMetrics(new Registry()),
    logger: { warn: () => undefined },
  }));
  app.use("/internal", createTenantEnforcementMiddleware({ db }));
  app.use(
    "/internal/automations",
    requireAuthenticatedUid,
    createAutomationAuthorizationBrokerRoutes({ db }),
  );
  return app;
}

function appForTest(input: {
  uid?: string;
  boundGatewayId?: string;
  docs?: Record<string, Record<string, unknown>>;
}) {
  const db = fakeDb(input.docs ?? {});
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = input.uid;
    req.boundTenant = input.boundGatewayId
      ? { kind: "gateway", gatewayId: input.boundGatewayId }
      : undefined;
    next();
  });
  app.use("/internal/automations", createAutomationAuthorizationBrokerRoutes({ db }));
  return { app, db };
}

describe("POST /internal/automations/authorize", () => {
  it("authorizes current shared/default KSA through the tenant-bound middleware stack", async () => {
    const response = await request(middlewareStackApp("octogee-gw-default"))
      .post("/internal/automations/authorize")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .set("Authorization", "Bearer fixture-firebase-token")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ slug: "eggman", gatewayId: "default" });
  });

  it("requires Firebase identity after a valid gateway KSA is tenant-bound", async () => {
    const response = await request(middlewareStackApp("octogee-gw-default"))
      .post("/internal/automations/authorize")
      .set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN)
      .send({ gatewayId: "default" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthenticated" });
  });

  it.each([
    ["no gateway KSA", null],
    ["retired legacy shared KSA", "octogee-gateway"],
  ])("rejects Firebase identity with %s", async (_label, saName) => {
    const target = middlewareStackApp(saName ?? "octogee-gateway");
    const pending = request(target)
      .post("/internal/automations/authorize")
      .set("Authorization", "Bearer fixture-firebase-token")
      .send({ gatewayId: "default" });
    if (saName) pending.set(K8S_SA_TOKEN_HEADER, WELL_FORMED_SA_TOKEN);
    const response = await pending;

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
  });

  it("returns the owner slug only when the authenticated user assignment and workspace ownership match the bound gateway", async () => {
    const { app } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
      docs: {
        "users/eggman-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "eggman-devdays" } },
        },
        "workspaces/eggman": { ownerUid: "eggman-uid" },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ slug: "eggman", gatewayId: "eggman-devdays" });
  });

  it.each(["suspended", "deletion_scheduled", "erasing"])(
    "rejects an assigned owner whose lifecycle is %s",
    async (status) => {
      const { app } = appForTest({
        uid: "eggman-uid",
        boundGatewayId: "eggman-devdays",
        docs: {
          "users/eggman-uid": {
            username: "eggman",
            accountLifecycle: { status },
            provisioning: { openclaw: { slug: "eggman", gatewayId: "eggman-devdays" } },
          },
          "workspaces/eggman": { ownerUid: "eggman-uid" },
        },
      });

      const response = await request(app)
        .post("/internal/automations/authorize")
        .send({ gatewayId: "eggman-devdays" });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "forbidden" });
    },
  );

  it("404s when the authenticated user's assignment does not match the bound gateway", async () => {
    const { app } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
      docs: {
        "users/eggman-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "default" } },
        },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
  });

  it("403s when the assigned user is not the workspace owner", async () => {
    const { app } = appForTest({
      uid: "member-uid",
      boundGatewayId: "default",
      docs: {
        "users/member-uid": {
          username: "eggman",
          provisioning: { openclaw: { slug: "eggman", gatewayId: "default" } },
        },
        "workspaces/eggman": { ownerUid: "owner-uid" },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
  });

  it("rejects a malformed broker-derived slug before constructing a workspace Firestore path", async () => {
    const { app, db } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "default",
      docs: {
        "users/eggman-uid": {
          provisioning: { openclaw: { slug: "../../secrets", gatewayId: "default" } },
        },
      },
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
    expect(db.doc).toHaveBeenCalledTimes(1);
    expect(db.doc).toHaveBeenCalledWith("users/eggman-uid");
  });

  it("requires a dedicated gateway's bound owner to match the Firebase caller before reads", async () => {
    const { db } = appForTest({
      uid: "other-uid",
      boundGatewayId: "eggman-devdays",
    });
    const boundOwnerApp = express();
    boundOwnerApp.use(express.json());
    boundOwnerApp.use((req, _res, next) => {
      req.uid = "other-uid";
      req.boundTenant = {
        kind: "gateway",
        gatewayId: "eggman-devdays",
        ownerUid: "eggman-uid",
      };
      next();
    });
    boundOwnerApp.use("/internal/automations", createAutomationAuthorizationBrokerRoutes({ db }));

    const response = await request(boundOwnerApp)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "eggman-devdays" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
    expect(db.doc).not.toHaveBeenCalled();
  });

  it("rejects a claimed gateway different from the projected service-account binding before Firestore reads", async () => {
    const { app, db } = appForTest({
      uid: "eggman-uid",
      boundGatewayId: "eggman-devdays",
    });

    const response = await request(app)
      .post("/internal/automations/authorize")
      .send({ gatewayId: "default" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "forbidden" });
    expect(db.doc).not.toHaveBeenCalled();
  });
});
