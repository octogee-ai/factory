import { describe, expect, it } from "vitest";
import {
  deriveDesiredModelCredentialState,
  legacyByotSyncUserDataFromModelCredentialState,
} from "./model-credential-sync.js";

const completeUser = {
  username: "tester-70",
  provisioning: { openclaw: { status: "complete" } },
};

describe("model credential sync projection", () => {
  it("derives BYOT input from active canonical modelCredential state", () => {
    expect(
      deriveDesiredModelCredentialState({
        ...completeUser,
        systemConfig: {
          modelCredential: {
            active: true,
            provider: "openai-compatible",
            baseUrl: "https://llm.example/v1",
            model: "custom/fast",
          },
        },
      }),
    ).toMatchObject({
      enabled: true,
      input: {
        slug: "tester-70",
        provider: "openai-compatible",
        baseUrl: "https://llm.example/v1",
        model: "custom/fast",
      },
    });
  });

  it("inactive canonical state overrides stale legacy BYOT state", () => {
    const normalized = legacyByotSyncUserDataFromModelCredentialState({
      ...completeUser,
      byotActive: true,
      systemConfig: {
        modelCredential: {
          active: false,
          provider: "openai",
          model: "openai/gpt-5",
        },
        byot: { provider: "anthropic" },
      },
    });

    expect(normalized.byotActive).toBe(false);
    expect(normalized.systemConfig).toBeUndefined();
    expect(deriveDesiredModelCredentialState(normalized).enabled).toBe(false);
  });

  it("keeps legacy BYOT input as a compatibility source when canonical state is absent", () => {
    expect(
      deriveDesiredModelCredentialState({
        ...completeUser,
        byotActive: true,
        systemConfig: { byot: { provider: "openai", model: "openai/gpt-5" } },
      }).input,
    ).toMatchObject({
      slug: "tester-70",
      provider: "openai",
      model: "openai/gpt-5",
    });
  });
});
