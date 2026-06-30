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

  it("restores the dedicated builder config through the injected restore function", async () => {
    const messages: string[] = [];
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
      log: (msg) => messages.push(msg),
      restore,
    })).resolves.toEqual({
      action: "restore",
      gatewayClass: "dedicated",
      slug: "alice",
    });
    expect(restore).toHaveBeenCalledWith("alice", { log: expect.any(Function) });
    expect(messages).toContain("restore skipped: checkout-unavailable");
  });
});
