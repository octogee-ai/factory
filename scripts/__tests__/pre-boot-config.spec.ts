/**
 * Pre-boot config patching — pure function tests.
 *
 * Pinning the contract for `applyPreBootPatches(config, env)`:
 *   - Sets `tools.profile = "coding"` (gateway-wide policy that matches a
 *     fresh `openclaw` install). Reconciled on every boot.
 *   - Reconciles MM bot token + baseUrl from env into
 *     `channels.mattermost.accounts.default.*` and
 *     `channels.mattermost.baseUrl`.
 *   - Forces `channels.mattermost.commands.native = false` at the channel
 *     level AND on every per-account entry (regression: MM slash-command
 *     storm on reconnect).
 *   - Strips stale octogee-router plugin keys; removes the plugin entirely
 *     when `OCTOGEE_ROUTER_ENABLED === "false"`.
 *   - Returns `true` iff the config was mutated, so the caller can decide
 *     whether to atomic-write.
 *   - Pure: no I/O, no `process.env` reads — env is a parameter.
 */
import { describe, it, expect } from "vitest";
import { applyPreBootPatches } from "../pre-boot-config.js";

function emptyConfig(): any {
  return {};
}

// ── tools.profile = coding ───────────────────────────────────────────────────

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
    const config: any = {
      tools: { profile: "coding" },
      gateway: {
        controlPlane: { writeRateLimit: { maxRequests: 60, windowMs: 60_000 } },
      },
    };
    const changed = applyPreBootPatches(config, {});
    expect(changed).toBe(false);
    expect(config.tools.profile).toBe("coding");
  });
});

// ── MM commands.native = false ───────────────────────────────────────────────

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

// ── MM bot token + baseUrl sync from env ─────────────────────────────────────

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
    // Have to start with profile already coding + commands.native false +
    // url already matching to isolate the bot-token contribution to `changed`.
    config.tools = { profile: "coding" };
    config.channels.mattermost.commands = { native: false };
    config.channels.mattermost.accounts.default.commands = { native: false };
    config.channels.mattermost.baseUrl = "https://mm.example";
    config.gateway = {
      controlPlane: { writeRateLimit: { maxRequests: 60, windowMs: 60_000 } },
    };
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

// ── octogee-router stale-key cleanup ─────────────────────────────────────────

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

// ── No-change path ───────────────────────────────────────────────────────────

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
      gateway: {
        controlPlane: { writeRateLimit: { maxRequests: 60, windowMs: 60_000 } },
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

// ── gateway.controlPlane.writeRateLimit reconciliation ───────────────────────
// Restored on the 4.24 patch stack (PR #1 on ceckert/openclaw cherry-picks the
// fork patch onto octogee/gateway-scaling-patches-v2026.4.24). Same shape as
// the original block from before #725 / dd4163d4.

describe("applyPreBootPatches — control-plane writeRateLimit", () => {
  it("seeds maxRequests=60 and windowMs=60000 on a config with no gateway.controlPlane", () => {
    const config: any = {};
    const changed = applyPreBootPatches(config, {});
    expect(config.gateway.controlPlane.writeRateLimit).toEqual({
      maxRequests: 60,
      windowMs: 60_000,
    });
    expect(changed).toBe(true);
  });

  it("reconciles a drifted maxRequests back to 60", () => {
    const config: any = {
      gateway: {
        controlPlane: { writeRateLimit: { maxRequests: 3, windowMs: 60_000 } },
      },
    };
    applyPreBootPatches(config, {});
    expect(config.gateway.controlPlane.writeRateLimit.maxRequests).toBe(60);
  });

  it("reconciles a drifted windowMs back to 60000", () => {
    const config: any = {
      gateway: {
        controlPlane: { writeRateLimit: { maxRequests: 60, windowMs: 30_000 } },
      },
    };
    applyPreBootPatches(config, {});
    expect(config.gateway.controlPlane.writeRateLimit.windowMs).toBe(60_000);
  });

  it("does not clobber unrelated gateway.* keys", () => {
    const config: any = {
      gateway: {
        port: 18789,
        auth: { rateLimit: { maxAttempts: 10 } },
      },
    };
    applyPreBootPatches(config, {});
    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.auth.rateLimit.maxAttempts).toBe(10);
    expect(config.gateway.controlPlane.writeRateLimit).toEqual({
      maxRequests: 60,
      windowMs: 60_000,
    });
  });
});
