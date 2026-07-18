import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import { createMigrateCustomerHandler } from "../handlers/migrate-customer";
import type { MigrateCustomerDeps } from "../handlers/migrate-customer";
import type { OperationContext } from "../operation-router";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";

const SNAPSHOT: FleetBrokerUserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  tier: "trial",
  gatewayId: "gw-blue",
  status: "complete",
  agentIds: ["octogee-alice-coach"],
  repoUrl: "git@gitea:octogee/alice.git",
  mattermostUserId: "mm-alice",
  customerMmUserId: "mm-alice",
  greetingPosted: true,
  channels: [],
  projects: [],
  ownerName: "Alice",
  email: "alice@example.com",
  displayName: "Alice",
  lastName: "",
  photoURL: "",
  onboardingVibe: null,
  coachToken: "coach-token",
  coachMmUserId: "mm-coach",
} as unknown as FleetBrokerUserSnapshot;

function gatewayRootFence(
  gatewayId: string,
  release = 1,
): NonNullable<Operation["customerMigrationV2"]>["sourceRootFence"] {
  return {
    gatewayId,
    updatedAt: gatewayId === "gw-blue" ? 17 : 18,
    latestRelease: release,
    desiredRelease: release,
    liveRelease: release,
    gatewayClass: "operator",
    ownerUid: "uid-alice",
    builderSlug: "alice",
    configHash: gatewayId === "gw-blue" ? "7".repeat(64) : "8".repeat(64),
  };
}

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

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    restoreTarget: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`restore:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, restored: true, steps: [] };
    }) as MigrationClient["restoreTarget"],
    quiesce: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`quiesce:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"],
    flushGateway: vi.fn() as unknown as MigrationClient["flushGateway"],
    transferState: vi.fn(async ({ fromGatewayId, toGatewayId, slug, mode }) => {
      calls.push(`transfer:${mode ?? "default"}:${fromGatewayId}->${toGatewayId}`);
      return { migrationId: "mig-op-1", slug, imported: true };
    }) as MigrationClient["transferState"],
    verifyTarget: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`verify:${gatewayId}`);
      return {
        migrationId: "mig-op-1",
        slug,
        ready: true,
        checks: { customerDir: true, coachWired: true, mountMarked: true, accountHealthy: true },
      };
    }) as MigrationClient["verifyTarget"],
    unmount: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`unmount:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, unmounted: true };
    }) as MigrationClient["unmount"],
    calls,
  } as MigrationClient & { calls: string[] };
}

interface HarnessOptions {
  client?: MigrationClient & { calls: string[] };
  durable?: boolean;
  sourceGatewayId?: string;
}

function mkDeps(options: HarnessOptions = {}) {
  const client = options.client ?? happyClient();
  const events: string[] = [];
  const persisted: Array<NonNullable<Operation["customerMigrationV2"]>> = [];
  const deps: MigrateCustomerDeps = {
    readUser: vi.fn(async () => ({
      slug: "alice",
      currentGatewayId: options.sourceGatewayId ?? "gw-blue",
    })),
    readUserSnapshot: vi.fn(async () => SNAPSHOT),
    commitCutover: vi.fn(async (commit) => {
      events.push(`cutover:${commit.fromGatewayId}->${commit.toGatewayId}:mirror=${commit.flipMirror}`);
    }),
    resolveGatewayUrl: vi.fn(async (gatewayId: string) => `http://${gatewayId}.svc:3003`),
    buildClient: vi.fn(() => client),
    resolveSourcePlacement: vi.fn(async () => ({
      release: 1,
      epoch: 4,
      assignmentMode: "assigned" as const,
    })),
    resolveTargetPlacement: vi.fn(async () => ({ ok: true as const, release: 2 })),
    setAssignmentState: vi.fn(async (input) => {
      events.push(`assignment:${input.gatewayId}:${input.state}`);
    }),
    readGatewayRootFence: vi.fn(async (gatewayId: string) => gatewayRootFence(
      gatewayId,
      gatewayId === "gw-blue" ? 1 : 2,
    )),
    commitV2Cutover: vi.fn(async (input) => {
      events.push(`v2-cutover:${input.sourceGatewayId}->${input.targetGatewayId}`);
    }),
    useDurableMigration: vi.fn(async () => options.durable === true),
    genMigrationId: (operationId: string) => `mig-${operationId}`,
    now: vi.fn(() => 5_000),
    log: vi.fn(),
  };
  const steps: OperationStep[] = [];
  const ctx: OperationContext = {
    reportStep: vi.fn(async (step: OperationStep) => {
      steps.push(step);
    }),
    persistCustomerMigrationV2: vi.fn(async (state) => {
      persisted.push(state);
    }),
  } as unknown as OperationContext;
  return { deps, ctx, client, events, steps, persisted };
}

describe("migrate-customer — input validation", () => {
  it.each([
    [{ toGatewayId: "gw-green" }, /missing uid/u],
    [{ uid: "uid-alice" }, /missing toGatewayId/u],
  ])("rejects malformed input %j", async (input, message) => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: input as Operation["input"] }), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
  });

  it("rejects a migration whose declared source no longer matches the user's gateway", async () => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({
      input: { uid: "uid-alice", toGatewayId: "gw-green", fromGatewayId: "gw-stale" },
    }), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/declared source gw-stale does not match resolved source gw-blue/u);
  });

  it("rejects a same-gateway migration — simple-roll has one pod per gateway", async () => {
    const { deps, ctx } = mkDeps({ sourceGatewayId: "gw-green" });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already on gw-green/u);
  });

  it("fails when the target placement is rejected", async () => {
    const { deps, ctx } = mkDeps();
    (deps.resolveTargetPlacement as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "revision-not-ready",
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/placement rejected for gw-green: revision-not-ready/u);
  });
});

describe("migrate-customer — legacy data-plane migration (shared class)", () => {
  it("runs the full flow with the roster gate and no config steps", async () => {
    const { deps, ctx, client, events } = mkDeps();
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:keys:gw-blue->gw-green",
      "restore:gw-green",
      "transfer:pre:gw-blue->gw-green",
      "quiesce:gw-blue",
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
    expect(events).toContain("assignment:gw-blue:quiescing");
    expect(events).toContain("cutover:gw-blue->gw-green:mirror=true");
    expect(client.calls.every((call) => !/config/u.test(call))).toBe(true);
  });

  it("reports failure with rollback when quiesce cannot drain", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("agents busy"));
    const { deps, ctx, events } = mkDeps({ client });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toMatch(/agents busy/u);
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
    expect(events).toContain("assignment:gw-blue:serving");
  });
});

describe("migrate-customer — durable V2 migration", () => {
  it("initializes durable state from exact root fences and drives to complete", async () => {
    const { deps, ctx, client, events, persisted } = mkDeps({ durable: true });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(persisted[0]).toMatchObject({
      phase: "initialized",
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned",
      targetGatewayId: "gw-green",
      targetRelease: 2,
    });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "targetRestored", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete",
    ]);
    expect(client.calls).toEqual([
      "transfer:keys:gw-blue->gw-green",
      "restore:gw-green",
      "transfer:pre:gw-blue->gw-green",
      "quiesce:gw-blue",
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
    expect(events).toContain("v2-cutover:gw-blue->gw-green");
  });

  it("refuses initialization when the source root ownership changed", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    (deps.readGatewayRootFence as ReturnType<typeof vi.fn>).mockImplementation(
      async (gatewayId: string) => gatewayId === "gw-blue"
        ? { ...gatewayRootFence("gw-blue"), ownerUid: "someone-else" }
        : gatewayRootFence("gw-green", 2),
    );
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source root ownership changed/u);
  });

  it("resumes a durable migration from its persisted phase without re-running earlier steps", async () => {
    const { deps, ctx, client } = mkDeps({ durable: true });
    const handler = createMigrateCustomerHandler(deps);
    const state = {
      phase: "sourceQuiesced" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    const result = await handler(mkOp({ customerMigrationV2: state }), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
  });

  it("re-checks the initial bindings when resuming from initialized and refuses drift", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    (deps.resolveSourcePlacement as ReturnType<typeof vi.fn>).mockResolvedValue({
      release: 9,
      epoch: 4,
      assignmentMode: "assigned",
    });
    const handler = createMigrateCustomerHandler(deps);
    const state = {
      phase: "initialized" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    const result = await handler(mkOp({ customerMigrationV2: state }), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source placement changed/u);
  });

  it("classifies a transport failure as a 503 retry without aborting durable state", async () => {
    const client = happyClient();
    (client.transferState as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("fetch failed"), { retryable: true }),
    );
    const { deps, ctx, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/retry pending: status 503/u);
    expect(persisted.map((state) => state.phase)).toEqual(["initialized"]);
  });

  it("aborts on a terminal mid-flight failure: unmounts the target and restores the source", async () => {
    const client = happyClient();
    (client.verifyTarget as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("target verify failed"), { status: 409 }),
    );
    const { deps, ctx, client: c, events, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "targetRestored", "preSynced", "sourceQuiesced",
      "finalSynced", "abortIntent", "abortTargetUnmounted", "aborted",
    ]);
    expect(c.calls.filter((call) => call.startsWith("unmount:"))).toEqual(["unmount:gw-green"]);
    expect(events).toContain("assignment:gw-blue:serving");
  });

  it("replays a completed durable migration idempotently and refuses changed input", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    const handler = createMigrateCustomerHandler(deps);
    const state = {
      phase: "complete" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    await expect(handler(mkOp({ customerMigrationV2: state }), ctx)).resolves.toMatchObject({
      success: true,
      rolledBack: false,
    });
    await expect(handler(mkOp({
      customerMigrationV2: state,
      input: { uid: "uid-alice", toGatewayId: "gw-other" },
    }), ctx)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/input changed/u),
    });
  });

  it("turns a cancellation request into a durable abort once transfer started", async () => {
    const { deps, client, events } = mkDeps({ durable: true });
    const persisted: Array<NonNullable<Operation["customerMigrationV2"]>> = [];
    let cancelRequested = false;
    const ctx: OperationContext = {
      reportStep: vi.fn(async () => undefined),
      persistCustomerMigrationV2: vi.fn(async (state) => {
        persisted.push(state);
        if (state.phase === "preSynced") cancelRequested = true;
      }),
      cancellationRequested: vi.fn(async () => cancelRequested),
    } as unknown as OperationContext;
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toMatch(/superseded/u);
    expect(persisted.map((state) => state.phase)).toContain("abortIntent");
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual(["unmount:gw-green"]);
    expect(events).toContain("assignment:gw-blue:serving");
  });
});
