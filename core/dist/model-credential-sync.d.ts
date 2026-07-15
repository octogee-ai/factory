import { applyByotState, byosCoachConfigPatch, coachFullAgentList, deriveDesiredByotState, type ByotInput, type CoachModelInput, type CoachModelPatch, type FreeTierCoachModelInput } from "./byot-sync.js";
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
export type ModelCredentialCoachModelInput = CoachModelInput;
export type ModelCredentialFreeTierCoachModelInput = FreeTierCoachModelInput;
export type ModelCredentialCoachModelPatch = CoachModelPatch;
export declare function legacyByotSyncUserDataFromModelCredentialState(userData: ModelCredentialSyncUserData): LegacyByotSyncUserData;
export declare function deriveDesiredModelCredentialState(userData: ModelCredentialSyncUserData): ReturnType<typeof deriveDesiredByotState>;
export declare const applyModelCredentialState: typeof applyByotState;
export declare const modelCredentialCoachConfigPatch: typeof byosCoachConfigPatch;
export declare const modelCredentialFullAgentList: typeof coachFullAgentList;
export {};
