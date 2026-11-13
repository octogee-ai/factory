import type pg from "pg";
import { type RecordKey } from "../errors.js";
import { type Row } from "./sql.js";
export interface PlatformStateLogger {
    warn(message: string, detail: Readonly<Record<string, unknown>>): void;
    error(message: string, detail: Readonly<Record<string, unknown>>): void;
}
export interface PostgresRetryPolicy {
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly budgetMs: number;
}
export declare const DEFAULT_RETRY_POLICY: PostgresRetryPolicy;
export interface PostgresContext {
    readonly pool: pg.Pool;
    readonly schema: string;
    readonly retry: PostgresRetryPolicy;
    readonly logger: PlatformStateLogger;
}
export interface TransactionAttempt {
    readonly label: string;
    readonly readOnly: boolean;
    readonly attempt: number;
}
export interface PostgresSession {
    readonly context: PostgresContext;
    readonly transactional: boolean;
    read(operation: string, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    write(operation: string, record: RecordKey, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    execute(text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    atomically<T>(operation: string, body: (session: PostgresSession) => Promise<T>): Promise<T>;
}
export type PostgresRepositoryFactory<T> = (session: PostgresSession) => T;
export type TransactionRunner = <T>(context: PostgresContext, options: {
    readonly label: string;
}, body: (session: PostgresSession) => Promise<T>) => Promise<T>;
export declare class DirectPostgresSession implements PostgresSession {
    readonly context: PostgresContext;
    private readonly runTransaction;
    readonly transactional = false;
    private readonly run;
    constructor(context: PostgresContext, runTransaction: TransactionRunner);
    read(_operation: string, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    write(_operation: string, record: RecordKey, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    execute(text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    atomically<T>(operation: string, body: (session: PostgresSession) => Promise<T>): Promise<T>;
}
export declare class TransactionPostgresSession implements PostgresSession {
    readonly context: PostgresContext;
    readonly attempt: TransactionAttempt;
    readonly transactional = true;
    private readonly run;
    private wrote;
    private firstFailure;
    constructor(context: PostgresContext, client: pg.PoolClient, attempt: TransactionAttempt);
    get failure(): unknown;
    read(operation: string, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    write(operation: string, record: RecordKey, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    execute(text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
    atomically<T>(_operation: string, body: (session: PostgresSession) => Promise<T>): Promise<T>;
}
