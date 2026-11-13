import type { AgentStoreRecord, UserRepositories } from "../users.js";
import type { PostgresRepositoryFactory } from "./session.js";
export declare function agentStoreKeyOf(record: AgentStoreRecord): string;
export declare const createPostgresUserRepositories: PostgresRepositoryFactory<UserRepositories>;
