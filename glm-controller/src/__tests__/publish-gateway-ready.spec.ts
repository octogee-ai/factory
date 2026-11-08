import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { publishPlatformGatewayReady } from "../index.js";

const runtime = (heartbeat: Record<string, unknown>) => ({
  docKind: "runtime", gatewayId: "bender", release: 2, lifecycle: "provisioning", heartbeat,
});

describe("publishPlatformGatewayReady", () => {
  it("marks the runtime serving and ready while keeping the heartbeat it already reported", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["glmGateways/bender", runtime({
        status: "booting", startedAt: 7, mountedCustomers: ["alice"], lastError: "boom",
        configStatus: { runtimeReady: true }, lastHeartbeatAt: 5,
      })],
    ]);
    await publishPlatformGatewayReady(createDocumentFixtureStore(documents), { gatewayId: "bender", imageTag: "abc1234@sha256:1", now: 100 });
    expect(documents.get("glmGateways/bender")).toEqual({
      ...runtime({}),
      lifecycle: "serving",
      heartbeat: {
        status: "ready", version: "abc1234", internalUrl: expect.stringContaining("octogee-gateway-bender"),
        startedAt: 7, mountedCustomers: ["alice"], lastError: "boom",
        configStatus: { runtimeReady: true }, lastHeartbeatAt: 5,
      },
    });
  });

  it("starts the readiness clock and an empty mounted set for a runtime with no reported heartbeat", async () => {
    const documents = new Map<string, Record<string, unknown>>([["glmGateways/bender", runtime({ status: "unknown" })]]);
    await publishPlatformGatewayReady(createDocumentFixtureStore(documents), { gatewayId: "bender", now: 100 });
    expect(documents.get("glmGateways/bender")?.heartbeat).toEqual({
      status: "ready", version: "unknown", internalUrl: expect.stringContaining("octogee-gateway-bender"),
      startedAt: 100, mountedCustomers: [], lastError: null,
    });
  });

  it("refuses to publish readiness for a gateway with no runtime record", async () => {
    await expect(publishPlatformGatewayReady(createDocumentFixtureStore({}), { gatewayId: "bender", now: 100 }))
      .rejects.toThrow("cannot publish readiness: glmGateways/bender is not the gateway's runtime doc");
  });
});
