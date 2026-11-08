import type { SecretsRepository } from "../platform-state/secrets.js";
export declare const PROJECT_AGENT_PAT_DESCRIPTION = "Octogee project agent (OpenClaw)";
export declare function projectAgentSecretDocId(project: string): string;
export interface ProjectAgentDeps {
    mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
    secrets: Pick<SecretsRepository, "put" | "delete">;
    log: (msg: string) => void;
}
export interface CreateProjectAgentBotInput {
    uid: string;
    username: string;
    project: string;
    teamId: string;
    displayName: string;
    projectChannelIds: readonly string[];
}
export declare function createProjectAgentBot(deps: ProjectAgentDeps, input: CreateProjectAgentBotInput): Promise<{
    mmUserId: string;
    token: string;
}>;
export interface RetireProjectAgentBotInput {
    uid: string;
    project: string;
    mmUserId: string;
}
export declare function retireProjectAgentBot(deps: ProjectAgentDeps, input: RetireProjectAgentBotInput): Promise<void>;
