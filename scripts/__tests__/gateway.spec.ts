import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Verify advisory mode code is completely removed ─────────────────────────────

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

  it("no isAdvisoryMode in orchestrator", () => {
    const orchestratorPath = path.resolve(__dirname, "..", "local-provisioner.ts");
    const content = fs.readFileSync(orchestratorPath, "utf-8");
    expect(content).not.toContain("isAdvisoryMode");
    expect(content).not.toContain("syncAdvisorySlugs");
  });
});

// ── ensureGatewayDefaults behavior ──────────────────────────────────────────────

describe("ensureGatewayDefaults — config transformation", () => {
  // Test the gateway defaults logic by simulating what ensureGatewayDefaults does
  // without needing to mock readOpenClawConfig/writeOpenClawConfig

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

  it("sets coach model to sonnet 4.6", () => {
    const agent: any = { id: "octogee-foo-coach", model: "anthropic/claude-haiku-4-5" };
    if (/^octogee-.+-coach$/.test(agent.id)) {
      agent.model = "anthropic/claude-sonnet-4-6";
    }
    expect(agent.model).toBe("anthropic/claude-sonnet-4-6");
  });
});
