import { type RecordKey } from "../errors.js";
import type { WatchFilters } from "../store.js";
import type { WorkspaceRepositories } from "../workspaces.js";
import type { PostgresSession } from "./session.js";
import { type TableSpec } from "./values.js";
import type { PostgresWatchSource } from "./watch-sources.js";
export declare function resolveMergeValue(value: unknown, now: number | undefined, path: string): unknown;
export interface MergePut {
    readonly operation: string;
    readonly table: TableSpec;
    readonly record: RecordKey;
    readonly input: object;
    readonly deepMergeFields?: readonly string[];
}
export declare function mergePutRecord(session: PostgresSession, put: MergePut): Promise<void>;
export declare function createPostgresWorkspaceRepositories(session: PostgresSession): WorkspaceRepositories;
export declare function postgresWorkspacesWatchSource(filter: WatchFilters["workspaces"]): PostgresWatchSource<"workspaces">;
export declare function postgresWorkspaceMembersWatchSource(filter: WatchFilters["workspaceMembers"]): PostgresWatchSource<"workspaceMembers">;
export declare function postgresWorkspaceProjectsWatchSource(filter: WatchFilters["workspaceProjects"]): PostgresWatchSource<"workspaceProjects">;
export declare function postgresWorkspaceProjectMembersWatchSource(filter: WatchFilters["workspaceProjectMembers"]): PostgresWatchSource<"workspaceProjectMembers">;
export declare function postgresWorkspaceChannelsWatchSource(filter: WatchFilters["workspaceChannels"]): PostgresWatchSource<"workspaceChannels">;
export declare function postgresAgentIdentitiesWatchSource(filter: WatchFilters["agentIdentities"]): PostgresWatchSource<"agentIdentities">;
