import pg from "pg";
import { poolRunner, runQuery } from "./sql.js";

function requireTarget(recorded: unknown, selected: string): void {
  if (recorded === undefined) {
    throw new Error(`platform database has no deployment target; expected "${selected}"`);
  }
  if (recorded !== selected) {
    throw new Error(`platform database belongs to deployment target "${String(recorded)}", not "${selected}"`);
  }
}

export async function assertPlatformDatabaseTarget(pool: pg.Pool, selected: string, schema: string): Promise<void> {
  const rows = await runQuery(
    poolRunner(pool),
    pg.escapeIdentifier(schema),
    "SELECT target_id FROM $schema.platform_deployment_target",
  );
  requireTarget(rows[0]?.target_id, selected);
}

export async function claimPlatformDatabaseTarget(client: pg.PoolClient, selected: string): Promise<void> {
  await client.query(
    "INSERT INTO platform_deployment_target (target_id) VALUES ($1) ON CONFLICT (singleton) DO NOTHING",
    [selected],
  );
  const { rows } = await client.query<{ target_id: string }>("SELECT target_id FROM platform_deployment_target");
  requireTarget(rows[0]?.target_id, selected);
}
