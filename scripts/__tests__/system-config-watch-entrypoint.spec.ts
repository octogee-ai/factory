import { describe, expect, it } from "vitest";

import { resolveSystemConfigWatchPlan } from "../entrypoints/system-config-watch.js";

describe("system-config-watch entrypoint planning", () => {
  it("runs only for isolated gateways with a builder slug and canonical path", () => {
    expect(resolveSystemConfigWatchPlan({
      GATEWAY_CLASS: "builder",
      GATEWAY_BUILDER_SLUG: " alice ",
      OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/system_config/openclaw.json",
    })).toEqual({
      action: "watch",
      slug: "alice",
      configPath: "/home/node/.openclaw/system_config/openclaw.json",
    });
  });

  it("skips shared gateways and rejects an isolated runtime without the durable path", () => {
    expect(resolveSystemConfigWatchPlan({ GATEWAY_CLASS: "shared" })).toEqual({
      action: "skip",
      reason: "shared-gateway",
    });
    expect(() => resolveSystemConfigWatchPlan({
      GATEWAY_CLASS: "operator",
      GATEWAY_BUILDER_SLUG: "alice",
      HOME: "/home/node",
    })).toThrow(/OPENCLAW_CONFIG_PATH/);
  });
});
