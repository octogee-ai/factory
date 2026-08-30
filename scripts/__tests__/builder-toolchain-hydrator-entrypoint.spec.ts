import { describe, expect, it, vi } from "vitest";

import {
  createBuilderNpmProxyTokenProvider,
  createBuilderToolchainStatusPublisher,
  probeBuilderInteractiveReadiness,
  resolveBuilderToolchainHydratorConfig,
} from "../entrypoints/builder-toolchain-hydrator.js";

describe("Builder toolchain hydrator entrypoint", () => {
  it("resolves the image-pinned npm lock and managed proxy contract", () => {
    expect(resolveBuilderToolchainHydratorConfig({
      HOME: "/home/builder",
      GATEWAY_ID: "bender",
      GATEWAY_BUILDER_SLUG: "alice",
      FLEET_CONTROLLER_PORT: "4111",
      OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_JSON_PATH: "/octogee/toolchain/package.json",
      OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH: "/octogee/toolchain/package-lock.json",
      OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256: "a".repeat(64),
      OCTOGEE_BUILDER_NPM_PROXY_REGISTRY: "https://proxy.example/npm/",
    })).toEqual({
      root: "/home/builder/.octogee/toolchains",
      gatewayId: "bender",
      builderSlug: "alice",
      readinessUrl: "http://127.0.0.1:4111/surge-ready",
      packageJsonPath: "/octogee/toolchain/package.json",
      packageLockPath: "/octogee/toolchain/package-lock.json",
      packageLockSha256: "a".repeat(64),
      proxyRegistryUrl: "https://proxy.example/npm/",
      fallbackRegistryUrl: "https://registry.npmjs.org/",
    });
  });

  it("uses a short-lived Google access token without exposing auth in config", async () => {
    const getAccessToken = vi.fn(async () => "short-lived-token");
    const provide = createBuilderNpmProxyTokenProvider({ getAccessToken });

    await expect(provide()).resolves.toBe("short-lived-token");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
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
