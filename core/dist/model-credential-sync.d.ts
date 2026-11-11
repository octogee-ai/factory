import { applyByotState, byosDefaultAgentConfigPatch, defaultAgentFullAgentList, deriveDesiredByotState, type ByotInput, type DefaultAgentModelInput, type DefaultAgentModelPatch, type FreeTierDefaultAgentModelInput } from "./byot-sync.js";
type LegacyByotSyncUserData = Parameters<typeof deriveDesiredByotState>[0];
type LegacyByotSystemConfig = NonNullable<LegacyByotSyncUserData["systemConfig"]>;
interface ModelCredentialStateProjection {
    active?: boolean;
    provider?: string;
    baseUrl?: string;
    model?: string;
    [key: string]: unknown;
}
type ModelCredentialSystemConfig = LegacyByotSystemConfig & {
    modelCredential?: ModelCredentialStateProjection;
};
export type ModelCredentialSyncUserData = Omit<LegacyByotSyncUserData, "systemConfig"> & {
    systemConfig?: ModelCredentialSystemConfig;
};
export type ModelCredentialSyncInput = ByotInput;
export type ModelCredentialDefaultAgentModelInput = DefaultAgentModelInput;
export type ModelCredentialFreeTierDefaultAgentModelInput = FreeTierDefaultAgentModelInput;
export type ModelCredentialDefaultAgentModelPatch = DefaultAgentModelPatch;
export declare function legacyByotSyncUserDataFromModelCredentialState(userData: ModelCredentialSyncUserData): LegacyByotSyncUserData;
export declare function deriveDesiredModelCredentialState(userData: ModelCredentialSyncUserData): ReturnType<typeof deriveDesiredByotState>;
export declare const applyModelCredentialState: typeof applyByotState;
export declare const modelCredentialDefaultAgentConfigPatch: typeof byosDefaultAgentConfigPatch;
export declare const modelCredentialFullAgentList: typeof defaultAgentFullAgentList;
export {};
