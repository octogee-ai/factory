import { describe, expect, it, vi } from "vitest";
import { OpenclawWireError } from "./gateway-rpc.js";
import {
  OpenClawSecretsApplyError,
  applyOpenClawSecretsPlan,
  authProfileApiKeyTarget,
  buildOpenClawSecretsPlan,
  type OpenClawSecretsPlan,
} from "./openclaw-secrets-apply.js";

function target() {
  return authProfileApiKeyTarget({
    agentId: "octogee-alice-coach",
    profileId: "anthropic:default",
    provider: "anthropic",
    refId: "agent-model-token-octogee-alice-coach",
  });
}

function plan(): OpenClawSecretsPlan {
  return buildOpenClawSecretsPlan([target()], () => new Date("2026-08-07T00:00:00.000Z"));
}

function makeRpc(overrides?: { secretsApply?: ReturnType<typeof vi.fn> }) {
  return {
    secretsApply:
      overrides?.secretsApply ?? vi.fn(async () => ({ mode: "write", changed: true })),
    close: vi.fn(async () => {}),
  };
}

describe("authProfileApiKeyTarget", () => {
  it("addresses the profile's key by path and carries the exec ref the resolver answers", () => {
    expect(target()).toEqual({
      type: "auth-profiles.api_key.key",
      path: "profiles.anthropic:default.key",
      ref: {
        source: "exec",
        provider: "gcp-secret-manager",
        id: "agent-model-token-octogee-alice-coach",
      },
      agentId: "octogee-alice-coach",
      authProfileProvider: "anthropic",
    });
  });
});

describe("buildOpenClawSecretsPlan", () => {
  it("stamps the manual plan envelope openclaw's secrets apply expects", () => {
    expect(plan()).toEqual({
      version: 1,
      protocolVersion: 1,
      generatedAt: "2026-08-07T00:00:00.000Z",
      generatedBy: "manual",
      targets: [target()],
    });
  });
});

describe("applyOpenClawSecretsPlan", () => {
  it("sends the plan through the gateway secrets.apply RPC", async () => {
    const rpc = makeRpc();

    await applyOpenClawSecretsPlan(plan(), { rpc });

    expect(rpc.secretsApply).toHaveBeenCalledWith({ plan: plan() });
  });

  it("wraps a gateway refusal as a deferrable apply error", async () => {
    const rpc = makeRpc({
      secretsApply: vi
        .fn()
        .mockRejectedValue(
          new OpenclawWireError("rpc-error", "secrets.apply failed: provider refused"),
        ),
    });

    await expect(applyOpenClawSecretsPlan(plan(), { rpc })).rejects.toThrow(
      OpenClawSecretsApplyError,
    );
    await expect(applyOpenClawSecretsPlan(plan(), { rpc })).rejects.toThrow(
      /provider refused/,
    );
  });

  it("wraps a transport failure as a deferrable apply error (pre-boot gateway)", async () => {
    const rpc = makeRpc({
      secretsApply: vi
        .fn()
        .mockRejectedValue(new OpenclawWireError("connect-failed", "WS open timed out")),
    });

    await expect(applyOpenClawSecretsPlan(plan(), { rpc })).rejects.toThrow(
      /WS open timed out/,
    );
  });

  it("rethrows non-wire errors untouched", async () => {
    const boom = new TypeError("bad plan construction");
    const rpc = makeRpc({ secretsApply: vi.fn().mockRejectedValue(boom) });

    await expect(applyOpenClawSecretsPlan(plan(), { rpc })).rejects.toBe(boom);
  });

  it("does not call the gateway at all for an empty plan", async () => {
    const rpc = makeRpc();

    await applyOpenClawSecretsPlan(buildOpenClawSecretsPlan([]), { rpc });

    expect(rpc.secretsApply).not.toHaveBeenCalled();
  });

  it("leaves an injected client open for the caller to manage", async () => {
    const rpc = makeRpc();

    await applyOpenClawSecretsPlan(plan(), { rpc });

    expect(rpc.close).not.toHaveBeenCalled();
  });
});
