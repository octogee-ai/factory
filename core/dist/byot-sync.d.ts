import { type AgentModelSelections } from "@octogee/shared/types/agent-models";
import { type ModelCredentialConfigInput } from "./model-credential-materializer.js";
export type ByotInput = ModelCredentialConfigInput;
export interface HouseModelDefaultAgentModelInput {
    slug: string;
    model: string;
    source: "house-model";
}
export type ByotDefaultAgentModelInput = ByotInput & {
    houseModelRef?: string;
};
export type DefaultAgentModelInput = ByotDefaultAgentModelInput | HouseModelDefaultAgentModelInput;
type RuntimeModelsDef = Record<string, {
    agentRuntime?: {
        id: string;
    };
}>;
type DefaultAgentModelRef = string | {
    primary: string;
    fallbacks: string[];
};
export interface CodexAppServerPatch {
    sandbox: string;
    approvalPolicy: string;
}
export interface HouseModelDefaultAgentToolsBlock {
    profile: "minimal";
    alsoAllow: string[];
}
export declare const HOUSE_MODEL_DEFAULT_AGENT_TOOLS: HouseModelDefaultAgentToolsBlock;
export interface DefaultAgentModelPatch {
    agents: {
        list: Array<{
            id: string;
            model: DefaultAgentModelRef;
            tools?: HouseModelDefaultAgentToolsBlock;
        }>;
        defaults?: {
            models: RuntimeModelsDef;
        };
    };
}
export declare const STANDARD_CODEX_APP_SERVER: CodexAppServerPatch;
export declare const ISOLATED_CODEX_APP_SERVER: CodexAppServerPatch;
export declare function isPlatformProviderRef(ref: string): boolean;
export declare function byosDefaultAgentConfigPatch(input: DefaultAgentModelInput | null): DefaultAgentModelPatch | null;
export declare function convergedDefaultAgentToolsValue(existing: unknown, tools: HouseModelDefaultAgentToolsBlock | null): Record<string, unknown> | undefined;
export declare function defaultAgentFullAgentList(current: unknown, agentId: string, model: DefaultAgentModelPatch["agents"]["list"][number]["model"] | null, tools?: HouseModelDefaultAgentToolsBlock | null): unknown[];
export type DefaultAgentPatch = {
    list: unknown[];
} | {
    entries: Record<string, Record<string, unknown>>;
};
export declare function defaultAgentPatch(current: unknown, agentId: string, model: DefaultAgentModelPatch["agents"]["list"][number]["model"] | null, tools?: HouseModelDefaultAgentToolsBlock | null): DefaultAgentPatch;
export declare function defaultAgentExists(current: unknown, agentId: string): boolean;
export declare function defaultAgentPatchReplacePaths(current: unknown, agentId: string): string[];
export declare function deriveDesiredByotState(userData: {
    byotActive?: boolean;
    username?: string;
    planInputs: Record<string, unknown>;
    freeTierModelRef?: unknown;
    builderAgentDefault?: unknown;
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
    defaultAgentModelInput: DefaultAgentModelInput | null;
};
export declare function platformDefaultAgentModelInputForUser(slug: string, userData: Parameters<typeof deriveDesiredByotState>[0]): DefaultAgentModelInput | null;
export declare function applyByotState(slug: string, input: ByotInput | null, agentsDir?: string, opts?: {
    preserveAuthProfileStore?: boolean;
}): Promise<boolean>;
export {};
