import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { agentExists, writeOpenClawConfig } from "./config.js";

describe("active OpenClaw config path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses OPENCLAW_CONFIG_PATH for every core config consumer", async () => {
    vi.stubEnv("OPENCLAW_DIR", "/durable/.openclaw");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/durable/.openclaw/system_config/openclaw.json");
    vi.resetModules();

    const config = await import("./config.js");

    expect(config.OPENCLAW_DIR).toBe("/durable/.openclaw");
    expect(config.OPENCLAW_CONFIG).toBe(
      "/durable/.openclaw/system_config/openclaw.json",
    );
  });
});

describe("readOpenClawConfig / writeOpenClawConfig round-trip", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    configPath = path.join(tmpDir, "openclaw.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads back JSON correctly", () => {
    const config = {
      agents: { list: [{ id: "test-agent" }] },
      bindings: [],
    };
    writeOpenClawConfig(config, configPath);

const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(result.agents.list[0].id).toBe("test-agent");
    expect(result.bindings).toEqual([]);
  });

  it("preserves nested objects", () => {
    const config = {
      agents: {
        defaults: { maxConcurrent: 8 },
        list: [],
      },
      plugins: {
        entries: { codex: { enabled: false, config: { appServer: { sandbox: "workspace-write" } } } },
      },
    };
    writeOpenClawConfig(config, configPath);

    const result = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(result.agents.defaults.maxConcurrent).toBe(8);
    expect(result.plugins.entries.codex.config.appServer.sandbox).toBe("workspace-write");
  });
});

describe("agentExists", () => {
  it("returns true when agent is in the list", () => {
    const config = { agents: { list: [{ id: "octogee-test-coach" }] } };
    expect(agentExists(config, "octogee-test-coach")).toBe(true);
  });

  it("returns false when agent is not in the list", () => {
    const config = { agents: { list: [{ id: "octogee-other-coach" }] } };
    expect(agentExists(config, "octogee-test-coach")).toBe(false);
  });

  it("returns false when agents.list is empty", () => {
    const config = { agents: { list: [] } };
    expect(agentExists(config, "anything")).toBe(false);
  });

  it("returns false when agents is undefined", () => {
    const config = {};
    expect(agentExists(config, "anything")).toBe(false);
  });

  it("returns false when agents.list is undefined", () => {
    const config = { agents: {} };
    expect(agentExists(config, "anything")).toBe(false);
  });

  it("returns false when agents.list contains a non-object entry", () => {
    const config = { agents: { list: ["octogee-test-coach"] } };
    expect(agentExists(config, "octogee-test-coach")).toBe(false);
  });
});
