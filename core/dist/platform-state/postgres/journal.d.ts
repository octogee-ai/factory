import type { JournalRepositories, OperationAuditRow, OperationRecord } from "../operations.js";
import type { Stored } from "../store.js";
import type { PostgresSession } from "./session.js";
import { type Row } from "./sql.js";
export declare function mintOperationId(): string;
export declare function decodeOperation(row: Row): Stored<OperationRecord>;
export declare function decodeOperationAudit(row: Row): Stored<OperationAuditRow>;
export declare function createPostgresJournalRepositories(session: PostgresSession): JournalRepositories;
