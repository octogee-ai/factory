import { createHash } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";

const identifier = pg.escapeIdentifier;
const literal = pg.escapeLiteral;
const roleFor = (kind: string, id: string) => `octogee_${kind}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

export interface AgentStoreGatewayIdentity {
  gatewayId: string;
  gatewayClass: "shared" | "builder";
  token: string;
  builder?: { uid: string; slug: string };
}

async function transferSchemaOwnership(client: PoolClient, schema: string, owner: string): Promise<void> {
  await client.query(`ALTER SCHEMA ${identifier(schema)} OWNER TO ${identifier(owner)}`);
  const objects = await client.query("SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','S','v','m','f') ORDER BY c.relkind = 'S'", [schema]);
  for (const object of objects.rows) {
    const kind = ({ S: "SEQUENCE", v: "VIEW", m: "MATERIALIZED VIEW", f: "FOREIGN TABLE" } as Record<string, string>)[object.relkind] ?? "TABLE";
    await client.query(`ALTER ${kind} ${identifier(schema)}.${identifier(object.relname)} OWNER TO ${identifier(owner)}`);
  }
  const functions = await client.query("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1", [schema]);
  for (const { signature } of functions.rows) {
    await client.query(`ALTER FUNCTION ${signature} OWNER TO ${identifier(owner)}`);
  }
  const configurations = await client.query("SELECT cfgname FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace WHERE n.nspname = $1", [schema]);
  for (const { cfgname } of configurations.rows) await client.query(`ALTER TEXT SEARCH CONFIGURATION ${identifier(schema)}.${identifier(cfgname)} OWNER TO ${identifier(owner)}`);
}

async function isBuilderAgentSchema(client: PoolClient, schema: string, slug: string): Promise<boolean> {
  const isAgentStore = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'schema_meta' AND c.relkind = 'r'", [schema]);
  if (!isAgentStore.rowCount) return false;
  const metadata = await client.query(`SELECT agent_id FROM ${identifier(schema)}.schema_meta WHERE meta_key = 'primary' AND role = 'agent'`);
  return metadata.rows.length > 0 && agentIdBelongsToSlug(metadata.rows[0].agent_id, slug);
}

async function adoptBuilderStores(client: PoolClient, owner: string, sharedRole: string, unclaimedRole: string, slug: string): Promise<void> {
  const schemas = await client.query("SELECT n.nspname, r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = ANY($1::text[])", [[sharedRole, unclaimedRole]]);
  for (const { nspname: schema, rolname } of schemas.rows) {
    if (rolname === sharedRole && !await isBuilderAgentSchema(client, schema, slug)) continue;
    await transferSchemaOwnership(client, schema, owner);
  }
}

async function ensureRole(client: PoolClient, name: string): Promise<void> {
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if (!existing.rowCount) await client.query(`CREATE ROLE ${identifier(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
}

async function grantGatewayOwner(client: PoolClient, login: string, owner: string, unclaimedRole: string, claimed: boolean): Promise<void> {
  const memberships = await client.query("SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = $1", [login]);
  for (const row of memberships.rows) {
    if (row.rolname !== owner && !(claimed && row.rolname === unclaimedRole)) throw new Error("Agent-store Gateway identity changed; issue credentials for a new Gateway ID");
  }
  if (claimed && memberships.rows.some(row => row.rolname === unclaimedRole)) {
    await client.query(`GRANT ${identifier(owner)} TO ${identifier(unclaimedRole)}`);
    await client.query(`REVOKE ${identifier(unclaimedRole)} FROM ${identifier(login)}`);
  }
  await client.query(`GRANT ${identifier(owner)} TO ${identifier(login)}`);
}

export function createAgentStoreCredentialProvisioner(adminDsn: string, clientDsn: string) {
  const clientUrl = new URL(clientDsn);
  const adminUrl = new URL(adminDsn);
  if (clientUrl.pathname !== adminUrl.pathname || !clientUrl.pathname.slice(1)) {
    throw new Error("Agent-store administration and Gateway URLs must select the same database");
  }
  const scope = decodeURIComponent(clientUrl.pathname.slice(1));
  const sharedRole = roleFor("shared", scope);
  const pool = new pg.Pool({ connectionString: adminDsn, max: 2, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
  pool.on("error", error => console.error("Agent-store credential connection failed", error.message));
  return async (identity: AgentStoreGatewayIdentity): Promise<string> => {
    if (!identity.gatewayId || !identity.token || (identity.builder && (!identity.builder.uid || !identity.builder.slug))) {
      throw new Error("Agent-store credentials require a complete Gateway identity");
    }
    const login = roleFor("gateway", `${scope}:${identity.gatewayId}`);
    const unclaimedRole = roleFor("unclaimed", `${scope}:${identity.gatewayId}`);
    let owner = identity.gatewayClass === "shared" ? sharedRole : unclaimedRole;
    if (identity.builder) owner = roleFor("builder", `${scope}:${identity.builder.uid}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))");
      const { rows: [{ current_user: admin, current_database: database }] } = await client.query("SELECT current_user, current_database()");
      await ensureRole(client, sharedRole);
      await ensureRole(client, owner);
      await ensureRole(client, login);
      await client.query(`GRANT ${identifier(sharedRole)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await client.query(`GRANT ${identifier(owner)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      if (identity.builder) await client.query(`GRANT ${identifier(owner)} TO ${identifier(sharedRole)}`);
      await client.query(`GRANT CONNECT, CREATE ON DATABASE ${identifier(database)} TO ${identifier(owner)}`);
      await grantGatewayOwner(client, login, owner, unclaimedRole, Boolean(identity.builder));
      await client.query(`ALTER ROLE ${identifier(login)} LOGIN PASSWORD ${literal(identity.token)}`);
      await client.query(`ALTER ROLE ${identifier(login)} SET role = ${literal(owner)}`);
      if (identity.builder) {
        await adoptBuilderStores(client, owner, sharedRole, unclaimedRole, identity.builder.slug);
      }
      await client.query("COMMIT");
      const url = new URL(clientUrl);
      url.username = login;
      url.password = identity.token;
      return url.toString();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
}

export async function assertNoBuilderAgentStores(adminDsn: string, builder: { uid: string; slug: string }): Promise<void> {
  if (!builder.uid || !builder.slug) throw new Error("Agent-store verification requires a complete Builder identity");
  const scope = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  const owner = roleFor("builder", `${scope}:${builder.uid}`);
  const shared = roleFor("shared", scope);
  const client = new pg.Client({ connectionString: adminDsn, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const namespaces = await client.query("SELECT n.nspname, r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = ANY($1::text[]) OR ((r.rolname LIKE 'octogee_gateway_%' OR r.rolname LIKE 'octogee_unclaimed_%') AND r.oid IN (SELECT m.member FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid WHERE parent.rolname = $2))", [[owner, shared], owner]);
    for (const { nspname, rolname } of namespaces.rows) {
      if (rolname === shared) {
        const isAgent = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'schema_meta' AND c.relkind = 'r'", [nspname]);
        if (!isAgent.rowCount) continue;
        // eslint-disable-next-line sonarjs/sql-queries -- The schema identifier is escaped; metadata filters are constants.
        const metadata = await client.query(`SELECT agent_id FROM ${identifier(nspname)}.schema_meta WHERE meta_key = 'primary' AND role = 'agent'`);
        if (!metadata.rows.length || !agentIdBelongsToSlug(metadata.rows[0].agent_id, builder.slug)) continue;
      }
      throw new Error(`PostgreSQL agent stores remain for Builder ${builder.slug}; explicit database erasure is required before account deletion can complete`);
    }
  } finally { await client.end(); }
}
