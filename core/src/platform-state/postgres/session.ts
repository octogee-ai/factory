import type pg from "pg";
import { UnsupportedOperationError, type RecordKey } from "../errors.js";
import { translateWriteError } from "./pg-errors.js";
import { clientRunner, poolRunner, runQuery, type QueryRunner, type Row } from "./sql.js";

export interface PlatformStateLogger {
  warn(message: string, detail: Readonly<Record<string, unknown>>): void;
  error(message: string, detail: Readonly<Record<string, unknown>>): void;
}

export interface PostgresRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly budgetMs: number;
}

export const DEFAULT_RETRY_POLICY: PostgresRetryPolicy = { baseDelayMs: 25, maxDelayMs: 1_000, budgetMs: 10_000 };

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

export type TransactionRunner = <T>(
  context: PostgresContext,
  options: { readonly label: string },
  body: (session: PostgresSession) => Promise<T>,
) => Promise<T>;

async function write(run: QueryRunner, schema: string, record: RecordKey, text: string, values: readonly unknown[]): Promise<readonly Row[]> {
  try {
    return await runQuery(run, schema, text, values);
  } catch (error) {
    throw translateWriteError(error, record);
  }
}

export class DirectPostgresSession implements PostgresSession {
  readonly transactional = false;
  private readonly run: QueryRunner;

  constructor(
    readonly context: PostgresContext,
    private readonly runTransaction: TransactionRunner,
  ) {
    this.run = poolRunner(context.pool);
  }

  read(_operation: string, text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
    return runQuery(this.run, this.context.schema, text, values);
  }

  write(_operation: string, record: RecordKey, text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
    return write(this.run, this.context.schema, record, text, values);
  }

  execute(text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
    return runQuery(this.run, this.context.schema, text, values);
  }

  atomically<T>(operation: string, body: (session: PostgresSession) => Promise<T>): Promise<T> {
    return this.runTransaction(this.context, { label: operation }, body);
  }
}

export class TransactionPostgresSession implements PostgresSession {
  readonly transactional = true;
  private readonly run: QueryRunner;
  private wrote = false;
  private firstFailure: unknown;

  constructor(
    readonly context: PostgresContext,
    client: pg.PoolClient,
    readonly attempt: TransactionAttempt,
  ) {
    const run = clientRunner(client);
    this.run = async (config) => {
      try {
        return await run(config);
      } catch (error) {
        this.firstFailure ??= error;
        throw error;
      }
    };
  }

  get failure(): unknown {
    return this.firstFailure;
  }

  async read(operation: string, text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
    if (this.wrote) throw new UnsupportedOperationError("postgresql", operation, "read-after-write");
    return runQuery(this.run, this.context.schema, text, values);
  }

  async write(operation: string, record: RecordKey, text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
    if (this.attempt.readOnly) throw new UnsupportedOperationError("postgresql", operation, "write-in-read-only-transaction");
    this.wrote = true;
    return write(this.run, this.context.schema, record, text, values);
  }

  execute(text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
    return runQuery(this.run, this.context.schema, text, values);
  }

  atomically<T>(_operation: string, body: (session: PostgresSession) => Promise<T>): Promise<T> {
    return body(this);
  }
}
