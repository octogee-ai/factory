import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, type Operation } from "@octogee/shared/types/glm";
import {
  drainPendingOperationsOnce,
  processOperation,
  startOperationWorker,
  startOperationQueueDrain,
  OPERATION_QUEUE_DRAIN_MS_DEFAULT,
} from "../index";
import type { OperationHandler, OperationHandlers } from "../operation-router";

type FakeQuery = {
  where: (field: string, op: "==", value: unknown) => FakeQuery;
  orderBy: (field: string, direction?: "asc" | "desc") => FakeQuery;
  get: () => Promise<{ docs: FakeDocSnap[] }>;
  onSnapshot: (
    next: (snapshot: { docChanges: () => Array<{ type: string; doc: FakeDocSnap }> }) => void,
    error: (err: unknown) => void,
  ) => () => void;
};

interface FakeDocSnap {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
  ref: FakeDocRef;
}

interface FakeDocRef {
  id: string;
  get: () => Promise<FakeDocSnap>;
  update: (data: Record<string, unknown>) => Promise<void>;
}

function applyUpdate(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === FieldValue.delete()) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

// Minimal in-memory Firestore double covering exactly what the operation worker
// touches: single-collection get/where/orderBy queries and transactions that
// read a doc + a query before writing. Mirrors the fake used in
// reconciler.spec.ts (defer txn writes, apply after body() resolves).
function createFakeGlmOperationsDb(
  initial: Record<string, Record<string, unknown>>,
  opts: {
    orderByThrows?: boolean;
    gateways?: Record<string, Record<string, unknown>>;
    users?: Record<string, Record<string, unknown>>;
    snapshotChangeIds?: string[];
  } = {},
) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(initial));
  const writeLog: Array<{ id: string; data: Record<string, unknown> }> = [];

  function docRef(id: string): FakeDocRef {
    return {
      id,
      get: async () => ({
        id,
        exists: store.has(id),
        data: () => store.get(id),
        ref: docRef(id),
      }),
      update: async (data: Record<string, unknown>) => {
        const current = store.get(id) ?? {};
        store.set(id, applyUpdate(current, data));
      },
    };
  }

  function buildQuery(filters: Array<[string, unknown]>, order?: { field: string; direction: "asc" | "desc" }): FakeQuery {
    return {
      where: (field, _op, value) => buildQuery([...filters, [field, value]], order),
      orderBy: (field, direction = "asc") => {
        if (opts.orderByThrows) {
          throw new Error(
            "9 FAILED_PRECONDITION: The query requires an index (simulated — status+createdAt has no composite index)",
          );
        }
        return buildQuery(filters, { field, direction });
      },
      get: async () => {
        let entries = [...store.entries()].filter(([, data]) =>
          filters.every(([field, value]) => data[field] === value),
        );
        if (order) {
          const { field, direction } = order;
          entries = entries.sort((a, b) => {
            const av = Number(a[1][field] ?? 0);
            const bv = Number(b[1][field] ?? 0);
            return direction === "desc" ? bv - av : av - bv;
          });
        }
        return {
          docs: entries.map(([id, data]) => ({
            id,
            exists: true,
            data: () => data,
            ref: docRef(id),
          })),
        };
      },
      onSnapshot: (next, _error) => {
        queueMicrotask(() => {
          next({
            docChanges: () =>
              (opts.snapshotChangeIds ?? []).flatMap((id) => {
                const data = store.get(id);
                if (!data) return [];
                return [{
                  type: "added",
                  doc: {
                    id,
                    exists: true,
                    data: () => data,
                    ref: docRef(id),
                  },
                }];
              }),
          });
        });
        return () => undefined;
      },
    };
  }

  const collection = {
    doc: (id: string) => docRef(id),
    where: (field: string, op: "==", value: unknown) => buildQuery([[field, value]]),
    get: () => buildQuery([]).get(),
  };

  const db = {
    collection: (name: string) => {
      if (name === "gateways" || name === "users") {
        const docs = name === "gateways" ? opts.gateways ?? {} : opts.users ?? {};
        return {
          doc: (id: string) => ({
            id,
            get: async () => ({
              id,
              exists: docs[id] !== undefined,
              data: () => docs[id],
              ref: undefined,
            }),
          }),
          where: () => buildQuery([]),
          get: async () => ({ docs: [] }),
        };
      }
      if (name !== GLM_OPERATIONS_COLLECTION) {
        return { doc: () => docRef("unused"), where: () => buildQuery([]), get: async () => ({ docs: [] }) };
      }
      return collection;
    },
    runTransaction: async <T,>(
      body: (txn: {
        get: (refOrQuery: { get: () => Promise<unknown> }) => Promise<unknown>;
        update: (ref: FakeDocRef, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      const writes: Array<() => void> = [];
      const result = await body({
        get: async (refOrQuery) => refOrQuery.get(),
        update: (ref, data) => {
          writes.push(() => {
            writeLog.push({ id: ref.id, data });
            const current = store.get(ref.id) ?? {};
            store.set(ref.id, applyUpdate(current, data));
          });
        },
      });
      for (const write of writes) write();
      return result;
    },
  };

  return { db, store, writeLog };
}

function baseOp(overrides: Partial<Operation> & { id: string }): Record<string, unknown> {
  return {
    kind: "rollout",
    status: "pending",
    createdBy: "admin",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: {},
    steps: [],
    ...overrides,
  };
}

function buildDeps(
  db: ReturnType<typeof createFakeGlmOperationsDb>["db"],
  handlers: Partial<OperationHandlers>,
): Parameters<typeof drainPendingOperationsOnce>[0] {
  return {
    db,
    handlers: handlers as OperationHandlers,
    log: () => undefined,
  } as unknown as Parameters<typeof drainPendingOperationsOnce>[0];
}

describe("gateway operation queue — enqueue instead of reject (glmOperations wiring)", () => {
  it("does not execute an audit record from a pending scan or snapshot", async () => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createFakeGlmOperationsDb(
      {
        "audit-pending": {
          recordType: "audit",
          status: "recorded",
          actor: "operator",
          createdAt: 1,
        },
      },
      { snapshotChangeIds: ["audit-pending"] },
    );

    await drainPendingOperationsOnce(buildDeps(db, { rollout: rolloutHandler }));
    const stop = startOperationWorker(buildDeps(db, { rollout: rolloutHandler }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(rolloutHandler).not.toHaveBeenCalled();
    expect(store.get("audit-pending")?.status).toBe("recorded");
  });

  it("does not let an audit-shaped row participate in serial command conflicts", async () => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createFakeGlmOperationsDb({
      "audit-running": {
        recordType: "audit",
        status: "running",
        kind: "rollout",
        createdAt: 1,
      },
      "op-rollout": baseOp({ id: "op-rollout", createdAt: 2, input: { gatewayId: "bender" } }),
    });

    await drainPendingOperationsOnce(buildDeps(db, { rollout: rolloutHandler }));

    expect(rolloutHandler).toHaveBeenCalledOnce();
    expect(store.get("op-rollout")?.status).toBe("succeeded");
    expect(store.get("audit-running")?.status).toBe("running");
  });

  it("admits a pending durable cleanup retry while release admission drains", async () => {
    const migrationHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createFakeGlmOperationsDb({
      "op-cleanup": baseOp({
        id: "op-cleanup",
        kind: "migrate-customer",
        createdAt: 1,
        output: { configCleanup: { migrationId: "migration-1" } },
      }),
    });
    const deps = buildDeps(db, { "migrate-customer": migrationHandler });
    (deps as unknown as { releaseAdmissionGate: unknown }).releaseAdmissionGate = {
      stateInTransaction: async () => ({ draining: true, releaseId: "candidate", reason: "deploy" }),
    };

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-cleanup")?.status).toBe("succeeded");
    expect(migrationHandler).toHaveBeenCalledOnce();
  });

  it("queues a second rollout op instead of failing it while an earlier one is running, then admits it once the first finishes", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const rolloutHandler: OperationHandler = vi.fn(async (op) => {
      if (op.id === "op-bender") {
        await firstGate;
        return { steps: [], success: true };
      }
      return { steps: [], success: true };
    });

    const { db, store } = createFakeGlmOperationsDb({
      "op-bender": baseOp({ id: "op-bender", createdAt: 1, input: { gatewayId: "bender-blue" } }),
    });
    const deps = buildDeps(db, { rollout: rolloutHandler });

    const firstDrain = drainPendingOperationsOnce(deps);
    // Let op-bender's claim transaction commit and its handler start (and
    // suspend on firstGate) before the second gateway's roll is requested —
    // matching the real sequence: bender-blue's roll is already running when
    // default-green is clicked. A macrotask tick drains every microtask the
    // fake-Firestore claim path schedules.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get("op-bender")?.status).toBe("running");

    store.set(
      "op-default",
      baseOp({ id: "op-default", createdAt: 2, input: { gatewayId: "default-green" } }),
    );

    await drainPendingOperationsOnce(deps);

    const queued = store.get("op-default");
    expect(queued?.status).toBe("pending");
    expect(queued?.waitingOn).toBe("roll bender-blue");
    expect(queued?.error).toBeUndefined();

    releaseFirst();
    await firstDrain;
    expect(store.get("op-bender")?.status).toBe("succeeded");

    await drainPendingOperationsOnce(deps);
    expect(store.get("op-default")?.status).toBe("succeeded");
    expect(store.get("op-default")?.waitingOn).toBeUndefined();
  });

  it("never marks a queued op failed — it stays pending the whole time it waits", async () => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createFakeGlmOperationsDb({
      "op-running": { ...baseOp({ id: "op-running", createdAt: 1 }), status: "running" },
      "op-queued": baseOp({ id: "op-queued", createdAt: 2, input: { gatewayId: "default-green" } }),
    });
    const deps = buildDeps(db, { rollout: rolloutHandler });

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-queued")?.status).toBe("pending");
    expect(rolloutHandler).not.toHaveBeenCalled();
  });

  it("queues a migrate-customer op behind another one targeting the SAME gateway, but admits one to a DIFFERENT target immediately", async () => {
    const migrateHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createFakeGlmOperationsDb({
      "op-running": {
        ...baseOp({
          id: "op-running",
          kind: "migrate-customer",
          createdAt: 1,
          input: { fromGatewayId: "gw-blue", toGatewayId: "gw-green" },
        }),
        status: "running",
      },
      "op-same-target": baseOp({
        id: "op-same-target",
        kind: "migrate-customer",
        createdAt: 2,
        input: { toGatewayId: "gw-green" },
      }),
      "op-other-target": baseOp({
        id: "op-other-target",
        kind: "migrate-customer",
        createdAt: 3,
        input: { toGatewayId: "gw-purple" },
      }),
    });
    const deps = buildDeps(db, { "migrate-customer": migrateHandler });

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-same-target")?.status).toBe("pending");
    expect(store.get("op-same-target")?.waitingOn).toBe("migration gw-blue → gw-green");
    expect(store.get("op-other-target")?.status).toBe("succeeded");
    expect(migrateHandler).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "rollout begins on migration source",
      {
        running: { kind: "migrate-customer", input: { fromGatewayId: "source", toGatewayId: "target" } },
        pending: { kind: "rollout", input: { gatewayId: "source" } },
      },
    ],
    [
      "rollout begins on migration target",
      {
        running: { kind: "migrate-customer", input: { fromGatewayId: "source", toGatewayId: "target" } },
        pending: { kind: "rollout", input: { gatewayId: "target" } },
      },
    ],
    [
      "migration begins during source rollout",
      {
        running: { kind: "rollout", input: { gatewayId: "source" } },
        pending: { kind: "migrate-customer", input: { fromGatewayId: "source", toGatewayId: "target" } },
      },
    ],
    [
      "migration begins during target rollout",
      {
        running: { kind: "rollout", input: { gatewayId: "target" } },
        pending: { kind: "migrate-customer", input: { fromGatewayId: "source", toGatewayId: "target" } },
      },
    ],
  ] as const)("serializes cross-protocol conflict: %s", async (_name, fixture) => {
    const rolloutHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const migrateHandler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createFakeGlmOperationsDb({
      "op-running": {
        ...baseOp({
          id: "op-running",
          kind: fixture.running.kind,
          createdAt: 1,
          input: fixture.running.input,
        }),
        status: "running",
      },
      "op-pending": baseOp({
        id: "op-pending",
        kind: fixture.pending.kind,
        createdAt: 2,
        input: fixture.pending.input,
      }),
    });
    const deps = buildDeps(db, {
      rollout: rolloutHandler,
      "migrate-customer": migrateHandler,
    });

    await drainPendingOperationsOnce(deps);

    expect(store.get("op-pending")?.status).toBe("pending");
    expect(rolloutHandler).not.toHaveBeenCalled();
    expect(migrateHandler).not.toHaveBeenCalled();
  });
});

describe("gateway operation queue — FIFO per scope across the fast path", () => {
  function fakeRefFor(
    db: ReturnType<typeof createFakeGlmOperationsDb>["db"],
    id: string,
  ): Parameters<typeof processOperation>[1] {
    return db
      .collection(GLM_OPERATIONS_COLLECTION)
      .doc(id) as unknown as Parameters<typeof processOperation>[1];
  }

  it("a NEW rollout arriving via the fast path after the blocker completed queues behind the older queued op; the drain then claims the old one first", async () => {
    const claimedOrder: string[] = [];
    const rolloutHandler: OperationHandler = vi.fn(async (op) => {
      claimedOrder.push(op.id);
      return { steps: [], success: true };
    });
    const { db, store } = createFakeGlmOperationsDb({
      "op-done": {
        ...baseOp({ id: "op-done", createdAt: 1, input: { gatewayId: "canary" } }),
        status: "succeeded",
        completedAt: 10,
      },
      "op-old": {
        ...baseOp({ id: "op-old", createdAt: 2, input: { gatewayId: "bender-blue" } }),
        waitingOn: "canary → canary-blue",
      },
    });
    const deps = buildDeps(db, { rollout: rolloutHandler });

    store.set(
      "op-new",
      baseOp({ id: "op-new", createdAt: 3, input: { gatewayId: "default-green" } }),
    );
    await processOperation(
      { ...(store.get("op-new") as unknown as Operation), id: "op-new" },
      fakeRefFor(db, "op-new"),
      deps,
    );

    expect(rolloutHandler).not.toHaveBeenCalled();
    expect(store.get("op-new")?.status).toBe("pending");
    expect(store.get("op-new")?.waitingOn).toBe("roll bender-blue");

    await drainPendingOperationsOnce(deps);

    expect(claimedOrder).toEqual(["op-old", "op-new"]);
    expect(store.get("op-old")?.status).toBe("succeeded");
    expect(store.get("op-new")?.status).toBe("succeeded");
  });

  it("clears nextAttemptAt when claiming so a running doc never carries stale backoff state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: OperationHandler = vi.fn(async () => {
      await gate;
      return { steps: [], success: true };
    });
    const { db, store } = createFakeGlmOperationsDb({
      "op-retry": {
        ...baseOp({ id: "op-retry", createdAt: 1, input: { gatewayId: "bender-blue" } }),
        attempts: 1,
        nextAttemptAt: 1,
      },
    });
    const deps = buildDeps(db, { rollout: handler });

    const drain = drainPendingOperationsOnce(deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get("op-retry")?.status).toBe("running");
    expect(store.get("op-retry")?.nextAttemptAt).toBeUndefined();

    release();
    await drain;
    expect(store.get("op-retry")?.status).toBe("succeeded");
  });
});

describe("gateway operation queue — automatic retry with backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requeues a transient failure with backoff and attempts, then succeeds once the backoff elapses", async () => {
    vi.setSystemTime(1_000_000);
    let calls = 0;
    const handler: OperationHandler = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" };
      }
      return { steps: [], success: true };
    });
    const { db, store } = createFakeGlmOperationsDb({
      "op-migrate": baseOp({ id: "op-migrate", kind: "migrate-customer", createdAt: 1 }),
    });
    const deps = buildDeps(db, { "migrate-customer": handler });

    await drainPendingOperationsOnce(deps);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.get("op-migrate")?.status).toBe("pending");
    expect(store.get("op-migrate")?.attempts).toBe(1);
    expect(store.get("op-migrate")?.nextAttemptAt).toBe(1_000_000 + 30_000);

    // Backoff hasn't elapsed — the drain must not re-invoke the handler yet.
    vi.setSystemTime(1_000_000 + 10_000);
    await drainPendingOperationsOnce(deps);
    expect(handler).toHaveBeenCalledTimes(1);

    // Backoff elapsed — the drain retries and this attempt succeeds.
    vi.setSystemTime(1_000_000 + 31_000);
    await drainPendingOperationsOnce(deps);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.get("op-migrate")?.status).toBe("succeeded");
    expect(store.get("op-migrate")?.attempts).toBe(2);
  });

  it("fails a terminal (validation) error immediately with no retry", async () => {
    vi.setSystemTime(1_000_000);
    const handler: OperationHandler = vi.fn(async () => ({
      steps: [],
      success: false,
      error: "missing gatewayId in op.input",
    }));
    const { db, store } = createFakeGlmOperationsDb({
      "op-bad": baseOp({ id: "op-bad", kind: "add-gateway", createdAt: 1 }),
    });
    const deps = buildDeps(db, { "add-gateway": handler });

    await drainPendingOperationsOnce(deps);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.get("op-bad")?.status).toBe("failed");
    expect(store.get("op-bad")?.error).toBe("missing gatewayId in op.input");
    expect(store.get("op-bad")?.attempts).toBe(1);
  });

  it("stops retrying and fails terminally once the attempt cap is reached, even for a transient cause", async () => {
    vi.setSystemTime(1_000_000);
    const handler: OperationHandler = vi.fn(async () => ({
      steps: [],
      success: false,
      error: "connect ECONNREFUSED 10.0.0.1:443",
    }));
    const { db, store } = createFakeGlmOperationsDb({
      "op-flaky": baseOp({ id: "op-flaky", kind: "restart-gateway", createdAt: 1 }),
    });
    const deps = buildDeps(db, { "restart-gateway": handler });

    await drainPendingOperationsOnce(deps);
    vi.setSystemTime(1_000_000 + 31_000);
    await drainPendingOperationsOnce(deps);
    vi.setSystemTime(1_000_000 + 31_000 + 121_000);
    await drainPendingOperationsOnce(deps);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(store.get("op-flaky")?.status).toBe("failed");
    expect(store.get("op-flaky")?.attempts).toBe(3);
    expect((store.get("op-flaky")?.attemptHistory as unknown[]).length).toBe(3);
  });

  it("keeps an automatic Builder return pending after a transient failure beyond the generic cap", async () => {
    vi.setSystemTime(1_000_000);
    const handler: OperationHandler = vi.fn(async () => ({
      steps: [],
      success: false,
      error: "/restore/default transport failed: fetch failed",
    }));
    const priorAttempts = [
      { attempt: 1, startedAt: 1, completedAt: 2, error: "fetch failed", classification: "transient", steps: [] },
      { attempt: 2, startedAt: 3, completedAt: 4, error: "fetch failed", classification: "transient", steps: [] },
      { attempt: 3, startedAt: 5, completedAt: 6, error: "fetch failed", classification: "transient", steps: [] },
    ];
    const { db, store } = createFakeGlmOperationsDb({
      "builder-return-run-alice": baseOp({
        id: "builder-return-run-alice",
        kind: "migrate-customer",
        origin: "automatic",
        createdAt: 1,
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
          toGatewayId: "default",
        },
        attempts: 3,
        attemptHistory: priorAttempts,
      }),
    });
    const deps = buildDeps(db, { "migrate-customer": handler });

    await drainPendingOperationsOnce(deps);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.get("builder-return-run-alice")?.status).toBe("pending");
    expect(store.get("builder-return-run-alice")?.attempts).toBe(4);
    expect(store.get("builder-return-run-alice")?.nextAttemptAt).toBe(1_000_000 + 480_000);
    expect((store.get("builder-return-run-alice")?.attemptHistory as unknown[]).length).toBe(4);
  });
});

describe("startOperationQueueDrain", () => {
  it("ticks on the configured interval and can be stopped", async () => {
    vi.useFakeTimers();
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    const { db, store } = createFakeGlmOperationsDb({
      "op-1": baseOp({ id: "op-1", createdAt: 1 }),
    });
    const deps = buildDeps(db, { rollout: handler });

    const stop = startOperationQueueDrain(deps, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.get("op-1")?.status).toBe("succeeded");

    stop();
    store.set("op-2", baseOp({ id: "op-2", createdAt: 2 }));
    await vi.advanceTimersByTimeAsync(OPERATION_QUEUE_DRAIN_MS_DEFAULT * 2);
    expect(store.get("op-2")?.status).toBe("pending");

    vi.useRealTimers();
  });
});

describe("queue drain — composite-index-free FIFO", () => {
  it("drains pending ops in createdAt order without orderBy (no composite index exists for status+createdAt)", async () => {
    const { db } = createFakeGlmOperationsDb(
      {
        "op-c": baseOp({ id: "op-c", createdAt: 30 }),
        "op-a": baseOp({ id: "op-a", createdAt: 10 }),
        "op-b": baseOp({ id: "op-b", createdAt: 20 }),
      },
      { orderByThrows: true },
    );
    const order: string[] = [];
    const handler: OperationHandler = vi.fn(async (op) => {
      order.push(op.id);
      return { steps: [], success: true };
    });
    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));
    expect(order).toEqual(["op-a", "op-b", "op-c"]);
  });
});

describe("completion bookkeeping reads the fresh doc, not the caller's snapshot", () => {
  it("a stale worker snapshot cannot reset attempts or drop attemptHistory", async () => {
    const priorAttempts = [
      { attempt: 1, startedAt: 1, completedAt: 2, error: "e1", classification: "transient", steps: [] },
      { attempt: 2, startedAt: 3, completedAt: 4, error: "e2", classification: "transient", steps: [] },
    ];
    const { db, store } = createFakeGlmOperationsDb({
      "op-r": baseOp({ id: "op-r", createdAt: 5, attempts: 2, attemptHistory: priorAttempts }),
    });
    const handler: OperationHandler = vi.fn(async () => ({
      steps: [],
      success: false,
      error: "connect ECONNREFUSED 10.0.0.1:443",
    }));
    const staleSnapshot = { ...(baseOp({ id: "op-r", createdAt: 5 }) as unknown as Operation), id: "op-r" };
    const ref = (db.collection(GLM_OPERATIONS_COLLECTION) as { doc: (id: string) => unknown }).doc("op-r");
    await processOperation(
      staleSnapshot,
      ref as Parameters<typeof processOperation>[1],
      buildDeps(db, { rollout: handler }),
    );
    const doc = store.get("op-r")!;
    expect(doc.attempts).toBe(3);
    expect(doc.status).toBe("failed");
    expect((doc.attemptHistory as unknown[]).length).toBe(3);
  });
});

describe("queued op bookkeeping is write-quiet", () => {
  it("does not rewrite an identical waitingOn on every drain tick", async () => {
    const { db, store, writeLog } = createFakeGlmOperationsDb({
      "op-live": baseOp({ id: "op-live", status: "running" }),
      "op-blocked": baseOp({ id: "op-blocked", createdAt: 9 }),
    });
    const handler: OperationHandler = vi.fn(async () => ({ steps: [], success: true }));
    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));
    const firstWrites = writeLog.filter((w) => w.id === "op-blocked").length;
    expect(store.get("op-blocked")?.waitingOn).toBeTruthy();
    await drainPendingOperationsOnce(buildDeps(db, { rollout: handler }));
    const secondWrites = writeLog.filter((w) => w.id === "op-blocked").length;
    expect(secondWrites).toBe(firstWrites);
  });
});
