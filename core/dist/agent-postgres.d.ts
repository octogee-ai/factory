import { type PoolClient, type QueryResultRow } from "pg";
export interface PostgresAgentAnchor {
    storeId: string;
    schema: string;
}
export declare function readPostgresAgentAnchor(file: string): PostgresAgentAnchor | null;
export declare function queryAgentStore<Row extends QueryResultRow = QueryResultRow>(anchor: PostgresAgentAnchor, query: string, values?: unknown[]): Promise<Row[]>;
export declare function writeAgentStore<T>(anchor: PostgresAgentAnchor, write: (client: PoolClient, schema: string) => Promise<T>): Promise<T>;
