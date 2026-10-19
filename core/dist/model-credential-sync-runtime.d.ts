import { PLATFORM_MODEL_POLICY_ALLOW_PATH, applyCoachModelPatch, customerMountConfigPatch, customerSecurityProjectionReplacePaths, platformModelAllowlistPatch, brokerFetchByosubCreds, restoreOauthStoreForSlug, refreshCoachRuntimeSessions, triggerSecretsReload, type SyncByotForCustomerDeps } from "./byot-sync-runtime.js";
import { applyModelCredentialState, type ModelCredentialSyncUserData } from "./model-credential-sync.js";
export type SyncModelCredentialsForCustomerDeps = SyncByotForCustomerDeps & {
    applyModelCredentialState?: typeof applyModelCredentialState;
};
export declare function syncModelCredentialsForCustomer(userData: ModelCredentialSyncUserData, deps?: SyncModelCredentialsForCustomerDeps): Promise<void>;
export { PLATFORM_MODEL_POLICY_ALLOW_PATH, customerMountConfigPatch, customerSecurityProjectionReplacePaths, platformModelAllowlistPatch, applyCoachModelPatch as applyModelCredentialCoachPatch, brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds, refreshCoachRuntimeSessions as refreshModelCredentialRuntimeSessions, restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug, triggerSecretsReload as triggerModelCredentialSecretsReload, };
