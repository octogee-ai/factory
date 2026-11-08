import type { MigrationTasksRepository, MigrationTransferTask } from "../migration-tasks.js";
import type { Stored, WatchFilters } from "../store.js";
import type { PostgresSession } from "./session.js";
import type { Row } from "./sql.js";
import type { PostgresWatchSource } from "./watch-sources.js";
export declare function decodeMigrationTransferTask(row: Row): Stored<MigrationTransferTask>;
export declare function createPostgresMigrationTasksRepository(session: PostgresSession): MigrationTasksRepository;
export declare function postgresMigrationTasksWatchSource(filter: WatchFilters["migrationTasks"]): PostgresWatchSource<"migrationTasks">;
