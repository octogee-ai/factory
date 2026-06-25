import { beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const internalFetchSpy = vi.fn();

vi.mock("../lib/internal-fetch", () => ({
  internalFetch: (url: string, init: RequestInit, opts: Record<string, unknown>) =>
    internalFetchSpy(url, init, opts),
}));

const modelCredentialSyncTrigger = await import("../lib/byot-sync-trigger.js");
const {
  gatewayModelCredentialSyncUrl,
  postGatewayModelCredentialSync,
  triggerGatewayModelCredentialSync,
} = modelCredentialSyncTrigger;

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

describe("model credential sync trigger", () => {
  beforeEach(() => {
    internalFetchSpy.mockReset();
    delete process.env.K8S_NAMESPACE;
    delete process.env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE;
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET;
  });

  it("builds the per-instance gateway-edge URL, never the round-robin gateway alias", () => {
    expect(gatewayModelCredentialSyncUrl("bender", { K8S_NAMESPACE: "octogee-test" })).toBe(
      "http://gateway-edge-bender.octogee-test.svc.cluster.local:3001/api/g/bender/internal/model-credential-sync",
    );
  });

  it("honors an explicit gateway-edge URL template", () => {
    expect(
      gatewayModelCredentialSyncUrl("gw-1", {
        GATEWAY_EDGE_INTERNAL_URL_TEMPLATE: "http://custom-{gatewayId}.svc:3001/root/",
      }),
    ).toBe("http://custom-gw-1.svc:3001/root/api/g/gw-1/internal/model-credential-sync");
  });

  it("does not export legacy BYOT trigger helper aliases", () => {
    expect("gatewayByotSyncUrl" in modelCredentialSyncTrigger).toBe(false);
    expect("postGatewayByotSync" in modelCredentialSyncTrigger).toBe(false);
    expect("triggerGatewayByotSync" in modelCredentialSyncTrigger).toBe(false);
  });

  it("POSTs the userData through internalFetch with a model credential sync HMAC", async () => {
    internalFetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await postGatewayModelCredentialSync({
      gatewayId: "bender",
      userData,
      env: { K8S_NAMESPACE: "octogee-test", BYOT_SYNC_INTERNAL_SIGNING_SECRET: "sync-secret" },
    });
    expect(internalFetchSpy).toHaveBeenCalledWith(
      "http://gateway-edge-bender.octogee-test.svc.cluster.local:3001/api/g/bender/internal/model-credential-sync",
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
      postGatewayModelCredentialSync({
        gatewayId: "bender",
        userData,
        env: { K8S_NAMESPACE: "octogee-test" },
      }),
    ).rejects.toThrow(/BYOT_SYNC_INTERNAL_SIGNING_SECRET/);
    expect(internalFetchSpy).not.toHaveBeenCalled();
  });

  it("throws on non-2xx responses so the fire-and-forget wrapper can log", async () => {
    internalFetchSpy.mockResolvedValue(new Response("nope", { status: 503 }));
    await expect(
      postGatewayModelCredentialSync({
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
      triggerGatewayModelCredentialSync({
        gatewayId: "bender",
        userData,
        env: { BYOT_SYNC_INTERNAL_SIGNING_SECRET: "sync-secret" },
        logWarn: warn,
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("503 nope")));
  });

  it.each([
    "routes/billing/byot.ts",
    "routes/byosub.ts",
    "routes/internal/billing.ts",
  ])("%s imports the model credential trigger name", (relativePath) => {
    const src = readFileSync(join(import.meta.dirname, "..", relativePath), "utf8");
    expect(src).toContain("triggerGatewayModelCredentialSync");
    expect(src).not.toContain("triggerGatewayByotSync");
  });
});
