import pg from "pg";
import type { OperationKind } from "@octogee/shared/types/glm";
import { afterEach, describe, expect, it } from "vitest";
import { initialGatewayReleaseDocuments } from "../../../gateway-live-release.js";
import { OperationAuditIdempotencyConflictError, recordOperationAuditIntent } from "../../../operation-audit.js";
import { migratePlatformState } from "../migrate.js";
import { createPostgresPlatformStateStore } from "../store.js";
import { audit, dsn, newPool, newSchemaName, operation } from "./fixtures/harness.js";

const BEFORE_RENAME = 11;
const RENAME = 12;
const UID = "uid-ada";

describe.skipIf(!dsn)("neutral stored names", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function database(through?: number) {
    const pool = newPool();
    const schema = newSchemaName();
    const table = (name: string) => `${pg.escapeIdentifier(schema)}.${name}`;
    await migratePlatformState(pool, { schema, through });
    const store = createPostgresPlatformStateStore({ pool, schema });
    cleanups.push(async () => {
      await store.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await pool.end();
    });
    const value = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
    return { pool, schema, table, store, value };
  }

  type Database = Awaited<ReturnType<typeof database>>;

  async function insertGateway(db: Database, gatewayId: string, gatewayClass: string, image: string | null) {
    await db.pool.query(
      `INSERT INTO ${db.table("gateways")} (gateway_id, created_at, created_by, updated_at, updated_by, latest_release,
         desired_release, desired_status, config_schema_version, profile, gateway_class, image_profile)
       VALUES ($1, 1, 'test', 1, 'test', 0, 0, 'running', 1, $2, $3, $4)`,
      [gatewayId, image === "standard" ? null : image, gatewayClass, image ?? "standard"],
    );
  }

  async function insertUser(db: Database, uid: string, gatewayProfile: string) {
    await db.pool.query(`INSERT INTO ${db.table("users")} (uid, gateway_profile) VALUES ($1, $2)`, [uid, gatewayProfile]);
  }

  async function mirror(db: Database, uid: string, gatewayId: string) {
    await db.pool.query(`UPDATE ${db.table("users")} SET gateway_id = $2 WHERE uid = $1`, [uid, gatewayId]);
  }

  function isolatedRoot(gatewayId: string) {
    return initialGatewayReleaseDocuments({
      gatewayId,
      config: {
        configSchemaVersion: 1, profile: "builder", gatewayClass: "builder", imageProfile: "builder", sizingTier: "l",
        gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
        builderAccess: { controlUiEnabled: true }, ownerUid: UID, builderSlug: "ada", modelBrokerLimits: null,
      },
      artifact: { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "753c212" },
      createdBy: "test",
      now: 1,
      desiredStatus: "running",
    }).gatewayDoc;
  }

  async function insertAssignment(db: Database, gatewayId: string, uid: string, source: string) {
    await db.pool.query(
      `INSERT INTO ${db.table("gateway_assignments")} (gateway_id, uid, slug, source, state, epoch, created_at, updated_at)
       VALUES ($1, $2, $2, $3, 'serving', 1, 1, 1)`,
      [gatewayId, uid, source],
    );
  }

  async function storeLegacyNames(db: Database) {
    await insertGateway(db, "ada", "builder", "builder");
    await insertGateway(db, "shared-a", "shared", "standard");
    await insertUser(db, UID, "builder");
    await insertUser(db, "uid-bob", "standard");
    await insertAssignment(db, "ada", UID, "migrate-customer");
    await insertAssignment(db, "shared-a", "uid-bob", "onboarding");
    await mirror(db, UID, "ada");
    for (const kind of ["migrate-customer", "deprovision-customer", "suspend-customer", "erase-customer", "rollout"]) {
      await db.store.journal.operations.create(operation({ id: `op-${kind}`, kind: kind as OperationKind, inputUid: UID }));
    }
    const mutations = [
      "assign-customer", "unassign-customer", "give-isolated-gateway", "schedule-customer-deletion",
      "accelerate-customer-erasure", "park-builder", "place-builder", "alias-flip",
    ];
    for (const kind of mutations) {
      await db.store.journal.audits.create(audit({
        idempotencyKey: `key-${kind}`,
        mutation: { kind, uid: UID },
        what: kind === "give-isolated-gateway" ? "give user an isolated gateway" : "flip alias",
      }));
    }
  }

  it("rewrites every name stored before the rename to its neutral spelling", async () => {
    const db = await database(BEFORE_RENAME);
    await storeLegacyNames(db);

    await expect(migratePlatformState(db.pool, { schema: db.schema, through: RENAME })).resolves.toMatchObject({ applied: [RENAME] });

    expect(await db.value(`SELECT id, kind FROM ${db.table("operations")} ORDER BY id`)).toEqual([
      { id: "op-deprovision-customer", kind: "deprovision-user" },
      { id: "op-erase-customer", kind: "erase-user" },
      { id: "op-migrate-customer", kind: "migrate-user" },
      { id: "op-rollout", kind: "rollout" },
      { id: "op-suspend-customer", kind: "suspend-user" },
    ]);
    expect(await db.value(`SELECT idempotency_key, mutation ->> 'kind' AS kind, what FROM ${db.table("operation_audits")} ORDER BY idempotency_key`)).toEqual([
      { idempotency_key: "key-accelerate-customer-erasure", kind: "accelerate-user-erasure", what: "flip alias" },
      { idempotency_key: "key-alias-flip", kind: "alias-flip", what: "flip alias" },
      { idempotency_key: "key-assign-customer", kind: "assign-user", what: "flip alias" },
      { idempotency_key: "key-give-isolated-gateway", kind: "move-to-isolated-gateway", what: "move user to an isolated gateway" },
      { idempotency_key: "key-park-builder", kind: "park-user", what: "flip alias" },
      { idempotency_key: "key-place-builder", kind: "place-user", what: "flip alias" },
      { idempotency_key: "key-schedule-customer-deletion", kind: "schedule-user-deletion", what: "flip alias" },
      { idempotency_key: "key-unassign-customer", kind: "unassign-user", what: "flip alias" },
    ]);
    expect(await db.value(`SELECT uid, source FROM ${db.table("gateway_assignments")} ORDER BY uid`)).toEqual([
      { uid: UID, source: "migrate-user" },
      { uid: "uid-bob", source: "onboarding" },
    ]);
    expect(await db.value(`SELECT gateway_id, profile, gateway_class, image_profile FROM ${db.table("gateways")} ORDER BY gateway_id`)).toEqual([
      { gateway_id: "ada", profile: "isolated", gateway_class: "isolated", image_profile: "isolated" },
      { gateway_id: "shared-a", profile: null, gateway_class: "shared", image_profile: "standard" },
    ]);
    expect(await db.value(`SELECT uid, gateway_profile FROM ${db.table("users")} ORDER BY uid`)).toEqual([
      { uid: UID, gateway_profile: "isolated" },
      { uid: "uid-bob", gateway_profile: "standard" },
    ]);
  });

  it("writes only the neutral names", async () => {
    const db = await database();
    await db.store.journal.operations.create(operation({ id: "op-migrate", kind: "migrate-user", inputUid: UID }));
    await insertGateway(db, "shared-a", "shared", "standard");
    await db.store.users.records.create({ uid: UID, createdAt: 1 });
    await db.store.gateways.assignments.create({
      uid: UID, slug: UID, gatewayId: "shared-a", source: "migrate-user", state: "serving", epoch: 1, createdAt: 1, updatedAt: 1,
      updatedByOperationId: "op-migrate",
    });
    await db.store.users.records.setGatewayMirror(UID, { gatewayId: "shared-a", gatewayProfile: "builder" });
    await db.store.gateways.roots.create(isolatedRoot("ada"));
    await db.store.gateways.roots.patch("ada", { profile: "builder", imageProfile: "builder" });

    expect(await db.value(`SELECT kind FROM ${db.table("operations")}`)).toEqual([{ kind: "migrate-user" }]);
    expect(await db.value(`SELECT source FROM ${db.table("gateway_assignments")}`)).toEqual([{ source: "migrate-user" }]);
    expect(await db.value(`SELECT gateway_profile FROM ${db.table("users")}`)).toEqual([{ gateway_profile: "isolated" }]);
    expect(await db.value(`SELECT profile, gateway_class, image_profile FROM ${db.table("gateways")} WHERE gateway_id = 'ada'`)).toEqual([
      { profile: "isolated", gateway_class: "isolated", image_profile: "isolated" },
    ]);
  });

  it("reads names the previous release still writes as their neutral spellings and finds them by either spelling", async () => {
    const db = await database();
    await storeLegacyNames(db);
    await insertGateway(db, "bob", "isolated", "isolated");
    await db.store.journal.operations.create(operation({ id: "op-migrate", kind: "migrate-user", inputUid: UID }));

    const journal = db.store.journal;
    expect((await journal.operations.get("op-migrate-customer"))?.kind).toBe("migrate-user");
    expect((await journal.operations.listByKind("migrate-user")).map((op) => op.id)).toEqual(["op-migrate", "op-migrate-customer"]);
    expect((await journal.operations.listForUid(UID, { kind: "erase-user" })).map((op) => op.id)).toEqual(["op-erase-customer"]);
    expect((await journal.audits.getByIdempotencyKey("key-give-isolated-gateway"))?.mutation).toEqual({
      kind: "move-to-isolated-gateway", uid: UID,
    });
    expect((await db.store.gateways.assignments.get("ada", UID))?.source).toBe("migrate-user");
    expect((await db.store.gateways.roots.list({ gatewayClass: "builder" })).map((root) => [root.gatewayId, root.gatewayClass])).toEqual([
      ["ada", "builder"],
      ["bob", "builder"],
    ]);
    expect((await db.store.users.records.get(UID))?.gateway?.gatewayProfile).toBe("builder");
  });

  const retriedIntent = {
    actor: "operator", forced: false, what: "give user an isolated gateway", why: "operator request",
    target: { uid: UID }, preActionStatus: {}, idempotencyKey: "retry-1:give user an isolated gateway",
  };
  const legacyMutation = { kind: "give-isolated-gateway", uid: UID, sizingProfile: "hobby" };
  const renamedMutation = { ...legacyMutation, kind: "move-to-isolated-gateway" };

  async function expectRetryMatches(db: Database, auditId: string) {
    await expect(recordOperationAuditIntent(db.store, { ...retriedIntent, mutation: renamedMutation }))
      .resolves.toEqual({ auditId, disposition: "existing", status: "recorded" });
    await expect(recordOperationAuditIntent(db.store, { ...retriedIntent, mutation: { ...renamedMutation, uid: "uid-bob" } }))
      .rejects.toBeInstanceOf(OperationAuditIdempotencyConflictError);
  }

  it("matches a retry under the neutral name to an audit the migration renamed", async () => {
    const db = await database(BEFORE_RENAME);
    const recorded = await recordOperationAuditIntent(db.store, { ...retriedIntent, mutation: legacyMutation });
    await migratePlatformState(db.pool, { schema: db.schema });

    await expectRetryMatches(db, recorded.auditId);
  });

  it("matches a retry under the neutral name to an audit the previous release wrote after the migration", async () => {
    const db = await database();
    const recorded = await recordOperationAuditIntent(db.store, { ...retriedIntent, mutation: legacyMutation });

    await expectRetryMatches(db, recorded.auditId);
  });
});
