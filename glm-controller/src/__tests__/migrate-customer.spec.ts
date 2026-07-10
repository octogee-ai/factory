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
};

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
    restoreTarget: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      restored: true,
      steps: ["clone-workspace-repo"],
    })) as MigrationClient["restoreTarget"],
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
    verifyTarget: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      ready: true,
      checks: {
        customerDir: true,
        coachWired: true,
        mountMarked: true,
        accountHealthy: true,
      },
    })) as MigrationClient["verifyTarget"],
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
    readUserSnapshot: vi.fn(async () => SNAPSHOT),
    commitCutover: vi.fn(async () => undefined),
    setAssignmentState: vi.fn(async () => undefined),
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
  it("returns success=true and writes all migration step pairs through ctx.reportStep", async () => {
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
      "keys-sync-state:running",
      "keys-sync-state:done",
      "restore-target:running",
      "restore-target:done",
      "pre-sync-state:running",
      "pre-sync-state:done",
      "quiesce-source:running",
      "quiesce-source:done",
      "final-sync-state:running",
      "final-sync-state:done",
      "verify-target:running",
      "verify-target:done",
      "cutover-firestore:running",
      "cutover-firestore:done",
      "unmount-source:running",
      "unmount-source:done",
    ]);
  });

  it("cuts over directly after verify-target during blue/green migration because the public router is stable", async () => {
    const calls: string[] = [];
    const client = happyClient();
    client.verifyTarget = vi.fn(async (input) => {
      calls.push("verify-target");
      return {
        migrationId: input.migrationId,
        slug: input.slug,
        ready: true,
        checks: {
          customerDir: true,
          coachWired: true,
          mountMarked: true,
          accountHealthy: true,
        },
      };
    }) as MigrationClient["verifyTarget"];
    const { deps } = makeDeps(
      {
        commitCutover: vi.fn(async (commit) => {
          calls.push(`cutover:${commit.toGatewayId}`);
        }),
      },
      client,
    );
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();

    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green", source: "release-roll" } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual(["verify-target", "cutover:gw-green"]);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).not.toContain("route-target:running");
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

  it("commits the cutover with the resolved uid, target gateway, user slug, and a cross-gateway mirror flip", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(deps.commitCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "uid-alice",
        toGatewayId: "gw-green",
        fromGatewayId: "gw-blue",
        slug: "alice",
        flipMirror: true, // cross-gateway
      }),
    );
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

  // Blue/green + builder-move is class-agnostic now (all gateways are emptyDir
  // Spot cattle): the customer's coach activation manifest must always ride to
  // the target, operator included — the old `sourceImageProfile !== "operator"`
  // skip left the coach half-provisioned (inert) on the new pod.
  it("always requests the activation manifest, regardless of source gateway class", async () => {
    const { deps, client } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({}), makeCtx());

    expect(client.transferState).toHaveBeenCalledWith(
      expect.objectContaining({ includeActivationManifest: true }),
    );
    expect(client.transferState).not.toHaveBeenCalledWith(
      expect.objectContaining({ includeActivationManifest: false }),
    );
    expect(client.transferState).toHaveBeenCalledTimes(3);
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

describe("createMigrateCustomerHandler — revision-targeted (same-gateway drain)", () => {
  it("ACCEPTS a same-gateway drain when the resolved from/to REVISIONS differ", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const resolveGatewayUrl = vi.fn(async (id: string) => `http://test/${id}`);
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveGatewayUrl,
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
      commitCutover,
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default", source: "release-roll" } }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    // Transport URLs resolve from the REVISION service names, not the bare gateway.
    expect(resolveGatewayUrl).toHaveBeenCalledWith("default-r1");
    expect(resolveGatewayUrl).toHaveBeenCalledWith("default-r2");
    // In-pod path/body stays bare — the migration client is handed the bare gatewayId.
    expect(client.quiesce).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "default" }));
    // The cutover commits the assignment to the target revision, mirror unflipped.
    expect(commitCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "uid-alice",
        toGatewayId: "default",
        flipMirror: false,
        revision: { revisionId: "default-r2", release: 2 },
      }),
    );
  });

  it("REJECTS a drain onto the SAME revision (no-op) instead of the bare-gateway check", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r2", release: 2 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already on default-r2/);
    expect(client.quiesce).not.toHaveBeenCalled();
  });

  // P1-3: a same-gateway drain with a resolved target but NO source assignment doc
  // must RUN — the source revision falls back to the gateway's live revision, so
  // it does not silently no-op as "already on target".
  it("RUNS a same-gateway drain when there is no source assignment doc (source falls back to live revision)", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      // No assignment doc → resolver returns the gateway's LIVE revision (r1).
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
      commitCutover,
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default", source: "release-roll" } }),
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(client.quiesce).toHaveBeenCalled(); // migration actually ran
    expect(commitCutover).toHaveBeenCalledWith(
      expect.objectContaining({ revision: { revisionId: "default-r2", release: 2 } }),
    );
  });

  it("does NOT flip the user mirror on a same-gateway drain (commit carries flipMirror=false)", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const { deps } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
      commitCutover,
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default", source: "release-roll" } }),
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(commitCutover).toHaveBeenCalledTimes(1);
    expect(commitCutover).toHaveBeenCalledWith(expect.objectContaining({ flipMirror: false }));
  });

  it("rejects when placement resolves but the target revision is not ready", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: false as const, reason: "revision-not-ready" as const })),
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/revision-not-ready/);
    expect(client.quiesce).not.toHaveBeenCalled();
  });

  it("cross-gateway migration still flips the mirror and resolves transport by bare gateway when no revisions exist", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const resolveGatewayUrl = vi.fn(async (id: string) => `http://test/${id}`);
    const { deps } = makeDeps({
      commitCutover,
      resolveGatewayUrl,
      resolveFromRevision: vi.fn(async () => null),
      resolvePlacement: vi.fn(async () => null),
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());
    expect(result.success).toBe(true);
    expect(resolveGatewayUrl).toHaveBeenCalledWith("gw-blue");
    expect(resolveGatewayUrl).toHaveBeenCalledWith("gw-green");
    // Legacy migration: mirror flips (cross-gateway), no assignment revision.
    expect(commitCutover).toHaveBeenCalledWith(
      expect.objectContaining({ toGatewayId: "gw-green", flipMirror: true, revision: null }),
    );
  });
});

describe("createMigrateCustomerHandler — failures + rollback", () => {
  it("propagates migration failure and rollback flag from runMigration", async () => {
    const client = happyClient();
    let transferCount = 0;
    client.transferState = vi.fn(async ({ migrationId, slug }) => {
      transferCount++;
      if (transferCount === 3) throw new Error("export: 503 upstream draining");
      return { migrationId, slug, imported: true };
    }) as MigrationClient["transferState"];

    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/503/);
    expect(result.rolledBack).toBe(true);

    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("final-sync-state");
    expect(failedStep?.error).toMatch(/503/);

    const rollbackSteps = ctx.reported.filter((s) => s.name.startsWith("rollback:"));
    expect(rollbackSteps.length).toBeGreaterThan(0);
  });
});

describe("createMigrateCustomerHandler — the sourceDisposable degradation is DELETED (PR7)", () => {
  it("a failed unmount-source rolls back and FAILS even for a roll-tagged migration — never log-and-continue", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async ({ migrationId, slug, gatewayId }) => {
      if ((client.unmount as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
        throw new Error("rate limit exceeded for config.patch; retry after 16s");
      }
      return { migrationId, slug, unmounted: true, gatewayId };
    }) as MigrationClient["unmount"];
    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);

    const res = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green", source: "release-roll" } }),
      makeCtx(),
    );

    expect(res.success).toBe(false);
    expect(res.rolledBack).toBe(true);
  });

  it("a revision drain marks the assignment quiescing BEFORE the quiesce RPC (threads setAssignmentState)", async () => {
    const calls: string[] = [];
    const client = happyClient();
    client.quiesce = vi.fn(async ({ migrationId, slug }) => {
      calls.push("quiesce");
      return { migrationId, slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"];
    const { deps } = makeDeps(
      {
        readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
        resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
        resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
        setAssignmentState: vi.fn(async ({ state }) => {
          calls.push(`roster:${state}`);
        }),
      },
      client,
    );
    const handler = createMigrateCustomerHandler(deps);
    const res = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default" } }),
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(calls).toEqual(["roster:quiescing", "quiesce"]);
  });
});
