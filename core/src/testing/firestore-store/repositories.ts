import type { PlatformStateRepositories } from "../../platform-state/store.js";
import { createFirestoreUserRepositories } from "./users.js";
import { createFirestoreChannelIdentitiesRepository } from "./channel-identities.js";
import { createFirestoreConfigRepositories } from "./config.js";
import { createFirestoreControllerStateRepositories } from "./controller-state.js";
import { createFirestoreFleetRegistryRepository } from "./fleet-registry.js";
import { createFirestoreGatewayRepositories } from "./gateways.js";
import { createFirestoreJobRepositories } from "./jobs.js";
import { createFirestoreJournalRepositories } from "./journal.js";
import { createFirestoreMigrationTasksRepository } from "./migration-tasks.js";
import { createFirestoreAccessRepositories, createFirestoreSecretsRepository } from "./secrets.js";
import type { FirestoreSession } from "./session.js";
import { createFirestoreWorkspaceRepositories } from "./workspaces.js";

export function createFirestoreRepositories(session: FirestoreSession): PlatformStateRepositories {
  return {
    journal: createFirestoreJournalRepositories(session),
    gateways: createFirestoreGatewayRepositories(session),
    fleetRegistry: createFirestoreFleetRegistryRepository(session),
    controllerState: createFirestoreControllerStateRepositories(session),
    migrationTasks: createFirestoreMigrationTasksRepository(session),
    config: createFirestoreConfigRepositories(session),
    users: createFirestoreUserRepositories(session),
    workspaces: createFirestoreWorkspaceRepositories(session),
    secrets: createFirestoreSecretsRepository(session),
    channelIdentities: createFirestoreChannelIdentitiesRepository(),
    access: createFirestoreAccessRepositories(session),
    jobs: createFirestoreJobRepositories(session),
  };
}
