import { describe, it, expect } from "vitest";
import { applyPreBootPatches } from "../pre-boot-config.js";

function emptyConfig(): any {
  return {};
}

describe("applyPreBootPatches — tools.profile (new)", () => {
  it("sets tools.profile=coding on a config with no tools field", () => {
    const config = emptyConfig();
    const changed = applyPreBootPatches(config, {});
    expect(config.tools).toEqual({ profile: "coding" });
    expect(changed).toBe(true);
  });

  it("sets tools.profile=coding when tools exists but profile is missing", () => {
    const config: any = { tools: { something: "else" } };
    applyPreBootPatches(config, {});
    expect(config.tools.profile).toBe("coding");
    expect(config.tools.something).toBe("else");
  });

  it("reconciles a drifted profile back to coding (gateway policy wins)", () => {
    const config: any = { tools: { profile: "research" } };
    const changed = applyPreBootPatches(config, {});
    expect(config.tools.profile).toBe("coding");
    expect(changed).toBe(true);
  });

  it("is idempotent: a config already at coding reports no change", () => {
    const config: any = { tools: { profile: "coding" } };
    const changed = applyPreBootPatches(config, {});
    expect(changed).toBe(false);
    expect(config.tools.profile).toBe("coding");
  });
});

describe("applyPreBootPatches — MM commands.native", () => {
  it("forces commands.native=false at the channel level when missing", () => {
    const config: any = { channels: { mattermost: {} } };
    const changed = applyPreBootPatches(config, {});
    expect(config.channels.mattermost.commands.native).toBe(false);
    expect(changed).toBe(true);
  });

  it("forces commands.native=false at the channel level when set to true", () => {
    const config: any = {
      channels: { mattermost: { commands: { native: true } } },
    };
    applyPreBootPatches(config, {});
    expect(config.channels.mattermost.commands.native).toBe(false);
  });

  it("forces commands.native=false on every per-account entry", () => {
    const config: any = {
      channels: {
        mattermost: {
          accounts: {
            default: { commands: { native: true } },
            secondary: { commands: { native: "auto" } },
            tertiary: {},
          },
        },
      },
    };
    applyPreBootPatches(config, {});
    expect(config.channels.mattermost.accounts.default.commands.native).toBe(false);
    expect(config.channels.mattermost.accounts.secondary.commands.native).toBe(false);
    expect(config.channels.mattermost.accounts.tertiary.commands.native).toBe(false);
  });

  it("does no MM work when channels.mattermost is absent", () => {
    const config: any = {};
    applyPreBootPatches(config, {});
    expect(config.channels).toBeUndefined();
  });
});

describe("applyPreBootPatches — MM env sync", () => {
  it("syncs MM_BOT_TOKEN into accounts.default.botToken", () => {
    const config: any = { channels: { mattermost: { accounts: {} } } };
    applyPreBootPatches(config, { MM_BOT_TOKEN: "tok-from-env" });
    expect(config.channels.mattermost.accounts.default.botToken).toBe(
      "tok-from-env",
    );
  });

  it("creates accounts.default if missing", () => {
    const config: any = { channels: { mattermost: {} } };
    applyPreBootPatches(config, { MM_BOT_TOKEN: "tok" });
    expect(config.channels.mattermost.accounts.default.botToken).toBe("tok");
  });

  it("does not change botToken when MM_BOT_TOKEN env is unset", () => {
    const config: any = {
      channels: { mattermost: { accounts: { default: { botToken: "existing" } } } },
    };
    applyPreBootPatches(config, {});
    expect(config.channels.mattermost.accounts.default.botToken).toBe("existing");
  });

  it("does not flag changed when env token already matches on-disk value", () => {
    const config: any = {
      channels: {
        mattermost: { accounts: { default: { botToken: "same-tok" } } },
      },
    };
    config.tools = { profile: "coding" };
    config.channels.mattermost.commands = { native: false };
    config.channels.mattermost.accounts.default.commands = { native: false };
    config.channels.mattermost.baseUrl = "https://mm.example";
    const changed = applyPreBootPatches(config, {
      MM_BOT_TOKEN: "same-tok",
      MM_URL: "https://mm.example",
    });
    expect(changed).toBe(false);
  });

  it("syncs MM_URL into channels.mattermost.baseUrl", () => {
    const config: any = { channels: { mattermost: {} } };
    applyPreBootPatches(config, { MM_URL: "https://chat.example.com" });
    expect(config.channels.mattermost.baseUrl).toBe("https://chat.example.com");
  });
});

describe("applyPreBootPatches — octogee-router cleanup", () => {
  it("removes the router from plugins.allow + plugins.entries when OCTOGEE_ROUTER_ENABLED=false", () => {
    const config: any = {
      plugins: {
        allow: ["octogee-router", "other-plugin"],
        entries: { "octogee-router": { config: {} }, "other-plugin": {} },
      },
    };
    applyPreBootPatches(config, { OCTOGEE_ROUTER_ENABLED: "false" });
    expect(config.plugins.allow).toEqual(["other-plugin"]);
    expect(config.plugins.entries["octogee-router"]).toBeUndefined();
    expect(config.plugins.entries["other-plugin"]).toBeDefined();
  });

  it("strips the documented stale config keys when router is enabled", () => {
    const config: any = {
      plugins: {
        entries: {
          "octogee-router": {
            config: {
              advisorySlugs: ["x"],
              enforcementOverrides: {},
              brainGatedSlugs: [],
              faceModelOverrides: {},
              brainModelOverrides: {},
              keepThisOne: "yes",
            },
          },
        },
      },
    };
    applyPreBootPatches(config, {});
    const cfg = config.plugins.entries["octogee-router"].config;
    expect(cfg.advisorySlugs).toBeUndefined();
    expect(cfg.enforcementOverrides).toBeUndefined();
    expect(cfg.brainGatedSlugs).toBeUndefined();
    expect(cfg.faceModelOverrides).toBeUndefined();
    expect(cfg.brainModelOverrides).toBeUndefined();
    expect(cfg.keepThisOne).toBe("yes");
  });

  it("is a no-op when there is no octogee-router plugin entry", () => {
    const config: any = { plugins: { entries: {} } };
    applyPreBootPatches(config, {});
    expect(config.plugins.entries).toEqual({});
  });
});

describe("applyPreBootPatches — no-change reporting", () => {
  it("returns false when nothing in the config needs touching", () => {
    const config: any = {
      tools: { profile: "coding" },
      channels: {
        mattermost: {
          baseUrl: "https://mm.example",
          commands: { native: false },
          accounts: {
            default: {
              botToken: "tok",
              commands: { native: false },
            },
          },
        },
      },
      plugins: { entries: {} },
    };
    const changed = applyPreBootPatches(config, {
      MM_BOT_TOKEN: "tok",
      MM_URL: "https://mm.example",
    });
    expect(changed).toBe(false);
  });
});

