import { describe, expect, it, vi } from "vitest";
import {
  createPreStopSystemConfigFlush,
  resolvePreStopFlushConfig,
} from "../entrypoints/prestop-flush.js";

describe("prestop-flush entrypoint config", () => {
  it("normalizes the local gateway id to default", () => {
    expect(resolvePreStopFlushConfig(
      { GATEWAY_BUILDER_SLUG: " alice " },
      { gatewayClass: "standard", gatewayId: "local" },
    )).toEqual({
      gatewayId: "default",
      gatewayClass: "standard",
      builderSlug: "alice",
    });
  });

  it("keeps dedicated gateway ids and leaves system config sync disabled without a slug", () => {
    expect(resolvePreStopFlushConfig(
      {},
      { gatewayClass: "dedicated", gatewayId: "gw-alice" },
    )).toEqual({
      gatewayId: "gw-alice",
      gatewayClass: "dedicated",
      builderSlug: "",
    });
  });

  it("requires an accepted durable system config checkpoint", async () => {
    const sync = vi.fn(() => ({
      committed: true,
      pushed: false,
      pending: true,
      errorCode: "push-failed",
    }));
    const flush = createPreStopSystemConfigFlush("alice", () => {}, sync);

    await expect(flush?.()).rejects.toThrow("push-failed");
    expect(sync).toHaveBeenCalledWith("alice", expect.objectContaining({
      durablePolicy: true,
      source: "auto-watch",
    }));
  });
});
