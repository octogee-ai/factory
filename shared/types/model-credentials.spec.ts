import { describe, expect, it } from "vitest";
import {
  MODEL_CREDENTIAL_CATALOG,
  MODEL_CREDENTIAL_CONNECTOR_ONLY_PROVIDER_IDS,
  MODEL_CREDENTIAL_MODES,
  MODEL_CREDENTIAL_OAUTH_PROVIDER_IDS,
  MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS,
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
  byosubSecretNameForUser,
  modelCredentialApiKeyState,
  modelCredentialOAuthState,
  modelCredentialOAuthEntryByProviderId,
  modelCredentialOAuthEntryBySubscriptionProvider,
  modelCredentialEntryById,
  resolveUserByosubCredentialRefs,
} from "./model-credentials.js";

describe("MODEL_CREDENTIAL_CATALOG", () => {
  it("has unique stable ids for every model credential row", () => {
    const ids = MODEL_CREDENTIAL_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "openai",
      "openai-codex",
      "anthropic",
      "claude-cli",
      "openrouter",
      "grok",
      "minimax",
      "openai-compatible",
      "gemini",
    ]);
  });

  it("classifies static key providers separately from OAuth subscription providers", () => {
    expect(MODEL_CREDENTIAL_MODES).toEqual(["api_key", "token", "oauth"]);
    expect(MODEL_CREDENTIAL_STATIC_PROVIDER_IDS).toEqual([
      "openai",
      "anthropic",
      "openrouter",
      "grok",
      "minimax",
      "openai-compatible",
    ]);
    expect(MODEL_CREDENTIAL_CONNECTOR_ONLY_PROVIDER_IDS).toEqual(["gemini"]);
    expect(MODEL_CREDENTIAL_OAUTH_PROVIDER_IDS).toEqual(["openai-codex", "claude-cli"]);
  });

  it("derives exported provider lists from catalog routing eligibility", () => {
    expect(MODEL_CREDENTIAL_STATIC_PROVIDER_IDS).toEqual(
      MODEL_CREDENTIAL_CATALOG
        .filter((entry) => entry.modes.includes("api_key") && entry.activeSlotEligible)
        .map((entry) => entry.id),
    );
    expect(MODEL_CREDENTIAL_CONNECTOR_ONLY_PROVIDER_IDS).toEqual(
      MODEL_CREDENTIAL_CATALOG
        .filter((entry) => entry.connectorOnlyUntilRouted === true)
        .map((entry) => entry.id),
    );
    expect(MODEL_CREDENTIAL_OAUTH_PROVIDER_IDS).toEqual(
      MODEL_CREDENTIAL_CATALOG
        .filter((entry) => entry.modes.includes("oauth"))
        .map((entry) => entry.id),
    );
  });

  it("pins the proven Codex and Claude CLI OAuth rows as non-SecretRef materializers", () => {
    expect(modelCredentialEntryById("openai-codex")).toMatchObject({
      id: "openai-codex",
      modes: ["oauth"],
      storage: { kind: "oauth-secret-manager", secretNamePrefix: "byosub" },
      materialization: { kind: "oauth-profile-store", writesAuthJson: true },
      openclaw: {
        authProvider: "openai",
        configProfileId: "openai-codex",
        storeProfileId: "openai-codex:default",
        secretRefAllowed: false,
      },
    });

    expect(modelCredentialEntryById("claude-cli")).toMatchObject({
      id: "claude-cli",
      modes: ["oauth"],
      storage: { kind: "oauth-secret-manager", secretNamePrefix: "byosub" },
      materialization: { kind: "oauth-profile-store", writesAuthJson: false },
      openclaw: {
        authProvider: "claude-cli",
        configProfileId: "anthropic:claude-cli",
        storeProfileId: "anthropic:claude-cli",
        secretRefAllowed: false,
      },
    });
  });

  it("maps subscription providers to the OAuth model credential rows", () => {
    expect(MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS).toEqual(["openai", "anthropic"]);
    expect(MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS).toEqual(
      MODEL_CREDENTIAL_OAUTH_PROVIDER_IDS.map(
        (id) => modelCredentialOAuthEntryByProviderId(id).oauth.subscriptionProvider,
      ),
    );
    expect(modelCredentialOAuthEntryBySubscriptionProvider("openai")).toMatchObject({
      id: "openai-codex",
      oauth: {
        subscriptionProvider: "openai",
        secretProvider: "openai",
        gatewayFlow: "device-auth",
      },
    });
    expect(modelCredentialOAuthEntryBySubscriptionProvider("anthropic")).toMatchObject({
      id: "claude-cli",
      oauth: {
        subscriptionProvider: "anthropic",
        secretProvider: "anthropic",
        gatewayFlow: "claude-sso",
      },
    });
    expect(modelCredentialOAuthEntryBySubscriptionProvider("gemini")).toBeNull();
  });

  it("resolves OAuth rows by catalog id for capture and restore paths", () => {
    expect(modelCredentialOAuthEntryByProviderId("openai-codex").oauth).toEqual({
      subscriptionProvider: "openai",
      secretProvider: "openai",
      gatewayFlow: "device-auth",
    });
    expect(modelCredentialOAuthEntryByProviderId("claude-cli").oauth).toEqual({
      subscriptionProvider: "anthropic",
      secretProvider: "anthropic",
      gatewayFlow: "claude-sso",
    });
  });

  it("builds the active static API-key credential state without raw secret material", () => {
    expect(
      modelCredentialApiKeyState({
        provider: "openai-compatible",
        secretName: "byok-smile-wring-011b-openai-compatible",
        fingerprint: "sk-or-...",
        keyHash: "a1b2c3d4e5f6",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-3.5-sonnet",
        addedAt: "server-time",
      }),
    ).toEqual({
      active: true,
      provider: "openai-compatible",
      mode: "api_key",
      status: "active",
      reasonCode: "ok",
      secretName: "byok-smile-wring-011b-openai-compatible",
      fingerprint: "sk-or-...",
      keyHash: "a1b2c3d4e5f6",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      addedAt: "server-time",
      lastUsedAt: null,
    });
  });

  it("builds the active OAuth credential state using the catalog provider id", () => {
    expect(
      modelCredentialOAuthState({
        provider: "openai-codex",
        secretName: "byosub-uid-1-openai",
        addedAt: "server-time",
      }),
    ).toEqual({
      active: true,
      provider: "openai-codex",
      mode: "oauth",
      status: "active",
      reasonCode: "ok",
      secretName: "byosub-uid-1-openai",
      addedAt: "server-time",
      lastUsedAt: null,
    });
  });

  it("requires static key providers to use SecretRef-compatible materialization", () => {
    for (const id of MODEL_CREDENTIAL_STATIC_PROVIDER_IDS) {
      const entry = modelCredentialEntryById(id);
      expect(entry.modes, id).toContain("api_key");
      expect(entry.storage.kind, id).toBe("secret-manager");
      expect(entry.storage.secretNamePrefix, id).toBe("byok");
      expect(entry.openclaw.secretRefAllowed, id).toBe(true);
      expect(entry.materialization.kind, id).not.toBe("oauth-profile-store");
    }
  });

  it("keeps custom OpenAI-compatible separate from canonical OpenAI-compatible providers", () => {
    expect(modelCredentialEntryById("openrouter")).toMatchObject({
      materialization: { kind: "custom-openai-provider" },
      baseUrl: { kind: "canonical", value: "https://openrouter.ai/api/v1" },
      model: { required: true },
    });
    expect(modelCredentialEntryById("grok")).toMatchObject({
      baseUrl: { kind: "canonical", value: "https://api.x.ai/v1" },
      model: { required: true },
    });
    expect(modelCredentialEntryById("minimax")).toMatchObject({
      baseUrl: { kind: "canonical", value: "https://api.minimax.io/v1" },
      model: { required: true },
    });
    expect(modelCredentialEntryById("openai-compatible")).toMatchObject({
      displayName: "Custom OpenAI-compatible",
      materialization: { kind: "custom-openai-provider" },
      baseUrl: { kind: "user", requiresHttps: true },
      model: { required: true },
    });
  });

  it("keeps Gemini honest until coach model routing is implemented", () => {
    expect(modelCredentialEntryById("gemini")).toMatchObject({
      activeSlotEligible: false,
      connectorOnlyUntilRouted: true,
      implemented: true,
      storage: { kind: "connector-secret", pathTemplate: "users/{uid}/secrets/{provider}" },
      openclaw: {
        configProfileId: null,
        storeProfileId: null,
        secretRefAllowed: false,
      },
    });
  });
});

describe("user-scoped BYOSUB credential authority", () => {
  it("derives provider secret names from the authenticated user integration, never a stored ref", () => {
    expect(
      resolveUserByosubCredentialRefs("uid_ABC", {
        providers: {
          openai: {
            provider: "openai",
            connected: true,
            status: "connected",
            secretName: "someone-elses-secret",
          },
          anthropic: {
            provider: "anthropic",
            connected: true,
            status: "connected",
          },
        },
      }),
    ).toEqual({
      refs: [
        { provider: "openai", secretName: "byosub-uid_ABC-openai" },
        { provider: "anthropic", secretName: "byosub-uid_ABC-anthropic" },
      ],
      skipped: [],
    });
  });

  it("fails closed for missing, disconnected, malformed, or unsafe user integration leaves", () => {
    expect(resolveUserByosubCredentialRefs("uid-1", undefined)).toEqual({
      refs: [],
      skipped: [],
    });
    expect(
      resolveUserByosubCredentialRefs("uid-1", {
        providers: {
          openai: { provider: "openai", connected: false, status: "disconnected" },
          anthropic: { provider: "anthropic", connected: false, status: "needs_reauth" },
        },
      }),
    ).toEqual({ refs: [], skipped: [] });
    expect(
      resolveUserByosubCredentialRefs("uid-1", {
        providers: { openai: { provider: "anthropic", connected: true, status: "connected" } },
      }),
    ).toEqual({ refs: [], skipped: ["openai: malformed provider leaf"] });
    expect(byosubSecretNameForUser("not/a-uid", "openai")).toBeNull();
  });
});
