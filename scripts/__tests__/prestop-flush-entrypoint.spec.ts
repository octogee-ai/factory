import { describe, expect, it, vi } from "vitest";
import {
  createPreStopGiteaKeyRelease,
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

  it("builds exact-key cleanup for a retiring tenant-bound pod", async () => {
    const releaseGiteaUserKey = vi.fn(async () => {});
    const release = createPreStopGiteaKeyRelease("alice", {
      readLocalCustomerPubKey: () => "ssh-ed25519 OLD predecessor",
      releaseGiteaUserKey,
    });

    await release?.();
    expect(releaseGiteaUserKey).toHaveBeenCalledWith("alice", "ssh-ed25519 OLD predecessor");
  });

  it("fails loud instead of reporting cleanup when the local public key is missing", async () => {
    const release = createPreStopGiteaKeyRelease("alice", {
      readLocalCustomerPubKey: () => null,
      releaseGiteaUserKey: vi.fn(async () => {}),
    });
    await expect(release?.()).rejects.toThrow(/local SSH public key is missing/);
  });
});
