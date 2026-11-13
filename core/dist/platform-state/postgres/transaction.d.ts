import type { TransactionOptions } from "../store.js";
import { TransactionPostgresSession, type PostgresContext, type PostgresRetryPolicy } from "./session.js";
import { type Row } from "./sql.js";
export declare const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 5;
export declare function contentionBackoffMs(policy: PostgresRetryPolicy, attempt: number): number;
export declare function runPostgresTransaction<T>(context: PostgresContext, options: TransactionOptions, body: (session: TransactionPostgresSession) => Promise<T>): Promise<T>;
export type SnapshotQuery = (text: string, values?: readonly unknown[]) => Promise<readonly Row[]>;
export declare function withReadSnapshot<T>(context: PostgresContext, label: string, body: (query: SnapshotQuery) => Promise<T>): Promise<T>;
