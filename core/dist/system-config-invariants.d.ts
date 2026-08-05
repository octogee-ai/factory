type JsonObject = Record<string, unknown>;
declare const ABSENT: unique symbol;
export type GatewayConfigClass = "shared" | "builder" | "operator";
export interface SystemConfigInvariantContext {
    gatewayClass: GatewayConfigClass;
    gatewayId?: string;
    apiOrigin?: string;
}
type ExactInvariant = {
    kind: "exact";
    path: string;
    value: unknown | typeof ABSENT;
};
type RequiredArrayInvariant = {
    kind: "required-array";
    path: string;
    values: readonly string[];
};
type ForbiddenArrayInvariant = {
    kind: "forbidden-array";
    path: string;
    values: readonly string[];
};
type CustomerAgentWorkspaceInvariant = {
    kind: "customer-agent-workspace";
    path: "agents.list[].tools.fs.workspaceOnly" | "agents.entries.*.tools.fs.workspaceOnly";
};
type MattermostAccountProjectionInvariant = {
    kind: "mattermost-account-projection";
    path: "channels.mattermost.accounts";
};
type CustomerAgentToolPolicyInvariant = {
    kind: "customer-agent-tool-policy";
    path: "agents.list[].tools" | "agents.entries.*.tools";
};
export type PlatformInvariant = ExactInvariant | RequiredArrayInvariant | ForbiddenArrayInvariant | CustomerAgentWorkspaceInvariant | CustomerAgentToolPolicyInvariant | MattermostAccountProjectionInvariant;
export declare function platformInvariantTable(context: SystemConfigInvariantContext): readonly PlatformInvariant[];
export declare class PlatformInvariantPolicyError extends Error {
    readonly paths: string[];
    readonly code = "platform-invariant-violation";
    constructor(paths: string[]);
}
export declare function platformInvariantViolations(config: JsonObject, context: SystemConfigInvariantContext): string[];
export declare function assertPlatformInvariants(config: JsonObject, context: SystemConfigInvariantContext): void;
export declare function reconcilePlatformInvariants(config: JsonObject, context: SystemConfigInvariantContext): {
    changedPaths: string[];
};
export {};
