import { describe, it, expect, vi } from "vitest";
import { recoverControllerOrphanedMigrations, runStuckOpReaperTick } from "../stuck-op-reaper.js";
import { decideOperationClaim } from "../operation-queue.js";

interface FakeOpDoc {
  id: string;
  data: {
    status?: string;
    kind?: string;
    origin?: string;
    startedAt?: number;
    createdAt?: number;
    lastProgressAt?: number;
    output?: Record<string, unknown>;
    customerMigrationV2?: { phase: string };
    recordType?: string;
    input?: Record<string, unknown>;
    steps?: Array<{ name: string; status: string }>;
    cutoverCommittedAt?: number;
    schedulerHandoffReleased?: boolean;
  };
  updated?: Record<string, unknown>;
}

interface FakeDbState {
  users?: Record<string, Record<string, unknown>>;
  assignments?: Record<string, Record<string, unknown>>;
  beforeTransaction?: () => void;
  transactionState?: { active: boolean };
}

function makeFakeDb(ops: FakeOpDoc[], state: FakeDbState = {}) {
  function operationRef(operation: FakeOpDoc) {
    return {
      snapshot: () => ({ exists: true, data: () => operation.data }),
      apply: (patch: Record<string, unknown>) => {
        operation.updated = patch;
        Object.assign(operation.data, patch);
      },
      update: async (patch: Record<string, unknown>) => {
        operation.updated = patch;
        Object.assign(operation.data, patch);
      },
    };
  }
  function stateRef(record: Record<string, unknown> | undefined) {
    return {
      snapshot: () => ({ exists: record !== undefined, data: () => record }),
      apply: (patch: Record<string, unknown>) => Object.assign(record ?? {}, patch),
    };
  }
  return {
    collection: (name: string) => {
      if (name === "users") {
        return { doc: (uid: string) => stateRef(state.users?.[uid]) };
      }
      if (name === "gateways") {
        return {
          doc: (gatewayId: string) => ({
            collection: (subcollection: string) => {
              if (subcollection !== "assignments") {
                throw new Error(`unexpected subcollection: ${subcollection}`);
              }
              return {
                doc: (uid: string) => stateRef(state.assignments?.[`${gatewayId}/${uid}`]),
              };
            },
          }),
        };
      }
      if (name !== "glmOperations") {
        throw new Error(`unexpected collection: ${name}`);
      }
      return {
        where: (field: string, op: string, value: unknown) => ({
          get: async () => ({
            docs: ops
              .filter((o) => {
                if (field !== "status" || op !== "==") return true;
                return o.data.status === value;
              })
              .map((o) => ({
                id: o.id,
                data: () => o.data,
                ref: operationRef(o),
              })),
          }),
        }),
      };
    },
    runTransaction: async (callback: (txn: {
      get: (ref: { snapshot: () => unknown }) => Promise<unknown>;
      update: (ref: { apply: (patch: Record<string, unknown>) => void }, patch: Record<string, unknown>) => void;
    }) => Promise<unknown>) => {
      state.beforeTransaction?.();
      if (state.transactionState) state.transactionState.active = true;
      try {
        return await callback({
          get: async (ref) => ref.snapshot(),
          update: (ref, patch) => ref.apply(patch),
        });
      } finally {
        if (state.transactionState) state.transactionState.active = false;
      }
    },
  };
}

const NOW = 1_700_000_000_000;

describe("runStuckOpReaperTick", () => {
  it("preserves an ID-less persisted automatic Builder return for restart recovery", async () => {
    const ops: FakeOpDoc[] = [{
      id: "builder-return-builder-alice",
      data: {
        kind: "migrate-customer", origin: "automatic", status: "running",
        startedAt: NOW - 60 * 60_000,
        input: { uid: "alice", source: "builder-activation-lease", fromGatewayId: "builder-alice" },
      },
    }];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as never, log: vi.fn(), now: () => NOW, stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("does not reap a stale running audit record", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "audit-running",
        data: {
          recordType: "audit",
          status: "running",
          kind: "rollout",
          startedAt: NOW - 60 * 60_000,
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("flips status=failed on a `running` op older than stalenessMs", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-stuck",
        data: {
          status: "running",
          kind: "migrate-customer",
          startedAt: NOW - 20 * 60_000,
        },
      },
    ];
    const log = vi.fn();
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log,
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toMatchObject({
      status: "failed",
      completedAt: NOW,
      error: expect.stringContaining("reaped"),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("op-stuck"));
  });

  it("does not manufacture a cleanup lease when the reaper cannot prove freeze ownership", async () => {
    const ops: FakeOpDoc[] = [{
      id: "op-stuck-migration",
      data: {
        status: "running",
        kind: "migrate-customer",
        startedAt: NOW - 20 * 60_000,
      },
    }];

    await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(ops[0].updated).not.toHaveProperty("output.configCleanup");
  });

  it("atomically restores an operation-owned legacy migration gate before failing the stuck op", async () => {
    const ops: FakeOpDoc[] = [{
      id: "placement-owned",
      data: {
        status: "running",
        kind: "migrate-customer",
        startedAt: NOW - 20 * 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
        },
      },
    }];
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      source: "migrate-customer",
      updatedByOperationId: "placement-owned",
    };
    const transactionState = { active: false };
    const db = makeFakeDb(ops, {
      users: {
        "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-a" } } },
      },
      assignments: { "shared-a/uid-mike": assignment },
      transactionState,
    });
    const log = vi.fn(() => expect(transactionState.active).toBe(false));

    const result = await runStuckOpReaperTick({
      db: db as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log,
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(assignment).toMatchObject({
      state: "serving",
      updatedAt: NOW,
      updatedByOperationId: "placement-owned",
    });
    expect(ops[0].updated).toMatchObject({ status: "failed" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("restored source assignment"));
  });

  it.each([
    ["a foreign gate owner", "another-operation", "shared-a"],
    ["a committed user move", "placement-owned", "shared-b"],
  ])("does not reopen a legacy source assignment with %s", async (_reason, owner, userGatewayId) => {
    const ops: FakeOpDoc[] = [{
      id: "placement-owned",
      data: {
        status: "running",
        kind: "migrate-customer",
        startedAt: NOW - 20 * 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
        },
      },
    }];
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      source: "migrate-customer",
      updatedByOperationId: owner,
    };
    const db = makeFakeDb(ops, {
      users: {
        "uid-mike": { provisioning: { openclaw: { gatewayId: userGatewayId } } },
      },
      assignments: { "shared-a/uid-mike": assignment },
    });

    await runStuckOpReaperTick({
      db: db as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(assignment.state).toBe("quiescing");
    expect(ops[0].updated).toMatchObject({ status: "failed" });
  });

  it.each([
    ["fresh progress", (op: FakeOpDoc) => { op.data.lastProgressAt = NOW; }],
    ["a terminal status", (op: FakeOpDoc) => { op.data.status = "succeeded"; }],
  ])("does not reap or reopen a legacy gate after the transaction observes %s", async (_reason, advance) => {
    const op: FakeOpDoc = {
      id: "placement-raced",
      data: {
        status: "running",
        kind: "migrate-customer",
        startedAt: NOW - 20 * 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
        },
      },
    };
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      source: "migrate-customer",
      updatedByOperationId: "placement-raced",
    };
    const db = makeFakeDb([op], {
      users: {
        "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-a" } } },
      },
      assignments: { "shared-a/uid-mike": assignment },
      beforeTransaction: () => advance(op),
    });
    const log = vi.fn();

    const result = await runStuckOpReaperTick({
      db: db as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log,
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });

    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(assignment.state).toBe("quiescing");
    expect(op.updated).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("leaves a recent `running` op alone", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-fresh",
        data: { status: "running", kind: "rollout", startedAt: NOW - 30_000 },
      },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it.each(["suspend-customer", "erase-customer"])(
    "does not terminalize a stale restart-resumable %s operation",
    async (kind) => {
      const ops: FakeOpDoc[] = [{
        id: `op-${kind}`,
        data: { status: "running", kind, startedAt: NOW - 60 * 60_000 },
      }];
      const result = await runStuckOpReaperTick({
        db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
        log: vi.fn(),
        now: () => NOW,
        stalenessMs: 15 * 60_000,
      });
      expect(result).toEqual({ scanned: 1, reaped: 0 });
      expect(ops[0].updated).toBeUndefined();
    },
  );

  it.each(["checkpointed", "promotionIntent", "finalized", "complete", "aborted"])(
    "never reaps a durable migration V2 operation held in %s for restart recovery",
    async (phase) => {
      const ops: FakeOpDoc[] = [{
        id: `op-v2-${phase}`,
        data: {
          status: "running",
          kind: "migrate-customer",
          startedAt: NOW - 60 * 60_000,
          customerMigrationV2: { phase },
        },
      }];

      const result = await runStuckOpReaperTick({
        db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
        log: vi.fn(),
        now: () => NOW,
        stalenessMs: 15 * 60_000,
      });

      expect(result).toEqual({ scanned: 1, reaped: 0 });
      expect(ops[0].updated).toBeUndefined();
    },
  );

  it("falls back to createdAt when startedAt is missing", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-no-started",
        data: {
          status: "running",
          kind: "migrate-customer",
          createdAt: NOW - 30 * 60_000,
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toBeDefined();
  });

it("skips ops with no anchor timestamp (defensively — log noise only)", async () => {
    const ops: FakeOpDoc[] = [
      { id: "op-no-anchor", data: { status: "running", kind: "rollout" } },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("does NOT reap a long-running op that is still making progress (fresh lastProgressAt beats an old startedAt)", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-progressing",
        data: {
          status: "running",
          kind: "rollout",
          startedAt: NOW - 20 * 60_000, // claimed 20m ago (would reap on absolute age)
          lastProgressAt: NOW - 60_000, // …but a step landed 1m ago
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("reaps a running op whose progress AND claim are both stale past the budget", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-hung",
        data: {
          status: "running",
          kind: "rollout",
          startedAt: NOW - 20 * 60_000,
          lastProgressAt: NOW - 18 * 60_000, // no step in 18m → genuinely stuck
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toMatchObject({ status: "failed" });
  });

  it("reaps multiple stuck ops in a single tick", async () => {
    const ops: FakeOpDoc[] = [
      { id: "op-a", data: { status: "running", kind: "migrate-customer", startedAt: NOW - 30 * 60_000 } },
      { id: "op-b", data: { status: "running", kind: "rollout", startedAt: NOW - 20 * 60_000 } },
      { id: "op-c", data: { status: "running", kind: "add-gateway", startedAt: NOW - 60_000 } },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 3, reaped: 2 });
    expect(ops[0].updated).toBeDefined();
    expect(ops[1].updated).toBeDefined();
    expect(ops[2].updated).toBeUndefined();
  });
});

describe("recoverControllerOrphanedMigrations", () => {
  const BOOTED_AT = NOW - 30_000;

  function orphanedPlacement(overrides: Partial<FakeOpDoc["data"]> = {}): FakeOpDoc {
    return {
      id: "placement-orphan",
      data: {
        status: "running",
        kind: "migrate-customer",
        origin: "automatic",
        startedAt: BOOTED_AT - 2 * 60_000,
        lastProgressAt: BOOTED_AT - 60_000,
        input: {
          uid: "uid-mike",
          fromGatewayId: "shared-a",
          toGatewayId: "shared-b",
          source: "continuous-placement-policy",
        },
        schedulerHandoffReleased: false,
        ...overrides,
      },
    };
  }

  function recover(db: unknown, log = vi.fn()) {
    return recoverControllerOrphanedMigrations({
      db: db as Parameters<typeof recoverControllerOrphanedMigrations>[0]["db"],
      log,
      now: () => NOW,
      controllerStartedAt: BOOTED_AT,
    });
  }

  it("fails a pre-cutover migration the previous controller orphaned without waiting out the reaper budget, reopening its source and unblocking the queued conflicting migration", async () => {
    const orphan = orphanedPlacement({
      steps: [
        { name: "keys-sync-state", status: "done" },
        { name: "quiesce-source", status: "running" },
      ],
    });
    const queued = {
      id: "placement-queued",
      kind: "migrate-customer",
      status: "pending",
      input: { uid: "uid-nina", fromGatewayId: "shared-a", toGatewayId: "shared-c" },
    };
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      updatedByOperationId: "placement-orphan",
    };
    const ops = [orphan];
    const db = makeFakeDb(ops, {
      users: { "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-a" } } } },
      assignments: { "shared-a/uid-mike": assignment },
    });
    const running = () => ops
      .filter((op) => op.data.status === "running")
      .map((op) => ({ id: op.id, kind: op.data.kind ?? "", input: op.data.input }));
    expect(decideOperationClaim({
      op: queued as never, now: NOW, runningOpsSameKind: running(), pendingOpsSameKind: [],
    }).outcome).toBe("queue");

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 1 });
    expect(orphan.data).toMatchObject({
      status: "failed",
      completedAt: NOW,
      error: expect.stringMatching(/^reaped: controller restarted mid-op/),
      schedulerHandoffReleased: false,
    });
    expect(assignment).toMatchObject({ state: "serving", updatedByOperationId: "placement-orphan" });
    expect(decideOperationClaim({
      op: queued as never, now: NOW, runningOpsSameKind: running(), pendingOpsSameKind: [],
    }).outcome).toBe("claim");
  });

  it("fails a post-cutover orphan for handoff completion without reopening the source it already left", async () => {
    const orphan = orphanedPlacement({
      cutoverCommittedAt: BOOTED_AT - 90_000,
      steps: [
        { name: "cutover-firestore", status: "done" },
        { name: "unmount-source", status: "running" },
      ],
    });
    const assignment = {
      uid: "uid-mike",
      gatewayId: "shared-a",
      state: "quiescing",
      updatedByOperationId: "placement-orphan",
    };
    const db = makeFakeDb([orphan], {
      users: { "uid-mike": { provisioning: { openclaw: { gatewayId: "shared-b" } } } },
      assignments: { "shared-a/uid-mike": assignment },
    });

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 1 });
    expect(orphan.data).toMatchObject({
      status: "failed",
      cutoverCommittedAt: BOOTED_AT - 90_000,
      schedulerHandoffReleased: false,
    });
    expect(assignment.state).toBe("quiescing");
  });

  it("leaves a migration this controller claimed after boot to its live worker", async () => {
    const claimedHere = orphanedPlacement({ startedAt: BOOTED_AT + 1 });
    const db = makeFakeDb([claimedHere]);

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(claimedHere.updated).toBeUndefined();
  });

  it("leaves an orphan this controller re-claims while the recovery transaction is pending", async () => {
    const raced = orphanedPlacement();
    const db = makeFakeDb([raced], { beforeTransaction: () => { raced.data.startedAt = BOOTED_AT + 5; } });

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(raced.data.status).toBe("running");
  });

  it.each<[string, Partial<FakeOpDoc["data"]>]>([
    ["a non-migration kind", { kind: "retire-gateway", input: { gatewayId: "shared-a" } }],
    ["a rollout the resume sweep re-drives", { kind: "rollout", input: { gatewayId: "shared-a" } }],
    ["a durable V2 migration", { customerMigrationV2: { phase: "checkpointed" } }],
    ["a suspend-customer op", { kind: "suspend-customer" }],
  ])("leaves %s to its own restart recovery", async (_label, overrides) => {
    const op = orphanedPlacement(overrides);
    const db = makeFakeDb([op]);

    const result = await recover(db);

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(op.updated).toBeUndefined();
  });

  it("leaves a level-triggered Builder return to the resume sweep", async () => {
    const op: FakeOpDoc = {
      id: "builder-return-builder-alice",
      data: {
        kind: "migrate-customer", origin: "automatic", status: "running",
        startedAt: BOOTED_AT - 60_000,
        input: { uid: "alice", source: "builder-activation-lease", fromGatewayId: "builder-alice" },
      },
    };

    const result = await recover(makeFakeDb([op]));

    expect(result).toEqual({ scanned: 1, recovered: 0 });
    expect(op.updated).toBeUndefined();
  });
});
