export declare const AGENT_CONVERSATION_SCHEMA_VERSION: 3;
export declare const AGENT_ACTIVITY_ENVELOPE_SCHEMA_VERSION: 1;
export declare const AGENT_ACTIVITY_RESERVED_ITEM_IDS: {
    readonly runRoot: "octogee:run-root";
    readonly turnFinalized: "octogee:turn-finalized";
    readonly terminalError: "octogee:terminal-error";
    readonly approvalPrefix: "octogee:approval:";
};
export type AgentRunOrigin = "human" | "followup" | "retry" | "scheduled" | "subagent";
export type AgentRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";
export type AgentAttention = "routine" | "action-required" | "failure";
export interface AgentRunRef {
    schemaVersion: 3;
    projectionKind: "run";
    conversationId: string;
    turnId: string;
    runId: string;
    parentRunId?: string;
    retryOfRunId?: string;
    origin: AgentRunOrigin;
    status: AgentRunStatus;
    mainChannelId: string;
    mainRootPostId: string;
    inputPostId?: string;
    activityRootPostId?: string;
    itemId?: string;
    toolCallId?: string;
    ordinal?: number;
    semanticVersion?: number;
    attention: AgentAttention;
}
export type AgentAdmissionOrigin = Exclude<AgentRunOrigin, "subagent">;
export type AgentAdmissionStatus = "received" | "queued" | "blocked" | "canceled" | "admitted";
export interface AgentAdmissionRef {
    schemaVersion: 3;
    projectionKind: "admission";
    conversationId: string;
    turnId: string;
    mainChannelId: string;
    inputPostId: string;
    origin: AgentAdmissionOrigin;
    retryOfRunId?: string;
    status: AgentAdmissionStatus;
    queuePosition?: number;
    attention: "routine";
}
export type ConversationProjectionRef = AgentRunRef | AgentAdmissionRef;
export interface ActivityCreateRef extends AgentRunRef {
    itemId: string;
    ordinal: number;
    semanticVersion: number;
}
export type AgentActivityKind = "commentary" | "tool" | "plan" | "patch" | "checkpoint" | "compaction" | "fallback" | "approval" | "error";
export interface AgentActivityIngressRef {
    conversationId: string;
    turnId: string;
    runId: string;
    parentRunId?: string;
    retryOfRunId?: string;
    agentId: string;
    sessionKey: string;
    origin: AgentRunRef["origin"];
    mainChannelId: string;
    mainRootPostId: string;
    inputPostId?: string;
    itemId: string;
    ordinal: number;
    semanticVersion: number;
}
export interface AgentActivityDetail {
    format: "text" | "markdown" | "json";
    text: string;
}
export interface AgentActivityAttachment {
    filename: string;
    mediaType: string;
    byteLength: number;
    sha256: string;
    multipartField: "detail";
}
export interface AgentActivityCompletedItem {
    kind: AgentActivityKind;
    status: "completed" | "failed" | "waiting";
    summary: string;
    detail?: AgentActivityDetail;
    attachment?: AgentActivityAttachment;
}
export interface AgentActivityControlTransition {
    from: "waiting";
    to: "approved" | "denied" | "expired";
    actorId: string;
}
export interface AgentActivityEnvelopeBaseV1 {
    schemaVersion: 1;
    eventKey: string;
    emittedAt: string;
    ref: AgentActivityIngressRef;
    redaction: {
        policy: "octogee-v1";
        appliedAt: "producer";
    };
}
export type AgentActivityEnvelopeV1 = (AgentActivityEnvelopeBaseV1 & {
    type: "turn.started";
}) | (AgentActivityEnvelopeBaseV1 & {
    type: "item.completed";
    item: AgentActivityCompletedItem;
}) | (AgentActivityEnvelopeBaseV1 & {
    type: "control.transition";
    control: AgentActivityControlTransition;
}) | (AgentActivityEnvelopeBaseV1 & {
    type: "turn.finalized";
    outcome: "completed" | "failed" | "stopped";
});
type AgentActivityEventKeyRef = Pick<AgentActivityIngressRef, "conversationId" | "runId" | "itemId" | "semanticVersion">;
export declare function agentActivityCanonicalKey(ref: AgentActivityEventKeyRef): string;
export {};
