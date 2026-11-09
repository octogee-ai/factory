import { postgresBuildersWatchSource } from "./builder-records.js";
import { postgresConfigWatchSource } from "./config.js";
import { postgresFleetRegistryWatchSource } from "./fleet-registry.js";
import { postgresAssignmentsWatchSource, postgresGatewaysWatchSource } from "./gateways.js";
import { decodeOperation } from "./journal.js";
import { postgresMigrationTasksWatchSource } from "./migration-tasks.js";
import { postgresAgentIdentitiesWatchSource, postgresWorkspaceChannelsWatchSource, postgresWorkspaceMembersWatchSource, postgresWorkspaceProjectMembersWatchSource, postgresWorkspaceProjectsWatchSource, postgresWorkspacesWatchSource, } from "./workspaces.js";
const operationsWatchSource = (filter) => {
    const statuses = [...filter.statuses];
    return {
        aggregate: "operations",
        operation: "watch operations",
        selectAll: (parameters) => `SELECT * FROM $schema.operations WHERE status = ANY(${parameters.add(statuses, "text[]")}) ORDER BY id`,
        selectKeys: (keys, parameters) => `SELECT * FROM $schema.operations WHERE status = ANY(${parameters.add(statuses, "text[]")}) AND id = ANY(${parameters.add([...keys], "text[]")})`,
        keyOf: (row) => row.id,
        decode: decodeOperation,
        mayMatch: (filterKeys) => filterKeys.status === undefined || filterKeys.status.some((status) => typeof status === "string" && statuses.includes(status)),
    };
};
const WATCH_SOURCES = {
    operations: operationsWatchSource,
    builders: postgresBuildersWatchSource,
    workspaces: postgresWorkspacesWatchSource,
    workspaceMembers: postgresWorkspaceMembersWatchSource,
    workspaceProjects: postgresWorkspaceProjectsWatchSource,
    workspaceProjectMembers: postgresWorkspaceProjectMembersWatchSource,
    workspaceChannels: postgresWorkspaceChannelsWatchSource,
    agentIdentities: postgresAgentIdentitiesWatchSource,
    gateways: postgresGatewaysWatchSource,
    assignments: postgresAssignmentsWatchSource,
    fleetRegistry: postgresFleetRegistryWatchSource,
    migrationTasks: postgresMigrationTasksWatchSource,
    config: postgresConfigWatchSource,
};
export function postgresWatchSource(request) {
    const factory = WATCH_SOURCES[request.aggregate];
    return factory(request.filter);
}
