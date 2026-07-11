import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import { Registry } from "prom-client";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  K8S_SA_TOKEN_HEADER,
  createTenantBindingMetrics,
  createTenantBindingMiddleware,
} from "../tenant-binding.js";
import type { Reviewer } from "../../lib/token-review.js";

function fakeDb(docs: Record<string, Record<string, unknown>>): Pick<Firestore, "collection" | "doc"> {
  return {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: Object.prototype.hasOwnProperty.call(docs, id),
          data: () => docs[id],
        }),
      }),
      where: (field: string, operator: string, value: unknown) => ({
        get: async () => ({
          docs: Object.entries(docs)
            .filter(([, data]) => operator === "==" && data[field] === value)
            .map(([id, data]) => ({ id, data: () => data })),
        }),
      }),
    }),
    doc: (path: string) => {
      const id = path.split("/").at(-1) ?? "";
      return {
        get: async () => ({
          exists: Object.prototype.hasOwnProperty.call(docs, id),
          data: () => docs[id],
        }),
      };
    },
  } as unknown as Pick<Firestore, "collection" | "doc">;
}

function gatewayRoot(serviceAccountName: string | null = null): Record<string, unknown> {
  return {
    gatewayId: "bender",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: "bender-r1",
    trafficRevisionId: "bender-r1",
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: "uid-bender",
    coOwnerUids: [],
    builderSlug: "bender",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  };
}

function buildApp(opts: {
  reviewer: Reviewer;
  docs?: Record<string, Record<string, unknown>>;
  registry?: Registry;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}) {
  const app = express();
  const registry = opts.registry ?? new Registry();
  app.use(express.json());
  app.use(
    "/internal",
    createTenantBindingMiddleware({
      reviewer: opts.reviewer,
      db: fakeDb(
        opts.docs ?? {
          bender: gatewayRoot(),
        },
      ),
      namespace: "octogee",
      metrics: createTenantBindingMetrics(registry),
      logger: { warn: opts.warn ?? (() => undefined) },
    }),
  );
  app.post("/internal/probe", (req, res) => {
    const body = req.body as { gatewayId?: unknown } | undefined;
    res.json({
      attempted: req.tenantBindingAttempted,
      requestedGatewayId: body?.gatewayId ?? null,
      boundTenant: req.boundTenant ?? null,
    });
  });
  return { app, registry };
}

describe("tenant binding middleware", () => {
  it("soft-fails missing tokens and still lets existing internal auth decide", async () => {
    const { app, registry } = buildApp({
      reviewer: async () => ({ authenticated: false }),
    });

    const res = await request(app).post("/internal/probe").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      attempted: true,
      requestedGatewayId: null,
      boundTenant: null,
    });
    await expect(registry.metrics()).resolves.toContain('result="missing"');
  });

  it("binds a valid gateway service-account token to the gateway owner", async () => {
    const { app, registry } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-bender",
        audiences: ["octogee-api"],
        podName: "octogee-gateway-bender-r7-5bc5949d46-p946t",
        podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({ gatewayId: "bender" });

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({
      kind: "gateway",
      gatewayId: "bender",
      ownerUid: "uid-bender",
      podName: "octogee-gateway-bender-r7-5bc5949d46-p946t",
      podUid: "b0de5f4c-2d38-4dc9-9bb7-3f20a0d7beef",
    });
    await expect(registry.metrics()).resolves.toContain('result="ok"');
  });

  it("does not fabricate pod identity when TokenReview did not verify both claims", async () => {
    const { app } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-bender",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({
      kind: "gateway",
      gatewayId: "bender",
      ownerUid: "uid-bender",
    });
  });

  it("binds the platform cron service-account token to a platform tenant", async () => {
    const { app, registry } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-cron",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({ kind: "platform", actor: "cron" });
    await expect(registry.metrics()).resolves.toContain('result="ok_platform"');
  });

  it("never yields a platform binding for a wrong-audience token (the kind=platform gate)", async () => {
    const warn = vi.fn();
    const { app, registry } = buildApp({
      warn,
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-cron",
        audiences: ["some-other-audience"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toBeNull();
    expect(warn).toHaveBeenCalled();
    await expect(registry.metrics()).resolves.toContain('result="audience_mismatch"');
  });

  it("binds a grandfathered operator gateway service-account token", async () => {
    const { app, registry } = buildApp({
      docs: { bender: gatewayRoot("octogee-gateway-bender") },
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gateway-bender",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({ gatewayId: "bender" });

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toMatchObject({
      kind: "gateway",
      gatewayId: "bender",
    });
    await expect(registry.metrics()).resolves.toContain('result="ok_legacy_operator"');
  });

  it("does not let a request body forge the caller gateway", async () => {
    const { app } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-bender",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({ gatewayId: "other" });

    expect(res.status).toBe(200);
    expect(res.body.requestedGatewayId).toBe("other");
    expect(res.body.boundTenant.gatewayId).toBe("bender");
  });

  it("binds known platform callers", async () => {
    const { app } = buildApp({
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-api",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({
      kind: "platform",
      actor: "octogee-api",
    });
  });

  it("records shared gateway callers without attaching a tenant", async () => {
    const warn = vi.fn();
    const { app, registry } = buildApp({
      warn,
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gateway",
        audiences: ["octogee-api"],
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toBeNull();
    await expect(registry.metrics()).resolves.toContain('result="shared_gateway"');
    expect(warn).not.toHaveBeenCalled();
  });

  it("soft-fails invalid tokens, reviewer errors, and unknown tenants", async () => {
    const warn = vi.fn();
    const invalid = buildApp({
      warn,
      reviewer: async () => ({ authenticated: false }),
    });
    const reviewerError = buildApp({
      warn,
      reviewer: async () => {
        throw new Error("api down");
      },
    });
    const unknownTenant = buildApp({
      warn,
      docs: {},
      reviewer: async () => ({
        authenticated: true,
        namespace: "octogee",
        saName: "octogee-gw-bender",
        audiences: ["octogee-api"],
      }),
    });

    await request(invalid.app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "bad")
      .expect(200);
    await request(reviewerError.app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "bad")
      .expect(200);
    const res = await request(unknownTenant.app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .expect(200);

    expect(res.body.boundTenant).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
