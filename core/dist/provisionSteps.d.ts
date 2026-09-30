import type { MmUpdate } from "./customer-lifecycle.js";
export { listTierTemplateFiles, writeTierTemplateFiles, } from "./tier-template-files.js";
export interface AgentBinding {
    agentId: string;
    match?: {
        channel?: string;
        accountId?: string;
        peer?: {
            kind?: string;
            id?: string;
        };
    };
}
export interface AgentEntry {
    id: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string;
    identity?: {
        name?: string;
        emoji?: string;
    };
    heartbeat?: {
        every?: string;
        target?: string;
        lightContext?: boolean;
    };
    tools?: {
        fs?: {
            workspaceOnly?: boolean;
        };
    };
    [k: string]: unknown;
}
export interface MattermostAccount {
    botToken?: string;
    [k: string]: unknown;
}
export interface OpenclawConfigShape {
    agents?: {
        list?: AgentEntry[];
    };
    bindings?: AgentBinding[];
    channels?: {
        mattermost?: {
            accounts?: Record<string, MattermostAccount>;
            defaultAccount?: string;
        };
    };
}
export interface ProvisioningContext {
    uid: string;
    slug: string;
    tier: string;
    ownerName: string;
    customerDir: string;
    today: string;
    username: string;
    templateVars: Record<string, string>;
    userData: Record<string, unknown>;
}
export declare function buildProvisioningContext(uid: string, userData: Record<string, unknown>): ProvisioningContext;
export declare function claimProvisioningSlot(ctx: ProvisioningContext): Promise<void>;
export declare function createCustomerDirectories(ctx: ProvisioningContext): void;
export declare function writeCustomerTemplateFiles(ctx: ProvisioningContext): Promise<void>;
export declare function registerCoachAgent(ctx: ProvisioningContext, config: OpenclawConfigShape): string;
export declare function buildCoachAgentEntry(ctx: ProvisioningContext): AgentEntry;
export declare function buildCoachBindings(current: unknown, coachAgentId: string, slug: string, mmUpdate: MmUpdate): AgentBinding[];
export declare function buildRemoveCustomerConfig(current: OpenclawConfigShape & Record<string, unknown>, slug: string, agentId: string): OpenclawConfigShape & Record<string, unknown>;
export declare function provisionMattermost(ctx: ProvisioningContext): Promise<MmUpdate>;
export declare function upsertMattermostBindingByAgentAndPeer(bindings: AgentBinding[], binding: AgentBinding & {
    match: {
        peer: {
            id: string;
        };
    };
}): void;
export declare function wireCoachMattermostBindings(config: OpenclawConfigShape, coachAgentId: string, slug: string, mmUpdate: MmUpdate): void;
export declare function markProvisioningComplete(ctx: ProvisioningContext, mmUpdate: MmUpdate, allAgentIds: string[]): Promise<void>;
export declare function buildUserOperationalFields(ctx: ProvisioningContext, provisioningObj: Record<string, unknown>, mmUpdate: MmUpdate): Record<string, unknown>;
export declare function buildCoachAgentDoc(uid: string, coachMmUserId: string): Record<string, unknown>;
export declare function notifyOpsOfSignup(ctx: ProvisioningContext): Promise<void>;
