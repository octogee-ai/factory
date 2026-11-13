import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackendFailureError, ContentionExhaustedError, FenceMismatchError, UnsupportedOperationError } from "../../errors.js";
import type { Revision } from "../../store.js";
import { barrier, createHarness, dsn, operation, type PlatformStateHarness } from "./fixtures/harness.js";

function sqlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe.skipIf(!dsn)("PostgreSQL platform state transactions", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("commits the body's writes and exposes its label, mode, and attempt", async () => {
    const created = operation();

    const handle = await harness.store.transaction({ label: "create one" }, async (transaction) => {
      await transaction.journal.operations.create(created);
      return { label: transaction.label, readOnly: transaction.readOnly, attempt: transaction.attempt };
    });

    expect(handle).toEqual({ label: "create one", readOnly: false, attempt: 1 });
    expect(await harness.store.journal.operations.get(created.id)).toMatchObject({ id: created.id, status: "pending" });
  });

  it("rolls back every write when the body throws", async () => {
    const created = operation();
    const failure = new Error("body failed");

    await expect(
      harness.store.transaction({ label: "abandon" }, async (transaction) => {
        await transaction.journal.operations.create(created);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await harness.store.journal.operations.get(created.id)).toBeNull();
  });

  it("retries a serialization failure from a real write skew and converges on one winner", async () => {
    const bothRead = barrier(2);
    const attempts: number[] = [];
    const claim = (id: string) =>
      harness.store.transaction({ label: `claim ${id}` }, async (transaction) => {
        attempts.push(transaction.attempt);
        const running = await transaction.journal.operations.listByStatus(["running"]);
        if (transaction.attempt === 1) await bothRead();
        if (running.length > 0) return "skipped";
        await transaction.journal.operations.create(operation({ id, status: "running", startedAt: 5 }));
        return "created";
      });

    const outcomes = await Promise.all([claim("claim-a"), claim("claim-b")]);

    expect([...outcomes].sort()).toEqual(["created", "skipped"]);
    expect(Math.max(...attempts)).toBeGreaterThanOrEqual(2);
    expect(await harness.store.journal.operations.listByStatus(["running"])).toHaveLength(1);
  });

  it("retries the victim of a real deadlock", async () => {
    await harness.store.journal.operations.create(operation({ id: "lock-a" }));
    await harness.store.journal.operations.create(operation({ id: "lock-b" }));
    const bothLocked = barrier(2);
    const attempts: number[] = [];
    const crossUpdate = (first: string, second: string) =>
      harness.store.transaction({ label: `lock ${first} then ${second}` }, async (transaction) => {
        attempts.push(transaction.attempt);
        await transaction.journal.operations.patch(first, { waitingOn: second });
        if (transaction.attempt === 1) await bothLocked();
        await transaction.journal.operations.patch(second, { waitingOn: first });
      });

    await Promise.all([crossUpdate("lock-a", "lock-b"), crossUpdate("lock-b", "lock-a")]);

    expect(attempts.filter((attempt) => attempt === 1)).toHaveLength(2);
    expect(Math.max(...attempts)).toBeGreaterThanOrEqual(2);
    const waits = [(await harness.store.journal.operations.get("lock-a"))?.waitingOn, (await harness.store.journal.operations.get("lock-b"))?.waitingOn];
    expect(waits.sort()).toEqual(["lock-a", "lock-b"]);
  });

  it("gives up after maxAttempts contended attempts with ContentionExhaustedError and logs it", async () => {
    let calls = 0;
    const contention = sqlError("40001", "could not serialize access");

    const failure = await harness.store
      .transaction({ label: "always contended", maxAttempts: 3 }, async () => {
        calls += 1;
        throw contention;
      })
      .catch((error: unknown) => error);

    expect(calls).toBe(3);
    expect(failure).toBeInstanceOf(ContentionExhaustedError);
    expect(failure).toMatchObject({ backend: "postgresql", transactionLabel: "always contended", attempts: 3, cause: contention });
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ level: "error", detail: expect.objectContaining({ label: "always contended", attempts: 3 }) }),
    );
  });

  it("retries the victim of a real deadlock even when the body swallows the failure", async () => {
    await harness.store.journal.operations.create(operation({ id: "swallow-a" }));
    await harness.store.journal.operations.create(operation({ id: "swallow-b" }));
    const bothLocked = barrier(2);
    const attempts: number[] = [];
    const crossUpdate = (first: string, second: string) =>
      harness.store.transaction({ label: `swallow ${first} then ${second}` }, async (transaction) => {
        attempts.push(transaction.attempt);
        await transaction.journal.operations.patch(first, { waitingOn: second });
        if (transaction.attempt === 1) await bothLocked();
        await transaction.journal.operations.patch(second, { waitingOn: first }).catch(() => undefined);
      });

    await Promise.all([crossUpdate("swallow-a", "swallow-b"), crossUpdate("swallow-b", "swallow-a")]);

    expect(Math.max(...attempts)).toBeGreaterThanOrEqual(2);
    const waits = [(await harness.store.journal.operations.get("swallow-a"))?.waitingOn, (await harness.store.journal.operations.get("swallow-b"))?.waitingOn];
    expect(waits.sort()).toEqual(["swallow-a", "swallow-b"]);
  });

  it("refuses to report a commit when the body swallows a database error, and keeps none of its writes", async () => {
    const existing = operation();
    const created = operation();
    await harness.store.journal.operations.create(existing);

    const failure = await harness.store
      .transaction({ label: "swallow duplicate" }, async (transaction) => {
        await transaction.journal.operations.create(created);
        await transaction.journal.operations.create(existing).catch(() => undefined);
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackendFailureError);
    expect(await harness.store.journal.operations.get(created.id)).toBeNull();
  });

  it("retries a deadlock code and succeeds on a later attempt", async () => {
    const created = operation();

    const attempt = await harness.store.transaction({ label: "deadlocked once" }, async (transaction) => {
      if (transaction.attempt === 1) throw sqlError("40P01", "deadlock detected");
      await transaction.journal.operations.create(created);
      return transaction.attempt;
    });

    expect(attempt).toBe(2);
    expect(await harness.store.journal.operations.get(created.id)).not.toBeNull();
  });

  it("rejects a maxAttempts that is not a positive integer", async () => {
    await expect(harness.store.transaction({ label: "bad", maxAttempts: 0 }, async () => 1)).rejects.toThrow(RangeError);
    await expect(harness.store.transaction({ label: "bad", maxAttempts: 1.5 }, async () => 1)).rejects.toThrow(RangeError);
  });

  it("does not retry a fence mismatch and rolls back the attempt's earlier writes", async () => {
    const fenced = operation();
    const sibling = operation();
    await harness.store.journal.operations.create(fenced);
    let calls = 0;

    const failure = await harness.store
      .transaction({ label: "fenced" }, async (transaction) => {
        calls += 1;
        await transaction.journal.operations.create(sibling);
        await transaction.journal.operations.patch(fenced.id, { status: "running" }, { status: ["running"] });
      })
      .catch((error: unknown) => error);

    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(FenceMismatchError);
    expect(await harness.store.journal.operations.get(sibling.id)).toBeNull();
  });

  it("serves reads in a read-only transaction and refuses its writes", async () => {
    const created = operation();
    await harness.store.journal.operations.create(created);

    const read = await harness.store.transaction({ label: "inspect", readOnly: true }, async (transaction) => {
      expect(transaction.readOnly).toBe(true);
      return transaction.journal.operations.get(created.id);
    });
    expect(read?.id).toBe(created.id);

    const failure = await harness.store
      .transaction({ label: "inspect then write", readOnly: true }, (transaction) =>
        transaction.journal.operations.patch(created.id, { status: "running" }),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnsupportedOperationError);
    expect(failure).toMatchObject({ reason: "write-in-read-only-transaction" });
    expect((await harness.store.journal.operations.get(created.id))?.status).toBe("pending");
  });

  it("refuses a read after the transaction has written", async () => {
    const created = operation();

    const failure = await harness.store
      .transaction({ label: "write then read" }, async (transaction) => {
        await transaction.journal.operations.create(created);
        await transaction.journal.operations.get(created.id);
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnsupportedOperationError);
    expect(failure).toMatchObject({ reason: "read-after-write", operation: "journal.operations.get" });
    expect(await harness.store.journal.operations.get(created.id)).toBeNull();
  });

  it("allows several writes, including fenced ones, after the transaction's reads", async () => {
    const first = operation();
    const second = operation();
    await harness.store.journal.operations.create(first);

    await harness.store.transaction({ label: "read then write" }, async (transaction) => {
      const current = await transaction.journal.operations.get(first.id);
      await transaction.journal.operations.patch(first.id, { status: "running" }, { revision: current?.revision as Revision });
      await transaction.journal.operations.create(second);
      await transaction.journal.operations.patch(second.id, { status: "running" }, { status: ["pending"] });
    });

    expect((await harness.store.journal.operations.get(first.id))?.status).toBe("running");
    expect((await harness.store.journal.operations.get(second.id))?.status).toBe("running");
  });

  it("retries an attempt whose connection drops before COMMIT", async () => {
    const created = operation();
    const attempts: number[] = [];

    await harness.store.transaction({ label: "connection lost" }, async (transaction) => {
      attempts.push(transaction.attempt);
      await transaction.journal.operations.create(created);
      if (transaction.attempt === 1) expect(await harness.terminate("idle in transaction")).toBe(1);
      await transaction.journal.operations.patch(created.id, { status: "running" });
    });

    expect(attempts).toEqual([1, 2]);
    expect((await harness.store.journal.operations.get(created.id))?.status).toBe("running");
  });

  it("does not retry when the connection drops at COMMIT, because the outcome is unknown", async () => {
    const created = operation();
    let calls = 0;

    const failure = await harness.store
      .transaction({ label: "commit lost" }, async (transaction) => {
        calls += 1;
        await transaction.journal.operations.create(created);
        await harness.terminate("idle in transaction");
      })
      .catch((error: unknown) => error);

    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ContentionExhaustedError);
  });
});
