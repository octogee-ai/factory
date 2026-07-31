import { beforeEach, describe, expect, it, vi } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

describe("fleet broker system config status", () => {
  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    vi.mocked(internalFetch).mockResolvedValue(new Response(null, { status: 204 }));
    delete process.env.FLEET_BROKER_URL;
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("publishes the redacted status against the immutable revision", async () => {
    await createFleetBrokerClient("bender", "bender-r9").recordSystemConfigStatus({
      state: "error",
      acceptedCommit: "abc123",
      lastErrorCode: "non-fast-forward-conflict",
    });

    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/system-config-status",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          gatewayId: "bender",
          revisionId: "bender-r9",
          status: {
            state: "error",
            acceptedCommit: "abc123",
            lastErrorCode: "non-fast-forward-conflict",
          },
        }),
      }),
    );
  });

  it("requests the narrow configured-builder bootstrap against the immutable revision", async () => {
    const bootstrap = {
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
      projectCredentials: [],
    };
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ bootstrap }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await expect(
      createFleetBrokerClient("bender", "bender-r9").configuredBuilderBootstrap("alice"),
    ).resolves.toEqual(bootstrap);
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/configured-builder-bootstrap",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          gatewayId: "bender",
          revisionId: "bender-r9",
          slug: "alice",
        }),
      }),
    );
  });
});
