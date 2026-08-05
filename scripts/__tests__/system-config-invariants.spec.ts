import { describe, expect, it } from "vitest";

import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants,
  reconcilePlatformInvariants,
} from "../lib/system-config-invariants.js";

function config(): Record<string, unknown> {
  return {
    discovery: { mdns: { mode: "on" } },
    gateway: {
      port: 9000,
      mode: "remote",
      bind: "loopback",
      auth: { mode: "password" },
      controlUi: { allowedOrigins: ["*"] },
    },
    secrets: { providers: {} },
    channels: { mattermost: { enabled: false, commands: { native: true } } },
    plugins: { enabled: false, allow: ["customer-plugin"], entries: {} },
    tools: { deny: ["exec", "customer-deny"], exec: { mode: "deny" } },
    commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
    mcp: { servers: { stale: { command: "sh" } } },
  };
}

const env = {
  GATEWAY_CLASS: "builder",
  GATEWAY_ID: "bender",
  API_PUBLIC_URL: "https://api-test.octogee.com",
};

describe("system config platform invariants", () => {
  it("reconciles the typed platform paths without removing customer-owned values", () => {
    const candidate = config();

    const result = reconcilePlatformInvariants(candidate, env);

    expect(result.changedPaths).toEqual(expect.arrayContaining([
      "gateway.port",
      "gateway.mode",
      "gateway.bind",
      "gateway.auth.mode",
      "gateway.controlUi.allowedOrigins",
      "secrets.providers.octogee-mattermost",
      "channels.mattermost.enabled",
      "plugins.enabled",
      "plugins.allow",
      "tools.deny",
    ]));
    expect(candidate).toMatchObject({
      gateway: {
        port: 18789,
        mode: "local",
        bind: "lan",
        auth: { mode: "token" },
        controlUi: {
          basePath: "/g/bender/openclaw",
          allowedOrigins: ["https://api-test.octogee.com"],
          allowInsecureAuth: false,
          dangerouslyDisableDeviceAuth: false,
        },
      },
      secrets: {
        providers: {
          "octogee-mattermost": {
            source: "file",
            path: "/home/node/.openclaw/secrets/mattermost-accounts.json",
            mode: "json",
          },
        },
      },
      channels: { mattermost: { enabled: true, commands: { native: false } } },
      plugins: {
        enabled: true,
        allow: expect.arrayContaining(["customer-plugin", "mattermost"]),
        entries: {
          codex: { enabled: false },
          "octogee-chat-tools": {
            hooks: {
              allowPromptInjection: true,
              allowConversationAccess: true,
              timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
            },
          },
        },
      },
      tools: {
        deny: expect.arrayContaining([
          "customer-deny",
          "exec",
          "process",
          "subagents",
          "sessions_spawn",
          "terminal",
          "preview_start",
          "octogee_publish",
          "workspace_commit",
          "octogee_project_commit",
          "bundle-mcp",
        ]),
        exec: { mode: "deny" },
        sessions: { visibility: "self" },
      },
      commands: {
        bash: false,
        config: false,
        mcp: false,
        plugins: false,
        debug: false,
      },
    });
    expect((candidate.mcp as Record<string, unknown>)).not.toHaveProperty("servers");
  });

  it("converges the operator class back to its explicit execution exception", () => {
    const candidate = config();

    reconcilePlatformInvariants(candidate, {
      ...env,
      GATEWAY_CLASS: "operator",
      API_PUBLIC_URL: "https://api.octogee.com",
    });

    expect(candidate).toMatchObject({
      gateway: { terminal: { enabled: true } },
      plugins: {
        allow: expect.arrayContaining(["codex"]),
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "danger-full-access", approvalPolicy: "never" },
            },
          },
        },
      },
      tools: { deny: ["customer-deny"] },
    });
    expect((candidate.tools as Record<string, unknown>)).not.toHaveProperty("exec");
  });

  it("reports every violated path in a typed policy error without mutating the candidate", () => {
    const candidate = config();
    const before = structuredClone(candidate);

    expect(() => assertPlatformInvariants(candidate, env)).toThrowError(
      expect.objectContaining<Partial<PlatformInvariantPolicyError>>({
        code: "platform-invariant-violation",
        paths: expect.arrayContaining(["gateway.port", "plugins.allow", "tools.deny"]),
      }),
    );
    expect(candidate).toEqual(before);
  });

  it("is idempotent and accepts the reconciled result", () => {
    const candidate = config();
    reconcilePlatformInvariants(candidate, env);

    expect(reconcilePlatformInvariants(candidate, env)).toEqual({ changedPaths: [] });
    expect(() => assertPlatformInvariants(candidate, env)).not.toThrow();
  });
});
