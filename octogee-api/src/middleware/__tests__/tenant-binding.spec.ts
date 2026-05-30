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

function fakeDb(docs: Record<string, Record<string, unknown>>): Pick<Firestore, "collection"> {
  return {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: Object.prototype.hasOwnProperty.call(docs, id),
          data: () => docs[id],
        }),
      }),
    }),
  } as unknown as Pick<Firestore, "collection">;
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
          "gw-bender": {
            ownerUid: "uid-bender",
            instanceName: "bender",
          },
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
      }),
    });

    const res = await request(app)
      .post("/internal/probe")
      .set(K8S_SA_TOKEN_HEADER, "caller-jwt")
      .send({ gatewayId: "gw-bender" });

    expect(res.status).toBe(200);
    expect(res.body.boundTenant).toEqual({
      kind: "gateway",
      gatewayId: "gw-bender",
      ownerUid: "uid-bender",
      instanceName: "bender",
    });
    await expect(registry.metrics()).resolves.toContain('result="ok"');
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
      .send({ gatewayId: "gw-other" });

    expect(res.status).toBe(200);
    expect(res.body.requestedGatewayId).toBe("gw-other");
    expect(res.body.boundTenant.gatewayId).toBe("gw-bender");
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
