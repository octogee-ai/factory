import { firestoreBuildersWatchSource } from "./builders.js";
import { firestoreConfigWatchSource } from "./config.js";
import { firestoreFleetRegistryWatchSource } from "./fleet-registry.js";
import { firestoreAssignmentsWatchSource, firestoreGatewaysWatchSource } from "./gateways.js";
import { firestoreOperationsWatchSource } from "./journal.js";
import { firestoreMigrationTasksWatchSource } from "./migration-tasks.js";
import { firestoreAgentIdentitiesWatchSource, firestoreWorkspaceChannelsWatchSource, firestoreWorkspaceMembersWatchSource, firestoreWorkspaceProjectMembersWatchSource, firestoreWorkspaceProjectsWatchSource, firestoreWorkspacesWatchSource, } from "./workspaces.js";
const FIRESTORE_WATCH_SOURCES = {
    operations: firestoreOperationsWatchSource,
    gateways: firestoreGatewaysWatchSource,
    assignments: firestoreAssignmentsWatchSource,
    fleetRegistry: firestoreFleetRegistryWatchSource,
    builders: firestoreBuildersWatchSource,
    config: firestoreConfigWatchSource,
    migrationTasks: firestoreMigrationTasksWatchSource,
    workspaces: firestoreWorkspacesWatchSource,
    workspaceMembers: firestoreWorkspaceMembersWatchSource,
    workspaceProjects: firestoreWorkspaceProjectsWatchSource,
    workspaceProjectMembers: firestoreWorkspaceProjectMembersWatchSource,
    workspaceChannels: firestoreWorkspaceChannelsWatchSource,
    agentIdentities: firestoreAgentIdentitiesWatchSource,
};
export function firestoreWatchSource(db, request) {
    const factory = FIRESTORE_WATCH_SOURCES[request.aggregate];
    return factory(db, request.filter);
}
