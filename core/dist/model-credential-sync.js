import { applyByotState, byosCoachConfigPatch, coachFullAgentList, deriveDesiredByotState, } from "./byot-sync.js";
function byotSystemConfigFromModelCredential(credential) {
    const byot = {};
    if (typeof credential.provider === "string")
        byot.provider = credential.provider;
    if (typeof credential.baseUrl === "string")
        byot.baseUrl = credential.baseUrl;
    if (typeof credential.model === "string")
        byot.model = credential.model;
    return Object.keys(byot).length > 0 ? { byot } : undefined;
}
// agentModels (per-agent picker choices) are orthogonal to the credential
// normalization — they survive every branch, including an inactive credential
// clearing the byot half.
function withAgentModels(userData, systemConfig) {
    const agentModels = userData.systemConfig?.agentModels;
    if (!agentModels || Object.keys(agentModels).length === 0)
        return systemConfig;
    return { ...(systemConfig ?? {}), agentModels };
}
export function legacyByotSyncUserDataFromModelCredentialState(userData) {
    const credential = userData.systemConfig?.modelCredential;
    if (credential) {
        const systemConfig = withAgentModels(userData, credential.active === true ? byotSystemConfigFromModelCredential(credential) : undefined);
        return {
            ...userData,
            byotActive: credential.active === true,
            systemConfig,
        };
    }
    return {
        ...userData,
        systemConfig: withAgentModels(userData, userData.systemConfig?.byot ? { byot: userData.systemConfig.byot } : undefined),
    };
}
export function deriveDesiredModelCredentialState(userData) {
    return deriveDesiredByotState(legacyByotSyncUserDataFromModelCredentialState(userData));
}
export const applyModelCredentialState = applyByotState;
export const modelCredentialCoachConfigPatch = byosCoachConfigPatch;
export const modelCredentialFullAgentList = coachFullAgentList;
