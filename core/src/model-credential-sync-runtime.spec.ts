import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  syncByotForCustomer: vi.fn(),
  legacyUserData: vi.fn(),
  applyModelCredentialState: vi.fn(),
  applyCoachModelPatch: vi.fn(),
  brokerFetchByosubCreds: vi.fn(),
  markerProvidersForSlot: vi.fn(),
  restoreOauthStoreForSlug: vi.fn(),
  triggerSecretsReload: vi.fn(),
}));

vi.mock("./byot-sync-runtime.js", () => ({
  syncByotForCustomer: h.syncByotForCustomer,
  applyCoachModelPatch: h.applyCoachModelPatch,
  brokerFetchByosubCreds: h.brokerFetchByosubCreds,
  markerProvidersForSlot: h.markerProvidersForSlot,
  restoreOauthStoreForSlug: h.restoreOauthStoreForSlug,
  triggerSecretsReload: h.triggerSecretsReload,
}));

vi.mock("./model-credential-sync.js", () => ({
  applyModelCredentialState: h.applyModelCredentialState,
  legacyByotSyncUserDataFromModelCredentialState: h.legacyUserData,
}));

import {
  applyModelCredentialCoachPatch,
  brokerFetchModelCredentialOauthCreds,
  markerProvidersForModelCredentialOauthSlot,
  restoreModelCredentialOauthStoreForSlug,
  syncModelCredentialsForCustomer,
  triggerModelCredentialSecretsReload,
} from "./model-credential-sync-runtime.js";

describe("syncModelCredentialsForCustomer", () => {
  it("translates model credential user data and maps the model apply dependency to legacy BYOT state", async () => {
    const modelApply = vi.fn();
    const userData = {
      username: "mira",
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: { modelCredential: { active: true } },
    };
    const legacyData = { username: "mira", byotActive: true };
    h.legacyUserData.mockReturnValue(legacyData);
    h.syncByotForCustomer.mockResolvedValue(undefined);

    await syncModelCredentialsForCustomer(userData, {
      applyModelCredentialState: modelApply,
      triggerSecretsReload: h.triggerSecretsReload,
    });

    expect(h.legacyUserData).toHaveBeenCalledWith(userData);
    expect(h.syncByotForCustomer).toHaveBeenCalledWith(legacyData, {
      triggerSecretsReload: h.triggerSecretsReload,
      applyByotState: modelApply,
    });
  });

  it("re-exports model credential names for the legacy runtime helpers", () => {
    expect(applyModelCredentialCoachPatch).toBe(h.applyCoachModelPatch);
    expect(brokerFetchModelCredentialOauthCreds).toBe(h.brokerFetchByosubCreds);
    expect(markerProvidersForModelCredentialOauthSlot).toBe(h.markerProvidersForSlot);
    expect(restoreModelCredentialOauthStoreForSlug).toBe(h.restoreOauthStoreForSlug);
    expect(triggerModelCredentialSecretsReload).toBe(h.triggerSecretsReload);
  });
});
