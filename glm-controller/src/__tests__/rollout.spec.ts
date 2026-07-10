import { describe, it, expect, vi } from "vitest";
import { createRolloutHandler, type RolloutDeps } from "../handlers/rollout.js";
import type { Operation } from "@octogee/shared/types/glm";
import type { GatewayDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { OperationContext } from "../operation-router.js";

// The rollout op is now a THIN release-roll driver: it validates that the
// gateway is on the Step 2 identity schema (refusing with the backfill tool
// otherwise), confirms the desired release carries the requested image, kicks a
// reconcile tick, and awaits the reconciler roll arm's level-triggered
// convergence. All actual roll work lives in converge-roll.ts.

function mkPayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "cafe123-ocbeta2",
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    byosub: null,
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

describe("rollout op — un-backfilled refusal (replaces all dual machinery)", () => {
  it("refuses a gateway with no durable gateways/{id} desired doc, naming the backfill tool", async () => {
    const deps = mkDeps({ readGatewayDoc: async () => null });
    const handler = createRolloutHandler(deps);
    const res = await handler(mkOp({ gatewayId: "legacy-gw", imageTag: "cafe123-ocbeta2" }), ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("legacy-gw");
    expect(res.error).toContain("scripts/ops/backfill-gateway-identity.ts");
  });

  it("fails on missing gatewayId / imageTag inputs", async () => {
    const handler = createRolloutHandler(mkDeps());
    expect((await handler(mkOp({ imageTag: "t" }), ctx)).error).toContain("gatewayId");
    expect((await handler(mkOp({ gatewayId: "g" }), ctx)).error).toContain("imageTag");
  });

  it("refuses a retired gateway", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ desiredStatus: "retired" }),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("retired");
  });
});

describe("rollout op — awaits the roll arm's convergence", () => {
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
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
    expect(deps.requestReconcileTick).toHaveBeenCalled();
  });

  it("narrates roll status transitions into the op log", async () => {
    const states: GatewayDoc[] = [
      mkGateway({
        roll: {
          operationId: "roll-x",
          status: "warming",
          fromRelease: 1,
          toRelease: 2,
          sourceRevisionId: "default-r1",
          targetRevisionId: "default-r2",
          acceptingNewAssignments: false,
          startedAt: 0,
          updatedAt: 0,
          error: null,
          flippedAt: null,
        },
      }),
      mkGateway({
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
      mkGateway({ liveRelease: 2, liveRevisionId: "default-r2" }),
    ];
    let i = 0;
    const deps = mkDeps({
      readGatewayDoc: async () => states[Math.min(i, states.length - 1)],
      wait: async () => {
        i += 1;
      },
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
    expect(deps.logs.some((l) => l.includes("warming"))).toBe(true);
    expect(deps.logs.some((l) => l.includes("migrating"))).toBe(true);
  });

  it("fails with the roll's durable error when the roll arm marks the roll failed", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () =>
        mkGateway({
          roll: {
            operationId: "roll-x",
            status: "failed",
            fromRelease: 1,
            toRelease: 2,
            sourceRevisionId: "default-r1",
            targetRevisionId: "default-r2",
            acceptingNewAssignments: false,
            startedAt: 0,
            updatedAt: 0,
            error: "target default-r2 did not become ready within 300000ms",
            flippedAt: null,
          },
        }),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("did not become ready");
  });

  it("fails when the desired release payload never matches the requested image (superseded or the release cut failed)", async () => {
    const deps = mkDeps({
      readReleasePayload: async () => mkPayload({ imageTag: "other-tag" }),
      releaseRecordTimeoutMs: 3_000,
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
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
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
  });

  it("times out with the last observed roll state when convergence never happens", async () => {
    const deps = mkDeps({
      convergeTimeoutMs: 5_000,
      readGatewayDoc: async () =>
        mkGateway({
          roll: {
            operationId: "roll-x",
            status: "migrating",
            fromRelease: 1,
            toRelease: 2,
            sourceRevisionId: "default-r1",
            targetRevisionId: "default-r2",
            acceptingNewAssignments: false,
            startedAt: 0,
            updatedAt: 0,
            error: "migration for u1 failed: quiesce did not drain",
            flippedAt: null,
          },
        }),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("quiesce did not drain");
  });

  it("no-op rollout (already live on the requested release, no roll) succeeds immediately", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ liveRelease: 2, liveRevisionId: "default-r2" }),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
  });
});
