/* eslint-disable sonarjs/sql-queries -- Synthetic fixture identifiers are escaped; SQL values use query parameters. */
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentStoreCredentialProvisioner, assertNoBuilderAgentStores } from "./agent-store-credentials.js";
import { readAuthProfileStore, writeAuthProfileStore, deleteAuthProfileStore } from "./auth-profile-store.js";
import { purgeCustomerOauthRuntimeArtifacts } from "./byosub-restore.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe.skipIf(!dsn)("PostgreSQL agent store", () => {
  it("hands tenant ownership between Shared and Builder logins without exposing another Builder's store", async () => {
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const sharedDsn = await provision({ gatewayClass: "shared", gatewayId: "shared-test", token: "synthetic-shared-password" });
    const shared = new pg.Client({ connectionString: sharedDsn });
    await shared.connect();
    const suffix = randomUUID().replaceAll("-", "");
    const aliceSchema = `octogee_agent_${suffix}`;
    const bobSchema = `octogee_agent_b${suffix}`;
    const rogueSchema = `octogee_agent_r${suffix}`;
    const standbySchema = `octogee_agent_u${suffix}`;
    const object = (schema: string, table: string) => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)}`;
    try {
      for (const [schema, agentId] of [[aliceSchema, "octogee-alice-coach"], [bobSchema, "octogee-bob-coach"]]) {
        await shared.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema!)}`);
        await shared.query(`CREATE TABLE ${object(schema!, "schema_meta")} (meta_key TEXT, role TEXT, agent_id TEXT)`);
        await shared.query(`INSERT INTO ${object(schema!, "schema_meta")} VALUES ('primary', 'agent', $1)`, [agentId]);
        await shared.query(`CREATE TABLE ${object(schema!, "session_nodes")} (session_key TEXT PRIMARY KEY, entry_json TEXT)`);
        await shared.query(`INSERT INTO ${object(schema!, "session_nodes")} VALUES ('history', '{"providerOverride":"openai-codex","modelOverride":"unsafe-model","sessionId":"original-session"}')`);
        await shared.query(`CREATE TABLE ${object(schema!, "auth_profile_store")} (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at BIGINT)`);
      }
      const standbyId = `standby-${suffix}`;
      const standbyDsn = await provision({ gatewayClass: "builder", gatewayId: standbyId, token: "synthetic-standby-password" });
      const standby = new pg.Client({ connectionString: standbyDsn }); await standby.connect();
      try {
        await expect(standby.query(`SELECT * FROM ${object(bobSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        await standby.query(`CREATE SCHEMA ${pg.escapeIdentifier(standbySchema)}`);
        await standby.query(`CREATE TABLE ${object(standbySchema, "control_state")} (value TEXT)`);
        await standby.query(`INSERT INTO ${object(standbySchema, "control_state")} VALUES ('preserve-unclaimed-state')`);
        const claimedDsn = await provision({ gatewayClass: "builder", gatewayId: standbyId, token: "synthetic-standby-password", builder: { uid: "alice-uid", slug: "alice" } });
        expect(claimedDsn).toBe(standbyDsn);
        expect((await standby.query(`SELECT * FROM ${object(aliceSchema, "session_nodes")}`)).rowCount).toBe(1);
        const claimed = new pg.Client({ connectionString: claimedDsn }); await claimed.connect();
        try { expect((await claimed.query(`SELECT * FROM ${object(standbySchema, "control_state")}`)).rows).toEqual([{ value: "preserve-unclaimed-state" }]); }
        finally { await claimed.end(); }
      } finally { await standby.end(); }
      const aliceDsn = await provision({ gatewayClass: "builder", gatewayId: "native-alice", token: "synthetic-alice-password", builder: { uid: "alice-uid", slug: "alice" } });
      const alice = new pg.Client({ connectionString: aliceDsn });
      await alice.connect();
      try {
        await expect(alice.query(`SELECT * FROM ${object(bobSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        await alice.query(`ALTER TABLE ${object(aliceSchema, "session_nodes")} ADD COLUMN handoff_check TEXT`);
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-pg-auth-")); roots.push(root);
        const agentDir = path.join(root, "agents/octogee-alice-coach/agent");
        await fs.mkdir(agentDir, { recursive: true });
        const anchor = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
        anchor.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
        anchor.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(randomUUID(), aliceSchema);
        anchor.close();
        const previous = process.env.OPENCLAW_AGENT_STORE_DSN;
        process.env.OPENCLAW_AGENT_STORE_DSN = aliceDsn;
        try {
          const profile = { version: 1, profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "synthetic-key" } } };
          await writeAuthProfileStore(agentDir, profile);
          expect(await readAuthProfileStore(agentDir)).toEqual(profile);
          const result = await purgeCustomerOauthRuntimeArtifacts({ openclawDir: root, homeDir: root, agentIds: ["octogee-alice-coach"], allowedModelRefs: ["anthropic/safe"], allowedProviderIds: ["anthropic"] });
          expect(result.resetSessions).toBe(1);
          const { rows: [row] } = await alice.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")} WHERE session_key = 'history'`);
          expect(JSON.parse(row.entry_json)).toMatchObject({ sessionId: "original-session" });
          expect(JSON.parse(row.entry_json).providerOverride).toBeUndefined();
          await deleteAuthProfileStore(agentDir);
          expect(await readAuthProfileStore(agentDir)).toBeNull();
        } finally {
          if (previous === undefined) delete process.env.OPENCLAW_AGENT_STORE_DSN;
          else process.env.OPENCLAW_AGENT_STORE_DSN = previous;
        }
        const { rows } = await shared.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")}`);
        expect(rows).toHaveLength(1);
        await alice.query(`CREATE SCHEMA ${pg.escapeIdentifier(rogueSchema)}`);
        await alice.query(`CREATE TABLE ${object(rogueSchema, "schema_meta")} (untrusted TEXT)`);
        const secondDsn = await provision({ gatewayClass: "builder", gatewayId: "builder-alice", token: "synthetic-other-alice-password", builder: { uid: "alice-uid", slug: "alice" } });
        const second = new pg.Client({ connectionString: secondDsn }); await second.connect();
        try { expect((await second.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")}`)).rows).toEqual(rows); }
        finally { await second.end(); }
        await expect(provision({ gatewayClass: "builder", gatewayId: "native-alice", token: "changed", builder: { uid: "bob-uid", slug: "bob" } })).rejects.toThrow("identity changed");
        await expect(assertNoBuilderAgentStores(dsn!, { uid: "alice-uid", slug: "alice" })).rejects.toThrow("PostgreSQL agent stores remain");
        await expect(assertNoBuilderAgentStores(dsn!, { uid: "charlie-uid", slug: "charlie" })).resolves.toBeUndefined();
        expect((await shared.query(`SELECT * FROM ${object(aliceSchema, "session_nodes")}`)).rowCount).toBe(1);
        expect((await shared.query(`SELECT * FROM ${object(bobSchema, "session_nodes")}`)).rowCount).toBe(1);
      } finally { await alice.end(); }
    } finally {
      await shared.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(standbySchema)} CASCADE`);
      await shared.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(rogueSchema)} CASCADE`);
      await shared.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(aliceSchema)} CASCADE`);
      await shared.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(bobSchema)} CASCADE`);
      await shared.end();
    }
  });

});
