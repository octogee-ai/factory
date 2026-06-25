import {
  applyByotState,
  byosCoachConfigPatch,
  coachFullAgentList,
  deriveDesiredByotState,
  type ByotInput,
  type CoachModelInput,
  type CoachModelPatch,
  type FreeTierCoachModelInput,
} from "./byot-sync.js";

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

function byotSystemConfigFromModelCredential(
  credential: ModelCredentialStateProjection,
): LegacyByotSystemConfig | undefined {
  const byot: NonNullable<LegacyByotSystemConfig["byot"]> = {};
  if (typeof credential.provider === "string") byot.provider = credential.provider;
  if (typeof credential.baseUrl === "string") byot.baseUrl = credential.baseUrl;
  if (typeof credential.model === "string") byot.model = credential.model;
  return Object.keys(byot).length > 0 ? { byot } : undefined;
}

export function legacyByotSyncUserDataFromModelCredentialState(
  userData: ModelCredentialSyncUserData,
): LegacyByotSyncUserData {
  const credential = userData.systemConfig?.modelCredential;
  if (credential) {
    const systemConfig = credential.active === true
      ? byotSystemConfigFromModelCredential(credential)
      : undefined;

    return {
      ...userData,
      byotActive: credential.active === true,
      systemConfig,
    };
  }

  return {
    ...userData,
    systemConfig: userData.systemConfig?.byot
      ? { byot: userData.systemConfig.byot }
      : undefined,
  };
}

export function deriveDesiredModelCredentialState(
  userData: ModelCredentialSyncUserData,
): ReturnType<typeof deriveDesiredByotState> {
  return deriveDesiredByotState(legacyByotSyncUserDataFromModelCredentialState(userData));
}

export const applyModelCredentialState = applyByotState;
export const modelCredentialCoachConfigPatch = byosCoachConfigPatch;
export const modelCredentialFullAgentList = coachFullAgentList;
