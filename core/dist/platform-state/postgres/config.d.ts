import { type ConfigRepositories } from "../config.js";
import type { PostgresSession } from "./session.js";
import type { PostgresWatchSource } from "./watch-sources.js";
export declare function createPostgresConfigRepositories(session: PostgresSession): ConfigRepositories;
export declare function postgresConfigWatchSource(): PostgresWatchSource<"config">;
