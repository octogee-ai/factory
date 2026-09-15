import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  platformInvariantViolations,
  reconcilePlatformInvariants,
} from "../../core/dist/system-config-invariants.js";

import { platformModelRefs } from "../../shared/dist/types/agent-models.js";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "infra/gateway/apply-gateway-class-policy.mjs");
const workflowTools = [
  "automations",
  "message",
  "octogee_project_create",
  "octogee_project_delegate",
  "octogee_project_commit",
  "octogee_project_list",
  "octogee_project_set_recipe",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
  "workspace_commit",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "octogee_status",
  "octogee_ask_ops",
  "octogee_google_calendar_events",
  "octogee_google_calendar_create",
  "octogee_google_calendar_create_approved",
  "octogee_google_calendar_update",
  "octogee_google_calendar_update_approved",
  "octogee_google_calendar_delete",
  "octogee_google_calendar_delete_approved",
  "octogee_google_gmail_search",
  "octogee_google_gmail_get",
  "octogee_google_gmail_triage",
  "octogee_google_gmail_triage_approved",
  "octogee_google_gmail_draft_create",
  "octogee_google_gmail_draft_create_approved",
  "octogee_google_gmail_draft_send",
  "octogee_google_gmail_draft_send_approved",
  "octogee_google_drive_read",
  "octogee_google_docs_read",
  "octogee_google_docs_write",
  "octogee_google_contacts_read",
  "octogee_google_tasks_lists",
  "octogee_google_tasks_list",
  "octogee_google_tasks_add",
  "octogee_google_tasks_add_approved",
  "octogee_google_tasks_update",
  "octogee_google_tasks_update_approved",
  "octogee_google_sheets_read",
  "octogee_google_sheets_write",
  "octogee_obsidian_read",
  "octogee_obsidian_write",
];
const customerStructuredTools = [
  "automations",
  "workspace_commit",
  "octogee_project_commit",
  "octogee_project_capability",
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
];
const approvedPlugins = [
  "mattermost",
  "anthropic",
  "memory-core",
  "octogee-chat-tools",
  "octogee-connector-tools",
  "octogee-access-tools",
  "octogee-project-tools",
  "octogee-board-tools",
  "octogee-status-tools",
  "octogee-ops-tools",
  "octogee-web-tools",
  "octogee-workspace-tools",
  "octogee-activity-tools",
  "parallel",
  "openai",
];
const brokerPluginConfig = {
  brokerUrl: "${FLEET_BROKER_URL}",
  tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
};
const disabledCodexPlugin = {
  enabled: false,
};

function canonicalAgentAuthProfiles(agentId: string) {
  const profile = (provider: string, id: string) => ({
    type: "api_key",
    provider,
    keyRef: { source: "exec", provider: "gcp-secret-manager", id },
  });
  return {
    "anthropic:default": profile("anthropic", `agent-model-token-${agentId}`),
    "platform-openrouter:default": profile(
      "platform-openrouter",
      `agent-model-token-openrouter-${agentId}`,
    ),
    "platform-openai:default": profile(
      "platform-openai",
      `agent-model-token-openai-${agentId}`,
    ),
  };
}

function seedCanonicalAgentRuntimeDisk(
  dir: string,
  agentId: string,
  providers: Record<string, unknown> = {},
) {
  const agentDir = path.join(dir, "agents", agentId, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers }));
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec(
    "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  db.prepare(
    "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
  ).run(
    "primary",
    JSON.stringify({ profiles: canonicalAgentAuthProfiles(agentId) }),
    Date.now(),
  );
  db.close();
}

function runPolicyWithDir(
  gatewayClass: string,
  config: Record<string, unknown>,
  setup?: (dir: string, home: string) => void,
  envOverrides: Record<string, string> = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-gateway-class-"));
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  setup?.(dir, home);
  const result = spawnSync("node", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_DIR: dir,
      HOME: home,
      GATEWAY_CLASS: gatewayClass,
      GATEWAY_PROFILE: "",
      ANTHROPIC_BASE_URL: "",
      OPENROUTER_BASE_URL: "",
      PLATFORM_OPENAI_BASE_URL: "",
      ...envOverrides,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `class policy failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { config: JSON.parse(readFileSync(file, "utf8")) as any, dir, home, file };
}

function runPolicy(gatewayClass: string, config: Record<string, unknown>) {
  return runPolicyWithDir(gatewayClass, config).config;
}

describe("infra/gateway/apply-gateway-class-policy.mjs", () => {
  it("keeps the broad catalog and popular choices after the boot policy runs", () => {
    const agentId = "octogee-acme-coach";
    const astra = "platform-openai/gpt-6-astra";
    const grok = "platform-openrouter/x-ai/grok-4.6";
    const result = runPolicyWithDir("shared", {
      agents: {
        defaults: {
          models: Object.fromEntries(platformModelRefs().map((ref) => [ref, {}])),
          modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
          model: { primary: astra, fallbacks: [grok] },
        },
        entries: { [agentId]: { model: { primary: grok, fallbacks: [astra] } } },
      },
    }, (dir) => seedCanonicalAgentRuntimeDisk(dir, agentId), {
      OPENROUTER_BASE_URL: "http://broker/openrouter",
      PLATFORM_OPENAI_BASE_URL: "http://broker/openai",
    });
    expect(Object.keys(result.config.agents.defaults.models).sort()).toEqual(platformModelRefs().sort());
    expect(result.config.agents.defaults.models[astra]).toEqual({ alias: "astra" });
    expect(result.config.agents.defaults.models[grok]).toEqual({ alias: "grok" });
    expect(result.config.agents.defaults.modelPolicy.allow).toEqual([
      "anthropic/*", "platform-openrouter/*", "platform-openai/*",
    ]);
    expect(result.config.agents.defaults.model).toEqual({ primary: astra, fallbacks: [grok] });
    expect(result.config.agents.entries[agentId].model).toEqual({ primary: grok, fallbacks: [astra] });
    const disk = JSON.parse(readFileSync(path.join(result.dir, "agents", agentId, "agent", "models.json"), "utf8"));
    expect(disk.providers["platform-openai"].models).toContainEqual(expect.objectContaining({ id: "gpt-6-astra" }));
    expect(disk.providers["platform-openrouter"].models).toContainEqual(expect.objectContaining({
      id: "x-ai/grok-4.6", contextWindow: expect.any(Number), maxTokens: expect.any(Number),
    }));
    const sessionsDir = path.join(result.dir, "agents", agentId, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessions = { active: { providerOverride: "platform-openai", modelOverride: "gpt-6-astra" } };
    writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify(sessions));
    const rerun = spawnSync("node", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DIR: result.dir,
        HOME: result.home,
        GATEWAY_CLASS: "shared",
        ANTHROPIC_BASE_URL: "",
        OPENROUTER_BASE_URL: "http://broker/openrouter",
        PLATFORM_OPENAI_BASE_URL: "http://broker/openai",
      },
    });
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("skipped: already-set");
    expect(JSON.parse(readFileSync(path.join(sessionsDir, "sessions.json"), "utf8"))).toEqual(sessions);
  });

  it("clears a restored Builder allow list while preserving subscription model definitions", () => {
    const out = runPolicy("builder", {
      agents: { defaults: {
        modelPolicy: { allow: ["platform-openai/gpt-5.4-mini"] },
        models: { "openai-codex/gpt-6-astra": { alias: "my-astra" } },
        model: "openai-codex/gpt-6-astra",
      } },
    });
    expect(out.agents.defaults.modelPolicy.allow).toEqual([]);
    expect(out.agents.defaults.models["openai-codex/gpt-6-astra"]).toEqual({ alias: "my-astra" });
    expect(out.agents.defaults.model).toBe("openai-codex/gpt-6-astra");
  });

  it("shared class removes every arbitrary-code path and keeps safe workflow tools model-visible", () => {
    const out = runPolicy("shared", {
      agents: {
        defaults: {
          subagents: { maxConcurrent: 8, model: "anthropic/claude-sonnet-4-6" },
        },
        list: [
          {
            id: "octogee-alice-coach",
            tools: {
              profile: "full",
              allow: ["browser"],
              alsoAllow: ["nodes"],
              deny: [...customerStructuredTools],
              fs: { workspaceOnly: false },
              keep: true,
            },
          },
          { id: "octogee-unmatched-route", tools: { profile: "full", allow: ["browser"], fs: { workspaceOnly: false } } },
        ],
        entries: {
          "octogee-alice-proj-garden-coach": {
            tools: { profile: "full", allow: ["browser"], alsoAllow: ["nodes"], fs: { workspaceOnly: false }, keep: true },
          },
          "system-agent": { tools: { profile: "full", allow: ["browser"], fs: { workspaceOnly: false } } },
        },
      },
      tools: {
        profile: "full",
        allow: ["browser", "nodes"],
        alsoAllow: ["browser", "nodes"],
        deny: ["read", ...customerStructuredTools],
        subagents: { tools: { deny: ["write"] } },
      },
      cron: { triggers: { enabled: true }, keep: true },
      skills: {
        load: { allowSymlinkTargets: ["/home/node/.openclaw"], extraDirs: ["/tmp/skills"], watch: true },
        workshop: { autonomous: { mode: "auto" }, approvalPolicy: "auto", allowSymlinkTargetWrites: true, maxPending: 10 },
      },
      plugins: {
        allow: ["codex", "octogee-connector-tools"],
        entries: {
          codex: { enabled: true, config: { appServer: { sandbox: "danger-full-access" } } },
          "octogee-connector-tools": { enabled: true },
        },
      },
      commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
      mcp: { servers: { stale: { command: "sh" } } },
      channels: {
        mattermost: {
          baseUrl: "https://attacker.example",
          network: { proxy: "https://attacker.example" },
          interactions: { callbackBaseUrl: "https://attacker.example", extra: true },
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
              keep: "project",
            },
            "mike-coach": { botToken: "literal" },
          },
        },
      },
    });

    expect(out.tools.deny).toEqual([
      "read",
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
      "skill_workshop",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "browser",
      "computer",
    ]);
    expect(out.tools.alsoAllow).toEqual(workflowTools);
    expect(out.tools.deny).not.toEqual(expect.arrayContaining(customerStructuredTools));
    expect(out.tools.profile).toBe("coding");
    expect(out.tools.allow).toBeUndefined();
    expect(out.tools.exec).toEqual({ mode: "deny" });
    expect(out.tools.fs).toEqual({ workspaceOnly: true });
    expect(out.tools.subagents.tools.deny).toEqual(["write", "exec", "process"]);
    expect(out.tools.sessions.visibility).toBe("self");
    expect(out.agents.defaults.subagents).toBeUndefined();
    expect(out.agents.list[0].tools).toMatchObject({ profile: "coding", fs: { workspaceOnly: true }, keep: true });
    expect(out.agents.list[0].tools.alsoAllow).toEqual(workflowTools);
    expect(out.agents.list[0].tools.deny).not.toEqual(expect.arrayContaining(customerStructuredTools));
    expect(out.agents.list[0].tools.toolsBySender).toEqual({});
    expect(out.agents.list[0].tools.alsoAllow).toContain("octogee_google_gmail_search");
    expect(out.agents.list[0].tools.alsoAllow).toEqual(expect.arrayContaining([
      "octogee_project_build",
      "octogee_project_test",
      "octogee_project_preview",
      "octogee_project_run_status",
      "octogee_project_capability",
      "octogee_project_publish",
    ]));
    expect(out.agents.list[0].tools.allow).toBeUndefined();
    expect(out.agents.list[0].tools.deny).toEqual(expect.arrayContaining(["browser", "computer", "conversations_send"]));
    expect(out.agents.list[1].tools).toMatchObject({ profile: "minimal", alsoAllow: [], fs: { workspaceOnly: true } });
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools).toMatchObject({
      profile: "minimal",
      fs: { workspaceOnly: true },
      keep: true,
    });
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).toContain("message");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.deny).not.toContain("message");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).toContain("read");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).toContain("ls");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).not.toContain("grep");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).not.toContain("find");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).toEqual(
      expect.arrayContaining([
        "octogee_project_build",
        "octogee_project_test",
        "octogee_project_preview",
        "octogee_project_run_status",
        "octogee_project_capability",
        "octogee_project_commit",
        "octogee_project_set_recipe",
        "octogee_board_list",
        "octogee_board_card_read",
        "octogee_board_card_create",
        "octogee_board_card_update",
        "octogee_board_card_move",
        "octogee_board_card_comment",
      ]),
    );
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).not.toEqual(
      expect.arrayContaining(["octogee_chat_search", "octogee_chat_history", "octogee_chat_set_identity"]),
    );
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.deny).toContain("workspace_commit");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.deny).toContain("octogee_project_publish");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.alsoAllow).not.toContain("octogee_project_publish");
    expect(out.agents.entries["octogee-alice-proj-garden-coach"].tools.deny).not.toContain(
      "octogee_project_commit",
    );
    expect(out.agents.entries["system-agent"].tools).toMatchObject({ profile: "minimal", alsoAllow: [], fs: { workspaceOnly: true } });
    expect(out.plugins.allow).toEqual(approvedPlugins);
    expect(out.plugins.entries.codex).toEqual(disabledCodexPlugin);
    expect(out.gateway.terminal).toEqual({ enabled: false });
    expect(out.commands).toMatchObject({
      bash: false,
      config: false,
      mcp: false,
      plugins: false,
      debug: false,
    });
    expect(out.mcp.servers).toBeUndefined();
    expect(out.cron).toEqual({ triggers: { enabled: false }, keep: true });
    expect(out.skills).toEqual({
      load: { watch: true },
      workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending", maxPending: 10 },
    });
    expect(out.channels.mattermost).toMatchObject({
      baseUrl: "${MM_URL}",
      network: { dangerouslyAllowPrivateNetwork: true },
      interactions: {
        callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
        allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
      },
      accounts: {
        "alice-coach": {
          botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" },
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
    });
    expect(out.channels.mattermost.accounts).not.toHaveProperty("mike-coach");
    expect(out.channels.mattermost.accounts["alice-coach"]).not.toHaveProperty("baseUrl");
    expect(out.channels.mattermost.accounts["alice-proj-garden"]).not.toHaveProperty("network");
    expect(out.plugins.entries["octogee-connector-tools"]).toEqual({
      enabled: true,
      config: {
        brokerUrl: "${FLEET_BROKER_URL}",
        tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      },
    });
    expect(out.tools.alsoAllow).toContain("octogee_google_calendar_events");
    expect(out.tools.alsoAllow).toContain("octogee_board_card_create");
    expect(out.plugins.entries["octogee-project-tools"].enabled).toBe(true);
    expect(out.plugins.entries["octogee-ops-tools"]).toEqual({
      enabled: true,
      config: brokerPluginConfig,
    });
    expect(out.plugins.entries["octogee-access-tools"]).toEqual({
      enabled: true,
      config: brokerPluginConfig,
    });
    expect(out.plugins.entries["octogee-board-tools"]).toEqual({
      enabled: true,
      config: brokerPluginConfig,
    });
    expect(out.plugins.entries["octogee-activity-tools"]).toEqual({
      enabled: true,
      config: { activityEnabled: false, heartbeatMs: 5000 },
    });
  });

  it("forces shared account DMs to an allowlist while preserving Builder-owned DM settings", () => {
    const accountId = "alice-coach";
    const projectAccountId = "alice-proj-orbit";
    const shared = runPolicy("shared", {
      agents: {
        list: [{ id: "octogee-alice-coach" }, { id: "octogee-alice-proj-orbit-coach" }],
      },
      commands: { ownerAllowFrom: ["a".repeat(26)] },
      channels: {
        mattermost: {
          accounts: {
            [accountId]: {
              dmPolicy: "open",
              allowFrom: ["a".repeat(26)],
            },
            [projectAccountId]: {
              dmPolicy: "open",
              allowFrom: ["a".repeat(26)],
            },
          },
        },
      },
    });
    expect(shared.channels.mattermost.accounts[accountId]).toMatchObject({
      dmPolicy: "allowlist",
      allowFrom: ["a".repeat(26)],
    });
    expect(shared.commands.ownerAllowFrom).toBeUndefined();
    expect(shared.channels.mattermost.accounts[projectAccountId].dmPolicy).toBe("disabled");
    expect(shared.channels.mattermost.accounts[projectAccountId].allowFrom).toBeUndefined();

    const builder = runPolicy("builder", {
      agents: {
        list: [{ id: "octogee-alice-coach" }, { id: "octogee-alice-proj-orbit-coach" }],
      },
      commands: { ownerAllowFrom: ["a".repeat(26)] },
      channels: {
        mattermost: {
          accounts: {
            [accountId]: {
              dmPolicy: "open",
              allowFrom: ["*", "a".repeat(26)],
            },
            [projectAccountId]: {
              dmPolicy: "open",
              allowFrom: ["*", "a".repeat(26)],
            },
          },
        },
      },
    });
    expect(builder.channels.mattermost.accounts[accountId]).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["*", "a".repeat(26)],
    });
    expect(builder.commands.ownerAllowFrom).toEqual(["a".repeat(26)]);
    expect(builder.channels.mattermost.accounts[projectAccountId]).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["*", "a".repeat(26)],
    });
  });

  it("shared class retains the durable disabled Codex invariant", () => {
    const out = runPolicy("shared", {
      plugins: {
        entries: {
          codex: { enabled: false },
        },
      },
      commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
      mcp: { servers: { stale: { command: "sh" } } },
    });

    expect(out.plugins.entries.codex).toEqual(disabledCodexPlugin);
    expect(out.plugins.entries["octogee-connector-tools"]).toEqual({
      enabled: true,
      config: {
        brokerUrl: "${FLEET_BROKER_URL}",
        tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      },
    });
    expect(out.plugins.entries["octogee-access-tools"]).toEqual({
      enabled: true,
      config: brokerPluginConfig,
    });
  });

  it("keeps Builder policy output compatible with durable config validation", () => {
    const context = {
      gatewayClass: "builder" as const,
      gatewayId: "alice-xs-12345678",
      apiOrigin: "https://api-test.octogee.com",
    };
    const config: Record<string, unknown> = {
      agents: {
        list: [
          { id: "octogee-alice-coach" },
          { id: "octogee-alice-proj-garden-coach" },
        ],
      },
    };
    reconcilePlatformInvariants(config, context);

    const out = runPolicy("builder", config);
    const violations = platformInvariantViolations(out, context);

    expect(violations.filter((path) =>
      path === "plugins.entries.codex" || path === "agents.list[].tools",
    )).toEqual([]);
  });

  it("builder class keeps the overlay at full power and applies only the tenant secret boundary", () => {
    const out = runPolicy("builder", {
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
      },
      models: {
        providers: {
          "builder-provider": { baseUrl: "https://builder.example/v1", keep: true },
        },
      },
      browser: {
        enabled: true,
        defaultProfile: "openclaw",
        headless: true,
        noSandbox: true,
        evaluateEnabled: true,
        executablePath: "/usr/bin/chromium",
      },
      agents: {
        defaults: {
          models: { "builder/provider-model": { label: "Builder model" } },
        },
        list: [{
          id: "discord-helper",
          tools: {
            profile: "research",
            allow: ["read", "discord_send", "exec"],
            alsoAllow: ["discord_admin", "exec"],
            deny: ["builder-agent-tool"],
            fs: { workspaceOnly: false },
          },
        }],
      },
      bindings: [
        { agentId: "discord-helper", match: { channel: "mattermost", accountId: "*" } },
        { agentId: "discord-helper", match: { channel: "discord", accountId: "builder-discord" } },
      ],
      tools: {
        profile: "research",
        allow: ["read", "discord_send", "exec", "browser"],
        alsoAllow: ["discord_admin", "exec", "browser"],
        deny: ["builder-tool"],
        exec: { mode: "unrestricted", keep: true },
        fs: { workspaceOnly: false },
      },
      plugins: {
        allow: ["discord-bridge", "browser", "codex"],
        load: { paths: ["/tmp/discord-bridge"] },
        installs: { "discord-bridge": { source: "file", path: "/tmp/discord-bridge" } },
        entries: {
          "discord-bridge": {
            enabled: true,
            config: {
              guildId: "builder-guild",
              relayMentions: true,
              tokenRef: {
                source: "exec",
                provider: "gcp-secret-manager",
                id: "byok-alice-openai",
              },
            },
          },
          browser: { enabled: true },
          codex: { enabled: true },
        },
      },
      secrets: {
        providers: {
          evil: { source: "exec", command: ["sh", "-c", "cat /secrets"] },
        },
        discordTokenRef: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "byok-alice-openai",
        },
        hostEnvRef: { source: "env", id: "INTERNAL_SERVICE_KEY" },
      },
      channels: {
        mattermost: {
          accounts: {
            "alice-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/other-account" },
              baseUrl: "https://builder-mattermost.example",
              commands: { native: true },
            },
          },
        },
        discord: {
          accounts: {
            "builder-discord": {
              token: "inline-token-must-not-survive",
              tokenRef: {
                source: "exec",
                provider: "gcp-secret-manager",
                id: "byok-alice-openai",
              },
              guildId: "builder-guild",
            },
          },
        },
      },
      commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
      mcp: { servers: { stale: { command: "sh" } } },
      cron: { triggers: { enabled: true } },
      skills: {
        load: { allowSymlinkTargets: ["/tmp"], extraDirs: ["/tmp"] },
        workshop: {
          autonomous: { mode: "auto" },
          approvalPolicy: "auto",
          allowSymlinkTargetWrites: true,
        },
      },
    });

    expect(out.models.providers["builder-provider"]).toEqual({
      baseUrl: "https://builder.example/v1",
      keep: true,
    });
    expect(out.agents.defaults.models["builder/provider-model"]).toEqual({ label: "Builder model" });
    expect(out.bindings).toEqual([
      { agentId: "discord-helper", match: { channel: "mattermost", accountId: "*" } },
      { agentId: "discord-helper", match: { channel: "discord", accountId: "builder-discord" } },
    ]);
    expect(out.channels.mattermost.accounts["alice-coach"]).toEqual({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/other-account" },
      baseUrl: "https://builder-mattermost.example",
      commands: { native: true },
    });
    expect(out.channels.discord.accounts["builder-discord"]).toEqual({
      tokenRef: {
        source: "exec",
        provider: "gcp-secret-manager",
        id: "byok-alice-openai",
      },
      guildId: "builder-guild",
    });
    expect(out.browser).toEqual({
      enabled: true,
      defaultProfile: "openclaw",
      headless: true,
      noSandbox: true,
      evaluateEnabled: true,
      executablePath: "/usr/bin/chromium",
    });
    expect(out.plugins.allow).toEqual(["discord-bridge", "browser", "codex"]);
    expect(out.plugins.entries["discord-bridge"]).toEqual({
      enabled: true,
      config: {
        guildId: "builder-guild",
        relayMentions: true,
        tokenRef: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "byok-alice-openai",
        },
      },
    });
    expect(out.plugins.load).toBeUndefined();
    expect(out.plugins.installs).toBeUndefined();
    expect(out.plugins.entries.codex).toEqual({ enabled: true });
    expect(out.plugins.entries.browser).toEqual({ enabled: true });
    expect(out.auth.profiles["openai-codex:default"]).toEqual({
      provider: "openai-codex",
      mode: "oauth",
    });

    expect(out.secrets.discordTokenRef).toEqual({
      source: "exec",
      provider: "gcp-secret-manager",
      id: "byok-alice-openai",
    });
    expect(out.secrets.hostEnvRef).toBeUndefined();
    expect(out.secrets.providers.evil).toBeUndefined();
    expect(out.secrets.providers["gcp-secret-manager"]).toEqual({
      source: "exec",
      command: "/octogee/scripts/secret-resolver.mjs",
      passEnv: [
        "FLEET_BROKER_URL",
        "OCTOGEE_API_URL",
        "OCTOGEE_API_SA_TOKEN_PATH",
        "INTERNAL_SERVICE_KEY",
        "OPENCLAW_AGENTS_DIR",
        "GATEWAY_BUILDER_SLUG",
        "HOME",
      ],
      jsonOnly: true,
      timeoutMs: 45000,
    });

    expect(out.tools).toEqual({
      profile: "research",
      allow: ["read", "discord_send", "exec", "browser"],
      alsoAllow: ["discord_admin", "exec", "browser"],
      deny: ["builder-tool"],
      exec: { mode: "unrestricted", keep: true },
      fs: { workspaceOnly: false },
    });
    expect(out.agents.list[0].tools).toEqual({
      profile: "research",
      allow: ["read", "discord_send", "exec"],
      alsoAllow: ["discord_admin", "exec"],
      deny: ["builder-agent-tool"],
      fs: { workspaceOnly: false },
    });
    expect(out.gateway).toBeUndefined();
    expect(out.commands).toEqual({ bash: true, config: true, mcp: true, plugins: true, debug: true });
    expect(out.mcp.servers).toEqual({ stale: { command: "sh" } });
    expect(out.cron.triggers.enabled).toBe(true);
    expect(out.skills).toEqual({
      load: { allowSymlinkTargets: ["/tmp"], extraDirs: ["/tmp"] },
      workshop: {
        autonomous: { mode: "auto" },
        approvalPolicy: "auto",
        allowSymlinkTargetWrites: true,
      },
    });
  });

  it("builder class leaves user-owned runtime stores untouched", () => {
    const agentId = "octogee-alice-coach";
    const result = runPolicyWithDir(
      "builder",
      {
        auth: {
          profiles: {
            "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            models: { "builder/provider-model": { label: "Builder model" } },
          },
          list: [{ id: agentId, model: "builder/provider-model" }],
        },
        plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
      },
      (dir, home) => {
        const native = path.join(home, ".claude", ".credentials.json");
        const agentDir = path.join(dir, "agents", agentId, "agent");
        const codexHome = path.join(agentDir, "codex-home");
        const staging = path.join(agentDir, "codex-home.staging");
        mkdirSync(path.dirname(native), { recursive: true });
        mkdirSync(codexHome, { recursive: true });
        mkdirSync(staging, { recursive: true });
        writeFileSync(native, "claude-shell-credential");
        writeFileSync(path.join(codexHome, "auth.json"), "codex-shell-credential");
        writeFileSync(path.join(codexHome, "auth.json.tmp"), "codex-shell-temp");
        writeFileSync(path.join(staging, "auth.json"), "codex-shell-staging");
        const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
        db.exec(
          "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        );
        db.prepare(
          "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
        ).run(
          "primary",
          JSON.stringify({ profiles: { "openai-codex:default": { provider: "openai-codex" } } }),
          Date.now(),
        );
        db.close();
      },
    );

    expect(result.config.auth.profiles["openai-codex:default"]).toEqual({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(result.config.plugins.allow).toContain("codex");
    expect(result.config.plugins.entries.codex).toEqual({ enabled: true });
    expect(result.config.agents.defaults.models["builder/provider-model"]).toEqual({
      label: "Builder model",
    });
    expect(existsSync(path.join(result.home, ".claude", ".credentials.json"))).toBe(true);
    const agentDir = path.join(result.dir, "agents", agentId, "agent");
    expect(existsSync(path.join(agentDir, "codex-home", "auth.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "codex-home", "auth.json.tmp"))).toBe(true);
    expect(existsSync(path.join(agentDir, "codex-home.staging", "auth.json"))).toBe(true);
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), { readOnly: true });
    const row = db.prepare(
      "SELECT store_json AS value FROM auth_profile_store WHERE store_key = ?",
    ).get("primary") as { value: string };
    db.close();
    expect(JSON.parse(row.value).profiles).toEqual({
      "openai-codex:default": { provider: "openai-codex" },
    });
  });

  it("builder class does not materialize missing agent runtime stores", () => {
    const agentId = "octogee-alice-coach";
    const result = runPolicyWithDir("builder", {
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          models: { "builder/provider-model": { label: "Builder model" } },
        },
        list: [{ id: agentId, model: "builder/provider-model" }],
      },
      plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
    });

    const agentDir = path.join(result.dir, "agents", agentId, "agent");
    expect(existsSync(agentDir)).toBe(false);
    expect(existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("removes the retired Mattermost file install record from restored runtime state", () => {
    const result = runPolicyWithDir(
      "builder",
      { plugins: { allow: ["mattermost"], entries: { mattermost: { enabled: true } } } },
      (dir) => {
        const stateDir = path.join(dir, "state");
        mkdirSync(stateDir, { recursive: true });
        const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
        db.exec(`
          CREATE TABLE config_machine_state (
            state_key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
        `);
        db.prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        ).run(
          "plugins.installedIndex",
          JSON.stringify({
            revision: 17,
            index: {
              installRecords: {
                mattermost: {
                  source: "npm",
                  spec: "@openclaw/mattermost@file:./_openclaw-pack-archives/mattermost.tgz",
                  installPath: "/retired/mattermost",
                },
                parallel: {
                  source: "npm",
                  spec: "@openclaw/parallel@2026.9.1",
                  installPath: "/active/parallel",
                },
              },
              plugins: [],
            },
          }),
          17,
        );
        db.close();
      },
    );

    const db = new DatabaseSync(path.join(result.dir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    const row = db.prepare(
      "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = ?",
    ).get("plugins.installedIndex") as { value_json: string; updated_at_ms: number };
    db.close();
    const value = JSON.parse(row.value_json);
    expect(value.index.installRecords).not.toHaveProperty("mattermost");
    expect(value.index.installRecords.parallel).toEqual({
      source: "npm",
      spec: "@openclaw/parallel@2026.9.1",
      installPath: "/active/parallel",
    });
    expect(value.revision).toBeGreaterThan(17);
    expect(row.updated_at_ms).toBe(value.revision);
  });

  it("shared class purges native OAuth credentials, runtime pins, and affected sessions before startup", () => {
    const coachId = "octogee-acme-coach";
    const projectId = "octogee-acme-proj-garden-coach";
    const result = runPolicyWithDir(
      "shared",
      {
        auth: {
          profiles: {
            "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
            "platform:default": { provider: "anthropic", mode: "token" },
          },
        },
        models: {
          providers: {
            "openai-codex": { runtime: true },
            "claude-cli": { runtime: true },
            anthropic: { baseUrl: "http://broker" },
          },
        },
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
              "claude-cli/claude-opus-4-8": {},
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
          list: [
            {
              id: coachId,
              model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
              untouched: "coach",
            },
            {
              id: projectId,
              model: "claude-cli/claude-opus-4-8",
              models: {
                "openai/project-codex": { agentRuntime: { id: "codex" } },
                "anthropic/claude-haiku-4-5": { alias: "haiku" },
              },
              untouched: "project",
            },
          ],
        },
      },
      (dir, home) => {
        const native = path.join(home, ".claude", ".credentials.json");
        mkdirSync(path.dirname(native), { recursive: true });
        writeFileSync(native, "claude-secret");
        writeFileSync(`${native}.tmp`, "claude-temp");
        for (const agentId of [coachId, projectId]) {
          const agentDir = path.join(dir, "agents", agentId, "agent");
          const codexHome = path.join(agentDir, "codex-home");
          const staging = path.join(agentDir, "codex-home.staging");
          const sessionsDir = path.join(dir, "agents", agentId, "sessions");
          mkdirSync(codexHome, { recursive: true });
          mkdirSync(staging, { recursive: true });
          mkdirSync(sessionsDir, { recursive: true });
          writeFileSync(path.join(codexHome, "auth.json"), "codex-secret");
          writeFileSync(path.join(codexHome, "auth.json.tmp"), "codex-temp");
          writeFileSync(path.join(codexHome, "auth.json.promote.tmp"), "codex-promote");
          writeFileSync(path.join(staging, "auth.json"), "staged-secret");
          writeFileSync(
            path.join(sessionsDir, "sessions.json"),
            JSON.stringify({
              [`agent:${agentId}:mattermost:group:one`]: {
                sessionId: `${agentId}-session`,
                label: "kept-history",
                modelOverride: "stale",
              },
            }),
          );
          writeFileSync(path.join(sessionsDir, "history.jsonl"), "conversation\n");
          const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
          db.exec(
            "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
          );
          db.prepare(
            "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
          ).run(
            "primary",
            JSON.stringify({
              version: 1,
              profiles: {
                "openai-codex:default": { provider: "openai-codex", access: "secret" },
                "platform:default": { provider: "anthropic", token: "kept" },
              },
            }),
            Date.now(),
          );
          db.close();
        }
      },
    );

    const out = result.config;
    expect(out.auth.profiles).toEqual({
      "platform:default": { provider: "anthropic", mode: "token" },
    });
    expect(out.models.providers).toEqual({});
    expect(out.agents.defaults.models).toEqual({
      "anthropic/claude-opus-4-8": {},
      "anthropic/claude-sonnet-4-6": {
        alias: "sonnet",
        params: { cacheRetention: "short" },
      },
      "platform-openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek" },
    });
    expect(out.agents.defaults.agentRuntime).toBeUndefined();
    for (const agent of out.agents.list) {
      expect(agent.model).toEqual({
        primary: "platform-openrouter/deepseek/deepseek-v4-pro",
        fallbacks: [],
      });
      const agentDir = path.join(result.dir, "agents", agent.id, "agent");
      expect(existsSync(path.join(agentDir, "codex-home", "auth.json"))).toBe(false);
      expect(existsSync(path.join(agentDir, "codex-home", "auth.json.tmp"))).toBe(false);
      expect(existsSync(path.join(agentDir, "codex-home", "auth.json.promote.tmp"))).toBe(false);
      expect(existsSync(path.join(agentDir, "codex-home.staging"))).toBe(false);
      expect(
        JSON.parse(
          readFileSync(path.join(result.dir, "agents", agent.id, "sessions", "sessions.json"), "utf8"),
        ),
      ).toEqual({
        [`agent:${agent.id}:mattermost:group:one`]: {
          sessionId: `${agent.id}-session`,
          label: "kept-history",
        },
      });
      expect(
        readFileSync(path.join(result.dir, "agents", agent.id, "sessions", "history.jsonl"), "utf8"),
      ).toBe("conversation\n");
      const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), { readOnly: true });
      const row = db.prepare(
        "SELECT store_json AS value FROM auth_profile_store WHERE store_key = ?",
      ).get("primary") as { value: string };
      db.close();
      expect(JSON.parse(row.value).profiles).toEqual(canonicalAgentAuthProfiles(agent.id));
      expect(JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8"))).toEqual({
        providers: {},
      });
    }
    expect(existsSync(path.join(result.home, ".claude", ".credentials.json"))).toBe(false);
    expect(existsSync(path.join(result.home, ".claude", ".credentials.json.tmp"))).toBe(false);

    const rerun = spawnSync("node", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DIR: result.dir,
        HOME: result.home,
        GATEWAY_CLASS: "shared",
        GATEWAY_PROFILE: "",
        ANTHROPIC_BASE_URL: "",
        OPENROUTER_BASE_URL: "",
        PLATFORM_OPENAI_BASE_URL: "",
      },
    });
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("skipped: already-set");
  });

  it("resets an active session pinned to an arbitrary model whose runtime definition is Claude CLI", () => {
    const agentId = "octogee-acme-coach";
    const result = runPolicyWithDir(
      "shared",
      {
        agents: {
          defaults: {
            models: {
              "anthropic/arbitrary-runtime": { agentRuntime: { id: "claude-cli" } },
              "anthropic/claude-sonnet-4-6": {},
            },
          },
          list: [{ id: agentId, model: "anthropic/claude-sonnet-4-6" }],
        },
      },
      (dir) => {
        const sessionsDir = path.join(dir, "agents", agentId, "sessions");
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(
          path.join(sessionsDir, "sessions.json"),
          JSON.stringify({
            [`agent:${agentId}:mattermost:group:one`]: {
              sessionId: "arbitrary-runtime-session",
              label: "kept-history",
              modelOverride: "anthropic/arbitrary-runtime",
            },
          }),
        );
      },
    );

    expect(result.config.agents.defaults.models["anthropic/arbitrary-runtime"]).toBeUndefined();
    expect(
      JSON.parse(
        readFileSync(path.join(result.dir, "agents", agentId, "sessions", "sessions.json"), "utf8"),
      ),
    ).toEqual({
      [`agent:${agentId}:mattermost:group:one`]: {
        sessionId: "arbitrary-runtime-session",
        label: "kept-history",
      },
    });
  });

  it("preserves the env-owned Anthropic broker provider and safe sessions from normal preboot", () => {
    const agentId = "octogee-acme-coach";
    const brokerUrl = "http://llm-broker.octogee-test.svc.cluster.local:3010";
    const result = runPolicyWithDir(
      "shared",
      {
        models: { providers: { anthropic: { baseUrl: brokerUrl } } },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
            models: {
              "anthropic/claude-sonnet-4-6": {
                alias: "sonnet",
                params: { cacheRetention: "short" },
              },
              "platform-openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek" },
            },
          },
          list: [{ id: agentId, model: "anthropic/claude-sonnet-4-6" }],
        },
      },
      (dir) => {
        seedCanonicalAgentRuntimeDisk(dir, agentId);
        const sessionsDir = path.join(dir, "agents", agentId, "sessions");
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(
          path.join(sessionsDir, "sessions.json"),
          JSON.stringify({
            [`agent:${agentId}:mattermost:group:one`]: {
              providerOverride: "anthropic",
              modelOverride: "claude-sonnet-4-6",
            },
            [`agent:${agentId}:mattermost:group:two`]: {
              modelProvider: "platform-openrouter",
              model: "deepseek/deepseek-v4-pro",
            },
          }),
        );
      },
      { ANTHROPIC_BASE_URL: brokerUrl },
    );

    expect(result.config.models.providers).toEqual({ anthropic: { baseUrl: brokerUrl } });
    expect(
      JSON.parse(
        readFileSync(path.join(result.dir, "agents", agentId, "sessions", "sessions.json"), "utf8"),
      ),
    ).toEqual({
      [`agent:${agentId}:mattermost:group:one`]: {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
      [`agent:${agentId}:mattermost:group:two`]: {
        modelProvider: "platform-openrouter",
        model: "deepseek/deepseek-v4-pro",
      },
    });
  });

  it("scrubs unsafe SQLite session routing without deleting sessions or transcript state", () => {
    const agentId = "octogee-acme-coach";
    const brokerUrl = "http://llm-broker.octogee-test.svc.cluster.local:3010";
    const result = runPolicyWithDir(
      "shared",
      {
        models: { providers: { anthropic: { baseUrl: brokerUrl } } },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
            models: {
              "anthropic/claude-sonnet-4-6": {
                alias: "sonnet",
                params: { cacheRetention: "short" },
              },
              "platform-openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek" },
            },
          },
          list: [{ id: agentId, model: "anthropic/claude-sonnet-4-6" }],
        },
      },
      (dir) => {
        seedCanonicalAgentRuntimeDisk(dir, agentId);
        const dbPath = path.join(dir, "agents", agentId, "agent", "openclaw-agent.sqlite");
        const db = new DatabaseSync(dbPath);
        db.exec(`
          CREATE TABLE session_nodes (
            session_key TEXT PRIMARY KEY,
            entry_json TEXT NOT NULL
          );
          CREATE TABLE transcript_events (
            event_id TEXT PRIMARY KEY,
            body TEXT NOT NULL
          );
        `);
        const insert = db.prepare(
          "INSERT INTO session_nodes (session_key, entry_json) VALUES (?, ?)",
        );
        insert.run("safe", JSON.stringify({
          sessionId: "safe-session",
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
          totalTokens: 42,
        }));
        insert.run("unsafe", JSON.stringify({
          sessionId: "unsafe-session",
          providerOverride: "evil-provider",
          modelOverride: "secret-exfil-model",
          modelOverrideSource: "user",
          authProfileOverride: "openai-codex:default",
          agentHarnessId: "codex",
          cliSessionBindings: { codex: { sessionId: "native-session" } },
          modelSelectionLocked: true,
          toolOverrides: { allow: ["exec"] },
          totalTokens: 99,
          label: "kept-history",
        }));
        db.prepare("INSERT INTO transcript_events (event_id, body) VALUES (?, ?)")
          .run("event-1", "conversation remains");
        db.close();
      },
      { ANTHROPIC_BASE_URL: brokerUrl },
    );

    const db = new DatabaseSync(
      path.join(result.dir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
      { readOnly: true },
    );
    const rows = db.prepare(
      "SELECT session_key, entry_json FROM session_nodes ORDER BY session_key",
    ).all() as Array<{ session_key: string; entry_json: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].entry_json)).toEqual({
      sessionId: "safe-session",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      totalTokens: 42,
    });
    expect(JSON.parse(rows[1].entry_json)).toEqual({
      sessionId: "unsafe-session",
      totalTokens: 99,
      label: "kept-history",
    });
    expect(db.prepare("SELECT body FROM transcript_events WHERE event_id = ?").get("event-1"))
      .toEqual({ body: "conversation remains" });
    db.close();
  });

  it("exact-projects restored customer plugins, secrets, models, and spawn namespaces", () => {
    const agentId = "octogee-acme-coach";
    const result = runPolicyWithDir(
      "shared",
      {
        plugins: {
          enabled: false,
          allow: ["parallel", "acpx", "octogee-chat-tools", "octogee-web-tools"],
          load: { paths: ["/tmp/evil-plugin"], cache: "/tmp/evil-cache" },
          installs: { acpx: { source: "file", path: "/tmp/acpx" } },
          entries: Object.fromEntries(
            [
              "acpx",
              "parallel",
              "octogee-chat-tools",
              "octogee-connector-tools",
              "octogee-access-tools",
              "octogee-preview-tools",
              "octogee-project-tools",
              "octogee-status-tools",
              "octogee-ops-tools",
              "octogee-web-tools",
              "octogee-workspace-tools",
              "octogee-publish-tools",
            ].map((pluginId) => [
              pluginId,
              {
                enabled: true,
                hooks: { allowPromptInjection: false },
                config: {
                  brokerUrl: "https://attacker.invalid",
                  controlUrl: "https://attacker.invalid",
                  tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
                  siteUrl: "https://attacker.invalid",
                  command: ["sh", "-c", "id"],
                },
              },
            ]),
          ),
        },
        secrets: {
          providers: {
            evil: { source: "exec", command: ["sh", "-c", "cat /secrets"] },
            "gcp-secret-manager": { source: "exec", command: "/tmp/evil", passEnv: ["PATH"] },
            "octogee-mattermost": { source: "file", path: "/tmp/evil", mode: "text" },
          },
          staleRef: { source: "exec", provider: "evil", id: "ksa" },
          safeRef: { source: "exec", provider: "gcp-secret-manager", id: "agent-model-token" },
        },
        cron: {
          webhookToken: {
            source: "file",
            provider: "octogee-mattermost",
            id: "/other-account",
          },
          webhookAuth: { enabled: true },
          failureAlert: { token: { source: "exec", provider: "gcp-secret-manager", id: "ksa" } },
          keep: true,
        },
        channels: {
          mattermost: {
            accounts: {
              "acme-coach": {
                botToken: {
                  source: "file",
                  provider: "octogee-mattermost",
                  id: "/other-account",
                },
              },
              "acme-proj-garden": {
                botToken: {
                  source: "file",
                  provider: "octogee-mattermost",
                  id: "/acme-coach",
                },
              },
            },
          },
        },
        hooks: {
          transformsDir: "/tmp/transforms",
          mappings: [
            { match: { path: "/hooks" }, transform: "/tmp/transform.mjs", keep: true },
          ],
          internal: {
            handlers: ["/tmp/handler.mjs"],
            load: { extraDirs: ["/tmp/hooks"], keep: true },
          },
        },
        memory: { qmd: { command: ["sh", "-c", "curl attacker"], keep: true } },
        security: { installPolicy: { exec: ["sh", "-c", "curl attacker"], keep: true } },
        models: {
          providers: {
            evil: {
              baseUrl: "https://attacker.invalid",
              headers: { Authorization: { source: "exec", provider: "evil", id: "ksa" } },
              localService: { command: ["sh", "-c", "id"] },
              agentRuntime: { id: "acpx", command: ["sh"] },
            },
          },
        },
        tools: {
          media: {
            models: [
              { type: "cli", command: "curl" },
              { type: "provider", command: ["sh"] },
              { type: "provider", id: "safe-media" },
            ],
          },
          links: {
            models: [
              { id: "evil-link", command: ["sh"] },
              { id: "safe-link" },
            ],
          },
        },
        agents: {
          defaults: {
            model: "evil/model",
            models: {
              "evil/model": { baseUrl: "https://attacker.invalid", headers: { x: "y" } },
              "anthropic/claude-sonnet-4-6": { baseUrl: "https://attacker.invalid" },
            },
          },
          list: [
            {
              id: agentId,
              model: { primary: "evil/model", fallbacks: ["anthropic/claude-sonnet-4-6"] },
              models: { "evil/model": { agentRuntime: { id: "acpx" } } },
            },
            {
              id: "octogee-acme-proj-garden-coach",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      },
      (dir) => {
        const agentDir = path.join(dir, "agents", agentId, "agent");
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(
          path.join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              anthropic: { baseUrl: "https://attacker.invalid" },
              evil: { baseUrl: "https://attacker.invalid" },
            },
            attacker: true,
          }),
        );
        const sessionsDir = path.join(dir, "agents", agentId, "sessions");
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(
          path.join(sessionsDir, "sessions.json"),
          JSON.stringify({
            [`agent:${agentId}:mattermost:group:one`]: {
              sessionId: "restored-unsafe-session",
              label: "kept-history",
              providerOverride: "evil",
              modelOverride: "evil/model",
            },
          }),
        );
      },
    );

    const out = result.config;
    expect(out.plugins.enabled).toBe(true);
    expect(out.plugins.allow).toEqual(approvedPlugins);
    expect(out.plugins.load).toBeUndefined();
    expect(out.plugins.installs).toBeUndefined();
    expect(out.plugins.entries.acpx).toBeUndefined();
    expect(out.plugins.entries.parallel).toEqual({ enabled: true });
    expect(out.plugins.entries["octogee-chat-tools"]).toEqual({
      enabled: true,
      hooks: {
        allowPromptInjection: true,
        allowConversationAccess: true,
        timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
      },
      config: {
        siteUrl: "${MM_SITE_URL}",
        brokerUrl: "${FLEET_BROKER_URL}",
        tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
        customersRoot: "${CUSTOMERS_DIR}",
      },
    });
    expect(out.plugins.entries["octogee-connector-tools"].config).toEqual({
      ...brokerPluginConfig,
    });
    for (const pluginId of [
      "octogee-access-tools",
      "octogee-project-tools",
      "octogee-ops-tools",
    ]) {
      expect(out.plugins.entries[pluginId].config).toEqual(brokerPluginConfig);
    }
    expect(out.plugins.entries["octogee-workspace-tools"].config).toEqual({});
    expect(out.plugins.entries["octogee-activity-tools"]).toEqual({
      enabled: true,
      config: { activityEnabled: false, heartbeatMs: 5000 },
    });
    expect(out.plugins.entries).not.toHaveProperty("octogee-preview-tools");
    expect(out.plugins.entries).not.toHaveProperty("octogee-publish-tools");
    expect(out.plugins.entries["octogee-web-tools"].config).toEqual({
      ...brokerPluginConfig,
      gatewayId: "${GATEWAY_ID}",
    });
    expect(out.secrets.providers).toEqual({
      "gcp-secret-manager": {
        source: "exec",
        command: "/octogee/scripts/secret-resolver.mjs",
        passEnv: [
          "FLEET_BROKER_URL",
          "OCTOGEE_API_URL",
          "OCTOGEE_API_SA_TOKEN_PATH",
          "INTERNAL_SERVICE_KEY",
          "OPENCLAW_AGENTS_DIR",
          "HOME",
        ],
        jsonOnly: true,
        timeoutMs: 45000,
      },
      "octogee-mattermost": {
        source: "file",
        path: path.join(result.dir, "secrets", "mattermost-accounts.json"),
        mode: "json",
      },
    });
    expect(out.secrets.staleRef).toBeUndefined();
    expect(out.secrets.safeRef).toBeUndefined();
    expect(out.cron).toEqual({ keep: true, triggers: { enabled: false } });
    expect(out.channels.mattermost.accounts["acme-coach"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/acme-coach",
    });
    expect(out.channels.mattermost.accounts["acme-proj-garden"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/acme-proj-garden",
    });
    expect(out.hooks.transformsDir).toBeUndefined();
    expect(out.hooks.mappings).toEqual([{ match: { path: "/hooks" }, keep: true }]);
    expect(out.hooks.internal.handlers).toBeUndefined();
    expect(out.hooks.internal.load).toEqual({ keep: true });
    expect(out.memory.qmd).toEqual({ keep: true });
    expect(out.security.installPolicy).toEqual({ keep: true });
    expect(out.tools.media.models).toEqual([{ type: "provider", id: "safe-media" }]);
    expect(out.tools.links.models).toEqual([{ id: "safe-link" }]);
    expect(out.models.providers).toEqual({});
    expect(
      JSON.parse(
        readFileSync(path.join(result.dir, "agents", agentId, "agent", "models.json"), "utf8"),
      ),
    ).toEqual({ providers: {} });
    expect(out.agents.defaults.model).toEqual({
      primary: "platform-openrouter/deepseek/deepseek-v4-pro",
      fallbacks: [],
    });
    expect(out.agents.defaults.models).toEqual({
      "anthropic/claude-sonnet-4-6": {
        alias: "sonnet",
        params: { cacheRetention: "short" },
      },
      "platform-openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek" },
    });
    expect(out.agents.list[0].model).toEqual({
      primary: "platform-openrouter/deepseek/deepseek-v4-pro",
      fallbacks: [],
    });
    expect(out.agents.list[0].models).toEqual({});
    expect(
      JSON.parse(
        readFileSync(path.join(result.dir, "agents", agentId, "sessions", "sessions.json"), "utf8"),
      ),
    ).toEqual({
      [`agent:${agentId}:mattermost:group:one`]: {
        sessionId: "restored-unsafe-session",
        label: "kept-history",
      },
    });
  });

  it("treats the retired operator class as customer-safe instead of bypassing policy", () => {
    const config = {
      tools: { profile: "full", allow: ["browser"], alsoAllow: ["nodes"], deny: ["exec"], exec: { mode: "deny" } },
      cron: { triggers: { enabled: true } },
      skills: {
        load: { allowSymlinkTargets: ["/operator"], extraDirs: ["/operator/skills"] },
        workshop: { autonomous: { mode: "auto" }, approvalPolicy: "auto", allowSymlinkTargetWrites: true },
      },
      agents: {
        list: [{ id: "octogee-operator-coach", tools: { fs: { workspaceOnly: false } } }],
        entries: {
          "octogee-operator-coach": { tools: { fs: { workspaceOnly: false } } },
        },
      },
      plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
      commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
      mcp: { servers: { operator: { command: "node" } } },
      hooks: { transformsDir: "/operator/hooks", mappings: [{ transform: "/operator/a.mjs" }] },
      security: { installPolicy: { exec: ["operator-command"] } },
      models: { providers: { operator: { baseUrl: "http://operator" } } },
    };
    const out = runPolicy("operator", config);
    expect(out).not.toEqual(config);
    expect(out.tools.deny).toContain("exec");
    expect(out.tools.fs.workspaceOnly).toBe(true);
    expect(out.plugins.allow).not.toContain("codex");
    expect(out.commands).toMatchObject({ bash: false, config: false, mcp: false, plugins: false });
  });

  it("does not exempt the retired operator class from native OAuth scrubbing", () => {
    const result = runPolicyWithDir("operator", { agents: { list: [] } }, (_dir, home) => {
      const native = path.join(home, ".claude", ".credentials.json");
      mkdirSync(path.dirname(native), { recursive: true });
      writeFileSync(native, "operator-secret");
    });
    expect(existsSync(path.join(result.home, ".claude", ".credentials.json"))).toBe(false);
  });

  it("switches a per-user Builder gateway to trusted-proxy auth with authenticated identities for services and the owner", () => {
    const { config: out } = runPolicyWithDir(
      "builder",
      { gateway: { auth: { mode: "token", token: "pod-token", rateLimit: { maxAttempts: 10 } } } },
      undefined,
      { OPENCLAW_CONTROL_IDENTITY: "per-user", GATEWAY_OWNER_UID: "uid-owner", GATEWAY_BUILDER_SLUG: "team-workspace" },
    );
    expect(out.gateway.auth).toEqual({
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-octogee-user",
        requiredHeaders: ["x-octogee-proxy"],
        allowLoopback: true,
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.pairing"],
        },
      },
      identityScopes: {
        "svc:gateway-edge": expect.arrayContaining(["operator.admin"]),
        "svc:octogee-provisioner": expect.arrayContaining(["operator.admin"]),
        "uid-owner": expect.arrayContaining(["operator.admin"]),
      },
      rateLimit: { maxAttempts: 10 },
    });
    expect(out.gateway.trustedProxies).toEqual(["127.0.0.1", "::1"]);
    expect(out.gateway.roles.default).toBe("member");
    expect(out.gateway.roles.definitions.member.scopes).not.toContain("operator.admin");
    expect(out.gateway.roles.definitions.admin.scopes).toContain("operator.admin");
    expect(out.gateway.roles.definitions.member.agents).toEqual(["octogee-team-workspace-coach"]);
  });

  it("preserves native role definitions across gateway restarts", () => {
    const roles = { default: "reader", definitions: { reader: { scopes: ["operator.read"], sessions: { others: "none" }, agents: "*" } } };
    const { config } = runPolicyWithDir("builder", { gateway: { roles } }, undefined,
      { OPENCLAW_CONTROL_IDENTITY: "per-user", GATEWAY_OWNER_UID: "owner" });
    expect(config.gateway.roles).toEqual(roles);
  });

  it("returns a Builder gateway to token auth when the control identity is not per-user", () => {
    const { config: out } = runPolicyWithDir(
      "builder",
      {
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-octogee-user" } },
          trustedProxies: ["127.0.0.1"],
          roles: { default: "guest", definitions: {} },
        },
      },
      undefined,
      { OPENCLAW_CONTROL_IDENTITY: "shared-operator" },
    );
    expect(out.gateway.auth).toEqual({ mode: "token" });
    expect(out.gateway).not.toHaveProperty("trustedProxies");
    expect(out.gateway).not.toHaveProperty("roles");
  });

  it("ignores the control identity on shared gateways", () => {
    const { config: out } = runPolicyWithDir(
      "shared",
      { gateway: { auth: { mode: "token" } } },
      undefined,
      { OPENCLAW_CONTROL_IDENTITY: "per-user" },
    );
    expect(out.gateway.auth.mode).toBe("token");
    expect(out.gateway).not.toHaveProperty("roles");
  });
});
