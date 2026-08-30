import { describe, expect, it, vi } from "vitest";

import {
  createBuilderToolchainStatusPublisher,
  probeBuilderInteractiveReadiness,
  resolveBuilderToolchainHydratorConfig,
} from "../entrypoints/builder-toolchain-hydrator.js";

describe("Builder toolchain hydrator entrypoint", () => {
  it("resolves only the pinned image contract and configured HTTPS artifact input", () => {
    expect(resolveBuilderToolchainHydratorConfig({
      HOME: "/home/builder",
      GATEWAY_ID: "bender",
      GATEWAY_BUILDER_SLUG: "alice",
      FLEET_CONTROLLER_PORT: "4111",
      OCTOGEE_BUILDER_TOOLCHAIN_MANIFEST_PATH: "/octogee/toolchain/manifest.json",
      OCTOGEE_BUILDER_TOOLCHAIN_MANIFEST_SHA256: "a".repeat(64),
      OCTOGEE_BUILDER_TOOLCHAIN_ARTIFACT_URL: "https://broker.example/toolchain",
    })).toEqual({
      root: "/home/builder/.octogee/toolchains",
      gatewayId: "bender",
      builderSlug: "alice",
      readinessUrl: "http://127.0.0.1:4111/surge-ready",
      manifestPath: "/octogee/toolchain/manifest.json",
      manifestSha256: "a".repeat(64),
      artifactUrl: "https://broker.example/toolchain",
    });
  });

  it("projects exact states through the assigned-gateway broker and resolves the uid once", async () => {
    const client = {
      uidForSlug: vi.fn(async () => "uid-alice"),
      setToolchainStatus: vi.fn(async () => undefined),
    };
    const publish = createBuilderToolchainStatusPublisher({ client, builderSlug: "alice" });

    await publish({ schemaVersion: 1, status: "pending", updatedAt: "2026-08-30T00:00:00Z" });
    await publish({ schemaVersion: 1, status: "ready", updatedAt: "2026-08-30T00:01:00Z" });

    expect(client.uidForSlug).toHaveBeenCalledTimes(1);
    expect(client.setToolchainStatus.mock.calls).toEqual([
      ["uid-alice", "pending"],
      ["uid-alice", "ready"],
    ]);
  });

  it("retries assigned-user resolution after a fail-soft broker outage", async () => {
    const client = {
      uidForSlug: vi.fn()
        .mockRejectedValueOnce(new Error("broker unavailable"))
        .mockResolvedValueOnce("uid-alice"),
      setToolchainStatus: vi.fn(async () => undefined),
    };
    const publish = createBuilderToolchainStatusPublisher({ client, builderSlug: "alice" });
    const artifact = {
      schemaVersion: 1 as const,
      status: "ready" as const,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };

    await expect(publish(artifact)).rejects.toThrow("broker unavailable");
    await expect(publish(artifact)).resolves.toBeUndefined();
    expect(client.uidForSlug).toHaveBeenCalledTimes(2);
    expect(client.setToolchainStatus).toHaveBeenCalledWith("uid-alice", "ready");
  });

  it("treats only a successful surge-readiness response as interactive readiness", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(probeBuilderInteractiveReadiness("http://127.0.0.1:3003/surge-ready", fetchImpl))
      .resolves.toBe(false);
    await expect(probeBuilderInteractiveReadiness("http://127.0.0.1:3003/surge-ready", fetchImpl))
      .resolves.toBe(true);
  });
});
