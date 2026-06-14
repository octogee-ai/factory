import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db", () => ({
  auth: { verifyIdToken: vi.fn() },
  db: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => undefined }),
        update: async () => undefined,
        collection: () => ({
          doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
        }),
      }),
      where: () => ({ where: () => ({ get: async () => ({ size: 0, docs: [] }) }) }),
    }),
    doc: () => ({
      get: async () => ({ exists: false, data: () => undefined }),
    }),
  },
  FieldValue: {
    delete: () => ({ __op: "delete" }),
    increment: (n: number) => ({ __op: "increment", operand: n }),
    serverTimestamp: () => ({ __op: "serverTimestamp" }),
  },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

vi.mock("../lib/stripe", () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: vi.fn((_body: unknown, _sig: string, _secret: string) => ({
        type: "noop",
        data: { object: {} },
      })),
    },
  }),
  getWebhookSecret: () => "whsec_test",
}));

import { createApp } from "../index.js";

describe("gateway-edge sidecar surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
  });

  it("does not expose legacy platform internal brokers on the sidecar app", async () => {
    process.env.INTERNAL_SERVICE_KEY = "surface-test-key";
    const app = createApp({ surface: "sidecar" });

    expect(
      (
        await request(app)
          .post("/internal/gitea/ensure-user")
          .set("X-Internal-Service-Key", "surface-test-key")
          .send({ slug: "alice", pubKey: "ssh-ed25519 AAA" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/internal/billing/check-trial-expiry")
          .set("X-Internal-Service-Key", "surface-test-key")
          .send({})
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/internal/site/hosting-deploy")
          .set("X-Internal-Service-Key", "surface-test-key")
          .send({})
      ).status,
    ).toBe(404);
  });

  it("does not let locality auth middleware mask removed cluster APIs", async () => {
    const app = createApp({ surface: "sidecar" });

    expect((await request(app).get("/api/workspace/files")).status).toBe(404);
    expect((await request(app).post("/api/byosub/capture").send({})).status).toBe(404);
    expect((await request(app).get("/api/connect/state")).status).toBe(404);
    expect((await request(app).post("/api/projects").send({})).status).toBe(404);
  });

  it("keeps intended sidecar locality leaves mounted at the auth boundary", async () => {
    const app = createApp({ surface: "sidecar" });

    expect((await request(app).get("/api/g/gw-bender/workspace/git/status")).status).toBe(401);
    expect((await request(app).get("/api/g/gw-bender/byosub/health")).status).toBe(401);
    expect(
      (await request(app).post("/api/g/gw-bender/projects/acme/widget/deploy-preview").send({}))
        .status,
    ).toBe(401);
  });

  it("keeps builder-shell locality mounted on the sidecar", async () => {
    process.env.INTERNAL_SERVICE_KEY = "redeem-mount-test-key";
    const app = createApp({ surface: "sidecar" });

    const res = await request(app)
      .post("/internal/builder-shell/redeem")
      .set("X-Internal-Service-Key", "redeem-mount-test-key")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing ticket" });
  });
});
