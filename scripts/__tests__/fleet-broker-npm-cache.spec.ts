import { beforeEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_CREDENTIAL_TOKEN_HEADER } from "@octogee/core/internal-fetch";
import { internalFetch } from "../lib/internal-fetch.js";
import { RETIRED_COMPUTER_BINDING_DENIAL_REASON } from "../../shared/types/fleet-broker.js";
import {
  createFleetBrokerClient,
  isRetiredComputerBindingDenial,
} from "../lib/fleet-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

describe("fleet broker npm cache client", () => {
  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("requests an assignment-scoped capability with the purpose KSA credential", async () => {
    const credentials = {
      registryUrl: "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/",
      token: "opaque-capability",
      expiresAt: "2026-08-30T12:10:00.000Z",
    };
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(JSON.stringify(credentials), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const gatewayCredentialHeaders = vi.fn(async () => ({
      [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
    }));

    await expect(createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders,
    }).npmRegistryCredentials("alice")).resolves.toEqual(credentials);
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/npm-registry-credentials",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
        }),
        body: JSON.stringify({ gatewayId: "builder-alice", slug: "alice" }),
      }),
    );
  });

  it("does not copy a failed broker response body into an exception", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "opaque-capability-secret" }),
      { status: 503 },
    ));

    await expect(createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders: async () => ({
        [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
      }),
    }).npmRegistryCredentials("alice")).rejects.toThrow(
      "fleet-broker POST /internal/fleet/npm-registry-credentials → 503",
    );
  });

  it("recognizes a retired-computer tenant denial without copying the body into the message", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
        error: `forbidden: ${RETIRED_COMPUTER_BINDING_DENIAL_REASON}`,
        code: "tenant-enforcement",
      }),
      { status: 403 },
    ));

    const failure = await createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders: async () => ({
        [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
      }),
    }).npmRegistryCredentials("alice").catch((error: unknown) => error);

    expect(isRetiredComputerBindingDenial(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      "fleet-broker POST /internal/fleet/npm-registry-credentials → 403",
    );
  });

  it("does not mistake an unassigned-Builder denial for retirement", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403 },
    ));

    const failure = await createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders: async () => ({
        [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
      }),
    }).npmRegistryCredentials("alice").catch((error: unknown) => error);

    expect(isRetiredComputerBindingDenial(failure)).toBe(false);
  });
});
