import type { JobRepositories } from "../jobs.js";
import type { PostgresSession } from "./session.js";
export declare function createPostgresJobRepositories(session: PostgresSession): JobRepositories;
