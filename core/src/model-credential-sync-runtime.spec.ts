import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  syncByotForUser: vi.fn(),
  legacyUserData: vi.fn(),
  applyModelCredentialState: vi.fn(),
  applyDefaultAgentModelPatch: vi.fn(),
  brokerFetchByosubCreds: vi.fn(),
  restoreOauthStoreForSlug: vi.fn(),
  triggerSecretsReload: vi.fn(),
}));

vi.mock("./byot-sync-runtime.js", () => ({
  syncByotForUser: h.syncByotForUser,
  applyDefaultAgentModelPatch: h.applyDefaultAgentModelPatch,
  brokerFetchByosubCreds: h.brokerFetchByosubCreds,
  restoreOauthStoreForSlug: h.restoreOauthStoreForSlug,
  triggerSecretsReload: h.triggerSecretsReload,
}));

vi.mock("./model-credential-sync.js", () => ({
  applyModelCredentialState: h.applyModelCredentialState,
  legacyByotSyncUserDataFromModelCredentialState: h.legacyUserData,
}));

import {
  applyModelCredentialDefaultAgentPatch,
  brokerFetchModelCredentialOauthCreds,
  restoreModelCredentialOauthStoreForSlug,
  syncModelCredentialsForUser,
  triggerModelCredentialSecretsReload,
} from "./model-credential-sync-runtime.js";

describe("syncModelCredentialsForUser", () => {
  it("translates model credential user data and maps the model apply dependency to legacy BYOT state", async () => {
    const modelApply = vi.fn();
    const userData = {
      username: "mira",
      planInputs: {},
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: { modelCredential: { active: true } },
    };
    const legacyData = { username: "mira", byotActive: true };
    h.legacyUserData.mockReturnValue(legacyData);
    h.syncByotForUser.mockResolvedValue(undefined);

    await syncModelCredentialsForUser(userData, {
      applyModelCredentialState: modelApply,
      triggerSecretsReload: h.triggerSecretsReload,
    });

    expect(h.legacyUserData).toHaveBeenCalledWith(userData);
    expect(h.syncByotForUser).toHaveBeenCalledWith(legacyData, {
      triggerSecretsReload: h.triggerSecretsReload,
      applyByotState: modelApply,
    });
  });

  it("re-exports model credential names for the legacy runtime helpers", () => {
    expect(applyModelCredentialDefaultAgentPatch).toBe(h.applyDefaultAgentModelPatch);
    expect(brokerFetchModelCredentialOauthCreds).toBe(h.brokerFetchByosubCreds);
    expect(restoreModelCredentialOauthStoreForSlug).toBe(h.restoreOauthStoreForSlug);
    expect(triggerModelCredentialSecretsReload).toBe(h.triggerSecretsReload);
  });
});
