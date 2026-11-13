import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";

export interface PostgresAgentAnchor {
  storeId: string;
  schema: string;
}

export function readPostgresAgentAnchor(file: string): PostgresAgentAnchor | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'openclaw_engine_anchor'").get();
    if (!present) return null;
    const rows = db.prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor").all();
    const row = rows[0];
    if (rows.length !== 1 || row?.engine !== "postgres" || typeof row.store_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(row.store_id) ||
        typeof row.schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(row.schema)) {
      throw new Error(`Invalid PostgreSQL agent anchor: ${file}`);
    }
    return { storeId: row.store_id, schema: row.schema };
  } finally { db.close(); }
}

let pool: pg.Pool | undefined;
let poolDsn: string | undefined;

function agentStorePool(): pg.Pool {
  const dsn = process.env.OPENCLAW_AGENT_STORE_DSN;
  if (!dsn) throw new Error("OPENCLAW_AGENT_STORE_DSN is required for the PostgreSQL agent store");
  if (!pool || poolDsn !== dsn) {
    if (pool) void pool.end();
    poolDsn = dsn;
    pool = new pg.Pool({ connectionString: dsn, max: 4, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
    pool.on("error", (error) => console.error("PostgreSQL agent-store connection failed", error.message));
  }
  return pool;
}

export async function queryAgentStore<Row extends QueryResultRow = QueryResultRow>(
  anchor: PostgresAgentAnchor,
  query: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const result = await agentStorePool().query<Row>(query.replaceAll("$schema", pg.escapeIdentifier(anchor.schema)), values);
  return result.rows;
}

export async function writeAgentStore<T>(anchor: PostgresAgentAnchor, write: (client: PoolClient, schema: string) => Promise<T>): Promise<T> {
  const client = await agentStorePool().connect();
  try {
    await client.query("BEGIN");
    const key = createHash("sha256").update(anchor.storeId).digest().readBigInt64BE().toString();
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
    const result = await write(client, pg.escapeIdentifier(anchor.schema));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
