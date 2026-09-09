type JsonObject = Record<string, unknown>;
declare const ABSENT: unique symbol;
declare const REQUIRED_ARRAY: "required-array";
declare const FORBIDDEN_ARRAY: "forbidden-array";
export type GatewayConfigClass = "shared" | "builder";
export type GatewayControlIdentityMode = "shared-operator" | "per-user";
export interface SystemConfigInvariantContext {
    gatewayClass: GatewayConfigClass;
    gatewayId?: string;
    apiOrigin?: string;
    controlIdentity?: GatewayControlIdentityMode;
    ownerUid?: string;
    workspaceSlug?: string;
}
type ExactInvariant = {
    kind: "exact";
    path: string;
    value: unknown | typeof ABSENT;
};
type RequiredArrayInvariant = {
    kind: typeof REQUIRED_ARRAY;
    path: string;
    values: readonly string[];
};
type ForbiddenArrayInvariant = {
    kind: typeof FORBIDDEN_ARRAY;
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
type ProjectAgentToolPolicyInvariant = {
    kind: "project-agent-tool-policy";
    path: "agents.list[].tools" | "agents.entries.*.tools";
};
export type PlatformInvariant = ExactInvariant | RequiredArrayInvariant | ForbiddenArrayInvariant | CustomerAgentWorkspaceInvariant | CustomerAgentToolPolicyInvariant | ProjectAgentToolPolicyInvariant | MattermostAccountProjectionInvariant;
export declare const CUSTOMER_CODE_DENIED_TOOLS: readonly ["exec", "process", "subagents", "sessions_spawn", "terminal", "preview_start", "preview_stop", "preview_list", "octogee_publish", "bundle-mcp", "skill_workshop", "conversations_list", "conversations_send", "conversations_turn", "browser", "computer"];
export declare const CUSTOMER_WORKFLOW_TOOLS: readonly ["automations", "message", "octogee_project_create", "octogee_project_delegate", "octogee_project_commit", "octogee_project_list", "octogee_project_set_recipe", "octogee_project_capability", "octogee_project_build", "octogee_project_test", "octogee_project_preview", "octogee_project_run_status", "octogee_project_publish", "octogee_board_list", "octogee_board_card_read", "octogee_board_card_create", "octogee_board_card_update", "octogee_board_card_move", "octogee_board_card_comment", "delegated_access", "workspace_commit", "brave_search", "tavily_search", "tavily_extract", "octogee_chat_search", "octogee_chat_history", "octogee_chat_set_identity", "octogee_status", "octogee_ask_ops", "octogee_google_calendar_events", "octogee_google_calendar_create", "octogee_google_calendar_create_approved", "octogee_google_calendar_update", "octogee_google_calendar_update_approved", "octogee_google_calendar_delete", "octogee_google_calendar_delete_approved", "octogee_google_gmail_search", "octogee_google_gmail_get", "octogee_google_gmail_triage", "octogee_google_gmail_triage_approved", "octogee_google_gmail_draft_create", "octogee_google_gmail_draft_create_approved", "octogee_google_gmail_draft_send", "octogee_google_gmail_draft_send_approved", "octogee_google_drive_read", "octogee_google_docs_read", "octogee_google_docs_write", "octogee_google_contacts_read", "octogee_google_tasks_lists", "octogee_google_tasks_list", "octogee_google_tasks_add", "octogee_google_tasks_add_approved", "octogee_google_tasks_update", "octogee_google_tasks_update_approved", "octogee_google_sheets_read", "octogee_google_sheets_write", "octogee_obsidian_read", "octogee_obsidian_write"];
export declare const PRODUCTIVITY_TOOL_NAMES: ("automations" | "brave_search" | "delegated_access" | "message" | "octogee_ask_ops" | "octogee_board_card_comment" | "octogee_board_card_create" | "octogee_board_card_move" | "octogee_board_card_read" | "octogee_board_card_update" | "octogee_board_list" | "octogee_chat_history" | "octogee_chat_search" | "octogee_chat_set_identity" | "octogee_google_calendar_create" | "octogee_google_calendar_create_approved" | "octogee_google_calendar_delete" | "octogee_google_calendar_delete_approved" | "octogee_google_calendar_events" | "octogee_google_calendar_update" | "octogee_google_calendar_update_approved" | "octogee_google_contacts_read" | "octogee_google_docs_read" | "octogee_google_docs_write" | "octogee_google_drive_read" | "octogee_google_gmail_draft_create" | "octogee_google_gmail_draft_create_approved" | "octogee_google_gmail_draft_send" | "octogee_google_gmail_draft_send_approved" | "octogee_google_gmail_get" | "octogee_google_gmail_search" | "octogee_google_gmail_triage" | "octogee_google_gmail_triage_approved" | "octogee_google_sheets_read" | "octogee_google_sheets_write" | "octogee_google_tasks_add" | "octogee_google_tasks_add_approved" | "octogee_google_tasks_list" | "octogee_google_tasks_lists" | "octogee_google_tasks_update" | "octogee_google_tasks_update_approved" | "octogee_obsidian_read" | "octogee_obsidian_write" | "octogee_project_build" | "octogee_project_capability" | "octogee_project_commit" | "octogee_project_create" | "octogee_project_delegate" | "octogee_project_list" | "octogee_project_preview" | "octogee_project_publish" | "octogee_project_run_status" | "octogee_project_set_recipe" | "octogee_project_test" | "octogee_status" | "tavily_extract" | "tavily_search" | "workspace_commit")[];
export declare const PROJECT_AGENT_ALLOWED_TOOLS: readonly ["octogee_chat_set_identity", "message", "read", "ls", "write", "edit", "apply_patch", "web_search", "web_fetch", "brave_search", "tavily_search", "tavily_extract", "octogee_project_build", "octogee_project_capability", "octogee_project_test", "octogee_project_preview", "octogee_project_run_status", "octogee_project_commit", "octogee_project_set_recipe", "octogee_board_list", "octogee_board_card_read", "octogee_board_card_create", "octogee_board_card_update", "octogee_board_card_move", "octogee_board_card_comment"];
export declare const PROJECT_AGENT_DENIED_TOOLS: readonly [...("automations" | "brave_search" | "delegated_access" | "message" | "octogee_ask_ops" | "octogee_board_card_comment" | "octogee_board_card_create" | "octogee_board_card_move" | "octogee_board_card_read" | "octogee_board_card_update" | "octogee_board_list" | "octogee_chat_history" | "octogee_chat_search" | "octogee_chat_set_identity" | "octogee_google_calendar_create" | "octogee_google_calendar_create_approved" | "octogee_google_calendar_delete" | "octogee_google_calendar_delete_approved" | "octogee_google_calendar_events" | "octogee_google_calendar_update" | "octogee_google_calendar_update_approved" | "octogee_google_contacts_read" | "octogee_google_docs_read" | "octogee_google_docs_write" | "octogee_google_drive_read" | "octogee_google_gmail_draft_create" | "octogee_google_gmail_draft_create_approved" | "octogee_google_gmail_draft_send" | "octogee_google_gmail_draft_send_approved" | "octogee_google_gmail_get" | "octogee_google_gmail_search" | "octogee_google_gmail_triage" | "octogee_google_gmail_triage_approved" | "octogee_google_sheets_read" | "octogee_google_sheets_write" | "octogee_google_tasks_add" | "octogee_google_tasks_add_approved" | "octogee_google_tasks_list" | "octogee_google_tasks_lists" | "octogee_google_tasks_update" | "octogee_google_tasks_update_approved" | "octogee_obsidian_read" | "octogee_obsidian_write" | "octogee_project_build" | "octogee_project_capability" | "octogee_project_commit" | "octogee_project_create" | "octogee_project_delegate" | "octogee_project_list" | "octogee_project_preview" | "octogee_project_publish" | "octogee_project_run_status" | "octogee_project_set_recipe" | "octogee_project_test" | "octogee_status" | "tavily_extract" | "tavily_search" | "workspace_commit")[], "exec", "process", "subagents", "sessions_spawn", "terminal", "preview_start", "preview_stop", "preview_list", "octogee_publish", "workspace_commit", "octogee_project_create", "octogee_project_delegate", "octogee_project_publish", "delegated_access", "octogee_status", "octogee_chat_search", "octogee_chat_history", "bundle-mcp", "automations", "skill_workshop", "conversations_list", "conversations_send", "conversations_turn", "browser"];
export declare function platformInvariantTable(context: SystemConfigInvariantContext): readonly PlatformInvariant[];
export declare function reconcileCustomerAgentEntry(agentId: string, entry: Record<string, unknown>): Record<string, unknown>;
export declare function reconcileBuilderAgentEntry(agentId: string, entry: Record<string, unknown>): Record<string, unknown>;
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
