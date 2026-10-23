import { assertTrustedAgentStoreRoutines } from "./agent-store-routines.js";
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

type SchemaRelation = { relname: string; relkind: string; seqcache: string | null };

async function lockSchemaRelation(client: PoolClient, schema: string, source: string, object: SchemaRelation): Promise<void> {
  if (object.relkind === "S") {
    const cache = String(object.seqcache);
    if (!/^\d+$/.test(cache) || BigInt(cache) <= 0n) throw new Error(`unsafe agent-store schema ${schema}: invalid sequence cache`);
    await client.query(`ALTER SEQUENCE ${identifier(schema)}.${identifier(object.relname)} CACHE ${cache}`);
  } else if (object.relkind === "r" || object.relkind === "p") {
    await client.query(`LOCK TABLE ${identifier(schema)}.${identifier(object.relname)} IN ACCESS EXCLUSIVE MODE`);
  } else {
    throw new Error(`unsafe agent-store schema ${schema}: unsupported relation kind`);
  }
  const kind = object.relkind === "S" ? "SEQUENCE" : "TABLE";
  await client.query(`GRANT ALL ON ${kind} ${identifier(schema)}.${identifier(object.relname)} TO ${identifier(source)}`);
  if (kind === "TABLE") {
    const columns = await client.query("SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum", [schema, object.relname]);
    if (columns.rows.length) await client.query(`GRANT SELECT (${columns.rows.map(row => identifier(row.attname)).join(", ")}) ON ${identifier(schema)}.${identifier(object.relname)} TO ${identifier(source)}`);
  }

}

async function transferSchemaOwnership(client: PoolClient, schema: string, owner: string, family: "agent" | "neutral"): Promise<void> {
  const objects = await client.query<SchemaRelation>("SELECT c.relname, c.relkind, s.seqcache FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_sequence s ON s.seqrelid = c.oid WHERE n.nspname = $1 AND c.relkind IN ('r','p','S','v','m','f') ORDER BY c.relkind = 'S'", [schema]);
  const functions = await client.query("SELECT p.oid::regprocedure::text AS signature, p.procost FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind = 'f' ORDER BY p.oid", [schema]);
  if (family === "agent") {
    const { rows: [{ rolname: source }] } = await client.query("SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1", [schema]);
    await client.query(`GRANT ALL ON SCHEMA ${identifier(schema)} TO ${identifier(source)}`);
    for (const object of objects.rows) await lockSchemaRelation(client, schema, source, object);
    for (const { signature, procost } of functions.rows) {
      if (!Number.isFinite(procost) || procost <= 0) throw new Error(`unsafe agent-store schema ${schema}: invalid function cost`);
      await client.query(`ALTER FUNCTION ${signature} COST ${procost}`);
    }
    await assertSafeSchemaOwnershipTransfer(client, schema);
    await assertTrustedAgentStoreRoutines(client, schema);
  }
  await client.query(`ALTER SCHEMA ${identifier(schema)} OWNER TO ${identifier(owner)}`);
  for (const object of objects.rows) {
    const kind = object.relkind === "S" ? "SEQUENCE" : "TABLE";
    await client.query(`ALTER ${kind} ${identifier(schema)}.${identifier(object.relname)} OWNER TO ${identifier(owner)}`);
  }
  for (const { signature } of functions.rows) {
    await client.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    await client.query(`ALTER FUNCTION ${signature} OWNER TO ${identifier(owner)}`);
  }
  const configurations = await client.query("SELECT cfgname FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace WHERE n.nspname = $1", [schema]);
  for (const { cfgname } of configurations.rows) await client.query(`ALTER TEXT SEARCH CONFIGURATION ${identifier(schema)}.${identifier(cfgname)} OWNER TO ${identifier(owner)}`);
}

async function assertSafeSchemaOwnershipTransfer(client: PoolClient, schema: string): Promise<void> {
  const unsafe = await client.query(`
    WITH namespace AS (SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname = $1),
    relations AS (SELECT c.* FROM pg_catalog.pg_class c JOIN namespace n ON n.oid = c.relnamespace)
    SELECT 'schema grants' AS reason FROM namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee <> n.nspowner
    UNION ALL SELECT 'relation grants' FROM relations r, LATERAL pg_catalog.aclexplode(r.relacl) a WHERE a.grantee <> r.relowner
    UNION ALL SELECT 'column grants' FROM relations r JOIN pg_catalog.pg_attribute c ON c.attrelid = r.oid, LATERAL pg_catalog.aclexplode(c.attacl) a WHERE a.grantee <> r.relowner
    UNION ALL SELECT 'routine privileges' FROM pg_catalog.pg_proc p JOIN namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef OR p.prokind <> 'f' OR p.proowner <> n.nspowner
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND (a.grantee <> 0 OR a.privilege_type <> 'EXECUTE' OR a.is_grantable))
    UNION ALL SELECT 'relation ownership or execution' FROM relations r JOIN namespace n ON n.oid = r.relnamespace
      WHERE r.relowner <> n.nspowner OR r.relkind NOT IN ('r', 'S', 'i') OR r.relrowsecurity OR r.relforcerowsecurity
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = r.oid OR i.inhparent = r.oid)
    UNION ALL SELECT 'rewrite rules' FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid = w.ev_class
    UNION ALL SELECT 'external trigger function' FROM pg_catalog.pg_trigger t JOIN relations r ON r.oid = t.tgrelid JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND p.pronamespace <> r.relnamespace
    UNION ALL SELECT 'default grants' FROM pg_catalog.pg_default_acl d JOIN namespace n ON n.oid = d.defaclnamespace
    LIMIT 1`, [schema]);
  if (unsafe.rowCount) throw new Error(`unsafe agent-store schema ${schema}: ${unsafe.rows[0].reason}`);
}

async function isBuilderAgentSchema(client: PoolClient, schema: string, slug: string): Promise<boolean> {
  const isAgentStore = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'schema_meta' AND c.relkind = 'r'", [schema]);
  if (!isAgentStore.rowCount) return false;
  await client.query(`LOCK TABLE ${identifier(schema)}.schema_meta IN ACCESS EXCLUSIVE MODE`);
  await client.query("SET LOCAL row_security = off");
  const types = await client.query("SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'schema_meta' AND a.attname IN ('meta_key', 'role', 'agent_id') AND a.atttypid <> 'pg_catalog.text'::regtype", [schema]);
  if (types.rowCount) throw new Error(`unsafe agent-store schema ${schema}: untrusted metadata type`);
  const metadata = await client.query(`SELECT agent_id FROM ${identifier(schema)}.schema_meta WHERE meta_key = 'primary' AND role = 'agent'`);
  return metadata.rows.length > 0 && agentIdBelongsToSlug(metadata.rows[0].agent_id, slug);
}

async function transferStores(client: PoolClient, source: string, owner: string, slug: string): Promise<void> {
  const schemas = await client.query("SELECT n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = $1 ORDER BY n.nspname", [source]);
  for (const { nspname: schema } of schemas.rows) {
    if (!await isBuilderAgentSchema(client, schema, slug)) continue;
    await transferSchemaOwnership(client, schema, owner, "agent");
  }
}

async function claimNeutralStores(client: PoolClient, neutral: string, owner: string): Promise<void> {
  const schemas = await client.query("SELECT n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = $1", [neutral]);
  for (const { nspname } of schemas.rows) await transferSchemaOwnership(client, nspname, owner, "neutral");
}

async function isolateSharedRole(client: PoolClient, sharedRole: string): Promise<void> {
  const memberships = await client.query("SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = $1", [sharedRole]);
  for (const { rolname } of memberships.rows) await client.query(`REVOKE ${identifier(rolname)} FROM ${identifier(sharedRole)}`);
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
      await client.query("SET LOCAL search_path = pg_catalog");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))");
      const { rows: [{ current_user: admin, current_database: database }] } = await client.query("SELECT current_user, current_database()");
      await ensureRole(client, sharedRole);
      await ensureRole(client, owner);
      await ensureRole(client, login);
      await client.query(`GRANT ${identifier(sharedRole)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await client.query(`GRANT ${identifier(owner)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await isolateSharedRole(client, sharedRole);
      await client.query(`GRANT CONNECT, CREATE ON DATABASE ${identifier(database)} TO ${identifier(owner)}`);
      await grantGatewayOwner(client, login, owner, unclaimedRole, Boolean(identity.builder));
      await client.query(`ALTER ROLE ${identifier(login)} LOGIN PASSWORD ${literal(identity.token)}`);
      await client.query(`ALTER ROLE ${identifier(login)} SET role = ${literal(owner)}`);
      if (identity.builder) {
        await claimNeutralStores(client, unclaimedRole, owner);
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

export function createAgentStoreOwnershipTransferer(adminDsn: string) {
  const scope = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  if (!scope) throw new Error("Agent-store ownership transfer requires a database");
  const sharedRole = roleFor("shared", scope);
  const pool = new pg.Pool({ connectionString: adminDsn, max: 2, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
  pool.on("error", error => console.error("Agent-store ownership connection failed", error.message));
  return async (builder: { uid: string; slug: string }, target: "shared" | "builder"): Promise<void> => {
    if (!builder.uid || !builder.slug) throw new Error("Agent-store ownership transfer requires a complete Builder identity");
    const owner = roleFor("builder", `${scope}:${builder.uid}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = pg_catalog");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))");
      const { rows: [{ current_user: admin }] } = await client.query("SELECT current_user");
      await ensureRole(client, sharedRole);
      await ensureRole(client, owner);
      await client.query(`GRANT ${identifier(sharedRole)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await client.query(`GRANT ${identifier(owner)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await isolateSharedRole(client, sharedRole);
      await transferStores(client, target === "shared" ? owner : sharedRole, target === "shared" ? sharedRole : owner, builder.slug);
      await client.query("COMMIT");
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
    await client.query("SET search_path = pg_catalog");
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
