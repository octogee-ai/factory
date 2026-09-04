export const AGENT_CONVERSATION_SCHEMA_VERSION = 3 as const;
export const AGENT_ACTIVITY_ENVELOPE_SCHEMA_VERSION = 1 as const;

export const AGENT_ACTIVITY_RESERVED_ITEM_IDS = {
  runRoot: "octogee:run-root",
  turnFinalized: "octogee:turn-finalized",
  answerCommit: "octogee:answer-commit",
  terminalError: "octogee:terminal-error",
  approvalPrefix: "octogee:approval:",
} as const;

export type AgentRunOrigin = "human" | "followup" | "retry" | "scheduled" | "subagent";
export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";
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

export interface ActivityCreateRef extends AgentRunRef {
  itemId: string;
  ordinal: number;
  semanticVersion: number;
}

export type AgentActivityKind =
  | "commentary"
  | "tool"
  | "plan"
  | "patch"
  | "checkpoint"
  | "compaction"
  | "fallback"
  | "approval"
  | "error";

export interface AgentActivityIngressRef {
  conversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  retryOfRunId?: string;
  agentId: string;
  sessionKey: string;
  requesterSessionKey?: string;
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

export interface AgentActivityEnvelopeBaseV1 {
  schemaVersion: 1;
  eventKey: string;
  emittedAt: string;
  ref: AgentActivityIngressRef;
  redaction: { policy: "octogee-v1"; appliedAt: "producer" };
}

export type AgentAnswerDeliveryOutcome =
  | "delivered"
  | "partial"
  | "failed"
  | "suppressed"
  | "not-attempted";

export type AgentAnswerPartKind =
  | "text"
  | "media"
  | "voice"
  | "poll"
  | "card"
  | "preview"
  | "unknown";

export interface AgentAnswerPart {
  postId: string;
  kind: AgentAnswerPartKind;
  index: number;
  rootPostId?: string;
  threadId?: string;
}

export interface AgentAnswerCommitRecord {
  terminalOutcome: "completed" | "failed" | "stopped";
  deliveryOutcome: AgentAnswerDeliveryOutcome;
  postIds: string[];
  parts: AgentAnswerPart[];
}

export type AgentActivityEnvelopeV1 =
  | (AgentActivityEnvelopeBaseV1 & { type: "turn.started" })
  | (AgentActivityEnvelopeBaseV1 & {
      type: "item.completed";
      item: AgentActivityCompletedItem;
    })
  | (AgentActivityEnvelopeBaseV1 & {
      type: "turn.finalized";
      outcome: "completed" | "failed" | "stopped";
    })
  | (AgentActivityEnvelopeBaseV1 & {
      type: "answer.committed";
      answer: AgentAnswerCommitRecord;
    });

type AgentActivityEventKeyRef = Pick<
  AgentActivityIngressRef,
  "conversationId" | "runId" | "itemId" | "semanticVersion"
>;

export function agentActivityCanonicalKey(ref: AgentActivityEventKeyRef): string {
  return `v1\n${ref.conversationId}\n${ref.runId}\n${ref.itemId}\n${ref.semanticVersion}`;
}
