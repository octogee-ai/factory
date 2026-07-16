import { describe, expect, it, vi } from "vitest";

import { hydrateConfiguredBuilderBootstrap } from "../lib/configured-builder-bootstrap.js";

describe("configured builder bootstrap", () => {
  it("materializes only the exact coach account credential returned for this revision", async () => {
    const configuredBuilderBootstrap = vi.fn().mockResolvedValue({
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
    });
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      revisionId: "bender-r9",
      slug: "alice",
    }, {
      createClient: () => ({ configuredBuilderBootstrap }),
      writeSecrets,
    });

    expect(configuredBuilderBootstrap).toHaveBeenCalledWith("alice");
    expect(writeSecrets).toHaveBeenCalledWith("/tmp/openclaw", {
      set: { "alice-coach": "coach-token" },
    });
  });

  it("rejects a broker response whose account identity does not match the configured builder", async () => {
    const writeSecrets = vi.fn().mockResolvedValue(undefined);
    await expect(hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      revisionId: "bender-r9",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredBuilderBootstrap: vi.fn().mockResolvedValue({
          uid: "uid-victim",
          slug: "victim",
          agentId: "octogee-victim-coach",
          accountId: "victim-coach",
          coachToken: "victim-token",
        }),
      }),
      writeSecrets,
    })).rejects.toThrow("configured builder bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });
});
