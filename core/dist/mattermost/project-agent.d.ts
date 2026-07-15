export declare const PROJECT_AGENT_PAT_DESCRIPTION = "Octogee project agent (OpenClaw)";
export declare function projectAgentSecretDocId(project: string): string;
interface SecretDocRef {
    set(data: Record<string, unknown>): Promise<unknown>;
    delete(): Promise<unknown>;
}
interface SecretCollectionRef {
    doc(id: string): SecretDocRef;
}
interface UserDocRef {
    collection(name: string): SecretCollectionRef;
}
interface UsersCollectionRef {
    doc(id: string): UserDocRef;
}
export interface ProjectAgentDeps {
    mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
    db: {
        collection: (name: string) => UsersCollectionRef;
    };
    now: () => unknown;
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
export {};
