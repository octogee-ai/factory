import type { PlatformStateRepositories } from "../store.js";
import type { PostgresSession } from "./session.js";
export declare function createPostgresRepositories(session: PostgresSession): PlatformStateRepositories;
