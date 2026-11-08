import type { Stored, WatchAggregate, WatchFilters, WatchRecords, WatchRequest } from "../store.js";
import { postgresBuildersWatchSource } from "./builder-records.js";
import { postgresConfigWatchSource } from "./config.js";
import { postgresFleetRegistryWatchSource } from "./fleet-registry.js";
import { postgresAssignmentsWatchSource, postgresGatewaysWatchSource } from "./gateways.js";
import { decodeOperation } from "./journal.js";
import { postgresMigrationTasksWatchSource } from "./migration-tasks.js";
import type { Row, SqlParameters } from "./sql.js";
import {
  postgresAgentIdentitiesWatchSource,
  postgresWorkspaceChannelsWatchSource,
  postgresWorkspaceMembersWatchSource,
  postgresWorkspaceProjectsWatchSource,
  postgresWorkspacesWatchSource,
} from "./workspaces.js";

export type FilterKeys = Readonly<Record<string, readonly unknown[]>>;

export interface PostgresWatchSource<A extends WatchAggregate> {
  readonly aggregate: A;
  readonly operation: string;
  selectAll(parameters: SqlParameters): string;
  selectKeys(keys: readonly string[], parameters: SqlParameters): string;
  keyOf(row: Row): string;
  decode(row: Row): Stored<WatchRecords[A]>;
  mayMatch(filterKeys: FilterKeys): boolean;
}

type PostgresWatchSourceFactory<A extends WatchAggregate> = (filter: WatchFilters[A]) => PostgresWatchSource<A>;

const operationsWatchSource: PostgresWatchSourceFactory<"operations"> = (filter) => {
  const statuses = [...filter.statuses];
  return {
    aggregate: "operations",
    operation: "watch operations",
    selectAll: (parameters) =>
      `SELECT * FROM $schema.operations WHERE status = ANY(${parameters.add(statuses, "text[]")}) ORDER BY id`,
    selectKeys: (keys, parameters) =>
      `SELECT * FROM $schema.operations WHERE status = ANY(${parameters.add(statuses, "text[]")}) AND id = ANY(${parameters.add([...keys], "text[]")})`,
    keyOf: (row) => row.id as string,
    decode: decodeOperation,
    mayMatch: (filterKeys) =>
      filterKeys.status === undefined || filterKeys.status.some((status) => typeof status === "string" && statuses.includes(status as never)),
  };
};

const WATCH_SOURCES: { readonly [A in WatchAggregate]: PostgresWatchSourceFactory<A> } = {
  operations: operationsWatchSource,
  builders: postgresBuildersWatchSource,
  workspaces: postgresWorkspacesWatchSource,
  workspaceMembers: postgresWorkspaceMembersWatchSource,
  workspaceProjects: postgresWorkspaceProjectsWatchSource,
  workspaceChannels: postgresWorkspaceChannelsWatchSource,
  agentIdentities: postgresAgentIdentitiesWatchSource,
  gateways: postgresGatewaysWatchSource,
  assignments: postgresAssignmentsWatchSource,
  fleetRegistry: postgresFleetRegistryWatchSource,
  migrationTasks: postgresMigrationTasksWatchSource,
  config: postgresConfigWatchSource,
};

export function postgresWatchSource<A extends WatchAggregate>(request: WatchRequest<A>): PostgresWatchSource<A> {
  const factory = WATCH_SOURCES[request.aggregate] as PostgresWatchSourceFactory<A>;
  return factory(request.filter);
}
