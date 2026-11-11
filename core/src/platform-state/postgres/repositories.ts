import { createPostgresChannelIdentitiesRepository } from "./channel-identities.js";
import type { PlatformStateRepositories } from "../store.js";
import { createPostgresUserRepositories } from "./users.js";
import { createPostgresConfigRepositories } from "./config.js";
import { createPostgresControllerStateRepositories } from "./controller-state.js";
import { createPostgresFleetRegistryRepository } from "./fleet-registry.js";
import { createPostgresGatewayRepositories } from "./gateways.js";
import { createPostgresJobRepositories } from "./jobs.js";
import { createPostgresJournalRepositories } from "./journal.js";
import { createPostgresMigrationTasksRepository } from "./migration-tasks.js";
import { createPostgresAccessRepositories, createPostgresSecretsRepository } from "./secrets.js";
import type { PostgresSession } from "./session.js";
import { createPostgresWorkspaceRepositories } from "./workspaces.js";

export function createPostgresRepositories(session: PostgresSession): PlatformStateRepositories {
  return {
    journal: createPostgresJournalRepositories(session),
    gateways: createPostgresGatewayRepositories(session),
    fleetRegistry: createPostgresFleetRegistryRepository(session),
    controllerState: createPostgresControllerStateRepositories(session),
    migrationTasks: createPostgresMigrationTasksRepository(session),
    config: createPostgresConfigRepositories(session),
    users: createPostgresUserRepositories(session),
    workspaces: createPostgresWorkspaceRepositories(session),
    secrets: createPostgresSecretsRepository(session),
    channelIdentities: createPostgresChannelIdentitiesRepository(session),
    access: createPostgresAccessRepositories(session),
    jobs: createPostgresJobRepositories(session),
  };
}
