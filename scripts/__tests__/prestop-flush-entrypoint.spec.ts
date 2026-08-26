import { describe, expect, it, vi } from "vitest";
import {
  createPreStopBuilderRuntimeStateFlush,
  createPreStopGiteaKeyRelease,
  createPreStopSessionQuiesce,
  createPreStopSystemConfigFlush,
  PRESTOP_SESSION_QUIESCE_TIMEOUT_MS,
  resolvePreStopFlushConfig,
} from "../entrypoints/prestop-flush.js";
import { snapshotBuilderRuntimeState } from "../lib/builder-runtime-state.js";

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

  it("keeps dedicated gateway ids and leaves the builder slug empty when the pod is shared", () => {
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

  it("reports the dedicated builder's accepted system config commit", async () => {
    const acceptedCommit = "a".repeat(40);
    const sync = vi.fn(() => ({
      committed: true,
      pushed: true,
      pending: false,
      acceptedCommit,
    }));
    const flush = createPreStopSystemConfigFlush("alice", () => {}, sync);

    await expect(flush?.()).resolves.toEqual({ acceptedCommit });
  });

  it("skips system config on shared gateways", () => {
    const sync = vi.fn();

    expect(createPreStopSystemConfigFlush("", () => {}, sync)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it("treats an absent runtime database as a safe builder preStop no-op", async () => {
    const snapshot = vi.fn(async () => ({ status: "missing" as const })) as unknown as
      typeof snapshotBuilderRuntimeState;
    const flush = createPreStopBuilderRuntimeStateFlush(
      { gatewayId: "builder-alice", gatewayClass: "builder", builderSlug: "alice" },
      { builderRuntimeStateSnapshotUrls: vi.fn(), builderRuntimeStatePrune: vi.fn() },
      snapshot,
    );

    await expect(flush?.()).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("waits briefly for an active runtime snapshot without failing the preStop flush", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce({ status: "locked" })
      .mockResolvedValueOnce({
        status: "uploaded",
        path: "/state/openclaw.sqlite",
        size: 42,
        recoveryCount: 3,
        prunedCount: 0,
      }) as unknown as
      typeof snapshotBuilderRuntimeState;
    const wait = vi.fn(async () => {});
    const flush = createPreStopBuilderRuntimeStateFlush(
      { gatewayId: "builder-alice", gatewayClass: "builder", builderSlug: "alice" },
      { builderRuntimeStateSnapshotUrls: vi.fn(), builderRuntimeStatePrune: vi.fn() },
      snapshot,
      wait,
    );

    await expect(flush?.()).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it("quiesces only the dedicated builder before its preStop checkpoint", async () => {
    const quiesce = vi.fn(async () => ({ drained: true, runningCount: 0 }));
    const run = createPreStopSessionQuiesce("alice", {
      listCustomerSlugs: () => ["alice", "bob"],
      quiesce,
    });

    await run();

    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(quiesce).toHaveBeenCalledWith("alice", expect.objectContaining({
      timeoutMs: PRESTOP_SESSION_QUIESCE_TIMEOUT_MS,
    }));
  });

  it("attempts every shared customer and fails loud after bounded quiescence", async () => {
    const quiesce = vi.fn(async (slug: string) => slug === "alice"
      ? { drained: false, runningCount: 2 }
      : { drained: true, runningCount: 0 });
    const run = createPreStopSessionQuiesce("", {
      listCustomerSlugs: () => ["alice", "bob"],
      quiesce,
    });

    await expect(run()).rejects.toThrow(/alice.*2 session/u);
    expect(quiesce).toHaveBeenCalledTimes(2);
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
      listLocalCustomerPubKeys: () => [],
      releaseGiteaUserKey: vi.fn(async () => {}),
    });
    await expect(release?.()).rejects.toThrow(/local SSH public key is missing/);
  });

  it("releases every exact local customer key from a retiring shared gateway", async () => {
    const releaseGiteaUserKey = vi.fn(async () => {});
    const release = createPreStopGiteaKeyRelease("", {
      readLocalCustomerPubKey: () => null,
      listLocalCustomerPubKeys: () => [
        { slug: "alice", pubKey: "ssh-ed25519 ALICE predecessor" },
        { slug: "bob", pubKey: "ssh-ed25519 BOB predecessor" },
      ],
      releaseGiteaUserKey,
    });

    await release?.();
    expect(releaseGiteaUserKey.mock.calls).toEqual([
      ["alice", "ssh-ed25519 ALICE predecessor"],
      ["bob", "ssh-ed25519 BOB predecessor"],
    ]);
  });

  it("reports shared-gateway key cleanup failure after attempting every local customer", async () => {
    const releaseGiteaUserKey = vi.fn(async (slug: string) => {
      if (slug === "alice") throw new Error("broker unavailable");
    });
    const release = createPreStopGiteaKeyRelease("", {
      readLocalCustomerPubKey: () => null,
      listLocalCustomerPubKeys: () => [
        { slug: "alice", pubKey: "ssh-ed25519 ALICE predecessor" },
        { slug: "bob", pubKey: "ssh-ed25519 BOB predecessor" },
      ],
      releaseGiteaUserKey,
    });

    await expect(release?.()).rejects.toThrow(/alice.*broker unavailable/i);
    expect(releaseGiteaUserKey).toHaveBeenCalledTimes(2);
  });
});
