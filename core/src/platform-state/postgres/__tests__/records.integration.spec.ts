import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AlreadyExistsError,
  DuplicateRecordError,
  FenceMismatchError,
  MalformedRecordError,
  MissingRecordError,
} from "../../errors.js";
import type { OperationPatch } from "../../operations.js";
import type { Revision } from "../../store.js";
import { insertRecord, selectByKey, updateRecord } from "../records.js";
import { column, decodeStored, type TableSpec } from "../values.js";
import { audit, claimedAudit, createHarness, dsn, operation, receipt, type PlatformStateHarness } from "./fixtures/harness.js";

const WORKSPACES: TableSpec = {
  table: "workspaces",
  aggregate: "workspace",
  keyColumns: ["slug"],
  columns: [
    column("slug", "text"),
    column("id", "text"),
    column("ownerUid", "text"),
    column("mattermostTeamId", "text", { column: "channel_host_team_id" }),
    column("createdAt", "bigint"),
    column("updatedAt", "bigint"),
  ],
};

const WORKSPACE_MEMBERS: TableSpec = {
  table: "workspace_members",
  aggregate: "workspace-member",
  keyColumns: ["workspace_slug", "uid"],
  columns: [column("workspaceSlug", "text"), column("uid", "text"), column("role", "text"), column("joinedAt", "bigint")],
};

const USERS_BY_SLUG: TableSpec = {
  table: "users",
  aggregate: "builder",
  keyColumns: ["uid"],
  columns: [column("uid", "text"), column("slug", "text"), column("createdAt", "bigint")],
};

const serverNow = { serverNow: true } as const;
const clear = { clear: true } as const;

describe.skipIf(!dsn)("PostgreSQL platform state records", () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("fences", () => {
    it("applies a patch whose revision fence matches and issues a new revision", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);
      const before = await harness.store.journal.operations.get(created.id);

      await harness.store.journal.operations.patch(created.id, { status: "running" }, { revision: before!.revision });

      const after = await harness.store.journal.operations.get(created.id);
      expect(after?.status).toBe("running");
      expect(after?.revision).not.toBe(before?.revision);
    });

    it("rejects a stale revision fence with both revisions and leaves the record alone", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);
      const stale = (await harness.store.journal.operations.get(created.id))!.revision;
      await harness.store.journal.operations.patch(created.id, { waitingOn: "other" });
      const current = (await harness.store.journal.operations.get(created.id))!.revision;

      const failure = await harness.store.journal.operations
        .patch(created.id, { status: "running" }, { revision: stale })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FenceMismatchError);
      expect(failure).toMatchObject({
        record: { aggregate: "operation", key: created.id },
        fence: "revision",
        expected: stale,
        actual: current,
      });
      expect((await harness.store.journal.operations.get(created.id))?.status).toBe("pending");
    });

    it("matches a status fence against any listed status and reports the actual one on mismatch", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);

      await harness.store.journal.operations.patch(created.id, { status: "running", startedAt: 10 }, { status: ["pending", "running"] });
      const failure = await harness.store.journal.operations
        .patch(created.id, { status: "succeeded" }, { status: ["pending"] })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ fence: "status", expected: ["pending"], actual: "running" });
    });

    it("matches a startedAt fence on null and on a value", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);

      await harness.store.journal.operations.patch(created.id, { startedAt: 50 }, { startedAt: null });
      await harness.store.journal.operations.patch(created.id, { status: "running" }, { startedAt: 50 });
      const failure = await harness.store.journal.operations
        .patch(created.id, { startedAt: 60 }, { startedAt: null })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ fence: "startedAt", expected: null, actual: 50 });
      expect(await harness.store.journal.operations.get(created.id)).toMatchObject({ startedAt: 50, status: "running" });
    });

    it("checks an audit's claim fences, treating an absent claim as null", async () => {
      const recorded = audit();
      await harness.store.journal.audits.create(recorded);

      await harness.store.journal.audits.patch(
        recorded.id,
        { status: "in-progress", lifecycleStage: "action-started", actionClaimId: "claim-9", actionStartedAt: 900, actionRecoveryCount: 0 },
        { status: ["recorded"], actionClaimId: null, actionStartedAt: null },
      );
      const claimMismatch = await harness.store.journal.audits
        .patch(recorded.id, { actionRecoveryCount: 1 }, { actionClaimId: "claim-1" })
        .catch((error: unknown) => error);
      const startMismatch = await harness.store.journal.audits
        .patch(recorded.id, { actionRecoveryCount: 1 }, { actionClaimId: "claim-9", actionStartedAt: 100 })
        .catch((error: unknown) => error);
      await harness.store.journal.audits.patch(recorded.id, { actionRecoveryCount: 1 }, { actionClaimId: "claim-9", actionStartedAt: 900 });

      expect(claimMismatch).toMatchObject({ fence: "actionClaimId", expected: "claim-1", actual: "claim-9" });
      expect(startMismatch).toMatchObject({ fence: "actionStartedAt", expected: 100, actual: 900 });
      expect((await harness.store.journal.audits.get(recorded.id))?.actionRecoveryCount).toBe(1);
    });

    it("reports a fenced patch of a missing record as MissingRecordError", async () => {
      const failure = await harness.store.journal.operations
        .patch("missing", { status: "running" }, { status: ["pending"] })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MissingRecordError);
      expect(failure).toMatchObject({ record: { aggregate: "operation", key: "missing" } });
    });

    it("reports an unfenced patch of a missing record as MissingRecordError and deletes idempotently", async () => {
      await expect(harness.store.journal.operations.patch("missing", { status: "running" })).rejects.toBeInstanceOf(MissingRecordError);
      await expect(harness.store.journal.operations.delete("missing")).resolves.toBeUndefined();
    });

    it("issues a fresh revision when a deleted record is recreated", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);
      const first = (await harness.store.journal.operations.get(created.id))!.revision;
      await harness.store.journal.operations.delete(created.id);
      await harness.store.journal.operations.create(created);

      const failure = await harness.store.journal.operations
        .patch(created.id, { status: "running" }, { revision: first })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FenceMismatchError);
    });
  });

  describe("constraint mapping", () => {
    it("maps a primary key collision to AlreadyExistsError for each journal record", async () => {
      const created = operation();
      const recorded = audit();
      const recovered = receipt();
      await harness.store.journal.operations.create(created);
      await harness.store.journal.audits.create(recorded);
      await harness.store.journal.recoveryReceipts.create(recovered);

      await expect(harness.store.journal.operations.create(created)).rejects.toMatchObject({
        name: "AlreadyExistsError",
        record: { aggregate: "operation", key: created.id },
      });
      await expect(harness.store.journal.audits.create(recorded)).rejects.toBeInstanceOf(AlreadyExistsError);
      await expect(harness.store.journal.recoveryReceipts.create(recovered)).rejects.toBeInstanceOf(AlreadyExistsError);
    });

    it("maps a secondary unique collision to DuplicateRecordError naming the lookup", async () => {
      await insertRecord(harness.session, "user.create", USERS_BY_SLUG, { uid: "uid-1", slug: "taken" }, "create");

      const failure = await insertRecord(
        harness.session,
        "user.create",
        USERS_BY_SLUG,
        { uid: "uid-2", slug: "taken" },
        "create",
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DuplicateRecordError);
      expect(failure).toMatchObject({
        aggregate: "builder",
        lookup: "slug",
        value: "taken",
        keysFound: ["uid-2"],
      });
    });

    it("maps a missing parent to MissingRecordError for the parent", async () => {
      const failure = await insertRecord(
        harness.session,
        "member.create",
        WORKSPACE_MEMBERS,
        { workspaceSlug: "absent-workspace", uid: "uid-1", role: "member" },
        "create",
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MissingRecordError);
      expect(failure).toMatchObject({ record: { aggregate: "workspace", key: "absent-workspace" } });
    });

    it("rethrows other constraint violations untranslated", async () => {
      const failure = await harness.store.journal.operations
        .create(operation({ kind: "not-a-kind" as never }))
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "23514", constraint: "operations_kind_check" });
    });

    it("rejects fields the table does not hold and fields that are fixed after creation", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);

      await expect(harness.store.journal.operations.patch(created.id, { bogus: 1 } as OperationPatch)).rejects.toBeInstanceOf(
        MalformedRecordError,
      );
      await expect(harness.store.journal.operations.patch(created.id, { kind: "rollout" } as OperationPatch)).rejects.toThrow(
        /cannot change kind/,
      );
    });

    it("refuses to decode an audit row that fails the audit schema", async () => {
      const broken = claimedAudit();
      await harness.store.journal.audits.create(broken);
      await harness.query("UPDATE $schema.operation_audits SET lifecycle_stage = 'intent-recorded' WHERE id = $1", [broken.id]);

      await expect(harness.store.journal.audits.get(broken.id)).rejects.toMatchObject({
        name: "MalformedRecordError",
        record: { aggregate: "operation-audit", key: broken.id },
      });
    });
  });

  describe("server time and clears", () => {
    it("writes the database clock for a server time field", async () => {
      const before = Date.now();
      await insertRecord(
        harness.session,
        "workspace.create",
        WORKSPACES,
        { slug: "ws", id: "ws-id", ownerUid: "uid-1", createdAt: serverNow },
        "create",
      );
      const after = Date.now();

      const row = await selectByKey(harness.session, "workspace.get", { table: WORKSPACES, key: ["ws"] });
      const stored = decodeStored<{ createdAt: number }>(WORKSPACES, row!);
      expect(stored.createdAt).toBeGreaterThanOrEqual(before - 5_000);
      expect(stored.createdAt).toBeLessThanOrEqual(after + 5_000);
    });

    it("resolves one server time for every server time field in a write, nested ones included", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);

      await harness.store.journal.operations.patch(created.id, {
        lastProgressAt: serverNow,
        output: { observedAt: serverNow, nested: [{ at: serverNow }] },
      } as unknown as OperationPatch);

      const stored = await harness.store.journal.operations.get(created.id);
      expect(typeof stored?.lastProgressAt).toBe("number");
      expect(stored?.output).toEqual({ observedAt: stored?.lastProgressAt, nested: [{ at: stored?.lastProgressAt }] });
    });

    it("refuses a server time on a field that is not a time", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);

      await expect(
        harness.store.journal.operations.patch(created.id, { waitingOn: serverNow } as unknown as OperationPatch),
      ).rejects.toThrow(TypeError);
    });

    it("clears optional fields to absent and keeps nullable fields as null", async () => {
      const created = operation({ waitingOn: "rollout-1", error: "boom", output: { ok: true }, startedAt: 7 });
      await harness.store.journal.operations.create(created);

      await harness.store.journal.operations.patch(created.id, { waitingOn: clear, error: clear, output: clear, startedAt: null });

      const stored = await harness.store.journal.operations.get(created.id);
      expect(stored).not.toHaveProperty("waitingOn");
      expect(stored).not.toHaveProperty("error");
      expect(stored).not.toHaveProperty("output");
      expect(stored?.startedAt).toBeNull();
    });

    it("stores null in an optional column as absent", async () => {
      const created = operation({ waitingOn: null, nextAttemptAt: null, firstStartedAt: null });
      await harness.store.journal.operations.create(created);

      const stored = await harness.store.journal.operations.get(created.id);
      expect(stored).not.toHaveProperty("waitingOn");
      expect(stored).not.toHaveProperty("nextAttemptAt");
      expect(stored).not.toHaveProperty("firstStartedAt");
    });

    it("refuses a clear nested inside a value", async () => {
      const created = operation();
      await harness.store.journal.operations.create(created);

      await expect(
        harness.store.journal.operations.patch(created.id, { output: { keep: 1, drop: clear } } as unknown as OperationPatch),
      ).rejects.toThrow(/only valid at a patch field position/);
    });

    it("keeps JSON null inside a value distinct from an absent field", async () => {
      const created = operation({ output: { value: null }, input: { gatewayId: null } as never });
      await harness.store.journal.operations.create(created);

      const stored = await harness.store.journal.operations.get(created.id);
      expect(stored?.output).toEqual({ value: null });
      expect(stored?.input).toEqual({ gatewayId: null });
    });
  });

  describe("raw record helpers", () => {
    it("patches through updateRecord with a no-op patch that still issues a new revision", async () => {
      await insertRecord(harness.session, "workspace.create", WORKSPACES, { slug: "ws", id: "ws-id", ownerUid: "uid-1" }, "create");
      const before = await selectByKey(harness.session, "workspace.get", { table: WORKSPACES, key: ["ws"] });

      await updateRecord(harness.session, "workspace.touch", { table: WORKSPACES, key: ["ws"] }, {}, []);

      const after = await selectByKey(harness.session, "workspace.get", { table: WORKSPACES, key: ["ws"] });
      expect(String(after?.revision) as Revision).not.toBe(String(before?.revision));
    });
  });
});
