import pg, { type CustomTypesConfig, type QueryConfig, type QueryResultRow } from "pg";
export type Row = Readonly<Record<string, unknown>>;
export declare const PLATFORM_STATE_TYPES: CustomTypesConfig;
export declare function qualify(text: string, schemaIdentifier: string): string;
export declare function queryConfig(text: string, schemaIdentifier: string, values: readonly unknown[]): QueryConfig<unknown[]>;
export type QueryRunner = (config: QueryConfig<unknown[]>) => Promise<pg.QueryResult<Row & QueryResultRow>>;
export declare function poolRunner(pool: pg.Pool): QueryRunner;
export declare function clientRunner(client: pg.PoolClient): QueryRunner;
export declare function runQuery(run: QueryRunner, schemaIdentifier: string, text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
export declare class SqlParameters {
    readonly values: unknown[];
    add(value: unknown, cast?: string): string;
}
