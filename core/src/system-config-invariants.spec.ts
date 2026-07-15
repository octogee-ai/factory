import { describe, expect, it } from "vitest";

import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants,
  platformInvariantTable,
  platformInvariantViolations,
  reconcilePlatformInvariants,
} from "./system-config-invariants.js";

const isolated = {
  gatewayClass: "operator" as const,
  gatewayId: "bender",
  apiOrigin: "https://api.octogee.com",
};

describe("system config platform invariants", () => {
  it("reconciles isolated route, auth, integration, plugin, and tool policy from one typed table", () => {
    const config: Record<string, unknown> = {
      gateway: { port: 9000 },
      plugins: { allow: ["customer-plugin"] },
      tools: { deny: ["exec", "process", "customer-tool"] },
    };

    const result = reconcilePlatformInvariants(config, isolated);

    expect(result.changedPaths).toContain("gateway.controlUi.basePath");
    expect(platformInvariantViolations(config, isolated)).toEqual([]);
    expect(config).toMatchObject({
      gateway: {
        port: 18789,
        mode: "local",
        bind: "lan",
        auth: { mode: "token" },
        controlUi: {
          basePath: "/g/bender/openclaw",
          allowedOrigins: ["https://api.octogee.com"],
          allowInsecureAuth: false,
          dangerouslyDisableDeviceAuth: false,
          dangerouslyAllowHostHeaderOriginFallback: false,
        },
        terminal: { enabled: false },
      },
      logging: { redactSensitive: "tools" },
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
        deny: ["customer-tool"],
        elevated: { enabled: false },
      },
      plugins: { allow: expect.arrayContaining(["customer-plugin", "octogee-chat-tools"]) },
    });
    expect(config).toMatchObject({
      plugins: {
        entries: {
          "octogee-chat-tools": {
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

  it("reports exact invariant paths through the shared typed policy error", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, isolated);
    (config.gateway as Record<string, unknown>).port = 9999;
    ((config.gateway as Record<string, unknown>).controlUi as Record<string, unknown>).basePath = "/wrong";

    expect(() => assertPlatformInvariants(config, isolated)).toThrowError(
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
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
    });
    expect((config.gateway as Record<string, unknown>)).not.toHaveProperty("controlUi.basePath");
  });

  it("exposes the same exact paths to RPC and filesystem consumers", () => {
    expect(platformInvariantTable(isolated).map((entry) => entry.path)).toEqual(
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
        "tools.elevated.enabled",
      ]),
    );
  });

  it("treats reordered invariant object keys as semantically equal", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, isolated);
    const plugins = config.plugins as Record<string, unknown>;
    const entries = plugins.entries as Record<string, Record<string, unknown>>;
    entries["octogee-chat-tools"].config = {
      customersRoot: "${CUSTOMERS_DIR}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      brokerUrl: "${FLEET_BROKER_URL}",
      siteUrl: "${MM_SITE_URL}",
    };

    expect(platformInvariantViolations(config, isolated)).not.toContain(
      "plugins.entries.octogee-chat-tools.config",
    );
  });
});
