import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import {
  createDeprovisionCustomerHandler,
  type CustomerCleanupContext,
  type DeprovisionCustomerDeps,
} from "../handlers/deprovision-customer";
import type { OperationContext } from "../operation-router";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-deprov-1",
    kind: "deprovision-customer",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    input: { uid: "uid-alice" },
    steps: [],
    ...overrides,
  };
}

function mkCtx(): OperationContext & { reported: OperationStep[] } {
  const reported: OperationStep[] = [];
  return {
    reportStep: vi.fn(async (step: OperationStep) => {
      reported.push(step);
    }),
    reported,
  };
}

function mkCleanup(overrides: Partial<CustomerCleanupContext> = {}): CustomerCleanupContext {
  return {
    uid: "uid-alice",
    slug: "alice",
    email: "alice@example.com",
    giteaOrg: "alice",
    repoNames: ["workspace", "blog"],
    workspaceTeamId: "team-1",
    mmUserId: "mm-u-1",
    mmCoachUserId: "mm-coach-1",
    adminChannelId: "mm-c-admin",
    currentGatewayId: "gw-test",
    credentialSecretNames: [],
    ...overrides,
  };
}

function mkDeps(overrides: Partial<DeprovisionCustomerDeps> = {}): DeprovisionCustomerDeps {
  return {
    loadCleanupContext: vi.fn(async () => mkCleanup()),
    unmountFromGateway: vi.fn(async () => "unmounted" as const),
    cloudCleanup: {
      gitea: {
        deleteRepo: vi.fn(async () => undefined),
        deleteOrg: vi.fn(async () => undefined),
        deleteGiteaUser: vi.fn(async () => undefined),
      },
      mattermost: {
        destroyUser: vi.fn(async () => undefined),
        destroyChannel: vi.fn(async () => undefined),
        destroyTeam: vi.fn(async () => undefined),
        getUserChannels: vi.fn(async () => []),
      },
      nukeUserFirestore: vi.fn(async () => undefined),
      deleteCustomerStorage: vi.fn(async () => undefined),
      deleteCredentialSecrets: vi.fn(async () => undefined),
      deleteAuthUser: vi.fn(async () => undefined),
      log: vi.fn(),
    },
    now: () => 5_000,
    log: vi.fn(),
    ...overrides,
  };
}

describe("createDeprovisionCustomerHandler — happy path", () => {
  it("returns success=true and reports unmount-gateway + 7 cloud steps", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionCustomerHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    const stepNames = ctx.reported.map((s) => `${s.name}:${s.status}`);
    expect(stepNames).toEqual([
      "unmount-gateway:running",
      "unmount-gateway:done",
      "gitea:done",
      "mattermost:done",
      "storage:done",
      "hosting:skipped",
      "credentials:done",
      "firestore:done",
      "auth:done",
    ]);
  });

  it("calls unmountFromGateway with gateway + slug from cleanup context", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionCustomerHandler(deps);
    await handler(mkOp({}), mkCtx());
    expect(deps.unmountFromGateway).toHaveBeenCalledWith("gw-test", "alice");
  });
});

describe("createDeprovisionCustomerHandler — orphan path (no gateway)", () => {
  it("skips the unmount step, runs cloud cleanup, returns success", async () => {
    const deps = mkDeps({
      loadCleanupContext: vi.fn(async () => mkCleanup({ currentGatewayId: null })),
    });
    const handler = createDeprovisionCustomerHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(deps.unmountFromGateway).not.toHaveBeenCalled();
    expect(ctx.reported[0]).toMatchObject({ name: "unmount-gateway", status: "skipped" });
    
    expect(deps.cloudCleanup.gitea.deleteRepo).toHaveBeenCalled();
  });
});

describe("createDeprovisionCustomerHandler — gateway has no live pod", () => {
  it("reports the unmount step skipped and proceeds with cloud cleanup", async () => {
    const deps = mkDeps({
      unmountFromGateway: vi.fn(async () => "skipped-no-live-pod" as const),
    });
    const handler = createDeprovisionCustomerHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    const unmountSteps = ctx.reported.filter((s) => s.name === "unmount-gateway");
    expect(unmountSteps.map((s) => s.status)).toEqual(["running", "skipped"]);
    expect(deps.cloudCleanup.nukeUserFirestore).toHaveBeenCalled();
  });
});

describe("createDeprovisionCustomerHandler — unmount RPC failure", () => {
  it("reports failure for retry after continuing independent cloud cleanup", async () => {
    const deps = mkDeps({
      unmountFromGateway: vi.fn(async () => {
        throw new Error("gateway unreachable");
      }),
    });
    const handler = createDeprovisionCustomerHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

expect(deps.cloudCleanup.nukeUserFirestore).toHaveBeenCalled();
    
    const unmountSteps = ctx.reported.filter((s) => s.name === "unmount-gateway");
    expect(unmountSteps.map((s) => s.status)).toEqual(["running", "failed"]);
    expect(unmountSteps[1].error).toMatch(/gateway unreachable/);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain("unmount-gateway: gateway unreachable");
  });
});

describe("createDeprovisionCustomerHandler — cloud step failure", () => {
  it("returns success=false with the partial-failure summary when a cloud step fails", async () => {
    const deps = mkDeps({
      cloudCleanup: {
        gitea: {
          deleteRepo: vi.fn(async () => {
            throw new Error("gitea boom");
          }),
          deleteOrg: vi.fn(async () => undefined),
          deleteGiteaUser: vi.fn(),
        },
        mattermost: {
          destroyUser: vi.fn(),
          destroyChannel: vi.fn(),
          destroyTeam: vi.fn(),
          getUserChannels: vi.fn(async () => []),
        },
        nukeUserFirestore: vi.fn(),
        deleteCustomerStorage: vi.fn(),
        deleteCredentialSecrets: vi.fn(),
        deleteAuthUser: vi.fn(),
        log: vi.fn(),
      },
    });
    const handler = createDeprovisionCustomerHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cloud cleanup partial failure/);
    expect(result.error).toMatch(/gitea: gitea boom/);
  });
});

describe("createDeprovisionCustomerHandler — input validation", () => {
  it("returns failure when uid is missing from op.input", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionCustomerHandler(deps);
    const result = await handler(mkOp({ input: {} }), mkCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing uid/);
    expect(deps.loadCleanupContext).not.toHaveBeenCalled();
  });

  it("returns failure when user not found", async () => {
    const deps = mkDeps({
      loadCleanupContext: vi.fn(async () => null),
    });
    const handler = createDeprovisionCustomerHandler(deps);
    const result = await handler(mkOp({}), mkCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/user not found/);
  });

  it("rejects when user has no slug (caller should have used inline lite-delete)", async () => {
    const deps = mkDeps({
      loadCleanupContext: vi.fn(async () => mkCleanup({ slug: "" })),
    });
    const handler = createDeprovisionCustomerHandler(deps);
    const result = await handler(mkOp({}), mkCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no slug/);
  });
});

describe("createDeprovisionCustomerHandler — skip flags", () => {
  it("propagates skipAuth from op.input → nukeUserCloudSide → auth step skipped", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionCustomerHandler(deps);
    const ctx = mkCtx();
    await handler(mkOp({ input: { uid: "uid-alice", skipAuth: true } }), ctx);
    expect(deps.cloudCleanup.deleteAuthUser).not.toHaveBeenCalled();
    expect(ctx.reported.find((s) => s.name === "auth")?.status).toBe("skipped");
  });
});
