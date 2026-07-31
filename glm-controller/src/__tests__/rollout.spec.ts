import { describe, it, expect, vi } from "vitest";
import {
  createRolloutHandler,
  planDesiredReleaseActivation,
  type RolloutDeps,
} from "../handlers/rollout.js";
import type { Operation } from "@octogee/shared/types/glm";
import type { GatewayDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { OperationContext } from "../operation-router.js";

function mkPayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "cafe123-ocbeta2",
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function mkGateway(overrides: Partial<GatewayDoc> = {}): GatewayDoc {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "ci",
    updatedAt: 1,
    updatedBy: "ci",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    liveRevisionId: "default-r1",
    trafficRevisionId: "default-r1",
    desiredStatus: "running",
    roll: null,
    ...overrides,
  };
}

function mkOp(input: Record<string, unknown>): Operation {
  return {
    id: "op-1",
    kind: "rollout",
    status: "running",
    createdBy: "test",
    createdAt: 0,
    startedAt: 0,
    completedAt: null,
    input,
    steps: [],
  };
}

const ctx: OperationContext = { reportStep: vi.fn(async () => undefined) };

function mkDeps(overrides: Partial<RolloutDeps> = {}): RolloutDeps & { logs: string[] } {
  const logs: string[] = [];
  let now = 0;
  return {
    readGatewayDoc: async () => mkGateway(),
    readReleasePayload: async () => mkPayload(),
    activateDesiredRelease: vi.fn(async () => ({ success: true as const })),
    requestReconcileTick: vi.fn(),
    releaseRecordTimeoutMs: 10_000,
    convergeTimeoutMs: 100_000,
    pollIntervalMs: 1_000,
    now: () => now,
    wait: async () => {
      now += 1_000;
    },
    log: (msg: string) => logs.push(msg),
    logs,
    ...overrides,
  };
}

describe("rollout op — durable root validation", () => {
  it("refuses a gateway with no durable gateways/{id} desired doc without naming retired recovery tools", async () => {
    const deps = mkDeps({ readGatewayDoc: async () => null });
    const handler = createRolloutHandler(deps);
    const res = await handler(mkOp({ gatewayId: "legacy-gw", targetRelease: 2, imageTag: "cafe123-ocbeta2" }), ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("legacy-gw");
    expect(res.error).toContain("durable gateways/legacy-gw desired doc");
    expect(res.error).not.toContain("backfill-gateway-identity");
  });

  it("fails on missing gatewayId / targetRelease / imageTag inputs", async () => {
    const handler = createRolloutHandler(mkDeps());
    expect((await handler(mkOp({ targetRelease: 2, imageTag: "t" }), ctx)).error)
      .toContain("gatewayId");
    expect((await handler(mkOp({ gatewayId: "g", imageTag: "t" }), ctx)).error)
      .toContain("targetRelease");
    expect((await handler(mkOp({ gatewayId: "g", targetRelease: 2 }), ctx)).error)
      .toContain("imageTag");
  });

  it("refuses a retired gateway", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ desiredStatus: "retired" }),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("retired");
  });
});

describe("rollout desired release activation", () => {
  it("activates only the exact staged release from a stable live root", () => {
    expect(planDesiredReleaseActivation(
      mkGateway({ desiredRelease: 1, liveRelease: 1 }),
      2,
      100,
      "op-1",
    )).toEqual({
      success: true,
      patch: {
        desiredRelease: 2,
        updatedAt: 100,
        updatedBy: "rollout:op-1",
      },
    });
  });

  it("is idempotent after the operation has activated its release", () => {
    expect(planDesiredReleaseActivation(mkGateway(), 2, 100, "op-1"))
      .toEqual({ success: true, patch: null });
  });

  it("rejects a superseded target or another release still converging", () => {
    expect(planDesiredReleaseActivation(
      mkGateway({ latestRelease: 3, desiredRelease: 1, liveRelease: 1 }),
      2,
      100,
      "op-1",
    )).toMatchObject({ success: false, error: expect.stringContaining("superseded") });
    expect(planDesiredReleaseActivation(
      mkGateway({ desiredRelease: 1, liveRelease: 0 }),
      2,
      100,
      "op-1",
    )).toMatchObject({ success: false, error: expect.stringContaining("not live") });
  });
});

describe("rollout op — awaits the roll arm's convergence", () => {
  it("holds global rollout ownership until a prior desired release becomes live", async () => {
    let stable = false;
    let activated = false;
    const activateDesiredRelease = vi.fn(async () => {
      activated = true;
      return { success: true as const };
    });
    const reportStep = vi.fn(async () => undefined);
    const deps = mkDeps({
      readGatewayDoc: async () => activated
        ? mkGateway({
            latestRelease: 3,
            desiredRelease: 3,
            liveRelease: 3,
            liveRevisionId: "default-r3",
          })
        : stable
          ? mkGateway({
            latestRelease: 3,
            desiredRelease: 2,
            liveRelease: 2,
            liveRevisionId: "default-r2",
          })
          : mkGateway({
              latestRelease: 3,
              desiredRelease: 2,
              liveRelease: 1,
            }),
      readReleasePayload: async (_gatewayId, release) =>
        release === 3 ? mkPayload({ imageTag: "feed456-ocbeta2" }) : null,
      activateDesiredRelease,
      wait: async () => {
        expect(activateDesiredRelease).not.toHaveBeenCalled();
        stable = true;
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 3, imageTag: "feed456-ocbeta2" }),
      { reportStep },
    );

    expect(res.success).toBe(true);
    expect(activateDesiredRelease).toHaveBeenCalledWith({
      gatewayId: "default",
      targetRelease: 3,
      operationId: "op-1",
    });
    expect(deps.logs).toContain(
      "[rollout] default: waiting for r2 to become live before activating r3",
    );
    expect(
      reportStep.mock.calls.filter((call) => call[0].status === "running"),
    ).toHaveLength(2);
  });

  it("refreshes operation liveness on every convergence poll", async () => {
    let polls = 0;
    const reportStep = vi.fn(async () => undefined);
    const deps = mkDeps({
      readGatewayDoc: async () =>
        polls >= 3
          ? mkGateway({ liveRelease: 2, liveRevisionId: "default-r2" })
          : mkGateway({
              roll: {
                operationId: "roll-x",
                status: "migrating",
                fromRelease: 1,
                toRelease: 2,
                sourceRevisionId: "default-r1",
                targetRevisionId: "default-r2",
                acceptingNewAssignments: true,
                startedAt: 0,
                updatedAt: 0,
                error: null,
                flippedAt: null,
              },
            }),
      wait: async () => {
        polls += 1;
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      { reportStep },
    );

    expect(res.success).toBe(true);
    expect(
      reportStep.mock.calls.filter((call) => call[0].status === "running"),
    ).toHaveLength(4);
  });

  it("kicks a reconcile tick and succeeds once liveRelease reaches desiredRelease with no roll block", async () => {
    let converged = false;
    const deps = mkDeps({
      readGatewayDoc: async () =>
        converged
          ? mkGateway({ liveRelease: 2, liveRevisionId: "default-r2", trafficRevisionId: "default-r2" })
          : mkGateway({
              roll: {
                operationId: "roll-x",
                status: "migrating",
                fromRelease: 1,
                toRelease: 2,
                sourceRevisionId: "default-r1",
                targetRevisionId: "default-r2",
                acceptingNewAssignments: true,
                startedAt: 0,
                updatedAt: 0,
                error: null,
                flippedAt: null,
              },
            }),
      wait: async () => {
        converged = true;
      },
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
    expect(deps.activateDesiredRelease).toHaveBeenCalledWith({
      gatewayId: "default",
      targetRelease: 2,
      operationId: "op-1",
    });
    expect(deps.requestReconcileTick).toHaveBeenCalled();
  });

  it("does not reconcile when exact release activation is rejected", async () => {
    const deps = mkDeps({
      activateDesiredRelease: vi.fn(async () => ({
        success: false as const,
        error: "another release is not live",
      })),
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );

    expect(res).toMatchObject({ success: false, error: "another release is not live" });
    expect(deps.requestReconcileTick).not.toHaveBeenCalled();
  });

  it("narrates convergence progress into the op log", async () => {
    const states: GatewayDoc[] = [
      mkGateway(),
      mkGateway({ liveRelease: 2 }),
    ];
    let i = 0;
    const deps = mkDeps({
      readGatewayDoc: async () => states[Math.min(i, states.length - 1)],
      wait: async () => {
        i += 1;
      },
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
    expect(deps.logs.some((l) => l.includes("converging r1 → r2"))).toBe(true);
    expect(deps.logs.some((l) => l.includes("converged onto release 2"))).toBe(true);
  });

  it("fails when the desired release payload never matches the requested image (superseded or the release cut failed)", async () => {
    const deps = mkDeps({
      readReleasePayload: async () => mkPayload({ imageTag: "other-tag" }),
      releaseRecordTimeoutMs: 3_000,
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/superseded|release/i);
  });

  it("tolerates the admin wrapper's release write landing shortly AFTER the op is claimed (record race)", async () => {
    let recorded = false;
    const deps = mkDeps({
      readReleasePayload: async () => (recorded ? mkPayload() : mkPayload({ imageTag: "stale" })),
      readGatewayDoc: async () =>
        recorded ? mkGateway({ liveRelease: 2, liveRevisionId: "default-r2" }) : mkGateway(),
      wait: async () => {
        recorded = true;
      },
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
  });

  it("times out with the last observed convergence state when it never lands", async () => {
    const deps = mkDeps({
      convergeTimeoutMs: 5_000,
      readGatewayDoc: async () => mkGateway(),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("did not converge within 5000ms");
    expect(res.error).toContain("converging r1 → r2");
  });

  it("no-op rollout (already live on the requested release, no roll) succeeds immediately", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ liveRelease: 2, liveRevisionId: "default-r2" }),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
  });
});
