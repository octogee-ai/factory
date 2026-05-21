import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  byosubSecretName,
  validateCodexCredential,
  gatewayDeviceAuthClient,
  byosubConnectionView,
  isSafeGatewayId,
} from "../lib/byosub";

describe("byosubSecretName", () => {
  it("is owner-scoped and matches Chunk A secretNameFor", () => {
    expect(byosubSecretName("uid-1", "openai")).toBe("byosub-uid-1-openai");
  });
});

describe("validateCodexCredential — privileged write surface", () => {
  const good = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "a", refresh_token: "r", account_id: "acct" },
    last_refresh: "2026-05-16T00:00:00Z",
  });

  it("accepts a well-formed codex auth.json", () => {
    expect(validateCodexCredential(good)).toEqual({ ok: true });
  });

  it("rejects empty / non-JSON / non-object", () => {
    expect(validateCodexCredential("").ok).toBe(false);
    expect(validateCodexCredential("   ").ok).toBe(false);
    expect(validateCodexCredential("not json").ok).toBe(false);
    expect(validateCodexCredential("[]").ok).toBe(false);
    expect(validateCodexCredential("42").ok).toBe(false);
  });

  it("requires the fields codex restore actually needs", () => {
    expect(validateCodexCredential(JSON.stringify({ tokens: {} })).ok).toBe(false);
    expect(
      validateCodexCredential(JSON.stringify({ auth_mode: "chatgpt", tokens: {} })).ok,
    ).toBe(false);
    expect(
      validateCodexCredential(
        JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a" } }),
      ).ok,
    ).toBe(false);
    expect(
      validateCodexCredential(
        JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "r" } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects an oversized payload (no attacker-controlled blobs into the credential sink)", () => {
    const huge = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "a".repeat(40_000), refresh_token: "r" },
    });
    expect(validateCodexCredential(huge).ok).toBe(false);
  });
});

describe("gatewayDeviceAuthClient — addresses the gateway by instanceName", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = "k";
    process.env.K8S_NAMESPACE = "octogee";
    delete process.env.GATEWAY_INTERNAL_URL_TEMPLATE;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("derives the K8s Service from instanceName verbatim (no gw- stripping)", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ flowId: "f" }) } as any;
    }) as any;
    await gatewayDeviceAuthClient().start({ instanceName: "bender", agentId: "octogee-x-coach" });
    expect(seen[0]).toBe(
      "http://octogee-gateway-bender.octogee.svc.cluster.local:3003/internal/byosub/device-auth/start",
    );
  });

  it("honors the GATEWAY_INTERNAL_URL_TEMPLATE override with {instanceName}", async () => {
    process.env.GATEWAY_INTERNAL_URL_TEMPLATE = "http://127.0.0.1:9{instanceName}9";
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ state: "x" }) } as any;
    }) as any;
    await gatewayDeviceAuthClient().status({ instanceName: "00", flowId: "f1" });
    expect(seen[0]).toBe(
      "http://127.0.0.1:9009/internal/byosub/device-auth/status/f1",
    );
  });

  it("throws on a non-2xx gateway response (surfaced, not swallowed)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    })) as any;
    await expect(
      gatewayDeviceAuthClient().start({ instanceName: "bender", agentId: "a" }),
    ).rejects.toThrow(/502/);
  });
});

describe("byosubConnectionView — honest status (presence ≠ liveness; R8)", () => {
  it("no ref / no provider → not connected, no status", () => {
    expect(byosubConnectionView(undefined)).toEqual({ connected: false });
    expect(byosubConnectionView(null)).toEqual({ connected: false });
    expect(byosubConnectionView({})).toEqual({ connected: false });
    expect(byosubConnectionView({ provider: "" })).toEqual({ connected: false });
    expect(byosubConnectionView({ status: "connected" })).toEqual({ connected: false });
  });

  it("ref present, no/unknown/connected status → connected", () => {
    expect(byosubConnectionView({ provider: "openai" })).toEqual({
      connected: true,
      provider: "openai",
      status: "connected",
    });
    expect(byosubConnectionView({ provider: "openai", status: "connected" })).toEqual({
      connected: true,
      provider: "openai",
      status: "connected",
    });
    expect(byosubConnectionView({ provider: "openai", status: "weird" })).toEqual({
      connected: true,
      provider: "openai",
      status: "connected",
    });
  });

  it("needs_reauth → connected:false but distinguishable (UI shows Reconnect, not 'never connected')", () => {
    expect(
      byosubConnectionView({ provider: "openai", secretName: "s", status: "needs_reauth" }),
    ).toEqual({ connected: false, provider: "openai", status: "needs_reauth" });
  });
});

describe("isSafeGatewayId (Copilot #992 — Firestore doc-id safety; clean 400 not 500)", () => {
  it("accepts real slug-like gateway ids", () => {
    expect(isSafeGatewayId("default")).toBe(true);
    expect(isSafeGatewayId("gw-bender")).toBe(true);
    expect(isSafeGatewayId("gw-test")).toBe(true);
    expect(isSafeGatewayId("GW_test-1")).toBe(true);
  });
  it("rejects path-traversal / empty / overlong / non-string (would throw in .doc())", () => {
    expect(isSafeGatewayId("gw/evil")).toBe(false);
    expect(isSafeGatewayId("../x")).toBe(false);
    expect(isSafeGatewayId("")).toBe(false);
    expect(isSafeGatewayId("-leading-hyphen")).toBe(false);
    expect(isSafeGatewayId("a".repeat(129))).toBe(false);
    expect(isSafeGatewayId(undefined)).toBe(false);
    expect(isSafeGatewayId(123)).toBe(false);
    expect(isSafeGatewayId("has space")).toBe(false);
  });
});
