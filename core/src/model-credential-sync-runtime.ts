import {
  PLATFORM_MODEL_POLICY_ALLOW_PATH,
  applyCoachModelPatch,
  customerMountConfigPatch,
  customerSecurityProjectionReplacePaths,
  platformModelAllowlistPatch,
  brokerFetchByosubCreds,
  restoreOauthStoreForSlug,
  refreshCoachRuntimeSessions,
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
  PLATFORM_MODEL_POLICY_ALLOW_PATH,
  customerMountConfigPatch,
  customerSecurityProjectionReplacePaths,
  platformModelAllowlistPatch,
  applyCoachModelPatch as applyModelCredentialCoachPatch,
  brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds,
  refreshCoachRuntimeSessions as refreshModelCredentialRuntimeSessions,
  restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug,
  triggerSecretsReload as triggerModelCredentialSecretsReload,
};
