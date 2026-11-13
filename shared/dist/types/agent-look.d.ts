export declare const AGENT_LOOK_STYLES: readonly ["octo", "blob", "droplet", "ghost", "star", "kit"];
export type AgentLookStyle = (typeof AGENT_LOOK_STYLES)[number];
export interface AgentLook {
    style: AgentLookStyle;
    color: string;
}
export declare function parseAgentLook(value: unknown): AgentLook | null;
