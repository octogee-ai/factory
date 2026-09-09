import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOpenClawComputerBrowserConfig } from "../lib/openclaw-computer-browser.js";
import { gatewayAgentRoster } from "../lib/openclaw-config-builders.js";
import { applyPreBootPatches } from "../entrypoints/pre-boot-config.js";

const vmEnv = { GATEWAY_CLASS: "builder", GATEWAY_RUNTIME_KIND: "gce-vm", GATEWAY_BUILDER_SLUG: "owner" };
const template = (): Record<string, any> => JSON.parse(readFileSync(
  new URL("../../infra/gateway/openclaw.builder.template.json", import.meta.url), "utf8",
));

describe("computer browser runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("enables the built-in browser on the same attach-only desktop CDP profile", () => {
    const config = template();
    config.agents.list = [{ id: "octogee-owner-coach" }, { id: "octogee-owner-proj-site-coach" }];
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(true);
    expect(config.browser).toMatchObject({
      enabled: true, defaultProfile: "computer", headless: false, attachOnly: true,
      cdpUrl: "http://127.0.0.1:9222",
      profiles: { computer: { driver: "openclaw", cdpUrl: "http://127.0.0.1:9222", attachOnly: true } },
    });
    expect(config.plugins.entries.browser.enabled).toBe(true);
    expect(config.plugins.allow).toContain("browser");
    expect(config.gateway.nodes.browser).toEqual({ mode: "off" });
    expect(config.gateway.nodes.commands.allow).toContain("desktop.stream");
    expect(config.tools.alsoAllow).toEqual(expect.arrayContaining(["browser", "computer"]));
    expect(config.gateway.nodes.commands.deny).toEqual(expect.arrayContaining(["system.run", "terminal.upload", "browser.proxy"]));
    expect(config.gateway.nodes.commands.deny).not.toEqual(expect.arrayContaining(["computer.act", "screen.snapshot"]));
    expect(config.agents.list[0]).not.toHaveProperty("tools");
    expect(config.agents.list[1].tools.deny).toEqual(expect.arrayContaining(["browser", "computer"]));
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("extends the owner coach's own tool policy so the agent step keeps the desktop tools", () => {
    const config = {
      tools: { profile: "coding", alsoAllow: ["workspace_commit"] },
      agents: {
        entries: {
          "octogee-owner-coach": { tools: { profile: "coding", alsoAllow: ["workspace_commit"], deny: ["exec", "browser"] } },
          "octogee-owner-proj-site-coach": { tools: { profile: "minimal", alsoAllow: ["read"] } },
        },
      },
    };
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.agents.entries["octogee-owner-coach"].tools).toEqual({
      profile: "coding",
      alsoAllow: ["workspace_commit", "browser", "computer"],
      deny: ["exec"],
    });
    expect(config.agents.entries["octogee-owner-proj-site-coach"].tools).toEqual({
      profile: "minimal",
      alsoAllow: ["read"],
      deny: ["browser", "computer"],
    });
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("keeps the restored tool list and adds the desktop tools once", () => {
    const config = {
      tools: { profile: "coding", alsoAllow: ["workspace_commit", "computer"] },
      agents: { entries: { "octogee-owner-coach": {} } },
    };
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.tools.alsoAllow).toEqual(["workspace_commit", "computer", "browser"]);
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("restricts later provisioned project agents before they enter the live roster", () => {
    for (const [key, value] of Object.entries(vmEnv)) vi.stubEnv(key, value);
    const agents = [
      { id: "octogee-owner-coach" },
      { id: "octogee-owner-proj-site-coach" },
      { id: "another-agent", tools: { profile: "full" } },
    ];
    const before = structuredClone(agents);
    expect(gatewayAgentRoster(agents)).toEqual([
      { id: "octogee-owner-coach" },
      { id: "octogee-owner-proj-site-coach", tools: { deny: ["browser", "computer"] } },
      { id: "another-agent", tools: { profile: "full", deny: ["browser", "computer"] } },
    ]);
    expect(agents).toEqual(before);
  });

  it("applies the visible browser profile on the real pre-boot path", () => {
    const config = template();
    applyPreBootPatches(config, vmEnv);
    expect(config.browser.defaultProfile).toBe("computer");
    expect(config.plugins.entries.browser.enabled).toBe(true);
  });

  it("denies the desktop tools for every agent when the VM has no assigned owner", () => {
    const config = { agents: { entries: { "octogee-owner-coach": {} } } };
    applyOpenClawComputerBrowserConfig(config, { ...vmEnv, GATEWAY_BUILDER_SLUG: "" });
    expect(config.agents.entries["octogee-owner-coach"]).toEqual({ tools: { deny: ["browser", "computer"] } });
  });

  it.each([
    { GATEWAY_CLASS: "builder" },
    { GATEWAY_CLASS: "shared", GATEWAY_RUNTIME_KIND: "gce-vm" },
    { GATEWAY_CLASS: "builder", GATEWAY_RUNTIME_KIND: "k8s" },
  ])("leaves browser and tool permissions unchanged outside a Builder VM: %j", (env) => {
    const config = template();
    const before = structuredClone(config);
    expect(applyOpenClawComputerBrowserConfig(config, env)).toBe(false);
    expect(config).toEqual(before);
  });

  it("keeps custom browser profiles and explicit agent tool restrictions", () => {
    const config = template();
    config.browser.profiles = { custom: { cdpUrl: "http://127.0.0.1:9444", attachOnly: true } };
    config.tools.deny = ["browser"];
    config.agents.list = [{ id: "octogee-owner-proj-site-coach", tools: { deny: ["computer", "browser"] } }];
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.browser.profiles.custom).toEqual({ cdpUrl: "http://127.0.0.1:9444", attachOnly: true });
    expect(config.tools.deny).toEqual(["browser"]);
    expect(config.agents.list[0].tools.deny).toEqual(["computer", "browser"]);
  });

  it("rejects malformed owned config rather than silently replacing it", () => {
    expect(() => applyOpenClawComputerBrowserConfig({ browser: [] }, vmEnv)).toThrow("browser");
    expect(() => applyOpenClawComputerBrowserConfig({ plugins: { allow: "browser" } }, vmEnv)).toThrow("allow");
  });
});
