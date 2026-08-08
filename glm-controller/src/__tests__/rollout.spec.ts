import { describe, it, expect, vi } from "vitest";
import {
  createRolloutHandler,
  planDesiredReleaseActivation,
  type RolloutDeps,
} from "../handlers/rollout.js";
import type { Operation } from "@octogee/shared/types/glm";
import type { GatewayDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { OperationContext } from "../operation-router.js";
import { decideRollStateMigration } from "../roll-state-migration.js";

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
    builderAccess: null,
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
    readGatewayOpenclawVersion: async () => "beta2",
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

  it("rejects a superseded target", () => {
    expect(planDesiredReleaseActivation(
      mkGateway({ latestRelease: 3, desiredRelease: 1, liveRelease: 1 }),
      2,
      100,
      "op-1",
    )).toMatchObject({ success: false, error: expect.stringContaining("superseded") });
  });

  it("replaces an incomplete desired release while the live source remains serving", () => {
    expect(planDesiredReleaseActivation(
      mkGateway({ latestRelease: 3, desiredRelease: 2, liveRelease: 1 }),
      3,
      100,
      "op-1",
    )).toEqual({
      success: true,
      patch: {
        desiredRelease: 3,
        updatedAt: 100,
        updatedBy: "rollout:op-1",
      },
    });
  });
});

describe("rollout op — awaits the roll arm's convergence", () => {
  it("supersedes a prior incomplete desired release without waiting for its convergence", async () => {
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
        : mkGateway({
            latestRelease: 3,
            desiredRelease: 2,
            liveRelease: 1,
          }),
      readReleasePayload: async (_gatewayId, release) =>
        release === 3 ? mkPayload({ imageTag: "feed456-ocbeta2" }) : null,
      activateDesiredRelease,
      wait: async () => {
        throw new Error("newer rollout should not wait for the incomplete prior release");
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
    expect(
      reportStep.mock.calls.filter((call) => call[0].status === "running"),
    ).toHaveLength(1);
  });

  it("fails a running older rollout promptly when a newer cut advances latest release", async () => {
    let newerReleaseCut = false;
    let now = 0;
    const deps = mkDeps({
      readGatewayDoc: async () => newerReleaseCut
        ? mkGateway({ latestRelease: 3, desiredRelease: 2, liveRelease: 1 })
        : mkGateway({ latestRelease: 2, desiredRelease: 2, liveRelease: 1 }),
      activateDesiredRelease: vi.fn(async () => ({ success: true as const })),
      convergeTimeoutMs: 2_000,
      now: () => now,
      wait: async () => {
        now += 1_000;
        newerReleaseCut = true;
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("superseded by latest release 3");
    expect(deps.activateDesiredRelease).toHaveBeenCalledTimes(1);
  });

  it("activates the newer latest release while the old live source serves until convergence", async () => {
    let activated = false;
    let converged = false;
    let sourceObservedDuringHandoff = false;
    let now = 0;
    const deps = mkDeps({
      readGatewayDoc: async () => {
        if (!activated) return mkGateway({ latestRelease: 3, desiredRelease: 2, liveRelease: 1 });
        if (!converged) {
          sourceObservedDuringHandoff = true;
          return mkGateway({ latestRelease: 3, desiredRelease: 3, liveRelease: 1 });
        }
        return mkGateway({ latestRelease: 3, desiredRelease: 3, liveRelease: 3 });
      },
      readReleasePayload: async (_gatewayId, release) =>
        release === 3 ? mkPayload({ imageTag: "feed456-ocbeta2" }) : null,
      activateDesiredRelease: vi.fn(async () => {
        activated = true;
        return { success: true as const };
      }),
      convergeTimeoutMs: 2_000,
      now: () => now,
      wait: async () => {
        now += 1_000;
        expect(sourceObservedDuringHandoff).toBe(true);
        converged = true;
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 3, imageTag: "feed456-ocbeta2" }),
      ctx,
    );

    expect(res.success).toBe(true);
    expect(deps.activateDesiredRelease).toHaveBeenCalledWith({
      gatewayId: "default",
      targetRelease: 3,
      operationId: "op-1",
    });
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
    expect(deps.requestReconcileTick).toHaveBeenCalledTimes(2);
    expect(deps.requestReconcileTick).toHaveBeenCalledWith("default");
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

  it("journals a state migration when the release keeps the gateway's openclaw version", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ liveRelease: 2 }),
      readReleasePayload: async () => mkPayload({ imageTag: "cafe123-oc2026.7.2-beta.7" }),
      readGatewayOpenclawVersion: async () => "2026.7.2-beta.7",
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-oc2026.7.2-beta.7" }),
      ctx,
    );

    expect(res.success).toBe(true);
    expect(res.output).toEqual({
      stateMigration: decideRollStateMigration({
        sourceOpenclawVersion: "2026.7.2-beta.7",
        targetOpenclawVersion: "2026.7.2-beta.7",
      }),
    });
    expect((res.output?.stateMigration as { strategy: string }).strategy).toBe("migrate-state");
  });

  it("journals a fresh provision across an openclaw version change", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ liveRelease: 2 }),
      readReleasePayload: async () => mkPayload({ imageTag: "8886d40-oc2026.7.2-beta.7" }),
      readGatewayOpenclawVersion: async () => "2026.7.1",
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "8886d40-oc2026.7.2-beta.7" }),
      ctx,
    );

    expect(res.success).toBe(true);
    expect(res.output).toEqual({
      stateMigration: {
        strategy: "provision-fresh",
        sourceOpenclawVersion: "2026.7.1",
        targetOpenclawVersion: "2026.7.2-beta.7",
        reason: expect.stringContaining("2026.7.1"),
      },
    });
    expect(deps.logs.some((line) => line.includes("provision-fresh"))).toBe(true);
  });

  it("journals a fresh provision when the source gateway reports no openclaw version", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ liveRelease: 2 }),
      readReleasePayload: async () => mkPayload({ imageTag: "8886d40-oc2026.7.2-beta.7" }),
      readGatewayOpenclawVersion: async () => null,
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "8886d40-oc2026.7.2-beta.7" }),
      ctx,
    );

    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({
      stateMigration: { strategy: "provision-fresh", sourceOpenclawVersion: null },
    });
  });

  it("journals the chosen strategy even when the roll never converges", async () => {
    const deps = mkDeps({
      convergeTimeoutMs: 5_000,
      readGatewayDoc: async () => mkGateway(),
      readReleasePayload: async () => mkPayload({ imageTag: "8886d40-oc2026.7.2-beta.7" }),
      readGatewayOpenclawVersion: async () => "2026.7.1",
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "8886d40-oc2026.7.2-beta.7" }),
      ctx,
    );

    expect(res.success).toBe(false);
    expect(res.output).toMatchObject({ stateMigration: { strategy: "provision-fresh" } });
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
