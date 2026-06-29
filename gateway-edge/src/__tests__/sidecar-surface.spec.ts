import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { _setBuilderShellTokenReviewerForTests } from "../middleware/builder-shell-auth.js";

let projectedTokenDir: string | null = null;

function configureOperatorServiceAccountAuth() {
  projectedTokenDir = mkdtempSync(join(tmpdir(), "octogee-sidecar-auth-"));
  const tokenPath = join(projectedTokenDir, "token");
  writeFileSync(tokenPath, "projected-reviewer-token\n");

  delete process.env.INTERNAL_SERVICE_KEY;
  process.env.GATEWAY_PROFILE = "operator";
  process.env.GATEWAY_ID = "bender";
  process.env.K8S_NAMESPACE = "octogee-test";
  process.env.K8S_SERVICE_ACCOUNT_NAME = "octogee-gw-bender";
  process.env.OCTOGEE_API_SA_TOKEN_PATH = tokenPath;

  const reviewer = vi.fn(async (jwt: string) =>
    jwt === "valid-ksa-token"
      ? {
          authenticated: true as const,
          namespace: "octogee-test",
          saName: "octogee-gw-bender",
          audiences: ["octogee-api"],
        }
      : { authenticated: false as const },
  );
  _setBuilderShellTokenReviewerForTests(reviewer);
  return reviewer;
}

describe("gateway-edge sidecar surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    _setBuilderShellTokenReviewerForTests(null);
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.GATEWAY_PROFILE;
    delete process.env.GATEWAY_ID;
    delete process.env.K8S_NAMESPACE;
    delete process.env.K8S_SERVICE_ACCOUNT_NAME;
    delete process.env.OCTOGEE_API_SA_TOKEN_PATH;
    if (projectedTokenDir) rmSync(projectedTokenDir, { recursive: true, force: true });
    projectedTokenDir = null;
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
      (await request(app).post("/api/g/gw-bender/projects/acme/widget/publish").send({}))
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

  it("keeps agent-owned internal workspace and project actions mounted on the sidecar", async () => {
    const app = createApp({ surface: "sidecar" });

    const commit = await request(app)
      .post("/internal/workspace/commit")
      .send({ slug: "../alice" });
    expect(commit.status).toBe(400);
    expect(commit.body).toEqual({ error: "Invalid slug", code: "BAD_SLUG" });

    const publish = await request(app)
      .post("/internal/project/publish")
      .send({ slug: "../alice", projectSlug: "demo" });
    expect(publish.status).toBe(400);
    expect(publish.body).toEqual({
      error: "Invalid slug or projectSlug",
      code: "BAD_INPUT",
    });
  });

  it("requires valid operator KSA auth on sidecar connector materialization", async () => {
    const reviewer = configureOperatorServiceAccountAuth();
    const app = createApp({ surface: "sidecar" });

    const missing = await request(app).get("/internal/connectors/cloudflare/materialize");
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: "x-k8s-sa-token header required" });
    expect(reviewer).not.toHaveBeenCalled();

    const invalid = await request(app)
      .get("/internal/connectors/cloudflare/materialize")
      .set("x-k8s-sa-token", "invalid-ksa-token");
    expect(invalid.status).toBe(401);
    expect(invalid.body).toEqual({ error: "Invalid internal service key" });
    expect(reviewer).toHaveBeenCalledWith("invalid-ksa-token");
  });

  it("does not mount connector materialization on the cluster surface", async () => {
    const reviewer = configureOperatorServiceAccountAuth();
    const app = createApp({ surface: "cluster" });

    const res = await request(app)
      .get("/internal/connectors/cloudflare/materialize")
      .set("x-k8s-sa-token", "valid-ksa-token");

    expect(res.status).toBe(404);
    expect(reviewer).not.toHaveBeenCalled();
  });
});
