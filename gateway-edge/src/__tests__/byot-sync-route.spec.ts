import request from "supertest";
import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncModelCredentialsForCustomerSpy = vi.fn(async () => {});
const applyConfigPatchSpy = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
const releaseLeaseSpy = vi.fn(async () => {});
const acquireLeaseSpy = vi.fn(async () => ({
  ok: true as const,
  lease: { release: releaseLeaseSpy },
}));

vi.mock("@octogee/core/model-credential-sync-runtime", () => ({
  syncModelCredentialsForCustomer: (
    userData: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) => syncModelCredentialsForCustomerSpy(userData, deps),
}));
vi.mock("@octogee/core/apply-config-patch", () => ({
  applyConfigPatch: (...args: unknown[]) => applyConfigPatchSpy(...args),
}));
vi.mock("@octogee/core/system-config-mutation-lease", () => ({
  acquireSystemConfigMutationLease: (...args: unknown[]) => acquireLeaseSpy(...args),
}));

const { createApp } = await import("../index.js");
const { default: byotSyncRoutes } = await import("../routes/internal/byot-sync.js");

const userData = {
  byotActive: true,
  username: "smile-wring-011b",
  provisioning: { openclaw: { status: "complete" } },
  systemConfig: { byot: { provider: "openai" } },
};

const PRIMARY_SYNC_PATH = "/api/g/bender/internal/model-credential-sync";
const LEGACY_SYNC_PATH = "/api/g/bender/internal/byot-sync";

type RouteLayer = {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
};

function routeSignatures(router: unknown): string[] {
  const stack = (router as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route;
      if (!route) throw new Error("expected route layer");
      const methods = Object.entries(route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase())
        .sort()
        .join(",");
      return `${methods} ${JSON.stringify(route.path)}`;
    });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function byotSyncHeaders(body: unknown, secret = "byot-sync-secret", timestamp = `${Date.now()}`): Record<string, string> {
  return {
    "X-Byot-Sync-Timestamp": timestamp,
    "X-Byot-Sync-Signature": crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${canonicalJson(body)}`)
      .digest("hex"),
  };
}

describe("POST /api/g/:gatewayId/internal/byot-sync", () => {
  beforeEach(() => {
    syncModelCredentialsForCustomerSpy.mockClear();
    applyConfigPatchSpy.mockClear();
    releaseLeaseSpy.mockClear();
    acquireLeaseSpy.mockClear();
    delete process.env.INTERNAL_SERVICE_KEY;
    process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET = "byot-sync-secret";
    delete process.env.GATEWAY_PROFILE;
    process.env.K8S_NAMESPACE = "octogee-test";
    process.env.OPENCLAW_DIR = "/home/node/.openclaw";
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET;
    delete process.env.K8S_NAMESPACE;
    delete process.env.GATEWAY_PROFILE;
    delete process.env.OPENCLAW_DIR;
  });

  it("rejects unauthenticated calls before sync", async () => {
    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .send(userData);
    expect(res.status).toBe(401);
    expect(syncModelCredentialsForCustomerSpy).not.toHaveBeenCalled();
  });

  it("mounts both canonical and legacy sync route aliases", () => {
    expect(routeSignatures(byotSyncRoutes)).toEqual([
      'POST ["/model-credential-sync","/byot-sync"]',
    ]);
  });

  it("validates the sync payload", async () => {
    const body = { byotActive: true };
    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(body))
      .send(body);
    expect(res.status).toBe(400);
    expect(syncModelCredentialsForCustomerSpy).not.toHaveBeenCalled();
  });

  it("runs model config writes under the shared system-config lease", async () => {
    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(syncModelCredentialsForCustomerSpy).toHaveBeenCalledWith(
      userData,
      expect.objectContaining({ applyConfigPatch: expect.any(Function) }),
    );

    const deps = syncModelCredentialsForCustomerSpy.mock.calls[0]?.[1];
    await deps.applyConfigPatch({ buildPatch: () => ({}) }, { maxRetries: 2 });

    expect(acquireLeaseSpy).toHaveBeenCalledWith({ openclawDir: "/home/node/.openclaw" });
    expect(applyConfigPatchSpy).toHaveBeenCalledWith(
      { buildPatch: expect.any(Function) },
      { maxRetries: 2 },
    );
    expect(releaseLeaseSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy BYOT sync route as an authenticated alias", async () => {
    const res = await request(createApp({ surface: "sidecar" }))
      .post(LEGACY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);

    expect(res.status).toBe(200);
    expect(syncModelCredentialsForCustomerSpy).toHaveBeenCalledWith(
      userData,
      expect.objectContaining({ applyConfigPatch: expect.any(Function) }),
    );
  });

  it("accepts canonical model credential sync payloads", async () => {
    const body = {
      username: userData.username,
      provisioning: userData.provisioning,
      systemConfig: {
        modelCredential: {
          active: true,
          provider: "claude-cli",
          mode: "oauth",
        },
      },
    };

    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(syncModelCredentialsForCustomerSpy).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ applyConfigPatch: expect.any(Function) }),
    );
  });

  it("rejects projected service-account tokens without the BYOT sync signature", async () => {
    process.env.GATEWAY_PROFILE = "standard";

    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .set("X-K8s-SA-Token", "octogee-api-jwt")
      .send(userData);

    expect(res.status).toBe(401);
    expect(syncModelCredentialsForCustomerSpy).not.toHaveBeenCalled();
  });

  it("rejects stale BYOT sync signatures", async () => {
    const staleTimestamp = `${Date.now() - 10 * 60 * 1000}`;
    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(userData, "byot-sync-secret", staleTimestamp))
      .send(userData);

    expect(res.status).toBe(401);
    expect(syncModelCredentialsForCustomerSpy).not.toHaveBeenCalled();
  });

  it("surfaces sync failures to the internal caller", async () => {
    syncModelCredentialsForCustomerSpy.mockRejectedValueOnce(new Error("config.patch failed"));
    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).toContain("config.patch failed");
  });
});
