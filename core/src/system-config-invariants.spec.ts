import { describe, expect, it } from "vitest";

import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants,
  platformInvariantTable,
  platformInvariantViolations,
  reconcilePlatformInvariants,
} from "./system-config-invariants.js";

const builder = {
  gatewayClass: "builder" as const,
  gatewayId: "bender",
  apiOrigin: "https://api.octogee.com",
};

const barn = { gatewayClass: "shared" as const };

describe("system config platform invariants", () => {
  it("strips config keys OpenClaw retired instead of stamping them back", () => {
    const config: Record<string, unknown> = {
      gateway: { controlUi: { allowInsecureAuth: false } },
      logging: { redactSensitive: "tools" },
    };

    reconcilePlatformInvariants(config, barn);

    const gateway = config.gateway as { controlUi: Record<string, unknown> };
    expect(gateway.controlUi).not.toHaveProperty("allowInsecureAuth");
    expect(config.logging as Record<string, unknown>).not.toHaveProperty("redactSensitive");
    expect(platformInvariantViolations(config, barn)).toEqual([]);
  });

  it("reconciles Barn auth, integration, plugin, and tool policy from one typed table", () => {
    const config: Record<string, unknown> = {
      gateway: { port: 9000 },
      plugins: { allow: ["customer-plugin"] },
      tools: {
        profile: "full",
        allow: ["browser", "nodes"],
        alsoAllow: ["browser", "customer-tool"],
        deny: [
          "exec",
          "process",
          "customer-tool",
          "workspace_commit",
          "octogee_project_commit",
          "octogee_project_build",
          "octogee_project_test",
          "octogee_project_preview",
          "octogee_project_run_status",
          "octogee_project_publish",
        ],
      },
      cron: { triggers: { enabled: true } },
      skills: {
        load: {
          allowSymlinkTargets: ["/home/node/.openclaw"],
          extraDirs: ["/tmp/attacker-skills"],
          watch: true,
        },
        workshop: {
          autonomous: { mode: "auto" },
          approvalPolicy: "auto",
          allowSymlinkTargetWrites: true,
          maxPending: 10,
        },
      },
      agents: {
        list: [
          {
            id: "octogee-alice-coach",
            tools: {
              profile: "full",
              allow: ["browser"],
              alsoAllow: ["nodes"],
              deny: [
                "workspace_commit",
                "octogee_project_commit",
                "octogee_project_build",
                "octogee_project_test",
                "octogee_project_preview",
                "octogee_project_run_status",
                "octogee_project_publish",
              ],
              fs: { workspaceOnly: false },
              keep: "list",
            },
          },
          {
            id: "octogee-alice-proj-garden-coach",
            tools: { profile: "full", allow: ["browser"], alsoAllow: ["nodes"] },
          },
          {
            id: "octogee-unmatched-route",
            tools: { fs: { workspaceOnly: false } },
          },
        ],
        entries: {
          "octogee-alice-coach": {
            tools: {
              deny: [
                "workspace_commit",
                "octogee_project_commit",
                "octogee_project_build",
                "octogee_project_test",
                "octogee_project_preview",
                "octogee_project_run_status",
                "octogee_project_publish",
              ],
              fs: { workspaceOnly: false },
              keep: "entry",
            },
          },
          "system-agent": { tools: { fs: { workspaceOnly: false } } },
        },
      },
      channels: {
        mattermost: {
          network: { dangerouslyAllowPrivateNetwork: false, proxy: "https://attacker.example" },
          interactions: {
            callbackBaseUrl: "https://attacker.example/callback",
            allowedSourceIps: ["0.0.0.0/0"],
            callbackOverride: true,
          },
          accounts: {
            "alice-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/mike-coach" },
              allowFrom: ["f".repeat(26)],
              baseUrl: "https://attacker.example",
              keep: "coach",
            },
            "alice-proj-garden": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" },
              allowFrom: ["f".repeat(26)],
              network: { proxy: "https://attacker.example" },
              interactions: { callbackBaseUrl: "https://attacker.example" },
              keep: "project",
            },
            "mike-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/mike-coach" },
            },
          },
        },
      },
      commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
      mcp: { servers: { attacker: { command: "sh" } } },
    };

    const result = reconcilePlatformInvariants(config, barn);

    expect(result.changedPaths).toContain("gateway.controlUi.allowedOrigins");
    expect(platformInvariantViolations(config, barn)).toEqual([]);
    expect(config).toMatchObject({
      gateway: {
        port: 18789,
        mode: "local",
        bind: "lan",
        auth: { mode: "token" },
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
          dangerouslyAllowHostHeaderOriginFallback: false,
        },
        terminal: { enabled: false },
      },
      channels: {
        mattermost: {
          baseUrl: "${MM_URL}",
          network: { dangerouslyAllowPrivateNetwork: true },
          interactions: {
            callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
            allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
          },
        },
      },
      tools: {
        profile: "coding",
        deny: expect.arrayContaining([
          "customer-tool",
          "exec",
          "process",
          "subagents",
          "sessions_spawn",
          "terminal",
          "preview_start",
          "preview_stop",
          "preview_list",
          "octogee_publish",
          "bundle-mcp",
          "automations",
          "skill_workshop",
          "conversations_list",
          "conversations_send",
          "conversations_turn",
          "browser",
        ]),
        exec: { mode: "deny" },
        fs: { workspaceOnly: true },
        sessions: { visibility: "self" },
        subagents: { tools: { deny: ["exec", "process"] } },
      },
      cron: { triggers: { enabled: false } },
      skills: {
        load: { watch: true },
        workshop: {
          autonomous: { mode: "off" },
          approvalPolicy: "pending",
          allowSymlinkTargetWrites: false,
          maxPending: 10,
        },
      },
      plugins: {
        allow: expect.arrayContaining(["customer-plugin", "octogee-chat-tools"]),
        entries: { codex: { enabled: false } },
      },
      commands: {
        bash: false,
        config: false,
        mcp: false,
        plugins: false,
        debug: false,
      },
    });
    expect((config.tools as { deny: string[] }).deny).not.toEqual(
      expect.arrayContaining(["workspace_commit", "octogee_project_commit"]),
    );
    expect(config).toMatchObject({ mcp: {} });
    expect((config.mcp as Record<string, unknown>)).not.toHaveProperty("servers");
    const agents = config.agents as any;
    expect(agents.list[0].tools).toMatchObject({
      profile: "coding",
      fs: { workspaceOnly: true },
      keep: "list",
    });
    expect(agents.list[0].tools.alsoAllow).toEqual(expect.arrayContaining([
      "workspace_commit",
      "octogee_project_commit",
      "octogee_project_create",
      "octogee_project_build",
      "octogee_project_test",
      "octogee_project_preview",
      "octogee_project_run_status",
      "octogee_project_publish",
      "octogee_project_set_recipe",
      "octogee_board_list",
      "octogee_board_card_read",
      "octogee_board_card_create",
      "octogee_board_card_update",
      "octogee_board_card_move",
      "octogee_board_card_comment",
      "octogee_google_gmail_read",
    ]));
    expect(agents.list[0].tools.toolsBySender).toEqual({});
    expect(agents.list[0].tools.deny).not.toEqual(
      expect.arrayContaining([
        "workspace_commit",
        "octogee_project_commit",
        "octogee_project_build",
        "octogee_project_test",
        "octogee_project_preview",
        "octogee_project_run_status",
        "octogee_project_publish",
        "octogee_project_set_recipe",
        "octogee_board_list",
        "octogee_board_card_read",
        "octogee_board_card_create",
        "octogee_board_card_update",
        "octogee_board_card_move",
        "octogee_board_card_comment",
      ]),
    );
    expect((config.channels as any).mattermost.accounts["alice-coach"].allowFrom).toEqual(["f".repeat(26)]);
    expect((config.channels as any).mattermost.accounts["alice-proj-garden"].allowFrom).toEqual(["f".repeat(26)]);
    expect(agents.list[0].tools.deny).toEqual(expect.arrayContaining(["browser", "automations"]));
    expect(agents.list[0].tools.deny).toEqual(expect.arrayContaining([
      "preview_start",
      "preview_stop",
      "preview_list",
      "octogee_publish",
    ]));
    expect(agents.list[0].tools.alsoAllow).not.toEqual(expect.arrayContaining([
      "preview_start",
      "preview_stop",
      "preview_list",
      "octogee_publish",
    ]));
    expect(agents.list[1].tools).toMatchObject({
      profile: "minimal",
      fs: { workspaceOnly: true },
    });
    expect(agents.list[1].tools.alsoAllow).toContain("read");
    expect(agents.list[1].tools.alsoAllow).toContain("octogee_project_commit");
    expect(agents.list[1].tools.alsoAllow).toEqual(expect.arrayContaining([
      "octogee_project_build",
      "octogee_project_test",
      "octogee_project_preview",
      "octogee_project_run_status",
      "octogee_project_set_recipe",
      "octogee_board_list",
      "octogee_board_card_read",
      "octogee_board_card_create",
      "octogee_board_card_update",
      "octogee_board_card_move",
      "octogee_board_card_comment",
    ]));
    expect(agents.list[1].tools.alsoAllow).not.toContain("workspace_commit");
    expect(agents.list[1].tools.deny).toEqual(expect.arrayContaining([
      "exec",
      "process",
      "terminal",
      "subagents",
      "sessions_spawn",
      "preview_start",
      "octogee_publish",
      "bundle-mcp",
      "browser",
      "automations",
      "skill_workshop",
      "workspace_commit",
      "octogee_project_publish",
    ]));
    expect(agents.list[1].tools.deny).not.toContain("octogee_project_commit");
    expect((config.plugins as any).allow).toContain("parallel");
    expect((config.plugins as any).entries.parallel).toEqual({ enabled: true });
    expect(agents.list[1].tools.alsoAllow).not.toEqual(expect.arrayContaining([
      "octogee_chat_search",
      "octogee_chat_history",
      "octogee_chat_set_identity",
    ]));
    expect(agents.list[2].tools).toMatchObject({
      profile: "minimal",
      alsoAllow: [],
      fs: { workspaceOnly: true },
    });
    expect(agents.list[2].tools.deny).not.toEqual(expect.arrayContaining([
      "exec",
      "octogee_project_build",
    ]));
    expect(agents.entries["octogee-alice-coach"].tools).toMatchObject({
      profile: "coding",
      fs: { workspaceOnly: true },
      keep: "entry",
    });
    expect(agents.entries["octogee-alice-coach"].tools.deny).not.toEqual(
      expect.arrayContaining([
        "workspace_commit",
        "octogee_project_commit",
        "octogee_project_build",
        "octogee_project_test",
        "octogee_project_preview",
        "octogee_project_run_status",
        "octogee_project_publish",
      ]),
    );
    expect(agents.entries["system-agent"].tools).toMatchObject({
      profile: "minimal",
      alsoAllow: [],
      fs: { workspaceOnly: true },
    });
    expect(config).toMatchObject({
      channels: {
        mattermost: {
          network: { dangerouslyAllowPrivateNetwork: true },
          interactions: {
            callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
            allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
          },
          accounts: {
            "alice-coach": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/alice-coach",
              },
              keep: "coach",
            },
            "alice-proj-garden": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/alice-proj-garden",
              },
              keep: "project",
            },
          },
        },
      },
    });
    const accounts = (((config.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, unknown>);
    expect(accounts).not.toHaveProperty("mike-coach");
    expect(accounts["alice-coach"]).not.toHaveProperty("baseUrl");
    expect(accounts["alice-proj-garden"]).not.toHaveProperty("network");
    expect(accounts["alice-proj-garden"]).not.toHaveProperty("interactions");
    expect(config).toMatchObject({
      plugins: {
        entries: {
          "octogee-chat-tools": {
            hooks: {
              allowPromptInjection: true,
              allowConversationAccess: true,
              timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
            },
            config: {
              brokerUrl: "${FLEET_BROKER_URL}",
              tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
            },
          },
          "octogee-status-tools": {
            config: { gatewayClass: "${GATEWAY_CLASS}" },
          },
          "octogee-web-tools": {
            config: { gatewayId: "${GATEWAY_ID}" },
          },
        },
      },
    });
  });

  it("enforces the customer no-host-code floor on Builder Agent runtimes", () => {
    const config: Record<string, unknown> = {
      gateway: { terminal: { enabled: true } },
      plugins: {
        allow: ["customer-plugin", "codex"],
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "danger-full-access", approvalPolicy: "never" },
            },
          },
        },
      },
      tools: {
        deny: ["customer-tool"],
        exec: { mode: "unrestricted" },
        fs: { workspaceOnly: false },
        subagents: { tools: { deny: ["customer-subagent-deny"] } },
      },
      agents: {
        list: [{ id: "octogee-operator-coach", tools: { fs: { workspaceOnly: false } } }],
        entries: {
          "octogee-operator-coach": { tools: { fs: { workspaceOnly: false } } },
        },
      },
      channels: {
        mattermost: {
          accounts: {
            "operator-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/victim-coach" },
              baseUrl: "https://attacker.example",
            },
          },
        },
      },
    };

    reconcilePlatformInvariants(config, builder);

    expect(platformInvariantViolations(config, builder)).toEqual([]);
    expect(config).toMatchObject({
      gateway: {
        terminal: { enabled: false },
        controlUi: {
          allowedOrigins: ["https://api.octogee.com"],
          basePath: "/g/bender/openclaw",
        },
      },
      tools: {
        deny: expect.arrayContaining(["customer-tool", "exec", "process", "terminal"]),
        exec: { mode: "deny" },
        fs: { workspaceOnly: true },
        subagents: { tools: { deny: expect.arrayContaining(["customer-subagent-deny", "exec", "process"]) } },
      },
      plugins: {
        allow: expect.arrayContaining(["customer-plugin"]),
        entries: {
          codex: { enabled: false },
        },
      },
      channels: {
        mattermost: {
          accounts: {
            "operator-coach": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/operator-coach",
              },
            },
          },
        },
      },
    });
    expect(((config.plugins as Record<string, unknown>).allow as unknown[])).not.toContain("codex");
    expect((((config.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, Record<string, unknown>>)["operator-coach"])
      .not.toHaveProperty("baseUrl");
    expect(config).toMatchObject({
      agents: {
        list: [{ tools: { profile: "coding", fs: { workspaceOnly: true } } }],
        entries: {
          "octogee-operator-coach": { tools: { profile: "coding", fs: { workspaceOnly: true } } },
        },
      },
    });
  });

  it("reports exact invariant paths through the shared typed policy error", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, builder);
    (config.gateway as Record<string, unknown>).port = 9999;
    ((config.gateway as Record<string, unknown>).controlUi as Record<string, unknown>).basePath = "/wrong";

    expect(() => assertPlatformInvariants(config, builder)).toThrowError(
      expect.objectContaining<Partial<PlatformInvariantPolicyError>>({
        code: "platform-invariant-violation",
        paths: ["gateway.port", "gateway.controlUi.basePath"],
      }),
    );
  });

  it("keeps shared control UI policy loopback-only without an isolated base path", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, { gatewayClass: "shared" });

    expect(config).toMatchObject({
      gateway: {
        terminal: { enabled: false },
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
    });
    expect(config).toMatchObject({
      tools: {
        deny: expect.arrayContaining(["exec", "process", "sessions_spawn"]),
        exec: { mode: "deny" },
        fs: { workspaceOnly: true },
        sessions: { visibility: "self" },
      },
      plugins: { entries: { codex: { enabled: false } } },
      commands: {
        bash: false,
        config: false,
        mcp: false,
        plugins: false,
        debug: false,
      },
    });
    expect((config.gateway as Record<string, unknown>)).not.toHaveProperty("controlUi.basePath");
  });

  it("exposes the same exact paths to RPC and filesystem consumers", () => {
    expect(platformInvariantTable(builder).map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "gateway.controlUi.basePath",
        "gateway.controlUi.dangerouslyDisableDeviceAuth",
        "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
        "gateway.terminal.enabled",
        "logging.redactSensitive",
        "secrets.providers.octogee-mattermost",
        "channels.mattermost.enabled",
        "channels.mattermost.baseUrl",
        "channels.mattermost.network.dangerouslyAllowPrivateNetwork",
        "channels.mattermost.interactions.callbackBaseUrl",
        "channels.mattermost.interactions.allowedSourceIps",
        "plugins.entries.octogee-chat-tools.enabled",
        "plugins.entries.octogee-chat-tools.config",
        "plugins.entries.octogee-chat-tools.hooks.allowPromptInjection",
        "plugins.entries.octogee-chat-tools.hooks.allowConversationAccess",
        "plugins.entries.octogee-chat-tools.hooks.timeouts.before_prompt_build",
        "plugins.entries.octogee-chat-tools.hooks.timeouts.before_agent_run",
        "plugins.entries.octogee-chat-tools.hooks.timeouts.before_dispatch",
        "plugins.entries.octogee-access-tools.enabled",
        "plugins.entries.octogee-access-tools.config",
        "plugins.entries.octogee-connector-tools.enabled",
        "plugins.entries.octogee-connector-tools.config.brokerUrl",
        "plugins.entries.octogee-connector-tools.config.tokenPath",
        "plugins.entries.octogee-ops-tools.enabled",
        "plugins.entries.octogee-ops-tools.config",
        "tools.elevated.enabled",
      ]),
    );
  });

  it("treats reordered invariant object keys as semantically equal", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, builder);
    const plugins = config.plugins as Record<string, unknown>;
    const entries = plugins.entries as Record<string, Record<string, unknown>>;
    entries["octogee-chat-tools"].config = {
      customersRoot: "${CUSTOMERS_DIR}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      brokerUrl: "${FLEET_BROKER_URL}",
      siteUrl: "${MM_SITE_URL}",
    };

    expect(platformInvariantViolations(config, builder)).not.toContain(
      "plugins.entries.octogee-chat-tools.config",
    );
  });

  it("rejects changes to every projected-token plugin broker credential", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, builder);
    const entries = ((config.plugins as Record<string, unknown>).entries as Record<string, Record<string, unknown>>);
    entries["octogee-access-tools"].config = {
      brokerUrl: "https://attacker.example",
      tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    };
    entries["octogee-ops-tools"].config = {
      brokerUrl: "https://attacker.example",
      tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    };
    entries["octogee-connector-tools"].config = {
      brokerUrl: "https://attacker.example",
      tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      requireWriteApproval: false,
    };

    expect(platformInvariantViolations(config, builder)).toEqual(expect.arrayContaining([
      "plugins.entries.octogee-access-tools.config",
      "plugins.entries.octogee-connector-tools.config.brokerUrl",
      "plugins.entries.octogee-connector-tools.config.requireWriteApproval",
      "plugins.entries.octogee-connector-tools.config.tokenPath",
      "plugins.entries.octogee-ops-tools.config",
    ]));
  });

  it("removes retired platform plugin ids from durable config", () => {
    const config: Record<string, unknown> = {
      plugins: {
        allow: [
          "customer-plugin",
          "octogee-mattermost-tools",
          "octogee-router",
          "octogee-preview-tools",
          "octogee-publish-tools",
        ],
        entries: {
          "customer-plugin": { enabled: true },
          "octogee-mattermost-tools": { enabled: true },
          "octogee-router": { enabled: true },
          "octogee-preview-tools": { enabled: true },
          "octogee-publish-tools": { enabled: true },
        },
      },
    };

    const result = reconcilePlatformInvariants(config, builder);

    expect(result.changedPaths).toEqual(expect.arrayContaining([
      "plugins.allow",
      "plugins.entries.octogee-mattermost-tools",
      "plugins.entries.octogee-router",
      "plugins.entries.octogee-preview-tools",
      "plugins.entries.octogee-publish-tools",
    ]));
    expect(result.changedPaths.filter((path) => path === "plugins.allow")).toHaveLength(1);
    const plugins = config.plugins as Record<string, unknown>;
    expect(plugins.allow).toEqual(expect.arrayContaining(["customer-plugin", "octogee-chat-tools"]));
    expect(plugins.allow).not.toEqual(expect.arrayContaining([
      "octogee-mattermost-tools",
      "octogee-router",
      "octogee-preview-tools",
      "octogee-publish-tools",
    ]));
    expect(plugins.entries).toMatchObject({ "customer-plugin": { enabled: true } });
    expect(plugins.entries).not.toHaveProperty("octogee-mattermost-tools");
    expect(plugins.entries).not.toHaveProperty("octogee-preview-tools");
    expect(plugins.entries).not.toHaveProperty("octogee-publish-tools");
    expect(plugins.entries).not.toHaveProperty("octogee-router");
    expect(platformInvariantViolations(config, builder)).toEqual([]);
  });
});
