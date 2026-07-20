import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { generateIdentity } from "@octogee/shared/types/device-identity";

import { OpenclawWireError } from "../openclaw/upstream.js";
import {
  openAuthenticatedUpstream,
  type AuthenticatedUpstreamDeps,
} from "../openclaw/authenticated-upstream.js";

function fakeSocket(label: string): WebSocket {
  return { label } as unknown as WebSocket;
}

function depsForTest(): AuthenticatedUpstreamDeps {
  const identity = generateIdentity();
  return {
    fetchGatewayAuth: vi.fn(),
    openUpstream: vi.fn(),
    clearGatewayDeviceToken: vi.fn(async () => undefined),
    invalidateGatewayToken: vi.fn(),
    persistGatewayDeviceToken: vi.fn(async () => undefined),
    getIdentity: vi.fn(() => identity),
  };
}

describe("openAuthenticatedUpstream", () => {
  it("clears a mismatched device token and re-enrolls with legacy auth", async () => {
    const deps = depsForTest();
    const recovered = fakeSocket("recovered");
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "device-token-file", deviceToken: "stale-device-token" })
      .mockResolvedValueOnce({ source: "legacy-token", token: "legacy-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValueOnce(new OpenclawWireError("auth-failed", "device token mismatch"))
      .mockImplementationOnce(async (params) => {
        await params.onDeviceToken?.({ deviceToken: "replacement-device-token" });
        return recovered;
      });

    const result = await openAuthenticatedUpstream({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
      timeoutMs: 10_000,
    }, deps);

    expect(result).toBe(recovered);
    expect(deps.clearGatewayDeviceToken).toHaveBeenCalledTimes(1);
    expect(deps.invalidateGatewayToken).not.toHaveBeenCalled();
    expect(deps.fetchGatewayAuth).toHaveBeenNthCalledWith(2, {
      gatewayId: "eggman-devdays",
      allowLegacyFallback: true,
      skipCache: true,
    });
    expect(deps.persistGatewayDeviceToken).toHaveBeenCalledWith({
      token: "replacement-device-token",
    });
    const openCalls = vi.mocked(deps.openUpstream).mock.calls;
    expect(openCalls).toHaveLength(2);
    expect(openCalls[1]?.[0].identity).toBe(openCalls[0]?.[0].identity);
  });

  it("invalidates cached legacy auth before retrying an auth failure", async () => {
    const deps = depsForTest();
    const recovered = fakeSocket("recovered");
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "legacy-token", token: "stale-legacy-token" })
      .mockResolvedValueOnce({ source: "legacy-token", token: "fresh-legacy-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValueOnce(new OpenclawWireError("auth-failed", "unauthorized"))
      .mockResolvedValueOnce(recovered);

    await expect(openAuthenticatedUpstream({
      gatewayId: "default",
      url: "http://127.0.0.1:18789",
    }, deps)).resolves.toBe(recovered);

    expect(deps.invalidateGatewayToken).toHaveBeenCalledWith("default");
    expect(deps.clearGatewayDeviceToken).not.toHaveBeenCalled();
  });

  it("does not rotate credentials for a non-authentication failure", async () => {
    const deps = depsForTest();
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "device-token-file", deviceToken: "device-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValueOnce(new OpenclawWireError("timeout", "connect timed out"));

    await expect(openAuthenticatedUpstream({
      gatewayId: "default",
      url: "http://127.0.0.1:18789",
    }, deps)).rejects.toMatchObject({ code: "timeout" });

    expect(deps.fetchGatewayAuth).toHaveBeenCalledTimes(1);
    expect(deps.clearGatewayDeviceToken).not.toHaveBeenCalled();
    expect(deps.invalidateGatewayToken).not.toHaveBeenCalled();
  });

  it("surfaces a second authentication failure after one rotation attempt", async () => {
    const deps = depsForTest();
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "device-token-file", deviceToken: "stale-device-token" })
      .mockResolvedValueOnce({ source: "legacy-token", token: "legacy-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValue(new OpenclawWireError("auth-failed", "unauthorized"));

    await expect(openAuthenticatedUpstream({
      gatewayId: "default",
      url: "http://127.0.0.1:18789",
    }, deps)).rejects.toMatchObject({ code: "auth-failed" });

    expect(deps.fetchGatewayAuth).toHaveBeenCalledTimes(2);
    expect(deps.openUpstream).toHaveBeenCalledTimes(2);
  });
});
