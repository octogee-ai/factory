import { beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";

const internalFetchSpy = vi.fn();

vi.mock("../lib/internal-fetch", () => ({
  internalFetch: (url: string, init: RequestInit, opts: Record<string, unknown>) =>
    internalFetchSpy(url, init, opts),
}));

const {
  gatewayByotSyncUrl,
  postGatewayByotSync,
  triggerGatewayByotSync,
} = await import("../lib/byot-sync-trigger.js");

const userData = {
  byotActive: true,
  username: "smile-wring-011b",
  provisioning: { openclaw: { status: "complete" } },
  systemConfig: { byot: { provider: "openai", model: "openai/gpt-5" } },
};

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

function expectedSignature(body: unknown, timestamp: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalJson(body)}`)
    .digest("hex");
}

describe("BYOT sync trigger", () => {
  beforeEach(() => {
    internalFetchSpy.mockReset();
    delete process.env.K8S_NAMESPACE;
    delete process.env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE;
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET;
  });

  it("builds the per-instance gateway-edge URL, never the round-robin gateway alias", () => {
    expect(gatewayByotSyncUrl("bender", { K8S_NAMESPACE: "octogee-test" })).toBe(
      "http://gateway-edge-bender.octogee-test.svc.cluster.local:3001/api/g/bender/internal/byot-sync",
    );
  });

  it("honors an explicit gateway-edge URL template", () => {
    expect(
      gatewayByotSyncUrl("gw-1", {
        GATEWAY_EDGE_INTERNAL_URL_TEMPLATE: "http://custom-{gatewayId}.svc:3001/root/",
      }),
    ).toBe("http://custom-gw-1.svc:3001/root/api/g/gw-1/internal/byot-sync");
  });

  it("POSTs the userData through internalFetch with a BYOT sync HMAC", async () => {
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await postGatewayByotSync({
      gatewayId: "bender",
      userData,
      env: { K8S_NAMESPACE: "octogee-test", BYOT_SYNC_INTERNAL_SIGNING_SECRET: "sync-secret" },
    });
    expect(internalFetchSpy).toHaveBeenCalledWith(
      "http://gateway-edge-bender.octogee-test.svc.cluster.local:3001/api/g/bender/internal/byot-sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(userData),
      }),
      expect.objectContaining({ internalServiceKey: "" }),
    );
    const headers = new Headers(internalFetchSpy.mock.calls[0][1].headers);
    expect(headers.get("content-type")).toBe("application/json");
    const timestamp = headers.get("x-byot-sync-timestamp");
    expect(timestamp).toMatch(/^\d+$/);
    expect(headers.get("x-byot-sync-signature")).toBe(
      expectedSignature(userData, timestamp!, "sync-secret"),
    );
    expect(headers.get("x-k8s-sa-token")).toBeNull();
  });

  it("fails before network I/O when no BYOT sync signing secret or legacy service key is configured", async () => {
    await expect(
      postGatewayByotSync({ gatewayId: "bender", userData, env: { K8S_NAMESPACE: "octogee-test" } }),
    ).rejects.toThrow(/BYOT_SYNC_INTERNAL_SIGNING_SECRET/);
    expect(internalFetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-2xx responses so the fire-and-forget wrapper can log", async () => {
    internalFetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(
      postGatewayByotSync({
        gatewayId: "bender",
        userData,
        env: { BYOT_SYNC_INTERNAL_SIGNING_SECRET: "sync-secret" },
      }),
    ).rejects.toThrow(/503 nope/);
  });

  it("fire-and-forget wrapper logs failures without throwing to the caller", async () => {
    internalFetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));
    const warn = vi.fn();
    expect(() =>
      triggerGatewayByotSync({
        gatewayId: "bender",
        userData,
        env: { BYOT_SYNC_INTERNAL_SIGNING_SECRET: "sync-secret" },
        logWarn: warn,
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("503 nope")));
  });
});
