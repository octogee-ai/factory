import { applyCoachModelPatch, brokerFetchByosubCreds, restoreOauthStoreForSlug, refreshCoachRuntimeSessions, triggerSecretsReload, type SyncByotForCustomerDeps } from "./byot-sync-runtime.js";
import { applyModelCredentialState, type ModelCredentialSyncUserData } from "./model-credential-sync.js";
export type SyncModelCredentialsForCustomerDeps = SyncByotForCustomerDeps & {
    applyModelCredentialState?: typeof applyModelCredentialState;
};
export declare function syncModelCredentialsForCustomer(userData: ModelCredentialSyncUserData, deps?: SyncModelCredentialsForCustomerDeps): Promise<void>;
export { applyCoachModelPatch as applyModelCredentialCoachPatch, brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds, refreshCoachRuntimeSessions as refreshModelCredentialRuntimeSessions, restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug, triggerSecretsReload as triggerModelCredentialSecretsReload, };
