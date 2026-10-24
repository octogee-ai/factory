/* eslint-disable sonarjs/sql-queries -- Disposable fixture identifiers are escaped; values use query parameters. */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createAgentStoreCredentialProvisioner, createAgentStoreCredentialRevoker } from "./agent-store-credentials.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const roleFor = (kind: string, id: string) => `octogee_${kind}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

describe.skipIf(!dsn)("retired Gateway PostgreSQL login", () => {
  it("disables only the stopped Gateway login, preserves ownership, rejects active sessions and stale issuance", async () => {
    const gatewayId = `retirement-${randomUUID()}`;
    const builder = { uid: gatewayId, slug: gatewayId };
    const scope = decodeURIComponent(new URL(dsn!).pathname.slice(1));
    const login = roleFor("gateway", `${scope}:${gatewayId}`);
    const owner = roleFor("builder", `${scope}:${builder.uid}`);
    const schema = `retirement_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: dsn });
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const revoke = createAgentStoreCredentialRevoker(dsn!);
    const identity = { gatewayId, gatewayClass: "builder" as const, builder, token: "synthetic-retirement" };
    let active: pg.Client | undefined;
    await admin.connect();
    try {
      const url = await provision(identity, async () => {});
      active = new pg.Client({ connectionString: url });
      await active.connect();
      await active.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      const before = await admin.query("SELECT oid, nspowner FROM pg_namespace WHERE nspname = $1", [schema]);
      await expect(revoke(gatewayId, async () => {})).rejects.toThrow("still has database sessions");
      await active.end(); active = undefined;
      let checks = 0;
      await expect(revoke(gatewayId, async () => { if (++checks === 2) throw new Error("claim lost"); })).rejects.toThrow("claim lost");
      expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(true);
      await revoke(gatewayId, async () => {});
      await revoke(gatewayId, async () => {});
      expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(false);
      expect((await admin.query("SELECT oid, nspowner FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual(before.rows);
      expect((await admin.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid = m.roleid JOIN pg_roles c ON c.oid = m.member WHERE p.rolname = $1 AND c.rolname = $2", [owner, login])).rowCount).toBe(1);
      await expect(provision(identity, async () => { throw new Error("Gateway retired"); })).rejects.toThrow("Gateway retired");
      checks = 0;
      await expect(provision(identity, async () => { if (++checks === 2) throw new Error("Gateway retired before commit"); })).rejects.toThrow("Gateway retired before commit");
      expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(false);
      const blocker = new pg.Client({ connectionString: dsn });
      await blocker.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))");
        const queuedUrl = new URL(dsn!);
        queuedUrl.searchParams.set("application_name", gatewayId);
        const delayedProvision = createAgentStoreCredentialProvisioner(queuedUrl.toString(), dsn!);
        let retired = false;
        pending = delayedProvision(identity, async () => { if (retired) throw new Error("queued issuer lost custody"); }).then(() => "unexpected issuance", error => error.message);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [gatewayId]);
          if (result.rowCount) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        retired = true;
        await blocker.query("COMMIT");
        expect(await pending).toBe("queued issuer lost custody");
        expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(false);
      } finally {
        await blocker.query("ROLLBACK");
        await pending;
        await blocker.end();
      }
      await revoke(`absent-${gatewayId}`, async () => {});
    } finally {
      await active?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await admin.query(`DROP OWNED BY ${pg.escapeIdentifier(login)}, ${pg.escapeIdentifier(owner)}`);
      await admin.query(`DROP ROLE ${pg.escapeIdentifier(login)}, ${pg.escapeIdentifier(owner)}`);
      await admin.end();
    }
  });
});
