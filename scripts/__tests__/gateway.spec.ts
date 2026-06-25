import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { OpenClawConfig } from "../lib/config.js";

vi.mock("../lib/firebase.js", () => ({
  db: { collection: vi.fn() },
}));

import { applyGatewayDefaults } from "../lib/gateway.js";

describe("advisory mode removal", () => {
  const libDir = path.resolve(__dirname, "..", "lib");

  it("no isAdvisoryMode function exists in any module", () => {
    const files = fs.readdirSync(libDir).filter(f => f.endsWith(".ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(libDir, file), "utf-8");
      expect(content).not.toContain("isAdvisoryMode");
    }
  });

  it("no syncAdvisorySlugs function exists in any module", () => {
    const files = fs.readdirSync(libDir).filter(f => f.endsWith(".ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(libDir, file), "utf-8");
      expect(content).not.toContain("syncAdvisorySlugs");
    }
  });

  it("no advisorySlugs references in gateway module", () => {
    const gatewayPath = path.join(libDir, "gateway.ts");
    const content = fs.readFileSync(gatewayPath, "utf-8");
    expect(content).not.toContain("advisorySlugs");
    expect(content).not.toContain("advisoryMode");
  });

  it("no Firebase-backed local provisioner entrypoint remains", () => {
    const provisionerPath = path.resolve(__dirname, "..", "entrypoints", "local-provisioner.ts");
    expect(fs.existsSync(provisionerPath)).toBe(false);
  });
});

describe("ensureGatewayDefaults — config transformation", () => {
  it("applies gateway, tool, concurrency, and coach workspace defaults without touching model or deny ownership", () => {
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
    expect(config.agents?.list?.[0]).toMatchObject({
      model: "old-model",
      heartbeat: { every: "60m", target: "last", lightContext: true },
      tools: { fs: { workspaceOnly: true }, deny: ["exec", "process", "other"] },
    });
  });

  it("returns false for an already compliant config", () => {
    const config: OpenClawConfig = {
      channels: {},
      agents: {
        defaults: {
          maxConcurrent: 8,
          verboseDefault: "on",
          subagents: {
            maxConcurrent: 8,
            model: "anthropic/claude-haiku-4-5",
            runTimeoutSeconds: 900,
          },
        },
        list: [
          {
            id: "octogee-acme-coach",
            model: "old-model",
            heartbeat: { every: "60m", target: "last", lightContext: true },
            tools: { fs: { workspaceOnly: true }, deny: ["exec", "process", "other"] },
          },
        ],
      },
      tools: {
        subagents: { tools: { deny: ["exec", "other"] } },
        elevated: { enabled: false },
      },
      gateway: {
        auth: {
          rateLimit: { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 },
        },
      },
    };

    expect(applyGatewayDefaults(config)).toBe(false);
  });

it("sets maxConcurrent to 8 when missing", () => {
    const config: any = { agents: { defaults: {} } };
    config.agents.defaults.maxConcurrent ??= 8;
    expect(config.agents.defaults.maxConcurrent).toBe(8);
  });

  it("sets maxConcurrent to 8 when below threshold", () => {
    const config: any = { agents: { defaults: { maxConcurrent: 2 } } };
    if (!config.agents.defaults.maxConcurrent || config.agents.defaults.maxConcurrent < 8) {
      config.agents.defaults.maxConcurrent = 8;
    }
    expect(config.agents.defaults.maxConcurrent).toBe(8);
  });

  it("does not reduce maxConcurrent if already higher", () => {
    const config: any = { agents: { defaults: { maxConcurrent: 16 } } };
    if (!config.agents.defaults.maxConcurrent || config.agents.defaults.maxConcurrent < 8) {
      config.agents.defaults.maxConcurrent = 8;
    }
    expect(config.agents.defaults.maxConcurrent).toBe(16);
  });

  it("enforces fs.workspaceOnly on coach agents", () => {
    const agent: any = { id: "octogee-test-coach", tools: {} };
    if (/^octogee-.+-coach$/.test(agent.id)) {
      agent.tools.fs = { workspaceOnly: true };
    }
    expect(agent.tools.fs.workspaceOnly).toBe(true);
  });

  it("preserves exec/process deny lists because gateway class policy owns tool access", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { maxConcurrent: 8, verboseDefault: "on", subagents: { maxConcurrent: 8, runTimeoutSeconds: 900 } },
        list: [
          {
            id: "octogee-biz-coach",
            heartbeat: { every: "60m", target: "last", lightContext: true },
            tools: { fs: { workspaceOnly: true }, deny: ["exec", "process", "other"] },
          },
        ],
      },
      tools: { subagents: { tools: { deny: ["exec", "process", "other"] } }, elevated: { enabled: false } },
      gateway: { auth: { rateLimit: { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 } } },
    };

    expect(applyGatewayDefaults(config)).toBe(false);
    expect(config.agents?.list?.[0]?.tools?.deny).toEqual(["exec", "process", "other"]);
    expect(config.tools?.subagents?.tools?.deny).toEqual(["exec", "process", "other"]);
  });

  it("does not write coach or subagent model defaults", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {},
        list: [{ id: "octogee-foo-coach", model: "anthropic/claude-haiku-4-5", tools: {} }],
      },
    };

    expect(applyGatewayDefaults(config)).toBe(true);
    expect(config.agents?.defaults?.subagents).not.toHaveProperty("model");
    expect(config.agents?.list?.[0]?.model).toBe("anthropic/claude-haiku-4-5");
  });

});
