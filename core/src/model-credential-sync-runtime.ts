import {
  applyCoachModelPatch,
  brokerFetchByosubCreds,
  markerProvidersForSlot,
  restoreOauthStoreForSlug,
  syncByotForCustomer,
  triggerSecretsReload,
  type SyncByotForCustomerDeps,
} from "./byot-sync-runtime.js";
import {
  applyModelCredentialState,
  legacyByotSyncUserDataFromModelCredentialState,
  type ModelCredentialSyncUserData,
} from "./model-credential-sync.js";

export type SyncModelCredentialsForCustomerDeps = SyncByotForCustomerDeps & {
  applyModelCredentialState?: typeof applyModelCredentialState;
};

function legacyDepsFromModelCredentialDeps(
  deps: SyncModelCredentialsForCustomerDeps | undefined,
): SyncByotForCustomerDeps | undefined {
  if (!deps) return undefined;
  const { applyModelCredentialState: modelCredentialApply, ...legacyDeps } = deps;
  return {
    ...legacyDeps,
    ...(modelCredentialApply ? { applyByotState: modelCredentialApply } : {}),
  };
}

export async function syncModelCredentialsForCustomer(
  userData: ModelCredentialSyncUserData,
  deps?: SyncModelCredentialsForCustomerDeps,
): Promise<void> {
  await syncByotForCustomer(
    legacyByotSyncUserDataFromModelCredentialState(userData),
    legacyDepsFromModelCredentialDeps(deps),
  );
}

export {
  applyCoachModelPatch as applyModelCredentialCoachPatch,
  brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds,
  markerProvidersForSlot as markerProvidersForModelCredentialOauthSlot,
  restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug,
  triggerSecretsReload as triggerModelCredentialSecretsReload,
};
