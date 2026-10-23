import { describe, expect, it, vi } from "vitest";

import {
  configuredAnthropicModelCredentialResolution,
  createAnthropicProviderKeyResolver,
  createModelBrokerProviderKeyResolver,
} from "../lib/model-broker-provider-keys.js";
import type { ModelBrokerTokenRecord } from "../lib/model-broker-tokens.js";

const record: ModelBrokerTokenRecord = {
  tokenHash: "hash",
  gatewayId: "jack",
  ownerUid: "uid-jack",
  provider: "anthropic",
  capped: true,
  secretName: "gateway-model-key-jack",
  createdAt: 1_000,
  expiresAt: null,
  limits: { spendWindowUsd: null, requestsPerMinute: null },
  revoked: false,
};

function gatewayRoot(gatewayClass: "shared" | "builder" = "builder"): Record<string, unknown> {
  return {
    gatewayId: "jack", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: gatewayClass === "builder" ? "builder" : null, gatewayClass,
    imageProfile: gatewayClass === "builder" ? "builder" : "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: gatewayClass === "builder" ? "uid-jack" : null,
    builderSlug: gatewayClass === "builder" ? "smile-wring-011b" : null,
    modelBrokerLimits: null, preemption: null,
  };
}

function fakeDb(docs: Record<string, Record<string, unknown> | undefined>) {
  const docRef = (path: string): unknown => ({
    get: async () => ({
      exists: docs[path] !== undefined,
      data: () => docs[path],
    }),
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${path}/${name}/${id}`),
    }),
  });
  return {
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${name}/${id}`),
    }),
    doc: docRef,
  };
}

describe("createAnthropicProviderKeyResolver", () => {
  it.each(["shared", "missing", "reassigned", "changed-during-secret", "parked-owner", "moved-during-secret", "revoked-during-secret"] as const)("keeps customer keys behind current Builder authority: %s", async state => {
    const docs: Record<string, Record<string, unknown> | undefined> = {
      "gateways/jack": state === "missing" ? undefined : { ...gatewayRoot(state === "shared" ? "shared" : "builder"), ...(state === "reassigned" ? { ownerUid: "different-owner" } : {}) },
      "users/uid-jack": { username: "smile-wring-011b", provisioning: { openclaw: { gatewayId: state === "parked-owner" ? "shared-1" : "jack" } } },
      "users/uid-jack/system/config": { modelCredential: { active: true, provider: "anthropic", mode: "api_key", secretName: "byok-smile-wring-011b-anthropic" } },
    };
    const readSecret = vi.fn(async () => {
      if (state === "changed-during-secret") docs["gateways/jack"] = gatewayRoot("shared");
      if (state === "moved-during-secret") docs["users/uid-jack"] = { username: "smile-wring-011b", provisioning: { openclaw: { gatewayId: "shared-1" } } };
      if (state === "revoked-during-secret") docs["users/uid-jack/system/config"] = { modelCredential: { active: false } };
      return "synthetic-owner-key";
    });
    const resolver = createModelBrokerProviderKeyResolver({ db: fakeDb(docs) as never, platformKeys: { anthropic: "synthetic-platform-key" }, readSecret });
    const result = await resolver({ provider: "anthropic", record });
    expect(result).toEqual(state === "shared" ? { apiKey: "synthetic-platform-key", source: "platform" } : null);
    expect(readSecret).toHaveBeenCalledTimes(state.endsWith("during-secret") ? 1 : 0);
  });


  it("does not select a platform key when durable host authority cannot be read", async () => {
    const readSecret = vi.fn(async () => "synthetic-owner-key");
    const db = fakeDb({
      "users/uid-jack": { username: "smile-wring-011b" },
      "users/uid-jack/system/config": { modelCredential: { active: true, provider: "anthropic", mode: "api_key", secretName: "byok-smile-wring-011b-anthropic" } },
    });
    const resolver = createAnthropicProviderKeyResolver({
      db: { ...db, doc: () => ({ get: async () => { throw new Error("authority unavailable"); } }) } as never,
      platformKey: "synthetic-platform-key", readSecret,
    });
    await expect(resolver({ provider: "anthropic", record })).rejects.toThrow("authority unavailable");
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("serves platform OpenRouter keys from broker environment config", async () => {
    const resolver = createModelBrokerProviderKeyResolver({
      db: fakeDb({}) as never,
      platformKeys: {
        anthropic: "sk-ant-platform",
        openrouter: " sk-or-v1-platform ",
      },
      readSecret: vi.fn(),
    });

    await expect(
      resolver({
        provider: "openrouter",
        record: { ...record, provider: "openrouter" },
      }),
    ).resolves.toEqual({
      apiKey: "sk-or-v1-platform",
      source: "platform",
    });
  });

  it("represents modelCredential source decisions as named outcomes", () => {
    expect(configuredAnthropicModelCredentialResolution(undefined, undefined)).toEqual({
      kind: "platform",
    });
    expect(
      configuredAnthropicModelCredentialResolution(
        { username: "smile-wring-011b" },
        {
          modelCredential: {
            active: false,
            provider: "anthropic",
            mode: "api_key",
            secretName: "byok-smile-wring-011b-anthropic",
          },
        },
      ),
    ).toEqual({ kind: "platform" });
    expect(
      configuredAnthropicModelCredentialResolution(
        { username: "smile-wring-011b" },
        {
          modelCredential: {
            active: true,
            provider: "anthropic",
            mode: "api_key",
            secretName: "byok-other-builder-anthropic",
          },
        },
      ),
    ).toEqual({ kind: "deny" });
    expect(
      configuredAnthropicModelCredentialResolution(
        { username: "smile-wring-011b" },
        {
          modelCredential: {
            active: true,
            provider: "anthropic",
            mode: "api_key",
            secretName: "byok-smile-wring-011b-anthropic",
          },
        },
      ),
    ).toEqual({
      kind: "owner_model_credential",
      secretName: "byok-smile-wring-011b-anthropic",
    });
  });

  it("uses the owner's active Anthropic modelCredential key without legacy byotActive", async () => {
    const readSecret = vi.fn(async () => " sk-ant-owner ");
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "gateways/jack": gatewayRoot(),
        "users/uid-jack": {
          username: "smile-wring-011b",
          provisioning: { openclaw: { slug: "smile-wring-011b", gatewayId: "jack" } },
        },
        "users/uid-jack/system/config": {
          modelCredential: {
            active: true,
            provider: "anthropic",
            mode: "api_key",
            secretName: "byok-smile-wring-011b-anthropic",
          },
        },
      }) as never,
      platformKey: "sk-ant-platform",
      readSecret,
    });

    await expect(resolver({ provider: "anthropic", record })).resolves.toEqual({
      apiKey: "sk-ant-owner",
      source: "owner_model_credential",
      secretName: "byok-smile-wring-011b-anthropic",
    });
    expect(readSecret).toHaveBeenCalledWith("byok-smile-wring-011b-anthropic");
  });

  it("does not revive stale legacy BYOT when modelCredential is inactive", async () => {
    const readSecret = vi.fn(async () => "sk-ant-owner");
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "gateways/jack": gatewayRoot(),
        "users/uid-jack": {
          byotActive: true,
          username: "smile-wring-011b",
          provisioning: { openclaw: { gatewayId: "jack" } },
        },
        "users/uid-jack/system/config": {
          modelCredential: {
            active: false,
            provider: "anthropic",
            mode: "api_key",
            secretName: "byok-smile-wring-011b-anthropic",
          },
          byot: {
            provider: "anthropic",
            secretName: "byok-smile-wring-011b-anthropic",
          },
        },
      }) as never,
      platformKey: " sk-ant-platform ",
      readSecret,
    });

    await expect(resolver({ provider: "anthropic", record })).resolves.toEqual({
      apiKey: "sk-ant-platform",
      source: "platform",
    });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("fails closed on an Anthropic modelCredential secret-name mismatch", async () => {
    const readSecret = vi.fn(async () => "sk-ant-owner");
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "gateways/jack": gatewayRoot(),
        "users/uid-jack": {
          username: "smile-wring-011b",
          provisioning: { openclaw: { gatewayId: "jack" } },
        },
        "users/uid-jack/system/config": {
          modelCredential: {
            active: true,
            provider: "anthropic",
            mode: "api_key",
            secretName: "byok-other-builder-anthropic",
          },
        },
      }) as never,
      platformKey: "sk-ant-platform",
      readSecret,
    });

    await expect(resolver({ provider: "anthropic", record })).resolves.toBeNull();
    expect(readSecret).not.toHaveBeenCalled();
  });

  it.each([
    "byok-smile-wring-011b-anthropic",
    "byok-other-builder-anthropic",
  ])("ignores legacy-only BYOT metadata referencing %s", async (secretName) => {
    const readSecret = vi.fn(async () => " sk-ant-owner ");
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "gateways/jack": gatewayRoot(),
        "users/uid-jack": {
          byotActive: true,
          username: "smile-wring-011b",
          provisioning: { openclaw: { slug: "smile-wring-011b", gatewayId: "jack" } },
        },
        "users/uid-jack/system/config": {
          byot: {
            provider: "anthropic",
            secretName,
          },
        },
      }) as never,
      platformKey: "sk-ant-platform",
      readSecret,
    });

    await expect(resolver({ provider: "anthropic", record })).resolves.toEqual({
      apiKey: "sk-ant-platform",
      source: "platform",
    });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("uses the platform key when another provider is configured", async () => {
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "gateways/jack": gatewayRoot(),
        "users/uid-jack": {
          username: "smile-wring-011b",
          provisioning: { openclaw: { gatewayId: "jack" } },
        },
        "users/uid-jack/system/config": {
          modelCredential: {
            active: true,
            mode: "api_key",
            provider: "openai",
            secretName: "byok-smile-wring-011b-openai",
          },
        },
      }) as never,
      platformKey: " sk-ant-platform ",
      readSecret: vi.fn(),
    });

    await expect(resolver({ provider: "anthropic", record })).resolves.toEqual({
      apiKey: "sk-ant-platform",
      source: "platform",
    });
  });
});
