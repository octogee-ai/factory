import { describe, expect, it, vi } from "vitest";
import {
  resolveSystemConfigRestorePlan,
  runSystemConfigRestore,
} from "../entrypoints/system-config-restore.js";

describe("system-config-restore entrypoint planning", () => {
  it("skips shared, standard, and unset gateway classes", () => {
    expect(resolveSystemConfigRestorePlan({ GATEWAY_CLASS: "shared" })).toMatchObject({
      action: "skip",
      reason: "skipping restore for shared/standard gateway class (shared)",
    });
    expect(resolveSystemConfigRestorePlan({ GATEWAY_PROFILE: "standard" })).toMatchObject({
      action: "skip",
      reason: "skipping restore for shared/standard gateway class (standard)",
    });
    expect(resolveSystemConfigRestorePlan({})).toMatchObject({
      action: "skip",
      reason: "skipping restore for shared/standard gateway class (unset)",
    });
  });

  it("skips dedicated gateways until a builder slug is available", () => {
    expect(resolveSystemConfigRestorePlan({ GATEWAY_CLASS: "dedicated" })).toEqual({
      action: "skip",
      gatewayClass: "dedicated",
      reason: "skipping restore for dedicated: GATEWAY_BUILDER_SLUG is unset",
    });
  });

  it("fails a dedicated boot when its durable checkout cannot be restored", async () => {
    const restore = vi.fn(async () => ({
      skipped: "checkout-unavailable",
      seeded: false,
      restored: false,
    }));

    await expect(runSystemConfigRestore({
      env: {
        GATEWAY_CLASS: "dedicated",
        GATEWAY_BUILDER_SLUG: " alice ",
      },
      log: () => {},
      restore,
    })).rejects.toThrow(/checkout-unavailable/);
    expect(restore).toHaveBeenCalledWith("alice", { log: expect.any(Function) });
  });
});
