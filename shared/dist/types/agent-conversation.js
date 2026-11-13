export const AGENT_CONVERSATION_SCHEMA_VERSION = 3;
export const AGENT_ACTIVITY_ENVELOPE_SCHEMA_VERSION = 1;
export const AGENT_ACTIVITY_RESERVED_ITEM_IDS = {
    runRoot: "octogee:run-root",
    turnFinalized: "octogee:turn-finalized",
    answerCommit: "octogee:answer-commit",
    terminalError: "octogee:terminal-error",
    approvalPrefix: "octogee:approval:",
};
export function agentActivityCanonicalKey(ref) {
    return `v1\n${ref.conversationId}\n${ref.runId}\n${ref.itemId}\n${ref.semanticVersion}`;
}
