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
      "tools.exec",
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
      plugins: { enabled: true, allow: expect.arrayContaining(["customer-plugin", "mattermost"]) },
      tools: { deny: ["customer-deny"] },
    });
  });

  it("reports every violated path in a typed policy error without mutating the candidate", () => {
    const candidate = config();
    const before = structuredClone(candidate);

    expect(() => assertPlatformInvariants(candidate, env)).toThrowError(
      expect.objectContaining<Partial<PlatformInvariantPolicyError>>({
        code: "platform-invariant-violation",
        paths: expect.arrayContaining(["gateway.port", "plugins.allow", "tools.exec"]),
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
