import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyAnthropicBaseUrlPatch,
  applyOpenClawBeta5CompatibilityPatch,
  applyGatewayRootConfig,
  applyPreBootPatches,
  applyGatewayOverrides,
  shouldMaterializeAnthropicBrokerProfiles,
  applyMattermostPreBootPatches,
  applyMemorySearchSchemaPatch,
  applySharedMattermostRoutingSafetyPatch,
  buildGitconfigContent,
  hydrateGitIdentity,
  pickSoleTenantSlug,
  preBootFirestoreEnabled,
  slugFromCoachAgentId,
  withTimeout,
  writeConfigAtomically,
} from "../entrypoints/pre-boot-config.js";

function emptyConfig(): any {
  return {};
}

describe("shared Mattermost routing safety", () => {
  it("creates the quarantine roster when a shared config has no explicit agents", () => {
    const config: any = {};

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn()),
    ).toBe(true);
    expect(config.agents.ownership).toBe("explicit");
    expect(config.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-unmatched-route" }),
    ]);
    expect(config.agents.list[0]).not.toHaveProperty("default");
  });

  it.each([
    ["unset", {}],
    ["empty", { GATEWAY_CLASS: "" }],
    ["a misspelling of shared", { GATEWAY_CLASS: "shraed" }],
    ["a retired operator class", { GATEWAY_CLASS: "operator" }],
  ])("quarantines unmatched routes when GATEWAY_CLASS is %s", (_label, env) => {
    const config: any = {};

    expect(applySharedMattermostRoutingSafetyPatch(config, env, vi.fn())).toBe(true);
    expect(config.agents.ownership).toBe("explicit");
    expect(config.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-unmatched-route" }),
    ]);
    expect(config.agents.list[0]).not.toHaveProperty("default");
  });

  it("leaves a Builder gateway pinned to its own coach", () => {
    const config: any = { agents: { list: [{ id: "octogee-ceckert-coach", default: true }] } };

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "builder" }, vi.fn()),
    ).toBe(false);
    expect(config.agents.list).toEqual([{ id: "octogee-ceckert-coach", default: true }]);
  });

  it("repairs an explicit keyed shared roster that still carries a legacy default marker", () => {
    const config: any = {
      agents: {
        ownership: "explicit",
        entries: {
          "octogee-unmatched-route": { default: true },
          "octogee-ceckert-test-coach": {},
        },
      },
    };

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn()),
    ).toBe(true);
    expect(config.agents).toEqual({
      ownership: "explicit",
      entries: expect.objectContaining({
        "octogee-unmatched-route": expect.not.objectContaining({ default: expect.anything() }),
        "octogee-ceckert-test-coach": {},
      }),
    });
  });

  it("installs an explicit quarantine roster and deterministic stable account routes", () => {
    const config: any = {
      agents: {
        list: [
          { id: "octogee-mike-coach", default: true },
          { id: "octogee-ceckert-coach" },
        ],
      },
      channels: {
        mattermost: {
          accounts: {
            "mike-coach": {},
            "ceckert-coach": {},
          },
        },
      },
      bindings: [
        {
          agentId: "octogee-mike-coach",
          match: {
            channel: "mattermost",
            accountId: "mike-coach",
            peer: { kind: "group", id: "mmmmmmmmmmmmmmmmmmmmmmmmmm" },
          },
        },
        {
          agentId: "octogee-ceckert-coach",
          match: {
            channel: "mattermost",
            accountId: "ceckert-coach",
            peer: { kind: "group", id: "cccccccccccccccccccccccccc" },
          },
        },
      ],
    };

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn()),
    ).toBe(true);
    expect(config.agents.ownership).toBe("explicit");
    expect(config.agents.list[0]).toMatchObject({
      id: "octogee-unmatched-route",
    });
    expect(config.agents.list[0]).not.toHaveProperty("default");
    expect(config.agents.list[1]).not.toHaveProperty("default");
    expect(config.bindings).toEqual(expect.arrayContaining([
      {
        agentId: "octogee-mike-coach",
        match: { channel: "mattermost", accountId: "mike-coach" },
      },
      {
        agentId: "octogee-ceckert-coach",
        match: { channel: "mattermost", accountId: "ceckert-coach" },
      },
    ]));
  });

  it("removes foreign peer routes without discarding the managed owner's routes", () => {
    const config: any = {
      agents: { list: [{ id: "octogee-mike-coach" }, { id: "octogee-jack-coach" }] },
      channels: { mattermost: { accounts: { "mike-coach": {} } } },
      bindings: [
        {
          agentId: "octogee-mike-coach",
          match: {
            channel: "mattermost",
            accountId: "mike-coach",
            peer: { kind: "group", id: "aaaaaaaaaaaaaaaaaaaaaaaaaa" },
          },
        },
        {
          agentId: "octogee-jack-coach",
          match: {
            channel: "mattermost",
            accountId: "mike-coach",
            peer: { kind: "group", id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" },
          },
        },
        {
          agentId: "octogee-mike-coach",
          match: { channel: "mattermost", accountId: "mike-coach" },
        },
      ],
    };
    const log = vi.fn();

    applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, log);

    expect(config.bindings).toContainEqual({
      agentId: "octogee-mike-coach",
      match: { channel: "mattermost", accountId: "mike-coach" },
    });
    expect(config.bindings).not.toContainEqual({
      agentId: "octogee-jack-coach",
      match: {
        channel: "mattermost",
        accountId: "mike-coach",
        peer: { kind: "group", id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" },
      },
    });
    expect(log).toHaveBeenCalledWith(
      "converged Mattermost account routes (stable=1, quarantined=0)",
    );
  });

  it("removes every account route when the deterministic managed agent is absent", () => {
    const config: any = {
      agents: { list: [{ id: "octogee-mike-coach", default: true }] },
      channels: { mattermost: { accounts: { "ceckert-coach": {} } } },
      bindings: [
        {
          agentId: "octogee-mike-coach",
          match: { channel: "mattermost", accountId: "ceckert-coach" },
        },
      ],
    };
    const log = vi.fn();

    applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, log);

    expect(config.bindings).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "refused account route without managed agent for ceckert-coach",
    );
  });

  it("never promotes a foreign peer into the deterministic account route", () => {
    const config: any = {
      agents: {
        list: [{ id: "octogee-mike-coach" }, { id: "octogee-ceckert-coach" }],
      },
      channels: { mattermost: { accounts: { "ceckert-coach": {} } } },
      bindings: [{
        agentId: "octogee-mike-coach",
        match: {
          channel: "mattermost",
          accountId: "ceckert-coach",
          peer: { kind: "group", id: "cccccccccccccccccccccccccc" },
        },
      }],
    };

    applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn());

    expect(config.bindings).toEqual([{
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost", accountId: "ceckert-coach" },
    }]);
  });

  it("converges stable routes from the beta keyed agent roster", () => {
    const config: any = {
      agents: {
        entries: {
          "octogee-ceckert-coach": { model: "platform/one" },
        },
      },
      channels: { mattermost: { accounts: { "ceckert-coach": {} } } },
      bindings: [],
    };

    applySharedMattermostRoutingSafetyPatch(
      config,
      { GATEWAY_CLASS: "shared" },
      vi.fn(),
    );

    expect(config.bindings).toEqual([{
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost", accountId: "ceckert-coach" },
    }]);
  });
});

describe("pre-boot config persistence", () => {
  it("atomically replaces the config without leaving a partial file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preboot-config-"));
    const configPath = path.join(dir, "openclaw.json");
    try {
      fs.writeFileSync(configPath, "{\"old\":true}\n");
      writeConfigAtomically(configPath, { safe: true });

      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ safe: true });
      expect(fs.readdirSync(dir)).toEqual(["openclaw.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyPreBootPatches — platform model catalog", () => {
  it("allowlists every broker-backed platform model for a Builder gateway", () => {
    const config: any = { agents: { defaults: { models: {} } } };

    const changed = applyPreBootPatches(config, {
      GATEWAY_CLASS: "builder",
      OPENROUTER_BASE_URL: "http://llm-broker/v1",
      PLATFORM_OPENAI_BASE_URL: "http://llm-broker/v1",
    });

    expect(changed).toBe(true);
    expect(config.agents.defaults.models).toMatchObject({
      "anthropic/claude-sonnet-4-6": {},
      "anthropic/claude-haiku-4-5": {},
      "platform-openrouter/z-ai/glm-5.2": {},
      "platform-openrouter/minimax/minimax-m3": {},
      "platform-openrouter/deepseek/deepseek-v4-pro": {},
      "platform-openrouter/openai/gpt-5.6-luna": {},
      "platform-openai/gpt-5.4-mini": {},
    });
  });
});

describe("applyOpenClawBeta5CompatibilityPatch", () => {
  it("migrates the root-owned Node SecretRef command to the node-owned resolver executable", () => {
    const config: any = {
      meta: { lastTouchedVersion: "2026.4.14", lastTouchedAt: "2026-04-17T01:04:39.966Z" },
      commands: { native: "auto", ownerDisplay: "raw" },
      secrets: {
        providers: {
          "gcp-secret-manager": {
            source: "exec",
            command: "/usr/local/bin/node",
            args: ["/octogee/scripts/secret-resolver.mjs"],
            passEnv: ["HOME"],
            jsonOnly: true,
            timeoutMs: 5000,
            allowInsecurePath: true,
          },
        },
      },
    };

    expect(applyOpenClawBeta5CompatibilityPatch(config)).toBe(true);
    expect(config).toEqual({
      meta: { lastTouchedVersion: "2026.4.14" },
      commands: { native: "auto" },
      secrets: {
        providers: {
          "gcp-secret-manager": {
            source: "exec",
            command: "/octogee/scripts/secret-resolver.mjs",
            passEnv: ["HOME"],
            jsonOnly: true,
            timeoutMs: 5000,
          },
        },
      },
    });
  });
});

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
    applyPreBootPatches(config, {});
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
  it("does not manufacture a permanent default Mattermost account", () => {
    const config: any = { channels: { mattermost: { accounts: {} } } };
    applyPreBootPatches(config, { MM_BOT_TOKEN: "legacy-token-must-not-be-used" });
    expect(config.channels.mattermost.accounts).toEqual({});
  });

  it("restores the durable MM_URL placeholder instead of materializing the runtime URL", () => {
    const config: any = {
      channels: { mattermost: { baseUrl: "https://legacy-chat.example.com" } },
    };

    const changed = applyMattermostPreBootPatches(
      config,
      { MM_URL: "https://chat.example.com" },
      vi.fn(),
    );

    expect(changed).toBe(true);
    expect(config.channels.mattermost.baseUrl).toBe("${MM_URL}");
  });
});

describe("applyPreBootPatches — conversation experiment", () => {
  it("enables durable Mattermost run threads in the standard broad mode", () => {
    const config: any = { channels: { mattermost: {} } };

    applyPreBootPatches(config, {
      OCTOGEE_ACTIVITY_BRIDGE_MODE: "broad",
    });

    expect(config.channels.mattermost).toMatchObject({
      replyToMode: "all",
      replyToModeByChatType: { direct: "all" },
      threadSessionScope: "channel",
    });
  });

  it("creates the Mattermost root settings before the fleet mounts a coach account", () => {
    const config: any = { channels: { mattermost: {} } };

    applyPreBootPatches(config, {
      OCTOGEE_ACTIVITY_BRIDGE_MODE: "publisher-live",
    });

    expect(config.channels.mattermost).toMatchObject({
      replyToMode: "all",
      replyToModeByChatType: { direct: "all" },
      threadSessionScope: "channel",
    });
  });

  it("migrates direct threading without replacing other chat-type reply modes", () => {
    const config: any = {
      channels: {
        mattermost: {
          threadDirectMessages: true,
          replyToModeByChatType: { direct: "off", group: "first" },
        },
      },
    };

    applyPreBootPatches(config, {
      OCTOGEE_ACTIVITY_BRIDGE_MODE: "broad",
    });

    expect(config.channels.mattermost.replyToModeByChatType).toEqual({
      direct: "all",
      group: "first",
    });
    expect(config.channels.mattermost).not.toHaveProperty("threadDirectMessages");
  });

  it("keeps Mattermost delivery native while enabling the external publisher", () => {
    const config: any = {
      channels: {
        mattermost: {
          agentActivity: true,
          accounts: {
            default: {
              agentActivity: true,
              replyToMode: "all",
              replyToModeByChatType: { direct: "all" },
              threadDirectMessages: true,
              threadSessionScope: "channel",
            },
            "chris-coach": {},
          },
        },
      },
    };

    applyPreBootPatches(config, {
      OCTOGEE_ACTIVITY_BRIDGE_MODE: "publisher-live",
    });

    expect(config.channels.mattermost).toMatchObject({
      replyToMode: "all",
      replyToModeByChatType: { direct: "all" },
      threadSessionScope: "channel",
    });
    expect(config.channels.mattermost).not.toHaveProperty("agentActivity");
    expect(config.channels.mattermost).not.toHaveProperty("threadDirectMessages");
    expect(config.channels.mattermost.accounts.default).not.toHaveProperty("agentActivity");
    expect(config.channels.mattermost.accounts.default).not.toHaveProperty("replyToMode");
    expect(config.channels.mattermost.accounts.default).not.toHaveProperty("threadDirectMessages");
    expect(config.channels.mattermost.accounts.default).not.toHaveProperty("threadSessionScope");
  });
});

describe("applyPreBootPatches — Anthropic broker base URL", () => {
  it("syncs ANTHROPIC_BASE_URL into the Anthropic model provider config", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
    };

    const changed = applyPreBootPatches(config, {
      ANTHROPIC_BASE_URL: "http://llm-broker.octogee-test.svc.cluster.local:3010",
    });

    expect(changed).toBe(true);
    expect(config.auth.profiles["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(config.auth.profiles["anthropic:default"].baseUrl).toBeUndefined();
    expect(config.models.providers.anthropic.baseUrl).toBe(
      "http://llm-broker.octogee-test.svc.cluster.local:3010",
    );
  });

  it("syncs ANTHROPIC_BASE_URL even when no Firebase credential is present", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
    };

    expect(preBootFirestoreEnabled({}, () => false)).toBe(false);

    const changed = applyPreBootPatches(config, {
      ANTHROPIC_BASE_URL: "http://llm-broker.octogee-test.svc.cluster.local:3010",
    });

    expect(changed).toBe(true);
    expect(config.models.providers.anthropic.baseUrl).toBe(
      "http://llm-broker.octogee-test.svc.cluster.local:3010",
    );
  });

  it("removes stale auth-profile baseUrl because OpenClaw validates provider URLs under models.providers", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
            baseUrl: "https://api.anthropic.com",
          },
        },
      },
    };

    const changed = applyPreBootPatches(config, {
      ANTHROPIC_BASE_URL: "http://llm-broker.octogee-test.svc.cluster.local:3010",
    });

    expect(changed).toBe(true);
    expect(config.auth.profiles["anthropic:default"].baseUrl).toBeUndefined();
    expect(config.models.providers.anthropic.baseUrl).toBe(
      "http://llm-broker.octogee-test.svc.cluster.local:3010",
    );
  });

  it("does not add Anthropic baseUrl when the broker env is absent", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
    };

    applyPreBootPatches(config, {});

    expect(config.auth.profiles["anthropic:default"].baseUrl).toBeUndefined();
    expect(config.models?.providers?.anthropic?.baseUrl).toBeUndefined();
  });

  it("preserves an existing non-object Anthropic provider entry", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
      models: { providers: { anthropic: "legacy-provider-shape" } },
    };

    const changed = applyAnthropicBaseUrlPatch(config, {
      ANTHROPIC_BASE_URL: "http://llm-broker.octogee-test.svc.cluster.local:3010",
    }, () => {});

    expect(changed).toBe(false);
    expect(config.models.providers.anthropic).toBe("legacy-provider-shape");
  });
});

describe("applyPreBootPatches — memory search embeddings", () => {
  it("moves legacy memorySearch into memory.search for stable and keyed rosters", () => {
    const stableSearch = { provider: "stable" };
    const keyedSearch = { provider: "keyed" };
    const config: any = {
      agents: {
        list: [{
          id: "octogee-stable-coach",
          memory: { citations: "auto" },
          memorySearch: stableSearch,
        }],
        entries: {
          "octogee-keyed-coach": {
            memorySearch: keyedSearch,
          },
        },
      },
    };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);
    expect(config.agents.list[0]).toEqual({
      id: "octogee-stable-coach",
      memory: { citations: "auto", search: stableSearch },
    });
    expect(config.agents.entries["octogee-keyed-coach"]).toEqual({
      memory: { search: keyedSearch },
    });
    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(false);
  });

  it("keeps canonical memory.search on collisions and ignores malformed legacy fields", () => {
    const legacySecretRef = {
      source: "exec",
      provider: "gcp-secret-manager",
      id: "agent-embedding-token-openai-octogee-collision-coach",
    };
    const config: any = {
      agents: {
        list: [
          {
            id: "octogee-collision-coach",
            memory: {
              search: {
                provider: "canonical",
                remote: {
                  baseUrl: "https://canonical.example/v1",
                  headers: { canonical: "yes" },
                },
              },
              citations: "auto",
            },
            memorySearch: {
              provider: "legacy",
              model: "legacy-model",
              remote: {
                baseUrl: "https://legacy.example/v1",
                apiKey: legacySecretRef,
                headers: { canonical: "no", legacy: "yes" },
              },
            },
          },
          {
            id: "octogee-malformed-legacy-coach",
            memorySearch: "legacy-string",
          },
          {
            id: "octogee-malformed-memory-coach",
            memory: "legacy-string",
            memorySearch: { provider: "legacy" },
          },
          null,
        ],
        entries: {
          malformed: "legacy-entry",
        },
      },
    };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);
    expect(config.agents.list[0]).toEqual({
      id: "octogee-collision-coach",
      memory: {
        search: {
          provider: "canonical",
          model: "legacy-model",
          remote: {
            baseUrl: "https://canonical.example/v1",
            apiKey: legacySecretRef,
            headers: { canonical: "yes", legacy: "yes" },
          },
        },
        citations: "auto",
      },
    });
    expect(config.agents.list[1].memorySearch).toBe("legacy-string");
    expect(config.agents.list[2]).toEqual({
      id: "octogee-malformed-memory-coach",
      memory: "legacy-string",
      memorySearch: { provider: "legacy" },
    });
    expect(config.agents.list[3]).toBeNull();
    expect(config.agents.entries.malformed).toBe("legacy-entry");
  });

  it("replaces malformed canonical memory.search with a clone of valid legacy config", () => {
    const legacySearch = {
      provider: "openai-compatible",
      remote: {
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-malformed-coach",
        },
      },
    };
    const config: any = {
      agents: {
        entries: {
          "octogee-malformed-coach": {
            memory: { search: "malformed", citations: "auto" },
            memorySearch: legacySearch,
          },
        },
      },
    };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);
    const entry = config.agents.entries["octogee-malformed-coach"];
    expect(entry).toEqual({
      memory: { search: legacySearch, citations: "auto" },
    });
    expect(entry.memory.search).not.toBe(legacySearch);
    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["malformed", "malformed"],
  ])("recursively removes hostile keys when canonical memory.search is %s", (_label, search) => {
    const legacySearch = JSON.parse(`{
      "provider": "openai-compatible",
      "__proto__": { "polluted": "root" },
      "remote": {
        "apiKey": {
          "source": "exec",
          "provider": "gcp-secret-manager",
          "id": "agent-embedding-token-openai-octogee-hostile-coach"
        },
        "constructor": { "polluted": "nested" },
        "headers": {
          "safe": "yes",
          "prototype": { "polluted": "deep" }
        }
      },
      "sources": [{ "safe": true, "__proto__": { "polluted": "array" } }]
    }`);
    const entry: any = {
      ...(search === undefined ? {} : { memory: { search } }),
      memorySearch: legacySearch,
    };
    const config: any = { agents: { entries: { "octogee-hostile-coach": entry } } };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);

    const migrated = entry.memory.search;
    expect(migrated).not.toBe(legacySearch);
    expect(migrated.remote.apiKey.id).toBe(
      "agent-embedding-token-openai-octogee-hostile-coach",
    );
    expect(migrated.remote.headers.safe).toBe("yes");
    expect(migrated.sources[0].safe).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(migrated, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(migrated.remote, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(migrated.remote.headers, "prototype")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(migrated.sources[0], "__proto__")).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("does not add memory search SecretRefs unless embeddings are enabled", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: { list: [{ id: "octogee-tester20-coach", name: "Gene" }] },
    };

    applyPreBootPatches(config, {});

    const coach = config.agents.list.find(
      (agent: any) => agent.id === "octogee-tester20-coach",
    );
    expect(coach.memorySearch).toBeUndefined();
    expect(coach.memory).toBeUndefined();
  });

  it("configures a keyed coach entry without reviving legacy memorySearch", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: {
        entries: {
          "octogee-keyed-coach": { name: "Keyed" },
        },
      },
    };

    expect(applyPreBootPatches(config, {
      GATEWAY_CLASS: "builder",
      OPENAI_EMBEDDINGS_ENABLED: "true",
    })).toBe(true);
    expect(config.agents.entries["octogee-keyed-coach"].memory.search).toMatchObject({
      provider: "openai-compatible",
      model: "text-embedding-3-small",
    });
    expect(config.agents.entries["octogee-keyed-coach"].memorySearch).toBeUndefined();
  });

  it("configures coach agents with a platform OpenAI-compatible embedding SecretRef", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: {
        list: [
          { id: "octogee-tester20-coach", name: "Gene" },
          { id: "utility-agent", name: "Utility" },
          {
            id: "octogee-custom-coach",
            memorySearch: { enabled: false },
          },
        ],
      },
    };

    const changed = applyPreBootPatches(config, {
      GATEWAY_CLASS: "builder",
      OPENAI_EMBEDDINGS_ENABLED: "true",
    });

    expect(changed).toBe(true);
    expect(config.agents.list[0].memory.search).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "http://llm-broker:3010/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-tester20-coach",
        },
      },
      model: "text-embedding-3-small",
    });
    expect(config.agents.list[1].memorySearch).toBeUndefined();
    expect(config.agents.list[2]).toMatchObject({ memory: { search: { enabled: false } } });
    expect(config.agents.list[2].memorySearch).toBeUndefined();
  });

  it("uses operator-selected embedding endpoint and model when provided", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: { list: [{ id: "octogee-tester20-coach" }] },
    };

    applyPreBootPatches(config, {
      GATEWAY_CLASS: "builder",
      OPENAI_EMBEDDINGS_ENABLED: "true",
      PLATFORM_OPENAI_BASE_URL: "https://llm-broker.internal.example/v1/",
      OPENAI_EMBEDDINGS_MODEL: "custom-embed-v1",
    });

    expect(config.agents.list[0].memory.search.remote.baseUrl).toBe(
      "https://llm-broker.internal.example/v1",
    );
    expect(config.agents.list[0].memory.search.model).toBe("custom-embed-v1");
  });
});

describe("applyMattermostPreBootPatches — non-object preservation", () => {
  it("does not replace existing non-object account or commands values", () => {
    const config: any = {
      channels: {
        mattermost: {
          replyToMode: "all",
          replyToModeByChatType: { direct: "all" },
          threadSessionScope: "channel",
          baseUrl: "${MM_URL}",
          commands: "legacy-commands",
          accounts: {
            default: "legacy-default",
            coach: { commands: "legacy-account-commands" },
          },
        },
      },
    };

    const changed = applyMattermostPreBootPatches(config, {
      MM_URL: "https://mm.example",
    }, () => {});

    expect(changed).toBe(false);
    expect(config.channels.mattermost.commands).toBe("legacy-commands");
    expect(config.channels.mattermost.accounts.default).toBe("legacy-default");
    expect(config.channels.mattermost.accounts.coach.commands).toBe("legacy-account-commands");
  });
});

describe("preBootFirestoreEnabled", () => {
  it("stays off for db-less gateways without an explicit credential file", () => {
    expect(preBootFirestoreEnabled({}, () => false)).toBe(false);
  });

  it("turns on when SA_KEY_PATH points at an existing credential file", () => {
    expect(
      preBootFirestoreEnabled(
        { SA_KEY_PATH: "/var/secrets/firebase.json" },
        (p) => p === "/var/secrets/firebase.json",
      ),
    ).toBe(true);
  });

  it("honors explicit operator overrides", () => {
    expect(preBootFirestoreEnabled({ OCTOGEE_PREBOOT_FIRESTORE: "true" }, () => false)).toBe(true);
    expect(preBootFirestoreEnabled({ OCTOGEE_PREBOOT_FIRESTORE: "false" }, () => true)).toBe(false);
  });
});

describe("applyGatewayRootConfig", () => {
  it("applies only durable root overrides and refuses a revision id as a config selector", async () => {
    const config: any = {};
    const readAuthorization = vi.fn(async () => ({
      config: { openclawOverrides: { session: { dmScope: "per-channel-peer" } } },
    }));

    await expect(
      applyGatewayRootConfig(config, {
        gatewayId: "default",
        readAuthorization,
      }),
    ).resolves.toBe(true);
    expect(config.session).toEqual({ dmScope: "per-channel-peer" });
    expect(readAuthorization).toHaveBeenCalledWith("default");

    const revisionRead = vi.fn(async () => ({
      config: { openclawOverrides: { session: { dmScope: "wrong" } } },
    }));
    await expect(
      applyGatewayRootConfig({}, {
        gatewayId: "default-r7",
        readAuthorization: revisionRead,
      }),
    ).resolves.toBe(false);
    expect(revisionRead).not.toHaveBeenCalled();
  });
});

describe("shouldMaterializeAnthropicBrokerProfiles", () => {
  it.each(["shared", "builder"])(
    "materializes per-agent broker-token profiles for %s gateways",
    (gatewayClass) => {
      expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_CLASS: gatewayClass })).toBe(true);
    },
  );

  it("rejects the retired operator class and profile", () => {
    expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_CLASS: "operator" })).toBe(false);
    expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_PROFILE: "operator" })).toBe(false);
  });

  it("skips unknown classes", () => {
    expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_CLASS: "preview" })).toBe(false);
  });
});

describe("applyPreBootPatches — plugin config", () => {
  it("does not mutate plugin allowlists through retired router env switches", () => {
    const config: any = {
      plugins: {
        allow: ["codex", "other-plugin"],
        entries: { codex: { enabled: false }, "other-plugin": {} },
      },
    };
    applyPreBootPatches(config, { OCTOGEE_UNKNOWN_PLUGIN_FLAG: "false" });
    expect(config.plugins.allow).toEqual(["codex", "other-plugin"]);
    expect(config.plugins.entries.codex).toEqual({ enabled: false });
    expect(config.plugins.entries["other-plugin"]).toBeDefined();
  });

  it("is a no-op when there are no plugin entries", () => {
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
          replyToMode: "all",
          replyToModeByChatType: { direct: "all" },
          threadSessionScope: "channel",
          baseUrl: "${MM_URL}",
          commands: { native: false },
          accounts: {
            "ceckert-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/ceckert-coach" },
              commands: { native: false },
            },
          },
        },
      },
      plugins: { entries: {} },
    };
    const changed = applyPreBootPatches(config, {
      GATEWAY_CLASS: "builder",
      MM_URL: "https://mm.example",
    });
    expect(changed).toBe(false);
  });
});

describe("applyGatewayOverrides — deep merge", () => {
  it("deep-merges nested objects without clobbering sibling keys", () => {
    const config: any = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      plugins: { entries: { mattermost: { enabled: true } } },
    };
    const changed = applyGatewayOverrides(config, {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      plugins: { entries: { "openai-responses": { enabled: true } } },
    });
    expect(changed).toBe(true);
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-5.5");
    expect(config.plugins.entries.mattermost).toEqual({ enabled: true });
    expect(config.plugins.entries["openai-responses"]).toEqual({ enabled: true });
  });

  it("replaces arrays wholesale (array-replace, not concat)", () => {
    const config: any = { plugins: { allow: ["mattermost", "octogee-router"] } };
    applyGatewayOverrides(config, { plugins: { allow: ["mattermost", "openai-responses"] } });
    expect(config.plugins.allow).toEqual(["mattermost", "openai-responses"]);
  });

  it("overrides scalars and creates absent paths", () => {
    const config: any = { gateway: { port: 18789 } };
    applyGatewayOverrides(config, { gateway: { mode: "local" }, session: { dmScope: "per-channel-peer" } });
    expect(config.gateway).toEqual({ port: 18789, mode: "local" });
    expect(config.session).toEqual({ dmScope: "per-channel-peer" });
  });

  it("is a no-op for undefined / null / empty overrides", () => {
    const base = { tools: { profile: "coding" } };
    for (const ov of [undefined, null, {}]) {
      const config: any = structuredClone(base);
      const changed = applyGatewayOverrides(config, ov as any);
      expect(changed).toBe(false);
      expect(config).toEqual(base);
    }
  });

  it("returns false when the override is identical to existing config", () => {
    const config: any = { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } };
    const changed = applyGatewayOverrides(config, {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    });
    expect(changed).toBe(false);
  });
});

describe("applyGatewayOverrides — secret safety (SecretRef-only)", () => {
  it("strips inline plaintext secrets from auth.profiles and logs loudly", () => {
    const logs: string[] = [];
    const config: any = {};
    applyGatewayOverrides(
      config,
      {
        auth: {
          profiles: {
            "openai:benderecho": { type: "api_key", apiKey: "sk-live-PLAINTEXT" },
          },
        },
      },
      (m) => logs.push(m),
    );
    expect(config.auth.profiles["openai:benderecho"].apiKey).toBeUndefined();
    expect(config.auth.profiles["openai:benderecho"].type).toBe("api_key");
    expect(logs.join("\n")).toMatch(/openai:benderecho/);
    expect(logs.join("\n")).toMatch(/apiKey/);
  });

  it("preserves SecretRef-shaped keyRef / tokenRef", () => {
    const config: any = {};
    applyGatewayOverrides(config, {
      auth: {
        profiles: {
          "openai:benderecho": {
            type: "api_key",
            keyRef: { source: "exec", provider: "gcp-secret-manager", id: "benderecho-openai-api-key/latest" },
          },
        },
      },
    });
    expect(config.auth.profiles["openai:benderecho"].keyRef).toEqual({
      source: "exec",
      provider: "gcp-secret-manager",
      id: "benderecho-openai-api-key/latest",
    });
  });

  it("strips a plaintext botToken from an override account entry", () => {
    const logs: string[] = [];
    const config: any = {};
    applyGatewayOverrides(
      config,
      { channels: { mattermost: { accounts: { default: { botToken: "xoxb-PLAINTEXT" } } } } },
      (m) => logs.push(m),
    );
    expect(config.channels?.mattermost?.accounts?.default?.botToken).toBeUndefined();
    expect(logs.join("\n")).toMatch(/botToken/);
  });
});

describe("applyGatewayOverrides + applyPreBootPatches — precedence (policy wins)", () => {
  it("pre-boot policy overrides anything the per-gateway override tried to set", () => {
    const config: any = {
      tools: { profile: "coding" },
      channels: { mattermost: { commands: { native: false }, accounts: {} } },
    };
    
    applyGatewayOverrides(config, {
      tools: { profile: "research" },
      channels: { mattermost: { commands: { native: true } } },
    });
    
    applyPreBootPatches(config, {});
    expect(config.tools.profile).toBe("coding");
    expect(config.channels.mattermost.commands.native).toBe(false);
  });
});

describe("applyGatewayOverrides — prototype pollution guard (Copilot #960)", () => {
  it("drops __proto__/constructor/prototype keys, never pollutes, keeps safe keys", () => {
    const logs: string[] = [];
    const config: any = {};
    const before = ({} as any).polluted;
    applyGatewayOverrides(
      config,
      JSON.parse(
        '{"__proto__":{"polluted":"yes"},"constructor":{"x":1},"prototype":{"y":2},"safe":1}',
      ),
      (m) => logs.push(m),
    );
    expect(({} as any).polluted).toBe(before);
    expect(Object.prototype.hasOwnProperty.call(config, "__proto__")).toBe(false);
    expect(config.constructor).toBe(Object);
    expect(config.safe).toBe(1);
    expect(logs.join("\n")).toMatch(/__proto__|prototype|constructor/);
  });

  it("guards nested prototype-pollution attempts", () => {
    const config: any = {};
    applyGatewayOverrides(
      config,
      JSON.parse('{"a":{"__proto__":{"polluted":"x"},"ok":1}}'),
    );
    expect(({} as any).polluted).toBeUndefined();
    expect(config.a).toEqual({ ok: 1 });
  });
});

describe("applyGatewayOverrides — SecretRef strictness (Copilot #960)", () => {
  it("treats a string keyRef/tokenRef as an inline secret (must be a SecretRef object)", () => {
    const logs: string[] = [];
    const config: any = {};
    applyGatewayOverrides(
      config,
      { auth: { profiles: { p: { keyRef: "sk-PLAINTEXT", tokenRef: "tok-PLAINTEXT" } } } },
      (m) => logs.push(m),
    );
    expect(config.auth?.profiles?.p?.keyRef).toBeUndefined();
    expect(config.auth?.profiles?.p?.tokenRef).toBeUndefined();
    expect(logs.join("\n")).toMatch(/keyRef/);
  });

  it("preserves an object keyRef (a valid SecretRef)", () => {
    const config: any = {};
    applyGatewayOverrides(config, {
      auth: {
        profiles: {
          p: { keyRef: { source: "exec", provider: "gcp-secret-manager", id: "x/latest" } },
        },
      },
    });
    expect(config.auth.profiles.p.keyRef).toEqual({
      source: "exec",
      provider: "gcp-secret-manager",
      id: "x/latest",
    });
  });
});

describe("withTimeout (Copilot #960 — Firestore read must not stall boot)", () => {
  it("passes through when the promise resolves before the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("rejects when the promise exceeds the timeout", async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r("late"), 100));
    await expect(withTimeout(slow, 10)).rejects.toThrow(/timeout/i);
  });
});

describe("slugFromCoachAgentId", () => {
  it("extracts the workspace slug from a canonical coach agent id", () => {
    expect(slugFromCoachAgentId("octogee-ceckert-coach")).toBe("ceckert");
  });

  it("returns null for non-coach agent ids (ops/tools/etc.)", () => {
    expect(slugFromCoachAgentId("octogee-ops-something")).toBeNull();
    expect(slugFromCoachAgentId("random")).toBeNull();
    expect(slugFromCoachAgentId("")).toBeNull();
  });

  it("preserves kebab-case slugs (the hyphen is part of the slug, not a delimiter)", () => {
    expect(slugFromCoachAgentId("octogee-my-builder-coach")).toBe("my-builder");
  });
});

describe("pickSoleTenantSlug", () => {
  it("returns the unique slug when one coach agent is present", () => {
    expect(pickSoleTenantSlug(["octogee-ceckert-coach"])).toBe("ceckert");
  });

  it("returns null when multiple distinct tenants are mounted (multi-tenant cattle)", () => {
    expect(pickSoleTenantSlug(["octogee-ceckert-coach", "octogee-bender-coach"]))
      .toBeNull();
  });

  it("returns null when no coach agents are present (fresh gateway, ops-only)", () => {
    expect(pickSoleTenantSlug([])).toBeNull();
    expect(pickSoleTenantSlug(["octogee-ops-tools"])).toBeNull();
  });

  it("treats duplicate ids for the same tenant as a single tenant", () => {
    expect(pickSoleTenantSlug(["octogee-ceckert-coach", "octogee-ceckert-coach"]))
      .toBe("ceckert");
  });
});

describe("buildGitconfigContent — first-boot seed shape", () => {
  it("emits [user] section with the given name and email", () => {
    const out = buildGitconfigContent({ name: "Chris Eckert", email: "c@e.com" });
    expect(out).toContain("[user]");
    expect(out).toMatch(/name = Chris Eckert/);
    expect(out).toMatch(/email = c@e\.com/);
  });

  it("emits [push] autoSetupRemote = true (the manual `git config` line we want to delete from the operator runbook)", () => {
    const out = buildGitconfigContent({ name: "X", email: "y@z.com" });
    expect(out).toMatch(/\[push\]\s*\n\s*autoSetupRemote = true/);
  });

  it("emits [init] defaultBranch = main", () => {
    const out = buildGitconfigContent({ name: "X", email: "y@z.com" });
    expect(out).toMatch(/\[init\]\s*\n\s*defaultBranch = main/);
  });

  it("includes a first-boot comment header so operators know editing it is safe", () => {
    const out = buildGitconfigContent({ name: "X", email: "Y" });
    expect(out).toMatch(/^#.*first-boot/im);
  });
});

describe("hydrateGitIdentity — always produces a working gitconfig, never blocks boot", () => {
  const baseDeps = (overrides: Record<string, unknown> = {}) => ({
    gitconfigPath: "/home/node/.gitconfig",
    agentIds: [] as readonly string[],
    fileExists: () => false,
    fetchUserBySlug: async () => null,
    writeFile: vi.fn(),
    logFn: vi.fn(),
    ...overrides,
  });

  it("writes Firebase Auth identity when single-tenant + displayName + email all present", async () => {
    const writeFile = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fetchUserBySlug: async () => ({ displayName: "Chris Eckert", email: "c@e.com" }),
      writeFile,
    }));
    expect(changed).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
    const [p, content] = writeFile.mock.calls[0];
    expect(p).toBe("/home/node/.gitconfig");
    expect(content).toMatch(/name = Chris Eckert/);
    expect(content).toMatch(/email = c@e\.com/);
  });

  it("falls back to slug-derived identity when Firestore returns nothing (smart default, no skip)", async () => {
    const writeFile = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fetchUserBySlug: async () => null,
      writeFile,
    }));
    expect(changed).toBe(true);
    const content = writeFile.mock.calls[0][1];
    expect(content).toMatch(/name = ceckert/);
    expect(content).toMatch(/email = ceckert@users\.noreply\.octogee\.com/);
  });

  it("falls back when Firestore returns a doc with NO displayName/email", async () => {
    const writeFile = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fetchUserBySlug: async () => ({}),
      writeFile,
    }));
    expect(changed).toBe(true);
    const content = writeFile.mock.calls[0][1];
    expect(content).toMatch(/name = ceckert/);
  });

  it("falls back when Firestore THROWS (transient outage must not block boot)", async () => {
    const writeFile = vi.fn();
    const logFn = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fetchUserBySlug: async () => { throw new Error("firestore unreachable"); },
      writeFile,
      logFn,
    }));
    expect(changed).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(logFn.mock.calls.flat().join(" ")).toMatch(/firestore.*unreachable/i);
  });

  it("writes generic identity for multi-tenant cattle (git still works; per-agent isolation is Phase 2)", async () => {
    const writeFile = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach", "octogee-bender-coach"],
      writeFile,
    }));
    expect(changed).toBe(true);
    const content = writeFile.mock.calls[0][1];
    expect(content).toMatch(/name = Octogee Builder/);
    expect(content).toMatch(/email = .*@users\.noreply\.octogee\.com/);
  });

  it("writes generic identity for fresh gateway with no agents mounted yet", async () => {
    const writeFile = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: [],
      writeFile,
    }));
    expect(changed).toBe(true);
    expect(writeFile.mock.calls[0][1]).toMatch(/Octogee Builder/);
  });

  it("idempotent: existing ~/.gitconfig is preserved (operator customizations win)", async () => {
    const writeFile = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fileExists: () => true,
      fetchUserBySlug: async () => ({ displayName: "Chris", email: "c@e.com" }),
      writeFile,
    }));
    expect(changed).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("never throws even when writeFile itself fails (disk full / readonly fs)", async () => {
    const writeFile = vi.fn(() => { throw new Error("ENOSPC: disk full"); });
    const logFn = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: [],
      writeFile,
      logFn,
    }));
    expect(changed).toBe(false);
    expect(logFn.mock.calls.flat().join(" ")).toMatch(/disk full/i);
  });

it("never throws when fileExists itself throws (treats failure as absent + proceeds)", async () => {
    const writeFile = vi.fn();
    const logFn = vi.fn();
    const changed = await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fileExists: () => { throw new Error("EACCES: permission denied"); },
      fetchUserBySlug: async () => ({ displayName: "Chris", email: "c@e.com" }),
      writeFile,
      logFn,
    }));
    expect(changed).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(logFn.mock.calls.flat().join(" ")).toMatch(/fileExists.*threw/i);
  });

it("sanitizes newlines in displayName (prevents gitconfig section injection)", async () => {
    const writeFile = vi.fn();
    await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fetchUserBySlug: async () => ({
        displayName: "Chris\n[user]\n\temail = evil@attacker.com",
        email: "c@e.com",
      }),
      writeFile,
    }));
    const content = writeFile.mock.calls[0][1] as string;
    
    expect(content.match(/^\[user\]$/gm)?.length).toBe(1);

const emailLines = content
      .split("\n")
      .filter((l) => /^\s*email\s*=/.test(l));
    expect(emailLines.length).toBe(1);
    expect(emailLines[0]).toContain("c@e.com");
    expect(emailLines[0]).not.toContain("attacker.com");
  });

  it("sanitizes CR / NUL / tab in email (other C0 control chars)", async () => {
    const writeFile = vi.fn();
    await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fetchUserBySlug: async () => ({
        displayName: "Chris",
        email: "c@e\r.com\t\0",
      }),
      writeFile,
    }));
    const content = writeFile.mock.calls[0][1] as string;
    const emailLine = content
      .split("\n")
      .find((l) => l.trim().startsWith("email ="));
    expect(emailLine).toBeDefined();
    expect(emailLine).toMatch(/email = c@e\.com$/);
  });

  it("falls back to fallback when displayName is entirely whitespace + control chars (cleaning empties it)", async () => {
    const writeFile = vi.fn();
    await hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fetchUserBySlug: async () => ({
        displayName: "\n\r\t   ",
        email: "c@e.com",
      }),
      writeFile,
    }));
    const content = writeFile.mock.calls[0][1] as string;
    
    expect(content).toMatch(/name = ceckert/);
    expect(content).toMatch(/email = c@e\.com/);
  });
});
