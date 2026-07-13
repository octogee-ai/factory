import { describe, it, expect, vi } from "vitest";
import {
  applyAnthropicBaseUrlPatch,
  applyGatewayRootConfig,
  applyPreBootPatches,
  applyGatewayOverrides,
  shouldMaterializeAnthropicBrokerProfiles,
  applyMattermostPreBootPatches,
  buildGitconfigContent,
  hydrateGitIdentity,
  pickSoleTenantSlug,
  preBootFirestoreEnabled,
  slugFromCoachAgentId,
  withTimeout,
} from "../entrypoints/pre-boot-config.js";

function emptyConfig(): any {
  return {};
}

const GLM_MODEL_REF = "platform-openrouter/z-ai/glm-5.2";
const MAC_MODEL_REF = "anthropic/claude-sonnet-4-6";

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

describe("applyPreBootPatches — Mac platform Anthropic pin", () => {
  it("repairs Mac from the customer OpenRouter default without changing the customer default", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: {
        defaults: {
          model: { primary: GLM_MODEL_REF },
          models: {
            [GLM_MODEL_REF]: { alias: "glm", params: { thinking: "xhigh" } },
          },
          subagents: { maxConcurrent: 8, model: GLM_MODEL_REF },
        },
        list: [
          {
            id: "octogee-ops-default",
            name: "Mac (default)",
            model: GLM_MODEL_REF,
          },
        ],
      },
    };

    const changed = applyPreBootPatches(config, { GATEWAY_CLASS: "shared" });

    expect(changed).toBe(true);
    expect(config.agents.defaults.model.primary).toBe(GLM_MODEL_REF);
    expect(config.agents.defaults.subagents.model).toBe(GLM_MODEL_REF);
    expect(config.agents.list[0].model).toBe(MAC_MODEL_REF);
    expect(config.auth.profiles["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(config.agents.defaults.models[MAC_MODEL_REF]).toEqual({
      alias: "sonnet",
      params: { cacheRetention: "short" },
    });
  });

  it("pins operator Mac subagents to Sonnet without changing the customer primary default", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: {
        defaults: {
          model: { primary: GLM_MODEL_REF },
          models: {},
          subagents: { maxConcurrent: 8, model: GLM_MODEL_REF },
        },
        list: [{ id: "${OPERATOR_AGENT_ID}", name: "Mac (${OPERATOR_AGENT_SLUG})" }],
      },
    };

    const changed = applyPreBootPatches(config, { GATEWAY_PROFILE: "operator" });

    expect(changed).toBe(true);
    expect(config.agents.defaults.model.primary).toBe(GLM_MODEL_REF);
    expect(config.agents.defaults.subagents.model).toBe(MAC_MODEL_REF);
    expect(config.agents.list[0].model).toBe(MAC_MODEL_REF);
  });

  it("does not claim the Anthropic profile was repaired when auth has an invalid shape", () => {
    const logs: string[] = [];
    const config: any = {
      auth: "legacy-invalid-auth",
      tools: { profile: "coding" },
      agents: {
        defaults: { models: {} },
        list: [{ id: "octogee-ops-default", model: GLM_MODEL_REF }],
      },
    };

    const changed = applyPreBootPatches(
      config,
      { GATEWAY_CLASS: "shared" },
      (msg) => logs.push(msg),
    );

    expect(changed).toBe(true);
    expect(config.auth).toBe("legacy-invalid-auth");
    expect(config.agents.list[0].model).toBe(MAC_MODEL_REF);
    expect(logs).toContain(
      "Mac pinned to anthropic/claude-sonnet-4-6 (auth profile not repaired: invalid auth/profiles shape)",
    );
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

describe("applyPreBootPatches — conversation experiment", () => {
  it("creates the Mattermost root settings before the fleet mounts a coach account", () => {
    const config: any = {};

    applyPreBootPatches(config, {
      OCTOGEE_ACTIVITY_BRIDGE_MODE: "publisher-live",
    });

    expect(config.channels.mattermost).toMatchObject({
      replyToMode: "all",
      threadDirectMessages: true,
      threadSessionScope: "channel",
    });
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
      threadDirectMessages: true,
      threadSessionScope: "channel",
    });
    expect(config.channels.mattermost).not.toHaveProperty("agentActivity");
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
  it("does not add memory search SecretRefs unless embeddings are enabled", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: { list: [{ id: "octogee-tester20-coach", name: "Gene" }] },
    };

    const changed = applyPreBootPatches(config, {});

    expect(changed).toBe(false);
    expect(config.agents.list[0].memorySearch).toBeUndefined();
  });

  it("configures coach agents with a platform OpenAI-compatible embedding SecretRef", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: {
        list: [
          { id: "octogee-tester20-coach", name: "Gene" },
          { id: "octogee-ops-default", name: "Mac" },
          {
            id: "octogee-custom-coach",
            memorySearch: { enabled: false },
          },
        ],
      },
    };

    const changed = applyPreBootPatches(config, { OPENAI_EMBEDDINGS_ENABLED: "true" });

    expect(changed).toBe(true);
    expect(config.agents.list[0].memorySearch).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "platform-openai-embedding-octogee-tester20-coach",
        },
      },
      model: "text-embedding-3-small",
    });
    expect(config.agents.list[1].memorySearch).toBeUndefined();
    expect(config.agents.list[2].memorySearch).toEqual({ enabled: false });
  });

  it("uses operator-selected embedding endpoint and model when provided", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: { list: [{ id: "octogee-tester20-coach" }] },
    };

    applyPreBootPatches(config, {
      OPENAI_EMBEDDINGS_ENABLED: "true",
      OPENAI_EMBEDDINGS_BASE_URL: "https://embeddings.internal.example/v1/",
      OPENAI_EMBEDDINGS_MODEL: "custom-embed-v1",
    });

    expect(config.agents.list[0].memorySearch.remote.baseUrl).toBe(
      "https://embeddings.internal.example/v1",
    );
    expect(config.agents.list[0].memorySearch.model).toBe("custom-embed-v1");
  });
});

describe("applyMattermostPreBootPatches — non-object preservation", () => {
  it("does not replace existing non-object account or commands values", () => {
    const config: any = {
      channels: {
        mattermost: {
          baseUrl: "https://mm.example",
          commands: "legacy-commands",
          accounts: {
            default: "legacy-default",
            coach: { commands: "legacy-account-commands" },
          },
        },
      },
    };

    const changed = applyMattermostPreBootPatches(config, {
      MM_BOT_TOKEN: "tok",
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
  it.each(["shared", "builder", "operator"])(
    "materializes per-agent broker-token profiles for %s gateways",
    (gatewayClass) => {
      expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_CLASS: gatewayClass })).toBe(true);
    },
  );

  it("falls back to operator profile when GATEWAY_CLASS is absent", () => {
    expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_PROFILE: "operator" })).toBe(true);
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
