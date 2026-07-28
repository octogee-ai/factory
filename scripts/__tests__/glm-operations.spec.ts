import { describe, it, expect, vi } from "vitest";
import {
  buildOperationAuditIntent,
  claimOperationAuditAction,
  enqueueOperation,
  finishOperationAudit,
  OperationAuditMissingError,
  OperationAuditIdempotencyConflictError,
  OperationAuditClaimNotStaleError,
  OperationAuditRecordTypeError,
  OperationAuditRecoveryContractError,
  OperationAuditSchemaError,
  OperationAuditStateError,
  recordOperationAuditIntent,
  resumeOperationAuditAction,
  readOperation,
  stageOperationAuditIntent,
  awaitOperation,
  isTerminalStatus,
  runWithOperationAuditIntent,
  type OperationsDb,
} from "../lib/glm-operations.js";
import { GLM_OPERATIONS_COLLECTION } from "../../shared/types/glm.js";

function makeFakeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initial));
  let seq = 0;
  const added: Array<{ id: string; data: Record<string, unknown> }> = [];
  const db: OperationsDb = {
    collection(name) {
      expect(name).toBe(GLM_OPERATIONS_COLLECTION);
      return {
        async add(data) {
          const id = `op-${++seq}`;
          docs.set(id, data);
          added.push({ id, data });
          return { id };
        },
        doc(id) {
          return {
            id,
            async get() {
              const data = docs.get(id);
              return { exists: data !== undefined, id, data: () => data };
            },
          };
        },
      };
    },
    async runTransaction(body) {
      const writes: Array<() => void> = [];
      const result = await body({
        get: async (ref) => ref.get(),
        create: (ref, data) => {
          writes.push(() => {
            if (docs.has(ref.id)) throw new Error(`document ${ref.id} already exists`);
            docs.set(ref.id, data);
          });
        },
        update: (ref, data) => {
          writes.push(() => {
            const current = docs.get(ref.id);
            if (!current) throw new Error(`document ${ref.id} does not exist`);
            docs.set(ref.id, { ...current, ...data });
          });
        },
      });
      for (const write of writes) write();
      return result;
    },
  };
  return { db, docs, added };
}

describe("isTerminalStatus", () => {
  it("treats succeeded/failed/rolled-back as terminal, pending/running as not", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("rolled-back")).toBe(true);
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("enqueueOperation", () => {
  it("writes a pending op with kind/input/createdBy and returns the new id", async () => {
    const { db, docs } = makeFakeDb();
    const id = await enqueueOperation(db, {
      kind: "migrate-customer",
      input: { uid: "u1", toGatewayId: "canary" },
      createdBy: "fleet-cli",
      now: () => 1234,
    });
    expect(id).toBe("op-1");
    const doc = docs.get("op-1")!;
    expect(doc).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      createdBy: "fleet-cli",
      createdAt: 1234,
      startedAt: null,
      completedAt: null,
      input: { uid: "u1", toGatewayId: "canary" },
      steps: [],
      inputUid: "u1",
    });
  });

  it("mirrors a gatewayId from input to the top-level field for controller indexing", async () => {
    const { db, docs } = makeFakeDb();
    await enqueueOperation(db, {
      kind: "retire-gateway",
      input: { gatewayId: "bender" },
      createdBy: "fleet-cli",
    });
    expect(docs.get("op-1")).toMatchObject({ gatewayId: "bender" });
    expect(docs.get("op-1")).not.toHaveProperty("inputUid");
  });
});

const auditIntent = {
  actor: "fleet-cli:chris",
  forced: true,
  what: "move release alias",
  why: "candidate verified in TEST",
  target: { gatewayId: "bender" },
  preActionStatus: { alias: "stable", target: "sha-old" },
  mutation: {
    aliases: [{ alias: "stable", target: "sha-next" }],
    gatewayId: "bender",
  },
  aliasPlan: [{ alias: "stable", expectedTarget: "sha-old", intendedTarget: "sha-next" }],
  releaseRollout: { releaseId: "v1.2.3", rolloutOperationId: "rollout-1" },
  testProvenance: { environment: "test" as const, sourceCommit: "abc123", verifiedAt: 1000 },
};

describe("operation audit journal", () => {
  it("builds a deterministic audit intent with release, alias, and TEST provenance", () => {
    const first = buildOperationAuditIntent({ ...auditIntent, now: () => 1234 });
    const second = buildOperationAuditIntent({
      ...auditIntent,
      mutation: { gatewayId: "bender", aliases: [{ target: "sha-next", alias: "stable" }] },
      now: () => 5678,
    });

    expect(first.id).toBe(second.id);
    expect(first.document).toMatchObject({
      recordType: "audit",
      schemaVersion: 1,
      status: "recorded",
      lifecycleStage: "intent-recorded",
      idempotencyKey: first.document.mutationFingerprint,
      mutation: auditIntent.mutation,
      aliasPlan: auditIntent.aliasPlan,
      releaseRollout: auditIntent.releaseRollout,
      testProvenance: auditIntent.testProvenance,
      createdAt: 1234,
      completedAt: null,
    });
  });

  it("rejects a cyclic nested array instead of recursing while fingerprinting intent", () => {
    const aliases: unknown[] = [];
    aliases.push(aliases);

    expect(() => buildOperationAuditIntent({
      ...auditIntent,
      mutation: { aliases },
      now: () => 1234,
    })).toThrow("operation audit mutation contains a cycle");
  });

  it("returns the existing deterministic journal row for an idempotent retry", async () => {
    const { db, docs } = makeFakeDb();

    const first = await recordOperationAuditIntent(db, { ...auditIntent, now: () => 1234 });
    const retry = await recordOperationAuditIntent(db, {
      ...auditIntent,
      mutation: { gatewayId: "bender", aliases: [{ target: "sha-next", alias: "stable" }] },
      now: () => 5678,
    });

    expect(first).toEqual({ auditId: retry.auditId, disposition: "created", status: "recorded" });
    expect(retry).toEqual({ auditId: first.auditId, disposition: "existing", status: "recorded" });
    expect(docs.size).toBe(1);
    expect(docs.get(first.auditId)?.createdAt).toBe(1234);
  });

  it("rejects a different mutation that reuses an audit idempotency key", async () => {
    const { db, docs } = makeFakeDb();
    await recordOperationAuditIntent(db, {
      ...auditIntent,
      idempotencyKey: "release-v1.2.3",
      now: () => 1234,
    });

    await expect(recordOperationAuditIntent(db, {
      ...auditIntent,
      idempotencyKey: "release-v1.2.3",
      mutation: { gatewayId: "other", aliases: [{ alias: "stable", target: "sha-next" }] },
      now: () => 5678,
    })).rejects.toBeInstanceOf(OperationAuditIdempotencyConflictError);
    expect(docs.size).toBe(1);
  });

  it("rejects a malformed or future existing audit row during idempotent staging", async () => {
    const { db, docs } = makeFakeDb();
    const audit = buildOperationAuditIntent({ ...auditIntent, now: () => 1234 });
    docs.set(audit.id, { ...audit.document, schemaVersion: 2 });

    await expect(db.runTransaction((transaction) =>
      stageOperationAuditIntent(db, transaction, audit),
    )).rejects.toBeInstanceOf(OperationAuditSchemaError);
    const action = vi.fn(async () => "must not run");
    await expect(runWithOperationAuditIntent(
      db,
      { ...auditIntent, now: () => 1234 },
      { claimId: "runner-1", now: () => 1235 },
      action,
    )).rejects.toBeInstanceOf(OperationAuditSchemaError);
    expect(action).not.toHaveBeenCalled();
    expect(docs.get(audit.id)?.schemaVersion).toBe(2);
  });

  it("stages the journal row beside a command write in the caller transaction", async () => {
    const { db, docs } = makeFakeDb({ command: { status: "pending" } });
    const audit = buildOperationAuditIntent({ ...auditIntent, now: () => 1234 });

    await db.runTransaction(async (transaction) => {
      await stageOperationAuditIntent(db, transaction, audit);
      transaction.update(db.collection(GLM_OPERATIONS_COLLECTION).doc("command"), { status: "running" });
    });

    expect(docs.get(audit.id)).toEqual(audit.document);
    expect(docs.get("command")).toEqual({ status: "running" });
  });

  it("does not invoke the external action when durable intent persistence rejects", async () => {
    const action = vi.fn(async () => undefined);
    const db = {
      collection: () => ({
        add: vi.fn(),
        doc: (id: string) => ({ id, get: vi.fn() }),
      }),
      runTransaction: vi.fn(async () => {
        throw new Error("firestore unavailable");
      }),
    } as unknown as OperationsDb;

    await expect(
      runWithOperationAuditIntent(
        db,
        { ...auditIntent, now: () => 1234 },
        { claimId: "runner-1", now: () => 1235 },
        action,
      ),
    ).rejects.toThrow("firestore unavailable");
    expect(action).not.toHaveBeenCalled();
  });

  it("lets only one runner claim a recorded action while the winning action is in progress", async () => {
    const { db } = makeFakeDb();
    let releaseAction!: () => void;
    let reportStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    const firstAction = vi.fn(async () => {
      reportStarted();
      await actionGate;
      return "done";
    });
    const secondAction = vi.fn(async () => "must not run");

    const first = runWithOperationAuditIntent(
      db,
      { ...auditIntent, now: () => 1234 },
      { claimId: "runner-1", now: () => 1235 },
      firstAction,
    );
    await actionStarted;

    await expect(runWithOperationAuditIntent(
      db,
      { ...auditIntent, now: () => 1234 },
      { claimId: "runner-2", now: () => 1236 },
      secondAction,
    )).rejects.toBeInstanceOf(OperationAuditStateError);
    expect(secondAction).not.toHaveBeenCalled();

    releaseAction();
    await expect(first).resolves.toBe("done");
    expect(firstAction).toHaveBeenCalledOnce();
  });

  it("leaves the claimed action repairable when completion persistence fails after success", async () => {
    const { db, docs } = makeFakeDb();
    const runTransaction = db.runTransaction.bind(db);
    let calls = 0;
    db.runTransaction = async (body) => {
      calls += 1;
      if (calls === 3) throw new Error("completion write unavailable");
      return runTransaction(body);
    };
    const action = vi.fn(async () => "external mutation succeeded");

    await expect(
      runWithOperationAuditIntent(
        db,
        { ...auditIntent, now: () => 1234 },
        { claimId: "runner-1", now: () => 1235 },
        action,
      ),
    ).rejects.toThrow("completion write unavailable");

    expect(action).toHaveBeenCalledOnce();
    expect([...docs.values()]).toHaveLength(1);
    expect([...docs.values()][0]).toMatchObject({
      status: "in-progress",
      lifecycleStage: "action-started",
      actionClaimId: "runner-1",
      actionStartedAt: 1235,
      completedAt: null,
    });
  });

  it("does not recover a live claim before its explicit lease expires", async () => {
    const { db, docs } = makeFakeDb();
    const { auditId } = await recordOperationAuditIntent(db, { ...auditIntent, now: () => 1234 });
    await claimOperationAuditAction(db, auditId, { claimId: "runner-1", now: () => 1235 });
    const recovery = vi.fn(async () => "must not run");

    await expect(resumeOperationAuditAction(db, {
      auditId,
      expectedClaimId: "runner-1",
      recoveryClaimId: "recovery-1",
      externalIdempotencyKey: auditId,
      now: () => 1236,
      staleAfterMs: 100,
    }, recovery)).rejects.toBeInstanceOf(OperationAuditClaimNotStaleError);

    expect(recovery).not.toHaveBeenCalled();
    expect(docs.get(auditId)).toMatchObject({
      status: "in-progress",
      actionClaimId: "runner-1",
      actionStartedAt: 1235,
      actionRecoveryCount: 0,
    });

    const expiredRecovery = vi.fn(async () => "recovered after expiry");
    await expect(resumeOperationAuditAction(db, {
      auditId,
      expectedClaimId: "runner-1",
      recoveryClaimId: "recovery-1",
      externalIdempotencyKey: auditId,
      now: () => 1335,
      staleAfterMs: 100,
    }, expiredRecovery)).resolves.toBe("recovered after expiry");
    expect(expiredRecovery).toHaveBeenCalledOnce();
  });

  it("requires an audit-ID-keyed externally idempotent contract to recover an ambiguous action", async () => {
    const { db, docs } = makeFakeDb();
    const runTransaction = db.runTransaction.bind(db);
    let calls = 0;
    db.runTransaction = async (body) => {
      calls += 1;
      if (calls === 3) throw new Error("completion write unavailable");
      return runTransaction(body);
    };
    const auditId = buildOperationAuditIntent({ ...auditIntent, now: () => 1234 }).id;
    await expect(runWithOperationAuditIntent(
      db,
      { ...auditIntent, now: () => 1234 },
      { claimId: "runner-1", now: () => 1235 },
      vi.fn(async () => "external mutation succeeded"),
    )).rejects.toThrow("completion write unavailable");
    db.runTransaction = runTransaction;

    const blindRetry = vi.fn(async () => "must not run");
    await expect(runWithOperationAuditIntent(
      db,
      { ...auditIntent, now: () => 1234 },
      { claimId: "runner-2", now: () => 1236 },
      blindRetry,
    )).rejects.toBeInstanceOf(OperationAuditStateError);
    expect(blindRetry).not.toHaveBeenCalled();

    const recovery = vi.fn(async (claim) => {
      expect(claim).toMatchObject({
        auditId,
        claimId: "recovery-1",
        externalIdempotencyKey: auditId,
        recovery: true,
      });
      await expect(finishOperationAudit(db, auditId, {
        expectedClaimId: "runner-1",
        outcome: "completed",
      })).rejects.toBeInstanceOf(OperationAuditStateError);
      return "recovered";
    });
    await expect(resumeOperationAuditAction(db, {
      auditId,
      expectedClaimId: "runner-1",
      recoveryClaimId: "recovery-1",
      externalIdempotencyKey: "wrong-key",
      now: () => 1237,
      staleAfterMs: 1,
    }, recovery)).rejects.toBeInstanceOf(OperationAuditRecoveryContractError);
    expect(recovery).not.toHaveBeenCalled();

    await expect(resumeOperationAuditAction(db, {
      auditId,
      expectedClaimId: "runner-1",
      recoveryClaimId: "recovery-1",
      externalIdempotencyKey: auditId,
      now: () => 1237,
      staleAfterMs: 1,
    }, recovery)).resolves.toBe("recovered");
    expect(docs.get(auditId)).toMatchObject({
      status: "completed",
      lifecycleStage: "action-completed",
      actionClaimId: "recovery-1",
      actionRecoveryCount: 1,
      outcome: "completed",
    });
  });

  it("finishes an audit only from its claimed in-progress state", async () => {
    const { db, docs } = makeFakeDb();
    const { auditId } = await recordOperationAuditIntent(db, { ...auditIntent, now: () => 1234 });
    await claimOperationAuditAction(db, auditId, { claimId: "runner-1", now: () => 1235 });

    await finishOperationAudit(db, auditId, {
      expectedClaimId: "runner-1",
      outcome: "partial",
      partialOutcome: { summary: "secondary alias deferred" },
      aliasOutcomes: [{ alias: "stable", status: "applied", observedTarget: "sha-next" }],
      now: () => 5678,
    });

    expect(docs.get(auditId)).toMatchObject({
      status: "completed",
      lifecycleStage: "action-partial",
      outcome: "partial",
      completedAt: 5678,
      partialOutcome: { summary: "secondary alias deferred" },
    });
  });

  it("persists a failed outcome and its error without replacing the intent", async () => {
    const { db, docs } = makeFakeDb();
    const { auditId } = await recordOperationAuditIntent(db, { ...auditIntent, now: () => 1234 });
    await claimOperationAuditAction(db, auditId, { claimId: "runner-1", now: () => 1235 });

    await finishOperationAudit(db, auditId, {
      expectedClaimId: "runner-1",
      outcome: "failed",
      error: "alias API timed out",
      now: () => 5678,
    });

    expect(docs.get(auditId)).toMatchObject({
      status: "failed",
      lifecycleStage: "action-failed",
      outcome: "failed",
      completedAt: 5678,
      error: "alias API timed out",
      mutation: auditIntent.mutation,
    });
  });

  it.each([
    ["missing", new OperationAuditMissingError("missing")],
    ["command", new OperationAuditRecordTypeError("command")],
    ["future", new OperationAuditSchemaError("future")],
    ["illegal", new OperationAuditSchemaError("illegal")],
    ["finished", new OperationAuditStateError("finished", "completed", "in-progress")],
  ])("rejects %s audit finalization without changing any command", async (id, expected) => {
    const { db, docs } = makeFakeDb({
      command: { kind: "rollout", status: "pending", input: {}, steps: [] },
      future: {
        ...buildOperationAuditIntent({ ...auditIntent, now: () => 1 }).document,
        schemaVersion: 2,
      },
      illegal: {
        ...buildOperationAuditIntent({ ...auditIntent, now: () => 1 }).document,
        status: "completed",
        lifecycleStage: "intent-recorded",
      },
      finished: {
        ...buildOperationAuditIntent({ ...auditIntent, now: () => 1 }).document,
        status: "completed",
        lifecycleStage: "action-completed",
        actionClaimId: "runner-1",
        actionStartedAt: 1,
        actionRecoveryCount: 0,
        outcome: "completed",
        completedAt: 2,
      },
    });
    const commandBefore = docs.get("command");
    const journalBefore = new Map(docs);

    await expect(
      finishOperationAudit(db, id, {
        expectedClaimId: "runner-1",
        outcome: "completed",
        now: () => 2,
      }),
    ).rejects.toBeInstanceOf(expected.constructor);
    expect(docs.get("command")).toEqual(commandBefore);
    expect(docs).toEqual(journalBefore);
  });
});

describe("readOperation", () => {
  it("returns null when the op does not exist", async () => {
    const { db } = makeFakeDb();
    expect(await readOperation(db, "missing")).toBeNull();
  });

  it("returns the op with its id merged in", async () => {
    const { db } = makeFakeDb({
      "op-1": { kind: "migrate-customer", status: "running", steps: [] },
    });
    const op = await readOperation(db, "op-1");
    expect(op).toMatchObject({ id: "op-1", status: "running" });
  });
});

describe("awaitOperation", () => {
  it("polls until the op reaches a terminal status and returns it", async () => {
    const base = { kind: "migrate-customer", createdBy: "fleet-cli", input: {} };
    const { db, docs } = makeFakeDb({
      "op-1": { ...base, status: "pending", steps: [] },
    });
    const transitions = [
      { status: "running", steps: [{ name: "quiesce-source", status: "running" }] },
      { status: "succeeded", steps: [{ name: "quiesce-source", status: "done" }] },
    ];
    let tick = 0;
    const sleep = vi.fn(async () => {
      const next = transitions[tick++] ?? transitions[transitions.length - 1];
      docs.set("op-1", { ...base, ...next });
    });
    const onUpdate = vi.fn();
    const op = await awaitOperation(db, "op-1", {
      pollMs: 1,
      timeoutMs: 10_000,
      now: () => 0,
      sleep,
      onUpdate,
    });
    expect(op.status).toBe("succeeded");
    // onUpdate fires once per distinct step set: [] → running → done
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it("throws when the op never finishes before the timeout", async () => {
    const { db } = makeFakeDb({
      "op-1": { kind: "migrate-customer", status: "pending", steps: [], createdBy: "x", input: {} },
    });
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 10_000);
    await expect(
      awaitOperation(db, "op-1", { pollMs: 1, timeoutMs: 1_000, now, sleep: vi.fn() }),
    ).rejects.toThrow(/did not finish within 1000ms/);
  });

  it("throws when the op disappears", async () => {
    const { db } = makeFakeDb();
    await expect(
      awaitOperation(db, "ghost", { now: () => 0, sleep: vi.fn() }),
    ).rejects.toThrow(/operation ghost not found/);
  });
});
