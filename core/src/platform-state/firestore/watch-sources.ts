import type { Firestore } from "firebase-admin/firestore";
import type { WatchAggregate, WatchRecords, WatchRequest } from "../store.js";
import { firestoreBuildersWatchSource } from "./builders.js";
import { firestoreConfigWatchSource } from "./config.js";
import { firestoreFleetRegistryWatchSource } from "./fleet-registry.js";
import { firestoreAssignmentsWatchSource, firestoreGatewaysWatchSource } from "./gateways.js";
import { firestoreOperationsWatchSource } from "./journal.js";
import { firestoreMigrationTasksWatchSource } from "./migration-tasks.js";
import type { FirestoreWatchSource, FirestoreWatchSourceFactory } from "./watch.js";
import {
  firestoreAgentIdentitiesWatchSource,
  firestoreWorkspaceChannelsWatchSource,
  firestoreWorkspaceMembersWatchSource,
  firestoreWorkspaceProjectsWatchSource,
  firestoreWorkspacesWatchSource,
} from "./workspaces.js";

const FIRESTORE_WATCH_SOURCES: { readonly [A in WatchAggregate]: FirestoreWatchSourceFactory<A> } = {
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
  workspaceChannels: firestoreWorkspaceChannelsWatchSource,
  agentIdentities: firestoreAgentIdentitiesWatchSource,
};

export function firestoreWatchSource<A extends WatchAggregate>(
  db: Firestore,
  request: WatchRequest<A>,
): FirestoreWatchSource<WatchRecords[A]> {
  const factory: FirestoreWatchSourceFactory<A> = FIRESTORE_WATCH_SOURCES[request.aggregate];
  return factory(db, request.filter);
}
