import { describe, expect, it, vi } from "vitest";

import {
  configuredAnthropicModelCredentialResolution,
  createAnthropicProviderKeyResolver,
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
  };
}

describe("createAnthropicProviderKeyResolver", () => {
  it("represents modelCredential source decisions as named outcomes", () => {
    expect(configuredAnthropicModelCredentialResolution(undefined, undefined)).toEqual({
      kind: "fallback",
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
        "users/uid-jack": {
          username: "smile-wring-011b",
          provisioning: { openclaw: { slug: "smile-wring-011b" } },
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
        "users/uid-jack": {
          byotActive: true,
          username: "smile-wring-011b",
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
        "users/uid-jack": {
          username: "smile-wring-011b",
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

  it("uses the owner's legacy Anthropic BYOT key when active and bound to the owner slug", async () => {
    const readSecret = vi.fn(async () => " sk-ant-owner ");
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "users/uid-jack": {
          byotActive: true,
          username: "smile-wring-011b",
          provisioning: { openclaw: { slug: "smile-wring-011b" } },
        },
        "users/uid-jack/system/config": {
          byot: {
            provider: "anthropic",
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

  it("fails closed on an Anthropic BYOT secret-name mismatch", async () => {
    const readSecret = vi.fn(async () => "sk-ant-owner");
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "users/uid-jack": {
          byotActive: true,
          username: "smile-wring-011b",
        },
        "users/uid-jack/system/config": {
          byot: {
            provider: "anthropic",
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

  it("falls back to the platform key when Anthropic BYOT is not active", async () => {
    const resolver = createAnthropicProviderKeyResolver({
      db: fakeDb({
        "users/uid-jack": {
          byotActive: true,
          username: "smile-wring-011b",
        },
        "users/uid-jack/system/config": {
          byot: { provider: "openai", secretName: "byok-smile-wring-011b-openai" },
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
