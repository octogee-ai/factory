import { type AgentModelSelections } from "@octogee/shared/types/agent-models";
import { type ModelCredentialConfigInput } from "./model-credential-materializer.js";
export type ByotInput = ModelCredentialConfigInput;
export interface FreeTierCoachModelInput {
    slug: string;
    model: string;
    source: "free-tier";
}
export type ByotCoachModelInput = ByotInput & {
    houseModelRef?: string;
};
export type CoachModelInput = ByotCoachModelInput | FreeTierCoachModelInput;
type RuntimeModelsDef = Record<string, {
    agentRuntime?: {
        id: string;
    };
}>;
type CoachModelRef = string | {
    primary: string;
    fallbacks: string[];
};
interface CodexAppServerPatch {
    sandbox: string;
    approvalPolicy: string;
}
export interface FreeTierCoachToolsBlock {
    profile: "minimal";
    alsoAllow: string[];
}
export declare const FREE_TIER_COACH_TOOLS: FreeTierCoachToolsBlock;
export interface CoachModelPatch {
    agents: {
        list: Array<{
            id: string;
            model: CoachModelRef;
            tools?: FreeTierCoachToolsBlock;
        }>;
        defaults?: {
            models: RuntimeModelsDef;
        };
    };
}
export declare const STANDARD_CODEX_APP_SERVER: CodexAppServerPatch;
export declare function isPlatformProviderRef(ref: string): boolean;
export declare function byosCoachConfigPatch(input: CoachModelInput | null): CoachModelPatch | null;
export declare function coachFullAgentList(current: unknown, agentId: string, model: CoachModelPatch["agents"]["list"][number]["model"] | null, tools?: FreeTierCoachToolsBlock | null): unknown[];
export type CoachAgentPatch = {
    list: unknown[];
} | {
    entries: Record<string, Record<string, unknown>>;
};
export declare function coachAgentPatch(current: unknown, agentId: string, model: CoachModelPatch["agents"]["list"][number]["model"] | null, tools?: FreeTierCoachToolsBlock | null): CoachAgentPatch;
export declare function coachAgentExists(current: unknown, agentId: string): boolean;
export declare function coachAgentPatchReplacePaths(current: unknown): string[];
export declare function deriveDesiredByotState(userData: {
    byotActive?: boolean;
    username?: string;
    tier?: string;
    selectedTier?: string;
    subscription?: unknown;
    builderSubscription?: unknown;
    trialGrant?: unknown;
    signupOfferConvertedAt?: unknown;
    freeTierModelRef?: unknown;
    provisioning?: {
        openclaw?: {
            status?: string;
        };
    };
    systemConfig?: {
        byot?: {
            provider?: string;
            baseUrl?: string;
            model?: string;
        };
        agentModels?: AgentModelSelections;
    };
}): {
    enabled: boolean;
    input: ByotInput | null;
    coachModelInput: CoachModelInput | null;
};
export declare function platformCoachModelInputForUser(slug: string, userData: Parameters<typeof deriveDesiredByotState>[0]): CoachModelInput | null;
export declare function applyByotState(slug: string, input: ByotInput | null, agentsDir?: string, opts?: {
    preserveAuthProfileStore?: boolean;
}): boolean;
export {};
