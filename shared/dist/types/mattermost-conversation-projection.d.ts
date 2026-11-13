import type { AgentAnswerCommitRecord, AgentAnswerDeliveryOutcome, AgentAnswerPart, AgentAnswerPartKind, AgentRunRef } from './agent-conversation.js';
export type MattermostConversationHistoryStatus = 'loading' | 'available' | 'unavailable';
export interface MattermostProjectionPost {
    id: string;
    channelId: string;
    rootId?: string;
    userId: string;
    username?: string;
    message: string;
    createAt: number;
    editedAt?: number;
    deletedAt?: number;
    pending?: boolean;
    fileIds?: string[];
    props?: Record<string, unknown>;
}
export interface MattermostProjectionActivityPost {
    id: string;
    channelId?: string;
    userId?: string;
    runRootId?: string;
    kind: string;
    semanticKind?: string;
    message: string;
    props?: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
}
export type AnswerDeliveryOutcome = AgentAnswerDeliveryOutcome;
export type MattermostAnswerPartKind = AgentAnswerPartKind;
export type MattermostAnswerPart = AgentAnswerPart;
export type MattermostAnswerCommitRecord = AgentAnswerCommitRecord;
export interface MattermostAnswerCommitProps extends AgentRunRef {
    status: 'completed' | 'failed' | 'stopped';
    itemId: 'octogee:answer-commit';
    ordinal: number;
    semanticVersion: 1;
    kind: 'agent.answer-commit';
    answer: MattermostAnswerCommitRecord;
}
export interface ProjectedCommittedAnswer<TPost extends MattermostProjectionPost> {
    commitPostId: string;
    runId: string;
    turnId: string;
    inputPostId: string;
    terminalOutcome: 'completed' | 'failed' | 'stopped';
    deliveryOutcome: 'delivered';
    parts: TPost[];
    ref: AgentRunRef;
}
export type ConversationRecoveryGapCode = 'missing-agent-identity' | 'activity-history-unavailable' | 'invalid-activity-record' | 'conflicting-activity-identity' | 'invalid-activity-binding' | 'invalid-answer-commit' | 'conflicting-answer-commit' | 'missing-answer-commit' | 'incomplete-answer-delivery' | 'missing-answer-part' | 'invalid-answer-part';
export interface ConversationRecoveryGap {
    code: ConversationRecoveryGapCode;
    sourceId: string;
    runId?: string;
    postId?: string;
}
export interface ConversationRecoveryCoverage {
    status: 'complete' | 'partial';
    gaps: ConversationRecoveryGap[];
}
export interface MattermostConversationRecordsInput<TPost extends MattermostProjectionPost, TActivity extends MattermostProjectionActivityPost> {
    mainMessages: ReadonlyArray<TPost>;
    activityRows: ReadonlyArray<TActivity>;
    activityStatus: MattermostConversationHistoryStatus;
    agentMmUserId?: string | null;
}
export interface MattermostConversationRecordsProjection<TPost extends MattermostProjectionPost, TActivity extends MattermostProjectionActivityPost> {
    basic: TPost[];
    activity: TActivity[];
    committedAnswers: Array<ProjectedCommittedAnswer<TPost>>;
    coverage: ConversationRecoveryCoverage;
}
