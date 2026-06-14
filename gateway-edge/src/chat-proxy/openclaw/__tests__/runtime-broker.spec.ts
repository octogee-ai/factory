import { describe, expect, it } from "vitest";

import {
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
});
