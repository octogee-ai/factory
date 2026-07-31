import { describe, expect, it, vi } from "vitest";

import { hydrateConfiguredBuilderBootstrap } from "../lib/configured-builder-bootstrap.js";

describe("configured builder bootstrap", () => {
  it("materializes the exact workspace and project coach credentials required at boot", async () => {
    const configuredBuilderBootstrap = vi.fn().mockResolvedValue({
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
      projectCredentials: [{
        projectId: "orbit",
        agentId: "octogee-alice-proj-orbit-coach",
        accountId: "alice-proj-orbit",
        token: "project-token",
      }],
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
      removePrefixes: ["alice-proj-"],
      set: {
        "alice-coach": "coach-token",
        "alice-proj-orbit": "project-token",
      },
    });
  });

  it("rejects a project credential outside the configured Builder identity", async () => {
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await expect(hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredBuilderBootstrap: vi.fn().mockResolvedValue({
          uid: "uid-alice",
          slug: "alice",
          agentId: "octogee-alice-coach",
          accountId: "alice-coach",
          coachToken: "coach-token",
          projectCredentials: [{
            projectId: "orbit",
            agentId: "octogee-victim-proj-orbit-coach",
            accountId: "victim-proj-orbit",
            token: "victim-token",
          }],
        }),
      }),
      writeSecrets,
    })).rejects.toThrow("configured builder bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing project credential list",
      bootstrap: {
        uid: "uid-alice",
        slug: "alice",
        agentId: "octogee-alice-coach",
        accountId: "alice-coach",
        coachToken: "coach-token",
      },
    },
    {
      name: "duplicate project credential",
      bootstrap: {
        uid: "uid-alice",
        slug: "alice",
        agentId: "octogee-alice-coach",
        accountId: "alice-coach",
        coachToken: "coach-token",
        projectCredentials: [
          {
            projectId: "orbit",
            agentId: "octogee-alice-proj-orbit-coach",
            accountId: "alice-proj-orbit",
            token: "project-token-a",
          },
          {
            projectId: "orbit",
            agentId: "octogee-alice-proj-orbit-coach",
            accountId: "alice-proj-orbit",
            token: "project-token-b",
          },
        ],
      },
    },
  ])("rejects a broker response with $name", async ({ bootstrap }) => {
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await expect(hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredBuilderBootstrap: vi.fn().mockResolvedValue(bootstrap),
      }),
      writeSecrets,
    })).rejects.toThrow("configured builder bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });

  it("provisions the configured coach once when a freshly claimed gateway has no bootstrap yet", async () => {
    const calls: string[] = [];
    const bootstrap = {
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
      projectCredentials: [],
    };
    const configuredBuilderBootstrap = vi.fn()
      .mockRejectedValueOnce(new Error(
        'fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 {"error":"configured_builder_bootstrap_unavailable"}',
      ))
      .mockImplementationOnce(async () => {
        calls.push("retry-bootstrap");
        return bootstrap;
      });
    const client = {
      configuredBuilderBootstrap,
      uidForSlug: vi.fn(async () => {
        calls.push("uid");
        return "uid-alice";
      }),
      provisionMattermost: vi.fn(async () => {
        calls.push("provision-mattermost");
        return { "mattermost.teamId": "team-alice" };
      }),
      setMattermostFields: vi.fn(async () => {
        calls.push("set-mattermost");
      }),
      setAgentIds: vi.fn(async () => {
        calls.push("set-agents");
      }),
    };
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      slug: "alice",
    }, {
      createClient: () => client,
      writeSecrets,
    });

    expect(calls).toEqual([
      "uid",
      "provision-mattermost",
      "set-mattermost",
      "set-agents",
      "retry-bootstrap",
    ]);
    expect(client.setMattermostFields).toHaveBeenCalledWith("uid-alice", {
      "mattermost.teamId": "team-alice",
    });
    expect(client.setAgentIds).toHaveBeenCalledWith("uid-alice", ["octogee-alice-coach"]);
    expect(writeSecrets).toHaveBeenCalledWith("/tmp/openclaw", {
      removePrefixes: ["alice-proj-"],
      set: { "alice-coach": "coach-token" },
    });
  });

  it("fails loudly when an unavailable bootstrap has no assigned builder uid", async () => {
    const provisionMattermost = vi.fn();
    await expect(hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredBuilderBootstrap: vi.fn().mockRejectedValue(new Error(
          'fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 {"error":"configured_builder_bootstrap_unavailable"}',
        )),
        uidForSlug: vi.fn().mockResolvedValue(null),
        provisionMattermost,
        setMattermostFields: vi.fn(),
        setAgentIds: vi.fn(),
      }),
    })).rejects.toThrow("configured builder alice has no assigned uid");
    expect(provisionMattermost).not.toHaveBeenCalled();
  });

  it.each([
    "fleet-broker POST /internal/fleet/configured-builder-bootstrap → 403 forbidden",
    "fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 not_found",
    "connect ECONNREFUSED",
  ])("does not provision Mattermost for a non-recoverable bootstrap error: %s", async (message) => {
    const uidForSlug = vi.fn();
    await expect(hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredBuilderBootstrap: vi.fn().mockRejectedValue(new Error(message)),
        uidForSlug,
        provisionMattermost: vi.fn(),
        setMattermostFields: vi.fn(),
        setAgentIds: vi.fn(),
      }),
    })).rejects.toThrow(message);
    expect(uidForSlug).not.toHaveBeenCalled();
  });

  it("validates the configured identity returned after recovery", async () => {
    const writeSecrets = vi.fn();
    await expect(hydrateConfiguredBuilderBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "bender",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredBuilderBootstrap: vi.fn()
          .mockRejectedValueOnce(new Error(
            'fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 {"error":"configured_builder_bootstrap_unavailable"}',
          ))
          .mockResolvedValueOnce({
            uid: "uid-victim",
            slug: "victim",
            agentId: "octogee-victim-coach",
            accountId: "victim-coach",
            coachToken: "victim-token",
            projectCredentials: [],
          }),
        uidForSlug: vi.fn().mockResolvedValue("uid-alice"),
        provisionMattermost: vi.fn().mockResolvedValue({}),
        setMattermostFields: vi.fn().mockResolvedValue(undefined),
        setAgentIds: vi.fn().mockResolvedValue(undefined),
      }),
      writeSecrets,
    })).rejects.toThrow("configured builder bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
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
          projectCredentials: [],
        }),
      }),
      writeSecrets,
    })).rejects.toThrow("configured builder bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });
});
