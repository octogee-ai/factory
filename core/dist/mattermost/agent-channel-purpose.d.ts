export type AgentChannelPurpose = (ownerLabel: string) => string;
export declare const defaultAgentChannelPurpose: AgentChannelPurpose;
export declare function installAgentChannelPurpose(purpose: AgentChannelPurpose): void;
export declare function agentChannelPurpose(ownerLabel: string): string;
