import { afterEach, describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "../../../shared/types/glm";
import {
  createMigrateCustomerHandler,
  _resetMigrationConcurrencyForTests,
} from "../handlers/migrate-customer";
import type { MigrateCustomerDeps } from "../handlers/migrate-customer";
import type { OperationContext } from "../operation-router";
import type { MigrationClient } from "../../../scripts/lib/fleet-migration-client";

afterEach(() => {
  _resetMigrationConcurrencyForTests();
});

function mkOp(overrides: Partial<Operation>): Operation {
  return {
    id: "op-1",
    kind: "migrate-customer",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    input: { uid: "uid-alice", toGatewayId: "gw-green" },
    steps: [],
    ...overrides,
  };
}

function happyClient(): MigrationClient {
  return {
    quiesce: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      drained: true,
      runningCount: 0,
    })) as MigrationClient["quiesce"],
    transferState: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      imported: true,
    })) as MigrationClient["transferState"],
    unmount: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      unmounted: true,
    })) as MigrationClient["unmount"],
  };
}

function makeDeps(
  overrides: Partial<MigrateCustomerDeps> = {},
  client: MigrationClient = happyClient(),
): { deps: MigrateCustomerDeps; client: MigrationClient } {
  const deps: MigrateCustomerDeps = {
    readUser: vi.fn(async (_uid: string) => ({
      slug: "alice",
      currentGatewayId: "gw-blue",
    })),
    cutoverFirestore: vi.fn(async (_uid: string, _to: string, _slug: string) => undefined),
    resolveGatewayUrl: vi.fn(async (gw: string) => `http://test/${gw}`),
    buildClient: vi.fn((_resolveSync: (gw: string) => string) => client),
    genMigrationId: () => "mig-test-1",
    now: () => 5_000,
    log: vi.fn((_msg: string) => undefined),
    ...overrides,
  };
  return { deps, client };
}

function makeCtx(): OperationContext & { reported: OperationStep[] } {
  const reported: OperationStep[] = [];
  return {
    reportStep: vi.fn(async (step: OperationStep) => {
      reported.push(step);
    }),
    reported,
  };
}

describe("createMigrateCustomerHandler — happy path", () => {
  it("returns success=true and writes all four step pairs through ctx.reportStep", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.rolledBack).toBe(false);

    const reported = ctx.reported;
    const names = reported.map((s) => `${s.name}:${s.status}`);
    expect(names).toEqual([
      "quiesce-source:running",
      "quiesce-source:done",
      "transfer-state:running",
      "transfer-state:done",
      "cutover-firestore:running",
      "cutover-firestore:done",
      "unmount-source:running",
      "unmount-source:done",
    ]);
  });

  it("looks up the user's slug + current gatewayId from readUser, not from op.input", async () => {
    const readUser = vi.fn(async (_uid: string) => ({
      slug: "alice-from-firestore",
      currentGatewayId: "gw-blue-from-firestore",
    }));
    const { deps, client } = makeDeps({ readUser });
    const handler = createMigrateCustomerHandler(deps);

    await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(readUser).toHaveBeenCalledWith("uid-alice");
    expect(client.quiesce).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "alice-from-firestore" }),
    );
  });

  it("invokes cutoverFirestore with the resolved uid, target gateway, and user slug", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(deps.cutoverFirestore).toHaveBeenCalledWith("uid-alice", "gw-green", "alice");
  });

  it("pre-resolves both gateway URLs via deps.resolveGatewayUrl before building the client", async () => {
    const resolveGatewayUrl = vi.fn(async (gw: string) => `http://test/${gw}`);
    const { deps } = makeDeps({ resolveGatewayUrl });
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(resolveGatewayUrl).toHaveBeenCalledWith("gw-blue");
    expect(resolveGatewayUrl).toHaveBeenCalledWith("gw-green");
    expect(deps.buildClient).toHaveBeenCalledTimes(1);
  });

  it("buildClient's resolver throws on an unexpected gatewayId — no silent default", async () => {
    let capturedResolver: ((gw: string) => string) | null = null;
    const buildClient = vi.fn((resolveSync: (gw: string) => string) => {
      capturedResolver = resolveSync;
      return happyClient();
    });
    const { deps } = makeDeps({ buildClient });
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({}), makeCtx());

    expect(capturedResolver).not.toBeNull();
    const resolver = capturedResolver as unknown as (gw: string) => string;
    expect(() => resolver("gw-unknown")).toThrow(/unexpected gatewayId/);
  });

  it("propagates resolveGatewayUrl errors as handler failure (does NOT silently route to a default)", async () => {
    const resolveGatewayUrl = vi.fn(async (gw: string) => {
      throw new Error(`gateway not registered in glmGateways: ${gw}`);
    });
    const { deps, client } = makeDeps({ resolveGatewayUrl });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({}), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not registered in glmGateways/);
    expect(client.quiesce).not.toHaveBeenCalled();
  });

  it("stamps startedAt on running steps and completedAt on done steps", async () => {
    let tick = 1_000;
    const { deps } = makeDeps({ now: () => tick++ });
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();
    await handler(mkOp({}), ctx);

    const running = ctx.reported.filter((s) => s.status === "running");
    const done = ctx.reported.filter((s) => s.status === "done");
    running.forEach((s) => expect(typeof s.startedAt).toBe("number"));
    done.forEach((s) => expect(typeof s.completedAt).toBe("number"));
  });
});

describe("createMigrateCustomerHandler — input validation", () => {
  it("returns failure with explicit error when op.input is missing uid", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/uid/);
  });

  it("returns failure with explicit error when op.input is missing toGatewayId", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({ input: { uid: "uid-alice" } }), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/toGatewayId/);
  });

  it("returns failure when the user doc does not exist", async () => {
    const readUser = vi.fn(async (_uid: string) => null);
    const { deps } = makeDeps({ readUser });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({}), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/user/i);
  });

  it("returns failure when target gateway equals current gateway (already mounted there)", async () => {
    const readUser = vi.fn(async (_uid: string) => ({
      slug: "alice",
      currentGatewayId: "gw-green",
    }));
    const { deps, client } = makeDeps({ readUser });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already/i);
    expect(client.quiesce).not.toHaveBeenCalled();
  });
});

describe("createMigrateCustomerHandler — per-target concurrency cap", () => {
  function deferredClient(): {
    client: MigrationClient;
    release: () => void;
  } {
    let releaseFn: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseFn = r;
    });
    const client: MigrationClient = {
      quiesce: vi.fn(async ({ migrationId, slug }) => ({
        migrationId,
        slug,
        drained: true,
        runningCount: 0,
      })) as MigrationClient["quiesce"],
      transferState: vi.fn(async ({ migrationId, slug }) => {
        await gate;
        return { migrationId, slug, imported: true };
      }) as MigrationClient["transferState"],
      unmount: vi.fn(async ({ migrationId, slug }) => ({
        migrationId,
        slug,
        unmounted: true,
      })) as MigrationClient["unmount"],
    };
    return { client, release: releaseFn };
  }

  it("rejects a second migration targeting the same gateway while one is in-flight", async () => {
    const { client: c1, release } = deferredClient();
    const { deps: d1 } = makeDeps({}, c1);

    const handler1 = createMigrateCustomerHandler(d1);
    const inflight = handler1(mkOp({ input: { uid: "uid-1", toGatewayId: "gw-green" } }), makeCtx());

    const { deps: d2 } = makeDeps({
      readUser: vi.fn(async (_uid: string) => ({ slug: "bob", currentGatewayId: "gw-blue" })),
    });
    const handler2 = createMigrateCustomerHandler(d2);
    const second = await handler2(
      mkOp({ id: "op-2", input: { uid: "uid-2", toGatewayId: "gw-green" } }),
      makeCtx(),
    );

    expect(second.success).toBe(false);
    expect(second.error).toMatch(/concurrency.*gw-green|already.*in-flight.*gw-green/i);

    release();
    const first = await inflight;
    expect(first.success).toBe(true);
  });

  it("allows a second migration to a different target gateway in parallel", async () => {
    const { client: c1, release } = deferredClient();
    const { deps: d1 } = makeDeps({}, c1);
    const handler1 = createMigrateCustomerHandler(d1);
    const inflight1 = handler1(
      mkOp({ input: { uid: "uid-1", toGatewayId: "gw-green" } }),
      makeCtx(),
    );

    const { deps: d2 } = makeDeps({
      readUser: vi.fn(async (_uid: string) => ({ slug: "bob", currentGatewayId: "gw-blue" })),
    });
    const handler2 = createMigrateCustomerHandler(d2);
    const second = await handler2(
      mkOp({ id: "op-2", input: { uid: "uid-2", toGatewayId: "gw-purple" } }),
      makeCtx(),
    );

    expect(second.success).toBe(true);
    release();
    await inflight1;
  });

  it("releases the slot after a successful migration so a follow-up can run", async () => {
    const { deps: d1 } = makeDeps();
    const handler1 = createMigrateCustomerHandler(d1);
    const first = await handler1(
      mkOp({ input: { uid: "uid-1", toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(first.success).toBe(true);

    const { deps: d2 } = makeDeps({
      readUser: vi.fn(async (_uid: string) => ({ slug: "bob", currentGatewayId: "gw-blue" })),
    });
    const handler2 = createMigrateCustomerHandler(d2);
    const second = await handler2(
      mkOp({ id: "op-2", input: { uid: "uid-2", toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(second.success).toBe(true);
  });

  it("releases the slot even when a migration fails so a retry can run", async () => {
    const client = happyClient();
    client.transferState = vi.fn(async () => {
      throw new Error("export: 500 boom");
    }) as MigrationClient["transferState"];
    const { deps: d1 } = makeDeps({}, client);
    const handler1 = createMigrateCustomerHandler(d1);
    const first = await handler1(
      mkOp({ input: { uid: "uid-1", toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(first.success).toBe(false);

    const { deps: d2 } = makeDeps({
      readUser: vi.fn(async (_uid: string) => ({ slug: "alice", currentGatewayId: "gw-blue" })),
    });
    const handler2 = createMigrateCustomerHandler(d2);
    const second = await handler2(
      mkOp({ id: "op-2", input: { uid: "uid-1", toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(second.success).toBe(true);
  });
});

describe("createMigrateCustomerHandler — failures + rollback", () => {
  it("propagates migration failure and rollback flag from runMigration", async () => {
    const client = happyClient();
    client.transferState = vi.fn(async () => {
      throw new Error("export: 503 upstream draining");
    }) as MigrationClient["transferState"];

    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/503/);
    expect(result.rolledBack).toBe(true);

    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("transfer-state");
    expect(failedStep?.error).toMatch(/503/);

    const rollbackSteps = ctx.reported.filter((s) => s.name.startsWith("rollback:"));
    expect(rollbackSteps.length).toBeGreaterThan(0);
  });
});
