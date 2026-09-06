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
    expect(config.tools.alsoAllow).toContain("browser");
    expect(config.agents.list[0]).not.toHaveProperty("tools");
    expect(config.agents.list[1].tools.deny).toContain("browser");
    expect(applyOpenClawComputerBrowserConfig(config, vmEnv)).toBe(false);
  });

  it("enables the desktop tool when restoring a configuration with the reserved computer tool", () => {
    const config = {
      tools: { profile: "coding", alsoAllow: ["workspace_commit", "computer"] },
      agents: { entries: { "octogee-owner-coach": {} } },
    };
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.tools.alsoAllow).toContain("octogee_computer");
    expect(config.tools.alsoAllow).not.toContain("computer");
    expect(config.tools.alsoAllow).toContain("workspace_commit");
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
      { id: "octogee-owner-proj-site-coach", tools: { deny: ["browser"] } },
      { id: "another-agent", tools: { profile: "full", deny: ["browser"] } },
    ]);
    expect(agents).toEqual(before);
  });

  it("applies the visible browser profile on the real pre-boot path", () => {
    const config = template();
    applyPreBootPatches(config, vmEnv);
    expect(config.browser.defaultProfile).toBe("computer");
    expect(config.plugins.entries.browser.enabled).toBe(true);
  });

  it("denies the browser for every agent when the VM has no assigned owner", () => {
    const config = { agents: { entries: { "octogee-owner-coach": {} } } };
    applyOpenClawComputerBrowserConfig(config, { ...vmEnv, GATEWAY_BUILDER_SLUG: "" });
    expect(config.agents.entries["octogee-owner-coach"]).toEqual({ tools: { deny: ["browser"] } });
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
    config.agents.list = [{ id: "octogee-owner-proj-site-coach", tools: { deny: ["browser"] } }];
    applyOpenClawComputerBrowserConfig(config, vmEnv);
    expect(config.browser.profiles.custom).toEqual({ cdpUrl: "http://127.0.0.1:9444", attachOnly: true });
    expect(config.tools.deny).toEqual(["browser"]);
    expect(config.agents.list[0].tools.deny).toEqual(["browser"]);
  });

  it("rejects malformed owned config rather than silently replacing it", () => {
    expect(() => applyOpenClawComputerBrowserConfig({ browser: [] }, vmEnv)).toThrow("browser");
    expect(() => applyOpenClawComputerBrowserConfig({ plugins: { allow: "browser" } }, vmEnv)).toThrow("allow");
  });
});
