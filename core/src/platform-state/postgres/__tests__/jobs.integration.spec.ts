import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlreadyExistsError, FenceMismatchError, MalformedRecordError, MissingRecordError } from "../../errors.js";
import type { AgentImportRecord, CustomerDeletionJob } from "../../jobs.js";
import { createHarness, dsn, type PlatformStateHarness } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const DAY = 24 * 60 * 60_000;
const iso = (millis: number) => new Date(millis).toISOString();

function deletionJob(overrides: Partial<CustomerDeletionJob> = {}): CustomerDeletionJob {
  return {
    deletionId: "del-1",
    version: 1,
    uid: "u1",
    slug: "acme",
    status: "suspension_pending",
    requestedBy: "user:u1",
    requestedAt: NOW,
    eraseAfter: NOW + 90 * DAY,
    currentGatewayId: "g1",
    suspensionOperationId: "op-suspend",
    erasureOperationId: "op-erase",
    productContext: { stripeCustomerIds: ["cus_1"], stripeSubscriptionIds: ["sub_1"] },
    ...overrides,
  };
}

describe.skipIf(!dsn)("PostgreSQL job repositories", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("customer deletion jobs", () => {
    it("creates a job once and reads it back with its product context", async () => {
      await harness.store.jobs.deletions.create(deletionJob());

      expect(await harness.store.jobs.deletions.get("del-1")).toEqual({ ...deletionJob(), revision: expect.any(String) });
      expect(await harness.store.jobs.deletions.get("missing")).toBeNull();
      await expect(harness.store.jobs.deletions.create(deletionJob())).rejects.toBeInstanceOf(AlreadyExistsError);
    });

    it("round-trips a minimal job, a null slug and every optional field", async () => {
      const minimal: CustomerDeletionJob = {
        deletionId: "del-min",
        version: 1,
        slug: null,
        currentGatewayId: null,
        status: "hibernating",
        requestedAt: NOW,
        eraseAfter: NOW + DAY,
      };
      const full = deletionJob({
        deletionId: "del-full",
        slug: null,
        currentGatewayId: null,
        cleanupContext: { mattermostTeamId: "team-1" },
        sharedAgentStoreCleanup: { database: "shared" },
        archiveId: "archive-1",
        suspendedAt: NOW + 1,
        cloudErasedAt: NOW + 2,
        verifiedAt: NOW + 3,
        completedAt: NOW + 4,
        updatedAt: NOW + 5,
      });

      await harness.store.jobs.deletions.create(minimal);
      await harness.store.jobs.deletions.create(full);

      expect(await harness.store.jobs.deletions.get("del-min")).toEqual({ ...minimal, revision: expect.any(String) });
      expect(await harness.store.jobs.deletions.get("del-full")).toEqual({ ...full, revision: expect.any(String) });
    });

    it("stores product verification as its own status and moves through it", async () => {
      await harness.store.jobs.deletions.create(deletionJob({ status: "product_verification_pending" }));

      await harness.store.jobs.deletions.patch("del-1", { status: "verified_pending_completion" });
      await harness.store.jobs.deletions.patch("del-1", { status: "product_verification_pending" });

      expect((await harness.store.jobs.deletions.get("del-1"))?.status).toBe("product_verification_pending");
    });

    it("replaces the product context as a whole and clears it", async () => {
      await harness.store.jobs.deletions.create(deletionJob());

      await harness.store.jobs.deletions.patch("del-1", { productContext: { posthogErasure: { requestId: "ph-1" } } });
      const replaced = await harness.store.jobs.deletions.get("del-1");
      await harness.store.jobs.deletions.patch("del-1", { productContext: { clear: true } });

      expect(replaced?.productContext).toEqual({ posthogErasure: { requestId: "ph-1" } });
      expect(await harness.store.jobs.deletions.get("del-1")).not.toHaveProperty("productContext");
    });

    it("scrubs identity fields and reads the scrubbed job without them", async () => {
      await harness.store.jobs.deletions.create(deletionJob({ cleanupContext: { mattermostTeamId: "team-1" } }));

      await harness.store.jobs.deletions.patch("del-1", {
        uid: { clear: true },
        slug: { clear: true },
        requestedBy: { clear: true },
        currentGatewayId: { clear: true },
        suspensionOperationId: { clear: true },
        erasureOperationId: { clear: true },
        cleanupContext: { clear: true },
        status: "verified",
        verifiedAt: NOW + 10,
      });

      expect(await harness.store.jobs.deletions.get("del-1")).toEqual({
        deletionId: "del-1",
        version: 1,
        slug: null,
        currentGatewayId: null,
        status: "verified",
        requestedAt: NOW,
        eraseAfter: NOW + 90 * DAY,
        productContext: { stripeCustomerIds: ["cus_1"], stripeSubscriptionIds: ["sub_1"] },
        verifiedAt: NOW + 10,
        revision: expect.any(String),
      });
      expect(await harness.store.jobs.deletions.listForUid("u1")).toEqual([]);
    });

    it("fences a patch on the domain status and the revision", async () => {
      await harness.store.jobs.deletions.create(deletionJob({ status: "product_verification_pending" }));
      const before = (await harness.store.jobs.deletions.get("del-1"))!;

      await expect(
        harness.store.jobs.deletions.patch("del-1", { status: "verified" }, { status: ["suspending"] }),
      ).rejects.toMatchObject({ constructor: FenceMismatchError, fence: "status", actual: "product_verification_pending" });
      await harness.store.jobs.deletions.patch("del-1", { status: "verified_pending_completion" }, { status: ["product_verification_pending"] });
      await expect(
        harness.store.jobs.deletions.patch("del-1", { status: "verified" }, { revision: before.revision }),
      ).rejects.toMatchObject({ constructor: FenceMismatchError, fence: "revision" });
      await expect(
        harness.store.jobs.deletions.patch("missing", { status: "verified" }, { status: ["suspending"] }),
      ).rejects.toBeInstanceOf(MissingRecordError);
      await expect(harness.store.jobs.deletions.patch("missing", { status: "verified" })).rejects.toBeInstanceOf(MissingRecordError);
      expect((await harness.store.jobs.deletions.get("del-1"))?.status).toBe("verified_pending_completion");
    });

    it("refuses a patch to an immutable field", async () => {
      await harness.store.jobs.deletions.create(deletionJob());

      await expect(harness.store.jobs.deletions.patch("del-1", { requestedAt: NOW + 1 } as never)).rejects.toBeInstanceOf(TypeError);
      expect((await harness.store.jobs.deletions.get("del-1"))?.requestedAt).toBe(NOW);
    });

    it("records retired gateway proofs under each gateway id and clears them together", async () => {
      await harness.store.jobs.deletions.create(deletionJob());

      await harness.store.jobs.deletions.recordRetiredGatewayProof("del-1", "g-1", { retiredAt: NOW, operationId: "op-1" });
      await harness.store.jobs.deletions.recordRetiredGatewayProof("del-1", "g_2", { retiredAt: { serverNow: true }, operationId: "op-2" });
      await harness.store.jobs.deletions.recordRetiredGatewayProof("del-1", "g-1", { retiredAt: NOW + 1, operationId: "op-3" });

      expect((await harness.store.jobs.deletions.get("del-1"))?.retiredGatewayProofs).toEqual({
        "g-1": { retiredAt: NOW + 1, operationId: "op-3" },
        g_2: { retiredAt: expect.any(Number), operationId: "op-2" },
      });
      await expect(harness.store.jobs.deletions.recordRetiredGatewayProof("del-1", "g.3", {})).rejects.toBeInstanceOf(TypeError);
      await expect(harness.store.jobs.deletions.recordRetiredGatewayProof("missing", "g-1", {})).rejects.toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "customer-deletion-job", key: "missing" },
      });

      await harness.store.jobs.deletions.patch("del-1", { retiredGatewayProofs: { clear: true } });
      expect(await harness.store.jobs.deletions.get("del-1")).not.toHaveProperty("retiredGatewayProofs");
    });

    it("moves the revision when a proof is recorded", async () => {
      await harness.store.jobs.deletions.create(deletionJob());
      const before = (await harness.store.jobs.deletions.get("del-1"))!;

      await harness.store.jobs.deletions.recordRetiredGatewayProof("del-1", "g-1", {});

      await expect(
        harness.store.jobs.deletions.patch("del-1", { status: "suspending" }, { revision: before.revision }),
      ).rejects.toMatchObject({ constructor: FenceMismatchError, fence: "revision" });
    });

    it("keeps Postgres agent store targets as a list of maps", async () => {
      const targets = [
        { database: "builder_u1", schema: "agents" },
        { database: "shared", schema: "u1" },
      ];

      await harness.store.jobs.deletions.create(deletionJob({ postgresAgentStoreTargets: targets }));

      expect((await harness.store.jobs.deletions.get("del-1"))?.postgresAgentStoreTargets).toEqual(targets);
    });

    it("lists a uid's deletion jobs", async () => {
      await harness.store.jobs.deletions.create(deletionJob({ deletionId: "del-2" }));
      await harness.store.jobs.deletions.create(deletionJob({ deletionId: "del-1" }));
      await harness.store.jobs.deletions.create(deletionJob({ deletionId: "del-3", uid: "u2" }));

      expect((await harness.store.jobs.deletions.listForUid("u1")).map((job) => job.deletionId)).toEqual(["del-1", "del-2"]);
    });
  });

  describe("anonymous operational archives", () => {
    it("creates an archive under a generated id beside its archive time", async () => {
      const id = await harness.store.jobs.archives.create({
        archivedAt: NOW,
        record: { planTier: "personal", gatewayClass: "shared", usage: { tokens: 10 } },
      });
      const other = await harness.store.jobs.archives.create({ archivedAt: NOW, record: {} });

      expect(id).not.toBe(other);
      expect((await harness.store.jobs.archives.list({ limit: 10 })).items).toContainEqual({
        id,
        archivedAt: NOW,
        record: { planTier: "personal", gatewayClass: "shared", usage: { tokens: 10 } },
      });
      await expect(harness.store.jobs.archives.create({ archivedAt: NOW, record: { archivedAt: 1 } })).rejects.toBeInstanceOf(TypeError);
    });

    it("deep-merges later facts into an archive without moving its archive time", async () => {
      const id = await harness.store.jobs.archives.create({ archivedAt: NOW, record: { usage: { tokens: 10, cost: 2 }, region: "us" } });

      await harness.store.jobs.archives.merge(id, { usage: { requests: 2, cost: { clear: true } }, deletedAt: NOW + 1 });
      await harness.store.jobs.archives.merge(id, { region: { clear: true }, erasedAt: { serverNow: true } });

      expect((await harness.store.jobs.archives.list({ limit: 1 })).items).toEqual([
        { id, archivedAt: NOW, record: { usage: { tokens: 10, requests: 2 }, deletedAt: NOW + 1, erasedAt: expect.any(Number) } },
      ]);
      await expect(harness.store.jobs.archives.merge(id, { archivedAt: NOW + 2 })).rejects.toBeInstanceOf(TypeError);
    });

    it("refuses to merge into an archive that does not exist", async () => {
      await expect(harness.store.jobs.archives.merge("missing", { deletedAt: NOW })).rejects.toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "anonymous-operational-archive", key: "missing" },
      });
    });

    it("pages archives newest first", async () => {
      const oldest = await harness.store.jobs.archives.create({ archivedAt: NOW, record: { n: 0 } });
      const middle = await harness.store.jobs.archives.create({ archivedAt: NOW + 1, record: { n: 1 } });
      const newest = await harness.store.jobs.archives.create({ archivedAt: NOW + 2, record: { n: 2 } });

      const first = await harness.store.jobs.archives.list({ limit: 2 });
      const second = await harness.store.jobs.archives.list({ limit: 2, after: first.next! });

      expect(first).toEqual({
        items: [
          { id: newest, archivedAt: NOW + 2, record: { n: 2 } },
          { id: middle, archivedAt: NOW + 1, record: { n: 1 } },
        ],
        next: middle,
      });
      expect(second).toEqual({ items: [{ id: oldest, archivedAt: NOW, record: { n: 0 } }], next: null });
      expect(await harness.store.jobs.archives.list({ limit: 3 })).toMatchObject({ next: null });
      await expect(harness.store.jobs.archives.list({ limit: 2, after: "missing" })).rejects.toBeInstanceOf(MissingRecordError);
    });

    it("pages archives that share an archive time without skipping or repeating one", async () => {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) ids.push(await harness.store.jobs.archives.create({ archivedAt: NOW, record: { index } }));
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await harness.store.jobs.archives.list({ limit: 2, ...(after === undefined ? {} : { after }) });
        seen.push(...page.items.map((item) => item.id));
        after = page.next ?? undefined;
      } while (after !== undefined);

      expect(seen).toHaveLength(5);
      expect([...seen].sort()).toEqual([...ids].sort());
    });
  });

  describe("agent imports", () => {
    const importPayload = {
      id: "import-1",
      uid: "u1",
      slug: "acme",
      status: "previewed",
      importCommit: null,
      source: { kind: "github", owner: "ada", repo: "agent" },
      createdAt: iso(NOW),
      updatedAt: iso(NOW + 1_000),
    };
    const exportPayload = {
      id: "export-1",
      kind: "authored-agent-export",
      uid: "u1",
      slug: "acme",
      status: "complete",
      importCommit: "abc123",
      approvalHash: "approval",
      createdAt: iso(NOW),
      updatedAt: iso(NOW + 2_000),
    };

    function importRecord(record: Record<string, unknown>, overrides: Partial<AgentImportRecord> = {}): AgentImportRecord {
      return {
        uid: "u1",
        importId: String(record.id),
        kind: "import",
        slug: "acme",
        status: String(record.status),
        importCommit: null,
        cleanupAt: NOW + DAY,
        createdAt: NOW,
        updatedAt: NOW + 1_000,
        record,
        ...overrides,
      };
    }

    const exportRecord = importRecord(exportPayload, {
      kind: "export",
      importCommit: "abc123",
      cleanupAt: NOW + 25 * 60 * 60_000,
      updatedAt: NOW + 2_000,
    });

    beforeEach(async () => {
      for (const uid of ["u1", "u2"]) await harness.query("INSERT INTO $schema.builders (uid) VALUES ($1::text)", [uid]);
    });

    it("round-trips import and export records", async () => {
      await harness.store.jobs.agentImports.put(importRecord(importPayload));
      await harness.store.jobs.agentImports.put(exportRecord);

      expect(await harness.store.jobs.agentImports.get("u1", "import-1")).toEqual({ ...importRecord(importPayload), revision: expect.any(String) });
      expect(await harness.store.jobs.agentImports.get("u1", "export-1")).toEqual({ ...exportRecord, revision: expect.any(String) });
      expect(await harness.store.jobs.agentImports.get("u1", "missing")).toBeNull();
    });

    it("replaces a record whole on a later put", async () => {
      await harness.store.jobs.agentImports.put(importRecord(importPayload));
      const applied = { ...importPayload, status: "applied", importCommit: "def456", updatedAt: iso(NOW + 5_000) };

      await harness.store.jobs.agentImports.put(importRecord(applied, { importCommit: "def456", cleanupAt: null, updatedAt: NOW + 5_000 }));

      expect(await harness.store.jobs.agentImports.get("u1", "import-1")).toMatchObject({
        status: "applied",
        importCommit: "def456",
        cleanupAt: null,
        updatedAt: NOW + 5_000,
        record: applied,
      });
    });

    it("puts back a record it read after the caller changes it", async () => {
      await harness.store.jobs.agentImports.put(importRecord(importPayload));
      const stored = (await harness.store.jobs.agentImports.get("u1", "import-1"))!;
      const committed = { ...stored.record, status: "committed", importCommit: "def456", updatedAt: iso(NOW + 5_000) };

      await harness.store.jobs.agentImports.put({ ...stored, status: "committed", importCommit: "def456", updatedAt: NOW + 5_000, record: committed });

      expect(await harness.store.jobs.agentImports.get("u1", "import-1")).toEqual({
        ...importRecord(committed, { status: "committed", importCommit: "def456", updatedAt: NOW + 5_000 }),
        revision: expect.any(String),
      });
    });

    it("rejects typed fields that disagree with the payload", async () => {
      await expect(harness.store.jobs.agentImports.put(importRecord(importPayload, { status: "workspace" }))).rejects.toBeInstanceOf(TypeError);
      await expect(harness.store.jobs.agentImports.put(importRecord(importPayload, { kind: "export" }))).rejects.toBeInstanceOf(TypeError);
      await expect(
        harness.store.jobs.agentImports.put(importRecord({ ...importPayload, cleanupAt: NOW }, { cleanupAt: null })),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(harness.store.jobs.agentImports.put(importRecord({ ...importPayload, status: 5 }))).rejects.toBeInstanceOf(
        MalformedRecordError,
      );
      expect(await harness.store.jobs.agentImports.listForUid("u1")).toEqual([]);
    });

    it("lists records whose cleanup time has passed across Builders", async () => {
      await harness.store.jobs.agentImports.put(importRecord({ ...importPayload, id: "expired-a" }, { cleanupAt: NOW - 1 }));
      await harness.store.jobs.agentImports.put(importRecord({ ...importPayload, id: "expired-b", uid: "u2" }, { uid: "u2", cleanupAt: NOW - 2 }));
      await harness.store.jobs.agentImports.put(importRecord({ ...importPayload, id: "live" }, { cleanupAt: NOW + 1 }));
      await harness.store.jobs.agentImports.put(importRecord({ ...importPayload, id: "kept" }, { cleanupAt: null }));

      const expired = await harness.store.jobs.agentImports.listExpired(NOW, 10);

      expect(expired.map((record) => `${record.uid}/${record.importId}`)).toEqual(["u2/expired-b", "u1/expired-a"]);
      expect((await harness.store.jobs.agentImports.listExpired(NOW, 1)).map((record) => record.importId)).toEqual(["expired-b"]);
      expect((await harness.store.jobs.agentImports.listForUid("u1")).map((record) => record.importId)).toEqual(["expired-a", "kept", "live"]);
    });

    it("deletes a record", async () => {
      await harness.store.jobs.agentImports.put(importRecord(importPayload));

      await harness.store.jobs.agentImports.delete("u1", "import-1");

      expect(await harness.store.jobs.agentImports.get("u1", "import-1")).toBeNull();
    });

    it("refuses a record for an unknown Builder and drops a Builder's records with the Builder", async () => {
      await expect(
        harness.store.jobs.agentImports.put(importRecord({ ...importPayload, uid: "ghost" }, { uid: "ghost" })),
      ).rejects.toMatchObject({ constructor: MissingRecordError, record: { aggregate: "builder", key: "ghost" } });
      await harness.store.jobs.agentImports.put(importRecord(importPayload));
      await harness.store.jobs.agentImports.putPointer("u1", "latest", { importId: "import-1", slug: "acme", updatedAt: NOW });

      await harness.query("DELETE FROM $schema.builders WHERE uid = 'u1'");

      expect(await harness.store.jobs.agentImports.listForUid("u1")).toEqual([]);
      expect(await harness.store.jobs.agentImports.getPointer("u1", "latest")).toBeNull();
    });

    describe("pointers", () => {
      beforeEach(async () => {
        await harness.store.jobs.agentImports.put(importRecord(importPayload));
        await harness.store.jobs.agentImports.put(exportRecord);
      });

      it("writes, replaces, reads and deletes the latest import and export pointers", async () => {
        await harness.store.jobs.agentImports.putPointer("u1", "latest", { importId: "export-1", slug: null, updatedAt: null });
        await harness.store.jobs.agentImports.putPointer("u1", "latest", { importId: "import-1", slug: "acme", updatedAt: NOW });
        await harness.store.jobs.agentImports.putPointer("u1", "export-latest", { importId: "export-1", slug: null, updatedAt: null });

        expect(await harness.store.jobs.agentImports.getPointer("u1", "latest")).toEqual({
          importId: "import-1",
          slug: "acme",
          updatedAt: NOW,
          revision: expect.any(String),
        });
        expect(await harness.store.jobs.agentImports.getPointer("u1", "export-latest")).toEqual({
          importId: "export-1",
          slug: null,
          updatedAt: null,
          revision: expect.any(String),
        });
        expect(await harness.store.jobs.agentImports.getPointer("u2", "latest")).toBeNull();

        await harness.store.jobs.agentImports.deletePointer("u1", "latest");
        expect(await harness.store.jobs.agentImports.getPointer("u1", "latest")).toBeNull();
        expect(await harness.store.jobs.agentImports.getPointer("u1", "export-latest")).not.toBeNull();
      });

      it("refuses a pointer to a record that does not exist", async () => {
        await expect(
          harness.store.jobs.agentImports.putPointer("u1", "latest", { importId: "missing", slug: null, updatedAt: NOW }),
        ).rejects.toMatchObject({ constructor: MissingRecordError, record: { aggregate: "agent-import", key: "u1/missing" } });
        await expect(
          harness.store.jobs.agentImports.putPointer("u2", "latest", { importId: "import-1", slug: null, updatedAt: NOW }),
        ).rejects.toBeInstanceOf(MissingRecordError);
      });

      it("drops a pointer with the record it names", async () => {
        await harness.store.jobs.agentImports.putPointer("u1", "latest", { importId: "import-1", slug: "acme", updatedAt: NOW });

        await harness.store.jobs.agentImports.delete("u1", "import-1");

        expect(await harness.store.jobs.agentImports.getPointer("u1", "latest")).toBeNull();
      });
    });
  });
});
