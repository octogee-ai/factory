import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetGatewayTokenCacheForTest,
  GatewayTokenError,
  fetchGatewayToken,
  invalidateGatewayToken,
} from "../openclaw/gateway-token.js";
import { GATEWAY_TOKEN_PLACEHOLDER } from "../openclaw/gateway-token-constants.js";

function makeClient(result: unknown, throws?: Error): any {
  const accessSecretVersion = vi.fn(async () => {
    if (throws) throw throws;
    return [result, undefined, undefined];
  });
  return { accessSecretVersion };
}

beforeEach(() => {
  __resetGatewayTokenCacheForTest();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.GCP_PROJECT_ID = "octogee-test";
});

afterEach(() => {
  __resetGatewayTokenCacheForTest();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.GCP_PROJECT_ID;
});

describe("fetchGatewayToken", () => {
  it("calls accessSecretVersion with the per-gatewayId secret name", async () => {
    const client = makeClient({
      payload: { data: Buffer.from("abc123", "utf8") },
    });
    const token = await fetchGatewayToken({
      gatewayId: "gw-test",
      client,
    });
    expect(token).toBe("abc123");
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/octogee-test/secrets/gateway-auth-token-gw-test/versions/latest",
    });
  });

  it("caches the token across calls within the TTL", async () => {
    const client = makeClient({
      payload: { data: Buffer.from("abc123", "utf8") },
    });
    const a = await fetchGatewayToken({ gatewayId: "gw-test", client });
    const b = await fetchGatewayToken({ gatewayId: "gw-test", client });
    expect(a).toBe(b);
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(1);
  });

  it("skipCache forces a fresh SM round-trip", async () => {
    const client = makeClient({
      payload: { data: Buffer.from("abc123", "utf8") },
    });
    await fetchGatewayToken({ gatewayId: "gw-test", client });
    await fetchGatewayToken({ gatewayId: "gw-test", client, skipCache: true });
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it("invalidateGatewayToken drops the cached entry", async () => {
    const client = makeClient({
      payload: { data: Buffer.from("abc123", "utf8") },
    });
    await fetchGatewayToken({ gatewayId: "gw-test", client });
    invalidateGatewayToken("gw-test");
    await fetchGatewayToken({ gatewayId: "gw-test", client });
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it("per-gateway cache does not cross-contaminate", async () => {
    const client = makeClient({
      payload: { data: Buffer.from("value", "utf8") },
    });
    await fetchGatewayToken({ gatewayId: "gw-a", client });
    await fetchGatewayToken({ gatewayId: "gw-b", client });
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it("throws `empty-token` when SM returns an empty payload", async () => {
    const client = makeClient({ payload: { data: Buffer.from("", "utf8") } });
    await expect(
      fetchGatewayToken({ gatewayId: "gw-test", client }),
    ).rejects.toBeInstanceOf(GatewayTokenError);
    await expect(
      fetchGatewayToken({ gatewayId: "gw-test", client }),
    ).rejects.toMatchObject({ code: "empty-token" });
  });

  it("throws `fetch-failed` on non-network SM errors (permission denied etc.)", async () => {
    const client = makeClient(undefined, new Error("PERMISSION_DENIED: caller does not have access"));
    await expect(
      fetchGatewayToken({ gatewayId: "gw-test", client }),
    ).rejects.toMatchObject({ code: "fetch-failed" });
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN env when SM is unreachable (code=14)", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "dev-token";
    const err = Object.assign(new Error("14 UNAVAILABLE"), { code: 14 });
    const client = makeClient(undefined, err);
    const token = await fetchGatewayToken({ gatewayId: "gw-test", client });
    expect(token).toBe("dev-token");
  });

  it("falls back on Node DNS/socket errors (ENOTFOUND, ECONNREFUSED)", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "dev-token";
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { errno: "ENOTFOUND" });
    const client = makeClient(undefined, err);
    const token = await fetchGatewayToken({ gatewayId: "gw-test", client });
    expect(token).toBe("dev-token");
  });

  it("does NOT use env fallback when SM returns a real error (permission, not-found)", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "dev-token";
    const err = Object.assign(new Error("NOT_FOUND: secret missing"), { code: 5 });
    const client = makeClient(undefined, err);
    await expect(
      fetchGatewayToken({ gatewayId: "gw-test", client }),
    ).rejects.toMatchObject({ code: "fetch-failed" });
  });

  it("does NOT fall back on a legit error whose message happens to contain UNAVAILABLE", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "dev-token";
    const err = Object.assign(new Error("secret is in state UNAVAILABLE"), { code: 7 });
    const client = makeClient(undefined, err);
    await expect(
      fetchGatewayToken({ gatewayId: "gw-test", client }),
    ).rejects.toMatchObject({ code: "fetch-failed" });
  });

  it("falls through to env fallback when GCP_PROJECT_ID is unset (local dev)", async () => {
    delete process.env.GCP_PROJECT_ID;
    process.env.OPENCLAW_GATEWAY_TOKEN = "dev-token";
    const client = makeClient({
      payload: { data: Buffer.from("sm-value", "utf8") },
    });
    const token = await fetchGatewayToken({ gatewayId: "gw-test", client });
    expect(token).toBe("dev-token");
    expect(client.accessSecretVersion).not.toHaveBeenCalled();
  });

  it("throws `not-configured` when neither SM nor env fallback is usable", async () => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    await expect(
      fetchGatewayToken({ gatewayId: "gw-test" }),
    ).rejects.toMatchObject({ code: "not-configured" });
  });

  it("rejects the bootstrap placeholder as `empty-token` (clean 503 during deploy window)", async () => {
    const client = makeClient({
      payload: { data: Buffer.from(GATEWAY_TOKEN_PLACEHOLDER, "utf8") },
    });
    await expect(
      fetchGatewayToken({ gatewayId: "gw-test", client }),
    ).rejects.toMatchObject({ code: "empty-token" });
  });

  it("validates gatewayId shape — rejects slashes, whitespace, newlines", async () => {
    const client = makeClient({
      payload: { data: Buffer.from("abc123", "utf8") },
    });
    for (const bad of ["../../other-secret", "gw-test\nfoo", "gw test", "GW-TEST", ""]) {
      await expect(
        fetchGatewayToken({ gatewayId: bad, client }),
      ).rejects.toMatchObject({ code: "invalid-gateway-id" });
    }
    expect(client.accessSecretVersion).not.toHaveBeenCalled();
  });
});
