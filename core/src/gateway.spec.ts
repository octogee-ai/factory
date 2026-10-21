import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config.js";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  where: vi.fn(),
  collection: vi.fn(),
}));

vi.mock("./firebase.js", () => ({
  db: {
    collection: h.collection,
  },
}));

import { agentToUid, applyGatewayDefaults, loadAgentToUidMapping } from "./gateway.js";

beforeEach(() => {
  agentToUid.clear();
  h.get.mockReset();
  h.where.mockReset();
  h.collection.mockReset();
  h.collection.mockReturnValue({ where: h.where });
  h.where.mockReturnValue({ get: h.get });
});

describe("loadAgentToUidMapping", () => {
  it("loads both legacy and multi-agent ids from completed user provisioning docs", async () => {
    h.get.mockResolvedValue({
      docs: [
        {
          id: "uid-1",
          data: () => ({
            provisioning: { openclaw: { agentId: "octogee-acme-coach" } },
          }),
        },
        {
          id: "uid-2",
          data: () => ({
            provisioning: {
              openclaw: {
                agentIds: ["octogee-beta-coach", "octogee-beta-research"],
              },
            },
          }),
        },
      ],
    });

    await loadAgentToUidMapping();

    expect(h.collection).toHaveBeenCalledWith("users");
    expect(h.where).toHaveBeenCalledWith("provisioning.openclaw.status", "==", "complete");
    expect(agentToUid.get("octogee-acme-coach")).toBe("uid-1");
    expect(agentToUid.get("octogee-beta-coach")).toBe("uid-2");
    expect(agentToUid.get("octogee-beta-research")).toBe("uid-2");
  });
});

describe("applyGatewayDefaults", () => {
  it("raises low concurrency and timeout defaults without taking over model ownership", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          maxConcurrent: 2,
          subagents: {
            maxConcurrent: 1,
            model: "anthropic/claude-haiku-4-5",
            runTimeoutSeconds: 30,
          },
        },
        list: [
          {
            id: "octogee-acme-coach",
            model: "old-model",
            tools: { deny: ["exec", "process", "other"] },
          },
        ],
      },
      tools: { subagents: { tools: { deny: ["exec", "other"] } }, elevated: { enabled: true } },
    };

    expect(applyGatewayDefaults(config)).toBe(true);

    expect(config.channels).toEqual({});
    expect(config.agents?.defaults).toMatchObject({
      maxConcurrent: 8,
      verboseDefault: "on",
      subagents: {
        maxConcurrent: 8,
        model: "anthropic/claude-haiku-4-5",
        runTimeoutSeconds: 900,
      },
    });
    expect(config.tools).toMatchObject({
      subagents: { tools: { deny: ["exec", "other"] } },
      elevated: { enabled: false },
    });
    expect(config.gateway?.auth?.rateLimit).toEqual({
      maxAttempts: 10,
      windowMs: 60000,
      lockoutMs: 300000,
    });
    expect(config.agents?.list?.[0]).not.toHaveProperty("heartbeat");
    expect(config.agents?.list?.[0]).toMatchObject({
      model: "old-model",
      tools: { fs: { workspaceOnly: true }, deny: ["exec", "process", "other"] },
    });
  });

  it("leaves an already compliant gateway config unchanged", () => {
    const config: OpenClawConfig = {
      channels: {},
      agents: {
        defaults: {
          maxConcurrent: 8,
          verboseDefault: "on",
          subagents: { maxConcurrent: 8, runTimeoutSeconds: 900 },
        },
        list: [
          {
            id: "octogee-acme-coach",
            heartbeat: { every: "60m", target: "last", lightContext: true },
            tools: { fs: { workspaceOnly: true }, deny: ["exec", "process", "other"] },
          },
        ],
      },
      tools: { elevated: { enabled: false } },
      gateway: {
        auth: {
          rateLimit: { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 },
        },
      },
    };

    expect(applyGatewayDefaults(config)).toBe(false);
  });

  it("does not apply coach-only defaults to non-coach agent ids", () => {
    const config: OpenClawConfig = {
      agents: {
        list: [{ id: "octogee-acme-research" }],
      },
    };

    expect(applyGatewayDefaults(config)).toBe(true);

    expect(config.agents?.list?.[0]).not.toHaveProperty("heartbeat");
    expect(config.agents?.list?.[0]).not.toHaveProperty("tools");
  });
});
