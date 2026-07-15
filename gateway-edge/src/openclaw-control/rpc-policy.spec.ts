import { describe, expect, it } from "vitest";
import { reconcilePlatformInvariants } from "@octogee/core/system-config-invariants";

import {
  OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS,
  evaluateOpenClawControlRpc,
  installedMethodsFromHello,
  openClawConfigSnapshotFromGetResponse,
  pinnedOpenClawRuntimeMatches,
} from "./rpc-policy.js";

const invariantContext = {
  gatewayClass: "operator" as const,
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
    const decision = evaluateOpenClawControlRpc(request("config.patch", {
      raw: JSON.stringify({ agents: { list: [{ id: "main", name: "Updated" }] } }),
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
