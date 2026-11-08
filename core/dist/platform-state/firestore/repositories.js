import { createFirestoreBuilderRepositories } from "./builders.js";
import { createFirestoreChannelIdentitiesRepository } from "./channel-identities.js";
import { createFirestoreConfigRepositories } from "./config.js";
import { createFirestoreControllerStateRepositories } from "./controller-state.js";
import { createFirestoreFleetRegistryRepository } from "./fleet-registry.js";
import { createFirestoreGatewayRepositories } from "./gateways.js";
import { createFirestoreJobRepositories } from "./jobs.js";
import { createFirestoreJournalRepositories } from "./journal.js";
import { createFirestoreMigrationTasksRepository } from "./migration-tasks.js";
import { createFirestoreAccessRepositories, createFirestoreSecretsRepository } from "./secrets.js";
import { createFirestoreWorkspaceRepositories } from "./workspaces.js";
export function createFirestoreRepositories(session) {
    return {
        journal: createFirestoreJournalRepositories(session),
        gateways: createFirestoreGatewayRepositories(session),
        fleetRegistry: createFirestoreFleetRegistryRepository(session),
        controllerState: createFirestoreControllerStateRepositories(session),
        migrationTasks: createFirestoreMigrationTasksRepository(session),
        config: createFirestoreConfigRepositories(session),
        builders: createFirestoreBuilderRepositories(session),
        workspaces: createFirestoreWorkspaceRepositories(session),
        secrets: createFirestoreSecretsRepository(session),
        channelIdentities: createFirestoreChannelIdentitiesRepository(),
        access: createFirestoreAccessRepositories(session),
        jobs: createFirestoreJobRepositories(session),
    };
}
