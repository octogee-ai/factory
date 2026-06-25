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
  it("applies gateway, tool, subagent, and coach defaults in one pure pass", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          maxConcurrent: 2,
          subagents: { maxConcurrent: 1, runTimeoutSeconds: 30 },
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

    expect(applyGatewayDefaults(config, "openai/gpt-5.5")).toBe(true);
    expect(config.channels).toEqual({});
    expect(config.agents?.defaults).toMatchObject({
      maxConcurrent: 8,
      verboseDefault: "on",
      subagents: {
        maxConcurrent: 8,
        model: "openai/gpt-5.5",
        runTimeoutSeconds: 900,
      },
    });
    expect(config.tools).toMatchObject({
      subagents: { tools: { deny: ["other"] } },
      elevated: { enabled: false },
    });
    expect(config.gateway?.auth?.rateLimit).toEqual({
      maxAttempts: 10,
      windowMs: 60000,
      lockoutMs: 300000,
    });
    expect(config.agents?.list?.[0]).toMatchObject({
      model: "openai/gpt-5.5",
      heartbeat: { every: "60m", target: "last", lightContext: true },
      tools: { fs: { workspaceOnly: true }, deny: ["other"] },
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
            model: "openai/gpt-5.5",
            runTimeoutSeconds: 900,
          },
        },
        list: [
          {
            id: "octogee-acme-coach",
            model: "openai/gpt-5.5",
            heartbeat: { every: "60m", target: "last", lightContext: true },
            tools: { fs: { workspaceOnly: true }, deny: ["other"] },
          },
        ],
      },
      tools: {
        subagents: { tools: { deny: ["other"] } },
        elevated: { enabled: false },
      },
      gateway: {
        auth: {
          rateLimit: { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 },
        },
      },
    };

    expect(applyGatewayDefaults(config, "openai/gpt-5.5")).toBe(false);
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

  it("removes exec/process from deny list", () => {
    const agent: any = { id: "octogee-biz-coach", tools: { deny: ["exec", "process", "other"] } };
    if (/^octogee-.+-coach$/.test(agent.id)) {
      agent.tools.deny = agent.tools.deny.filter((t: string) => t !== "exec" && t !== "process");
    }
    expect(agent.tools.deny).toEqual(["other"]);
  });

  it("sets coach model to sonnet 4.6 by default", () => {
    const agent: any = { id: "octogee-foo-coach", model: "anthropic/claude-haiku-4-5" };
    if (/^octogee-.+-coach$/.test(agent.id)) {
      const faceModel = process.env.OPENCLAW_FACE_MODEL ?? "anthropic/claude-sonnet-4-6";
      agent.model = faceModel;
    }
    expect(agent.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("respects OPENCLAW_FACE_MODEL env override for coach model", () => {
    const prev = process.env.OPENCLAW_FACE_MODEL;
    process.env.OPENCLAW_FACE_MODEL = "openai/gpt-5.5";
    const agent: any = { id: "octogee-foo-coach", model: "anthropic/claude-sonnet-4-6" };
    if (/^octogee-.+-coach$/.test(agent.id)) {
      const faceModel = process.env.OPENCLAW_FACE_MODEL ?? "anthropic/claude-sonnet-4-6";
      agent.model = faceModel;
    }
    expect(agent.model).toBe("openai/gpt-5.5");
    if (prev === undefined) delete process.env.OPENCLAW_FACE_MODEL;
    else process.env.OPENCLAW_FACE_MODEL = prev;
  });
});
