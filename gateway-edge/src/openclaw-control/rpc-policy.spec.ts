import { describe, expect, it } from "vitest";
import { reconcilePlatformInvariants } from "@octogee/core/system-config-invariants";
import delegatedInventory from "./openclaw-2026.7.1-delegated-dashboard-inventory.json" with { type: "json" };

import {
  OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS,
  evaluateDelegatedOpenClawControlRpc,
  projectOpenClawHelloForProfile,
  projectOpenClawServerFrameForProfile,
  evaluateOpenClawControlRpc,
  evaluateOpenClawControlRpcForProfile,
  installedMethodsFromHello,
  openClawConfigSnapshotFromGetResponse,
  pinnedOpenClawRuntimeMatches,
} from "./rpc-policy.js";

const invariantContext = {
  gatewayClass: "builder" as const,
  gatewayId: "bender",
  apiOrigin: "https://api.octogee.com",
};

function request(method: string, params: Record<string, unknown> = {}) {
  return { type: "req", id: "rpc-1", method, params };
}

function validConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const config = structuredClone(extra);
  reconcilePlatformInvariants(config, invariantContext);
  return config;
}

function policyContext(extra: Record<string, unknown> = {}) {
  return {
    installedMethods: new Set(OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS),
    invariantContext,
    ...extra,
  };
}

describe("OpenClaw Dashboard RPC policy", () => {
  it("retains delegated restrictions while owners use the sanitized policy", () => {
    const unsafeDelegatedRead = request("config.patch", {
      raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 30 } } }),
      baseHash: "hash-1",
    });
    const context = policyContext({
      currentConfig: { raw: validConfig(), hash: "hash-1" },
    });

    expect(evaluateOpenClawControlRpcForProfile(
      unsafeDelegatedRead,
      context,
      "delegated-read",
    )).toMatchObject({ allowed: false, reason: "method-unavailable" });
    expect(evaluateOpenClawControlRpcForProfile(
      request("tools.invoke", { name: "exec", args: { command: "id" } }),
      context,
      "native-owner",
    )).toMatchObject({ allowed: false, reason: "tool-denied" });
  });


  it("fails closed unless hello advertises the exact pinned runtime method set", () => {
    const methods = [...OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS];
    const hello = {
      type: "res",
      ok: true,
      payload: { type: "hello-ok", features: { methods } },
    };
    expect(installedMethodsFromHello(hello)).toEqual(new Set(methods));
    expect(pinnedOpenClawRuntimeMatches(new Set(methods))).toBe(true);
    expect(pinnedOpenClawRuntimeMatches(new Set(methods.slice(1)))).toBe(false);
    expect(pinnedOpenClawRuntimeMatches(new Set([...methods, "future.write"]))).toBe(false);
    expect(evaluateOpenClawControlRpc(request("config.get"), {
      ...policyContext(),
      installedMethods: new Set(methods.slice(1)),
    })).toMatchObject({ allowed: false, reason: "runtime-drift", category: "unknown" });
  });

  it("allows only pinned reads plus the three native config mutation methods", () => {
    for (const method of [
      "health",
      "status",
      "system.info",
      "gateway.identity.get",
      "config.get",
      "config.schema",
      "config.schema.lookup",
      "models.list",
      "agents.list",
      "channels.status",
      "tools.catalog",
      "tools.effective",
      "skills.status",
    ]) {
      expect(evaluateOpenClawControlRpc(request(method), policyContext()), method)
        .toMatchObject({ allowed: true, category: "read" });
    }
    for (const method of [
      "update.run",
      "gateway.restart.request",
      "plugins.install",
      "terminal.open",
      "wizard.start",
      "agents.update",
      "agents.files.set",
      "plugins.sessionAction",
      "channels.start",
      "sessions.patch",
      "cron.add",
      "future.write",
    ]) {
      expect(evaluateOpenClawControlRpc(request(method), policyContext()), method)
        .toMatchObject({ allowed: false, category: "forbidden_mutation" });
    }
  });

  it("gives viewers reads only and Trusted Helpers invariant-safe config without tools", () => {
    expect(evaluateDelegatedOpenClawControlRpc(
      request("status"),
      policyContext(),
      "delegated-read",
    )).toMatchObject({ allowed: true, category: "read" });
    expect(evaluateDelegatedOpenClawControlRpc(
      request("config.patch", { raw: "{}", baseHash: "hash" }),
      policyContext(),
      "delegated-read",
    )).toMatchObject({ allowed: false, category: "config_mutation" });
    expect(evaluateDelegatedOpenClawControlRpc(
      request("tools.invoke", { name: "memory_search", args: { query: "safe" } }),
      policyContext(),
      "delegated-config",
    )).toMatchObject({ allowed: false, category: "tools_invoke" });
  });

  it("pins the captured delegated Dashboard inventory to the exact runtime contract", () => {
    expect(delegatedInventory.runtimeVersion).toBe("2026.7.1");
    expect(delegatedInventory.capturedRoutes).toEqual([
      "/overview", "/agents", "/channels", "/models", "/config",
    ]);
    expect(delegatedInventory.delegatedConfigMethods).toEqual([
      ...delegatedInventory.delegatedReadMethods,
      "config.set",
      "config.apply",
      "config.patch",
    ]);
    for (const method of [
      ...delegatedInventory.delegatedConfigMethods,
      ...delegatedInventory.explicitlyExcludedMethods,
    ]) {
      expect(OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS).toContain(method);
    }
    expect(delegatedInventory.explicitlyExcludedMethods).toEqual(expect.arrayContaining([
      "tools.invoke", "sessions.list", "terminal.open", "secrets.resolve",
    ]));
  });

  it("filters hello discovery to the exact methods honest for each delegated profile", () => {
    const hello = {
      type: "res",
      ok: true,
      payload: {
        type: "hello-ok",
        features: { methods: [...OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS] },
      },
    };
    const viewer = projectOpenClawHelloForProfile(hello, "delegated-read");
    const helper = projectOpenClawHelloForProfile(hello, "delegated-config");
    expect((viewer.payload as any).features.methods).toContain("config.get");
    expect((viewer.payload as any).features.methods).not.toContain("config.patch");
    expect((helper.payload as any).features.methods).toContain("config.patch");
    expect((helper.payload as any).features.methods).not.toContain("tools.invoke");
    expect((helper.payload as any).features.octogeeAccess).toEqual({
      profile: "delegated-config",
      canConfigure: true,
      canUseShell: false,
    });
  });

  it("preserves native baseHash and replacePaths while validating the exact proposed candidate", () => {
    const current = validConfig({
      agents: {
        list: [
          { id: "main", name: "Main", workspace: "/main" },
          { id: "coach", name: "Coach" },
        ],
      },
    });
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });
    const currentMain = ((current.agents as { list: Record<string, unknown>[] }).list[0]);
    const decision = evaluateOpenClawControlRpc(request("config.patch", {
      raw: JSON.stringify({ agents: { list: [{ ...currentMain, name: "Updated" }] } }),
      baseHash: "hash-1",
      replacePaths: ["agents.list"],
    }), context);
    expect(decision).toMatchObject({ allowed: true, category: "config_mutation" });
    expect(decision.outbound).toMatchObject({
      params: { baseHash: "hash-1", replacePaths: ["agents.list"] },
    });
    expect(decision.proposedConfig).toMatchObject({
      agents: { list: [{ id: "main", name: "Updated" }] },
    });
    expect(evaluateOpenClawControlRpc(request("config.apply", {
      raw: JSON.stringify(current),
      baseHash: "hash-1",
      sessionKey: "agent:main:web:dm:current",
    }), context)).toMatchObject({ allowed: true, category: "config_mutation" });
    expect(evaluateOpenClawControlRpc(request("config.patch", {
      raw: "{}",
      baseHash: "hash-1",
      sessionKey: "agent:main:web:dm:current",
      note: "native-ui",
    }), context)).toMatchObject({ allowed: true, category: "config_mutation" });

    expect(evaluateOpenClawControlRpc(request("config.patch", {
      raw: "{}",
      baseHash: "stale",
      replacePaths: [],
    }), context)).toMatchObject({ allowed: false, reason: "config-base-mismatch" });
    expect(evaluateOpenClawControlRpc(request("config.patch", {
      raw: "{}",
      baseHash: "hash-1",
      replacePaths: [],
      unvalidatedNativeOption: true,
    }), context)).toMatchObject({ allowed: false, reason: "config-invalid" });
    expect(evaluateOpenClawControlRpc(request("config.patch", {
      raw: JSON.stringify({ gateway: { bind: "loopback" } }),
      baseHash: "hash-1",
      replacePaths: [],
    }), context)).toMatchObject({ allowed: false, reason: "platform-invariant" });
    expect(evaluateOpenClawControlRpc(request("config.set", {
      raw: JSON.stringify(current),
      baseHash: "hash-1",
      replacePaths: [],
    }), { ...context, configFrozen: true })).toMatchObject({
      allowed: false,
      reason: "config-frozen",
    });
  });

  it("captures only raw config plus its optimistic hash from config.get", () => {
    const source = validConfig({ agents: { defaults: { timeoutSeconds: 30 } } });
    expect(openClawConfigSnapshotFromGetResponse({
      type: "res",
      id: "rpc-1",
      ok: true,
      payload: {
        raw: JSON.stringify(source),
        hash: "hash-1",
        resolved: { secret: "not-the-source" },
      },
    }, "config.get")).toEqual({ raw: source, hash: "hash-1" });
    expect(openClawConfigSnapshotFromGetResponse({
      type: "res",
      ok: true,
      payload: { raw: "{}" },
    }, "config.get")).toBeNull();
  });

  it("projects delegated config reads without secret, resolved, sentinel, or unknown fields", () => {
    const frame = {
      type: "res",
      id: "config-read",
      ok: true,
      payload: {
        hash: "hash-1",
        raw: JSON.stringify({
          agents: {
            defaults: { model: { primary: "anthropic/claude" }, timeoutSeconds: 30 },
            list: [{ id: "main", name: "Main", model: "anthropic/claude" }],
          },
          models: {
            providers: {
              anthropic: { apiKey: "__OPENCLAW_REDACTED__", baseUrl: "https://api.example" },
            },
          },
        }),
        resolved: { apiKey: "owner-secret" },
        future: { nestedCredential: "owner-secret" },
      },
    };

    const projected = projectOpenClawServerFrameForProfile(
      frame,
      "config.get",
      "delegated-config",
    );
    expect(projected).not.toBeNull();
    const payload = projected!.payload as Record<string, unknown>;
    const raw = JSON.parse(String(payload.raw));

    expect(payload).toEqual({ hash: "hash-1", raw: expect.any(String) });
    expect(raw).toEqual({
      agents: {
        defaults: { model: { primary: "anthropic/claude" }, timeoutSeconds: 30 },
        list: [{ id: "main", name: "Main", model: "anthropic/claude" }],
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/REDACTED|owner-secret|baseUrl/u);
  });

  it("projects the keyed roster with the exact field policy the list form gets", () => {
    const projected = projectOpenClawServerFrameForProfile({
      type: "res",
      id: "config-read",
      ok: true,
      payload: {
        hash: "hash-1",
        raw: JSON.stringify({
          agents: {
            defaults: { model: { primary: "anthropic/claude" } },
            entries: {
              "octogee-ceckert-coach": {
                name: "Coach",
                default: true,
                model: { primary: "anthropic/claude", fallbacks: ["openai/gpt-5"] },
                workspace: "/workspace/ceckert",
                memorySearch: { remote: { apiKey: "owner-secret" } },
              },
              "octogee-ops-gw-bender": { model: "openai/gpt-5" },
              "octogee-blank-coach": { workspace: "/workspace/blank" },
            },
          },
        }),
      },
    }, "config.get", "delegated-config");

    expect(JSON.parse(String((projected!.payload as Record<string, unknown>).raw))).toEqual({
      agents: {
        defaults: { model: { primary: "anthropic/claude" } },
        entries: {
          "octogee-ceckert-coach": {
            name: "Coach",
            default: true,
            model: { primary: "anthropic/claude", fallbacks: ["openai/gpt-5"] },
          },
          "octogee-ops-gw-bender": { model: "openai/gpt-5" },
          "octogee-blank-coach": {},
        },
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/owner-secret|workspace/u);
  });

  it("drops roster keys and entry fields a hostile keyed config could smuggle through", () => {
    const projected = projectOpenClawServerFrameForProfile({
      type: "res",
      id: "config-read",
      ok: true,
      payload: {
        hash: "hash-1",
        raw: JSON.stringify({
          agents: {
            entries: {
              __OPENCLAW_REDACTED__: { name: "Sentinel" },
              ["__proto__"]: { name: "Polluted" },
              "": { name: "Empty" },
              [`octogee-${"a".repeat(260)}-coach`]: { name: "Oversized" },
              "octogee-gone-coach": null,
              "octogee-scalar-coach": "not-an-entry",
              "octogee-live-coach": {
                name: "__OPENCLAW_REDACTED__",
                default: "yes",
                model: {
                  primary: "__OPENCLAW_REDACTED__",
                  fallbacks: ["openai/gpt-5", "__OPENCLAW_REDACTED__"],
                },
              },
            },
          },
        }),
      },
    }, "config.get", "delegated-config");

    const raw = JSON.parse(String((projected!.payload as Record<string, unknown>).raw));
    expect(raw).toEqual({
      agents: {
        entries: {
          "octogee-live-coach": { model: { fallbacks: ["openai/gpt-5"] } },
        },
      },
    });
    expect(Object.getPrototypeOf(raw.agents.entries)).toBe(Object.prototype);
    expect(JSON.stringify(projected)).not.toMatch(/REDACTED|Polluted|Sentinel|Oversized/u);
  });

  it("projects both roster shapes when a migrated config still carries the stale list", () => {
    const projected = projectOpenClawServerFrameForProfile({
      type: "res",
      id: "config-read",
      ok: true,
      payload: {
        hash: "hash-1",
        raw: JSON.stringify({
          agents: {
            entries: { "octogee-new-coach": { name: "New", workspace: "/workspace/new" } },
            list: [{ id: "octogee-stale-coach", name: "Stale", workspace: "/workspace/stale" }],
          },
        }),
      },
    }, "config.get", "delegated-config");

    expect(JSON.parse(String((projected!.payload as Record<string, unknown>).raw))).toEqual({
      agents: {
        entries: { "octogee-new-coach": { name: "New" } },
        list: [{ id: "octogee-stale-coach", name: "Stale" }],
      },
    });
  });

  it("projects delegated model reads through a strict display-safe schema", () => {
    const projected = projectOpenClawServerFrameForProfile({
      type: "res",
      id: "models-read",
      ok: true,
      payload: {
        models: [{
          id: "anthropic/claude",
          name: "Claude",
          provider: "anthropic",
          contextWindow: 200_000,
          baseUrl: "https://attacker.example",
          apiKey: "owner-secret",
          future: { nestedToken: "owner-secret" },
        }],
        future: { credential: "owner-secret" },
      },
    }, "models.list", "delegated-read");

    expect(projected).toEqual({
      type: "res",
      id: "models-read",
      ok: true,
      payload: {
        models: [{
          id: "anthropic/claude",
          name: "Claude",
          provider: "anthropic",
          contextWindow: 200_000,
        }],
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/owner-secret|attacker|future/u);
  });

  it("drops unsolicited delegated frames and strips matched mutation responses", () => {
    const pushed = {
      type: "event",
      event: "session.updated",
      payload: { conversation: "private", token: "owner-secret" },
    };
    expect(projectOpenClawServerFrameForProfile(
      pushed,
      undefined,
      "delegated-config",
    )).toBeNull();
    expect(projectOpenClawServerFrameForProfile(
      pushed,
      undefined,
      "native-owner",
    )).toEqual(pushed);
    expect(projectOpenClawServerFrameForProfile({
      type: "res",
      id: "config-write",
      ok: true,
      payload: { accepted: true, resolved: { token: "owner-secret" } },
    }, "config.patch", "delegated-config")).toEqual({
      type: "res",
      id: "config-write",
      ok: true,
    });
  });

  it("lets helpers edit existing agent labels and models but not agent identity or default routing", () => {
    const current = validConfig({
      agents: {
        list: [{ id: "main", name: "Main", default: true, model: "openai/gpt-5" }],
      },
    });
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });
    const decide = (list: Record<string, unknown>[]) => evaluateDelegatedOpenClawControlRpc(
      request("config.patch", {
        raw: JSON.stringify({ agents: { list } }),
        baseHash: "hash-1",
      }),
      context,
      "delegated-config",
    );

    expect(decide([{ id: "main", name: "Primary", model: "openai/gpt-5.1" }]))
      .toMatchObject({ allowed: true });
    expect(decide([{ id: "helper", name: "Helper", model: "openai/gpt-5.1" }]))
      .toMatchObject({ allowed: false, reason: "platform-invariant" });
    expect(decide([{ id: "main", default: false }]))
      .toMatchObject({ allowed: false, reason: "config-unsafe-path" });
    expect(decide([
      { id: "main" },
      { id: "helper", name: "Helper", model: "openai/gpt-5.1" },
    ])).toMatchObject({ allowed: false, reason: "platform-invariant" });
  });

  it("lets helpers edit keyed roster labels and models but never roster membership", () => {
    const current = validConfig({
      agents: {
        entries: {
          "octogee-ceckert-coach": {
            name: "Coach",
            model: "openai/gpt-5",
            workspace: "/workspace/ceckert",
          },
          "octogee-aug04-coach": { name: "Aug04", model: "openai/gpt-5" },
        },
      },
    });
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });
    const decide = (entries: Record<string, unknown>) => evaluateDelegatedOpenClawControlRpc(
      request("config.patch", {
        raw: JSON.stringify({ agents: { entries } }),
        baseHash: "hash-1",
      }),
      context,
      "delegated-config",
    );

    expect(decide({ "octogee-ceckert-coach": { name: "Primary" } }))
      .toMatchObject({ allowed: true });
    expect(decide({
      "octogee-ceckert-coach": {
        model: { primary: "openai/gpt-5.1", fallbacks: ["anthropic/claude"] },
      },
    })).toMatchObject({ allowed: true });
    expect(decide({ "octogee-ceckert-coach": { workspace: "/workspace/attacker" } }))
      .toMatchObject({ allowed: false, reason: "config-unsafe-path" });
    expect(decide({ "octogee-ceckert-coach": { default: false } }))
      .toMatchObject({ allowed: false, reason: "config-unsafe-path" });
    expect(decide({ "octogee-helper-coach": { name: "Helper", model: "openai/gpt-5.1" } }))
      .toMatchObject({ allowed: false, reason: "platform-invariant" });
    expect(decide({ "octogee-aug04-coach": null }))
      .toMatchObject({ allowed: false, reason: "config-unsafe-path" });
    expect(decide({ "octogee-ceckert-coach": [{ name: "Smuggled" }] }))
      .toMatchObject({ allowed: false, reason: "config-unsafe-path" });
  });

  it("projects config schema to editable safe paths and rejects unsafe schema lookups", () => {
    const projected = projectOpenClawServerFrameForProfile({
      type: "res",
      id: "schema-read",
      ok: true,
      payload: {
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                defaults: {
                  type: "object",
                  properties: {
                    timeoutSeconds: { type: "number", minimum: 1, description: "Timeout" },
                    workspace: { type: "string", description: "Secret filesystem path" },
                  },
                },
              },
            },
            models: {
              type: "object",
              properties: { providers: { type: "object", additionalProperties: true } },
            },
          },
        },
        uiHints: { "models.providers.*.apiKey": { secret: true } },
        future: { credential: "owner-secret" },
      },
    }, "config.schema", "delegated-config");

    expect(projected).toEqual({
      type: "res",
      id: "schema-read",
      ok: true,
      payload: {
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                defaults: {
                  type: "object",
                  properties: {
                    timeoutSeconds: { type: "number", minimum: 1, description: "Timeout" },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(evaluateDelegatedOpenClawControlRpc(
      request("config.schema.lookup", { path: "models.providers.anthropic.apiKey" }),
      policyContext(),
      "delegated-config",
    )).toMatchObject({ allowed: false, reason: "method-unavailable" });
    expect(evaluateDelegatedOpenClawControlRpc(
      request("config.schema.lookup", { path: "agents.defaults.timeoutSeconds" }),
      policyContext(),
      "delegated-config",
    )).toMatchObject({ allowed: true, category: "read" });
  });

  it("opens the keyed roster schema branch to exactly the fields the list branch exposes", () => {
    const projected = projectOpenClawServerFrameForProfile({
      type: "res",
      id: "schema-read",
      ok: true,
      payload: {
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                entries: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      name: { type: "string", title: "Name" },
                      model: {
                        type: "object",
                        properties: {
                          primary: { type: "string" },
                          fallbacks: { type: "array", items: { type: "string" } },
                        },
                      },
                      workspace: { type: "string", description: "Secret filesystem path" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }, "config.schema", "delegated-config");

    expect(projected).toEqual({
      type: "res",
      id: "schema-read",
      ok: true,
      payload: {
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                entries: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      name: { type: "string", title: "Name" },
                      model: {
                        type: "object",
                        properties: {
                          primary: { type: "string" },
                          fallbacks: { type: "array", items: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    for (const path of [
      "agents.entries.octogee-ceckert-coach.name",
      "agents.entries.octogee-ceckert-coach.model",
      "agents.entries.octogee-ceckert-coach.model.primary",
      "agents.entries.octogee-ceckert-coach.model.fallbacks",
    ]) {
      expect(evaluateDelegatedOpenClawControlRpc(
        request("config.schema.lookup", { path }),
        policyContext(),
        "delegated-config",
      ), path).toMatchObject({ allowed: true, category: "read" });
    }
    for (const path of [
      "agents.entries.octogee-ceckert-coach.workspace",
      "agents.entries.octogee-ceckert-coach.sandbox.docker.setupCommand",
      "agents.entries.octogee-ceckert-coach.memorySearch.remote.apiKey",
      "agents.entries..name",
      "agents.entries[0].name",
    ]) {
      expect(evaluateDelegatedOpenClawControlRpc(
        request("config.schema.lookup", { path }),
        policyContext(),
        "delegated-config",
      ), path).toMatchObject({ allowed: false, reason: "method-unavailable" });
    }
  });

  it("preserves native redaction sentinels for OpenClaw to restore from its unredacted snapshot", () => {
    const current = validConfig({
      models: {
        providers: {
          anthropic: { apiKey: "__OPENCLAW_REDACTED__" },
        },
      },
    });
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });
    const decision = evaluateOpenClawControlRpc(request("config.set", {
      raw: JSON.stringify(current),
      baseHash: "hash-1",
    }), context);

    expect(decision).toMatchObject({ allowed: true, category: "config_mutation" });
    const outboundParams = decision.outbound?.params as Record<string, unknown>;
    expect(JSON.parse(String(outboundParams.raw))).toMatchObject({
      models: { providers: { anthropic: { apiKey: "__OPENCLAW_REDACTED__" } } },
    });
  });

  it("denies delegated provider endpoint changes beside preserved credentials", () => {
    const current = validConfig({
      models: {
        providers: {
          anthropic: {
            apiKey: "__OPENCLAW_REDACTED__",
            baseUrl: "https://api.anthropic.com",
          },
        },
      },
    });
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });

    expect(evaluateDelegatedOpenClawControlRpc(request("config.patch", {
      raw: JSON.stringify({
        models: { providers: { anthropic: { baseUrl: "https://attacker.example" } } },
      }),
      baseHash: "hash-1",
    }), context, "delegated-config")).toMatchObject({
      allowed: false,
      reason: "config-unsafe-path",
    });
  });

  it("fails closed when a full or replacement mutation structurally shifts a sentinel-bearing array", () => {
    const current = validConfig({
      agents: {
        list: [
          {
            id: "alpha",
            name: "Alpha",
            memorySearch: {
              remote: {
                apiKey: {
                  source: "exec",
                  provider: "gcp-secret-manager",
                  id: "__OPENCLAW_REDACTED__",
                },
              },
            },
          },
          {
            id: "beta",
            name: "Beta",
            memorySearch: {
              remote: {
                apiKey: {
                  source: "exec",
                  provider: "gcp-secret-manager",
                  id: "__OPENCLAW_REDACTED__",
                },
              },
            },
          },
        ],
      },
    });
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });
    const withAgents = (agents: unknown[]) => ({
      ...structuredClone(current),
      agents: { list: agents },
    });
    const alpha = structuredClone((current.agents as { list: unknown[] }).list[0]);
    const beta = structuredClone((current.agents as { list: unknown[] }).list[1]);

    expect(evaluateOpenClawControlRpc(request("config.apply", {
      raw: JSON.stringify(withAgents([beta])),
      baseHash: "hash-1",
    }), context)).toMatchObject({
      allowed: false,
      reason: "redacted-array-structural-edit",
    });
    expect(evaluateOpenClawControlRpc(request("config.set", {
      raw: JSON.stringify(withAgents([beta, alpha])),
      baseHash: "hash-1",
    }), context)).toMatchObject({
      allowed: false,
      reason: "redacted-array-structural-edit",
    });
    expect(evaluateOpenClawControlRpc(request("config.patch", {
      raw: JSON.stringify({ agents: { list: [beta] } }),
      baseHash: "hash-1",
      replacePaths: ["agents.list"],
    }), context)).toMatchObject({
      allowed: false,
      reason: "redacted-array-structural-edit",
    });
  });

  it("allows scalar and object edits when sentinel-bearing array identities stay positionally stable", () => {
    const current = validConfig({
      agents: {
        list: [{
          id: "alpha",
          name: "Alpha",
          memorySearch: {
            remote: {
              apiKey: {
                source: "exec",
                provider: "gcp-secret-manager",
                id: "__OPENCLAW_REDACTED__",
              },
            },
          },
        }],
      },
    });
    const proposed = structuredClone(current);
    (proposed.agents as { list: Array<Record<string, unknown>> }).list[0].name = "Renamed";
    (proposed.agents as { list: Array<Record<string, unknown>> }).list[0].workspace = "/workspace/alpha";
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });

    expect(evaluateOpenClawControlRpc(request("config.apply", {
      raw: JSON.stringify(proposed),
      baseHash: "hash-1",
    }), context)).toMatchObject({ allowed: true, category: "config_mutation" });
  });

  it("allows tools.invoke only for three exact safe schemas and categorizes without the tool name", () => {
    const allowed = [
      request("tools.invoke", {
        name: "memory_search",
        args: { query: "prior decision", maxResults: 5, minScore: 0.3, corpus: "memory" },
      }),
      request("tools.invoke", {
        name: "session_status",
        args: { sessionKey: "current", changesSince: 0 },
      }),
      request("tools.invoke", {
        name: "web_search",
        args: { query: "current OpenClaw release", count: 5, freshness: "week" },
      }),
    ];
    for (const frame of allowed) {
      expect(evaluateOpenClawControlRpc(frame, policyContext()))
        .toMatchObject({ allowed: true, category: "tools_invoke" });
    }

    for (const name of [
      "memory_get",
      "read",
      "write",
      "exec",
      "process",
      "terminal",
      "web_fetch",
      "browser",
      "message",
      "agents_list",
      "plugins.install",
      "octogee_chat_history",
    ]) {
      expect(evaluateOpenClawControlRpc(request("tools.invoke", { name, args: {} }), policyContext()), name)
        .toMatchObject({ allowed: false, category: "tools_invoke", reason: "tool-denied" });
    }
    expect(evaluateOpenClawControlRpc(request("tools.invoke", {
      name: "session_status",
      args: { sessionKey: "current", model: "secret-provider/model" },
    }), policyContext())).toMatchObject({ allowed: false, reason: "tool-schema-invalid" });
    expect(evaluateOpenClawControlRpc(request("tools.invoke", {
      name: "web_search",
      args: { query: "safe", url: "http://169.254.169.254" },
    }), policyContext())).toMatchObject({ allowed: false, reason: "tool-schema-invalid" });
  });
});
