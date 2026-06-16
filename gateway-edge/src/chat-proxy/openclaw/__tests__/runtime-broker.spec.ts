import { describe, expect, it, vi } from "vitest";

import {
  createOpenClawRuntimeBroker,
  createOpenClawRuntimeBrokerFromEnv,
  runtimeBrokerBaseUrlFromEnv,
} from "../runtime-broker.js";

describe("OpenClaw runtime broker env", () => {
  it("requires OPENCLAW_RUNTIME_BROKER_URL", () => {
    expect(() => runtimeBrokerBaseUrlFromEnv({ GATEWAY_ID: "default" })).toThrow(
      "OPENCLAW_RUNTIME_BROKER_URL is required",
    );
    expect(() => createOpenClawRuntimeBrokerFromEnv({ GATEWAY_ID: "default" })).toThrow(
      "OPENCLAW_RUNTIME_BROKER_URL is required",
    );
  });

  it("requires GATEWAY_ID when the broker URL is configured", () => {
    expect(() =>
      createOpenClawRuntimeBrokerFromEnv({
        OPENCLAW_RUNTIME_BROKER_URL: "http://octogee-api:3001/",
      }),
    ).toThrow("GATEWAY_ID is required for OpenClaw runtime broker");
  });

  it("constructs the broker only when both env vars are present", () => {
    const broker = createOpenClawRuntimeBrokerFromEnv({
      OPENCLAW_RUNTIME_BROKER_URL: "http://octogee-api:3001/",
      GATEWAY_ID: "default",
    });

    expect(broker).toEqual(
      expect.objectContaining({
        redeemOpenClawWs: expect.any(Function),
        getUserGatewayId: expect.any(Function),
        approvalRegistry: expect.any(Object),
      }),
    );
  });

  it("brokers Mattermost owner and user-id resolution through octogee-api", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      calls.push({ url, body });

      if (url.endsWith("/internal/openclaw/activity/channel-owner")) {
        return new Response(JSON.stringify({ ownerUid: "uid-owner" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/internal/openclaw/activity/user-by-mm")) {
        return new Response(JSON.stringify({ uid: "uid-author" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });

    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-bender",
      fetchImpl,
    });

    await expect(broker.resolveChannelOwnerUid("mm-channel")).resolves.toBe("uid-owner");
    await expect(broker.resolveOctogeeUidByMmUser("mm-user")).resolves.toBe("uid-author");
    expect(calls).toEqual([
      {
        url: "http://octogee-api:3001/internal/openclaw/activity/channel-owner",
        body: { gatewayId: "gw-bender", channelId: "mm-channel" },
      },
      {
        url: "http://octogee-api:3001/internal/openclaw/activity/user-by-mm",
        body: { gatewayId: "gw-bender", mmUserId: "mm-user" },
      },
    ]);
  });
});
