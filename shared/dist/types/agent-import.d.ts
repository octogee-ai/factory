type JsonObject = Record<string, unknown>;
export declare const AGENT_IMPORT_FORMAT_VERSION: 1;
export type AgentImportInventoryClassification = "credential" | "host" | "customer" | "platform" | "unknown";
export interface AgentImportConfigInventoryEntry {
    path: string;
    valueType: "array" | "boolean" | "null" | "number" | "object" | "string";
    classification: AgentImportInventoryClassification;
    sourceAgent: boolean;
}
export interface AgentImportModelHint {
    primary?: string;
    fallbacks?: string[];
}
export interface AgentImportPortableAgent {
    sourceAgentId: string;
    sourceOpenClawVersion?: string;
    name?: string;
    persona?: string;
    identity?: {
        name?: string;
        emoji?: string;
    };
    heartbeat?: {
        every?: string;
        activeHours?: {
            start?: string;
            end?: string;
            timezone?: string;
        };
        lightContext?: boolean;
    };
    bootstrapMaxChars?: number;
    bootstrapTotalMaxChars?: number;
    thinkingDefault?: string;
    verboseDefault?: string;
    timeoutSeconds?: number;
    requestedModel?: AgentImportModelHint;
}
export interface AgentImportConfigArtifacts {
    formatVersion: typeof AGENT_IMPORT_FORMAT_VERSION;
    portableAgent: AgentImportPortableAgent;
    configInventory: AgentImportConfigInventoryEntry[];
    doctorCandidate: JsonObject;
}
export type AgentImportDoctorOutcome = "migrated" | "unchanged" | "unsupported" | "failed";
export type AgentImportConfigDisposition = "apply" | "reauth_then_apply" | "drop_unsupported" | "drop_platform" | "manual_review";
export interface AgentImportConfigDecision {
    path: string;
    disposition: AgentImportConfigDisposition;
    reason: string;
}
export interface AgentImportConfigPlan {
    analyzer: "octogee-policy-v1";
    doctorOutcome: AgentImportDoctorOutcome;
    effectiveOutcome: "applied" | "safe_baseline" | "unchanged";
    identity: {
        name?: string;
        persona?: string;
        emoji?: string;
    };
    workspaceRuntimePatch: JsonObject;
    runtimePatch: JsonObject;
    decisions: AgentImportConfigDecision[];
    reauth: string[];
}
export interface AgentImportWorkspacePolicy {
    preserveConvergedContextFiles: boolean;
}
export declare const AGENT_IMPORT_AUTHORIZATION_INTENTS: readonly ["source_listing", "preview", "apply", "status", "abandon", "rollback"];
export type AgentImportAuthorizationIntent = typeof AGENT_IMPORT_AUTHORIZATION_INTENTS[number];
export declare function isAgentImportAuthorizationIntent(value: unknown): value is AgentImportAuthorizationIntent;
export interface AgentImportApprovalFields {
    source: Record<string, string>;
    destinationHead: string;
    workspaceDigest: string;
    configDigest: string;
    resolutions: Record<string, string>;
}
export declare class AgentImportConfigError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function buildAgentImportConfigArtifacts(source: unknown, selectedAgentId: string): AgentImportConfigArtifacts;
export declare function validateAgentImportConfigArtifacts(value: unknown): AgentImportConfigArtifacts;
export declare function planAgentImportConfig(input: AgentImportConfigArtifacts, options: {
    doctorOutcome: AgentImportDoctorOutcome;
    workspacePolicy: AgentImportWorkspacePolicy;
}): AgentImportConfigPlan;
export declare function classifyAgentImportArchivePath(path: string): "git" | "metadata" | "workspace" | null;
export declare function buildAgentImportApprovalInput(fields: AgentImportApprovalFields): string;
export {};
