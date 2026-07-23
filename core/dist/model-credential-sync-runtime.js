import { applyCoachModelPatch, brokerFetchByosubCreds, restoreOauthStoreForSlug, refreshCoachRuntimeSessions, syncByotForCustomer, triggerSecretsReload, } from "./byot-sync-runtime.js";
import { legacyByotSyncUserDataFromModelCredentialState, } from "./model-credential-sync.js";
function legacyDepsFromModelCredentialDeps(deps) {
    if (!deps)
        return undefined;
    const { applyModelCredentialState: modelCredentialApply, ...legacyDeps } = deps;
    return {
        ...legacyDeps,
        ...(modelCredentialApply ? { applyByotState: modelCredentialApply } : {}),
    };
}
export async function syncModelCredentialsForCustomer(userData, deps) {
    await syncByotForCustomer(legacyByotSyncUserDataFromModelCredentialState(userData), legacyDepsFromModelCredentialDeps(deps));
}
export { applyCoachModelPatch as applyModelCredentialCoachPatch, brokerFetchByosubCreds as brokerFetchModelCredentialOauthCreds, refreshCoachRuntimeSessions as refreshModelCredentialRuntimeSessions, restoreOauthStoreForSlug as restoreModelCredentialOauthStoreForSlug, triggerSecretsReload as triggerModelCredentialSecretsReload, };
