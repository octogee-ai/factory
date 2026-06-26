import request from "supertest";
import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncModelCredentialsForCustomerSpy = vi.fn(async () => {});

vi.mock("@octogee/core/model-credential-sync-runtime", () => ({
  syncModelCredentialsForCustomer: (userData: Record<string, unknown>) =>
    syncModelCredentialsForCustomerSpy(userData),
}));

const { createApp } = await import("../index.js");

const userData = {
  byotActive: true,
  username: "smile-wring-011b",
  provisioning: { openclaw: { status: "complete" } },
  systemConfig: { byot: { provider: "openai" } },
};

const PRIMARY_SYNC_PATH = "/api/g/bender/internal/model-credential-sync";
const LEGACY_SYNC_PATH = "/api/g/bender/internal/byot-sync";

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
    delete process.env.INTERNAL_SERVICE_KEY;
    process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET = "byot-sync-secret";
    delete process.env.GATEWAY_PROFILE;
    process.env.K8S_NAMESPACE = "octogee-test";
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET;
    delete process.env.K8S_NAMESPACE;
    delete process.env.GATEWAY_PROFILE;
  });

  it("rejects unauthenticated calls before sync", async () => {
    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .send(userData);
    expect(res.status).toBe(401);
    expect(syncModelCredentialsForCustomerSpy).not.toHaveBeenCalled();
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

  it("runs pod-local sync with a valid BYOT sync signature", async () => {
    const res = await request(createApp({ surface: "sidecar" }))
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(syncModelCredentialsForCustomerSpy).toHaveBeenCalledWith(userData);
  });

  it("keeps the legacy BYOT sync route as an authenticated alias", async () => {
    const res = await request(createApp({ surface: "sidecar" }))
      .post(LEGACY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);

    expect(res.status).toBe(200);
    expect(syncModelCredentialsForCustomerSpy).toHaveBeenCalledWith(userData);
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
    expect(syncModelCredentialsForCustomerSpy).toHaveBeenCalledWith(body);
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
