import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "../../../shared/types/glm";
import { createRolloutHandler } from "../handlers/rollout";
import type { RolloutDeps, CurrentGatewaySpec } from "../handlers/rollout";
import type { OperationContext } from "../operation-router";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-r-1",
    kind: "rollout",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: "gw-test", imageTag: "newSha" },
    steps: [],
    ...overrides,
  };
}

function makeCtx(): OperationContext & { reported: OperationStep[] } {
  const reported: OperationStep[] = [];
  return {
    reportStep: vi.fn(async (s: OperationStep) => {
      reported.push(s);
    }),
    reported,
  };
}

interface FakeState {
  /** Per-gatewayId current spec (mirrors glmGateways doc). */
  specs: Map<string, CurrentGatewaySpec>;
  /** instanceName → image rendered by helm. */
  helmInstances: Map<string, { repository: string; tag: string }>;
  /** Per-gatewayId heartbeat doc. */
  heartbeats: Map<string, { version: string | null; lastHeartbeatAt: number }>;
}

function makeDeps(state: FakeState, overrides: Partial<RolloutDeps> = {}): RolloutDeps {
  let virtualClock = 0;
  return {
    helm: {
      readDeployedInstances: vi.fn(async () => {
        const m: Record<string, { enabled: boolean; image: { repository: string; tag: string }; gatewayId: string }> = {};
        for (const [name, image] of state.helmInstances) {
          m[name] = { enabled: true, image, gatewayId: `gw-test-${name === "default" ? "" : name}`.replace(/-$/, "") || "gw-test" };
        }
        return m;
      }),
    },
    readCurrentSpec: vi.fn(async (gatewayId: string) => state.specs.get(gatewayId) ?? null),
    updateGlmGatewayImage: vi.fn(async (gatewayId, repo, tag) => {
      const cur = state.specs.get(gatewayId);
      if (cur) state.specs.set(gatewayId, { ...cur, imageRepository: repo, imageTag: tag });
    }),
    readGatewayHeartbeat: vi.fn(async (gatewayId) => state.heartbeats.get(gatewayId) ?? null),
    helmRenderTimeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    now: () => virtualClock,
    wait: vi.fn(async (ms: number) => {
      virtualClock += ms;
    }),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createRolloutHandler — happy path", () => {
  it("updates glmGateways spec, then waits for helm + heartbeat to converge on the new tag", async () => {
    const state: FakeState = {
      specs: new Map([
        ["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "oldSha" }],
      ]),
      helmInstances: new Map([["default", { repository: REPO, tag: "oldSha" }]]),
      heartbeats: new Map([["gw-test", { version: "oldSha", lastHeartbeatAt: 0 }]]),
    };

    let pollsToFlipHelm = 2;
    let pollsToFlipHeartbeat = 4;
    const deps = makeDeps(state, {
      wait: vi.fn(async (_ms: number) => {
        if (--pollsToFlipHelm === 0) {
          state.helmInstances.set("default", { repository: REPO, tag: "newSha" });
        }
        if (--pollsToFlipHeartbeat === 0) {
          state.heartbeats.set("gw-test", { version: "newSha", lastHeartbeatAt: 100 });
        }
      }),
    });

    const ctx = makeCtx();
    const result = await createRolloutHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(state.specs.get("gw-test")?.imageTag).toBe("newSha");
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "update-spec:running",
      "update-spec:done",
      "helm-render:running",
      "helm-render:done",
      "heartbeat-fresh:running",
      "heartbeat-fresh:done",
    ]);
  });

  it("succeeds idempotently when helm already shows the new tag at start (spec-not-yet-updated path)", async () => {
    const state: FakeState = {
      // glmGateways still says oldSha, but helm has already rendered newSha
      // (e.g. the previous rollout op's spec write succeeded but the heartbeat
      // poll timed out — operator re-runs the same rollout to converge).
      specs: new Map([
        ["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "oldSha" }],
      ]),
      helmInstances: new Map([["default", { repository: REPO, tag: "newSha" }]]),
      heartbeats: new Map([["gw-test", { version: "newSha", lastHeartbeatAt: 100 }]]),
    };
    const deps = makeDeps(state);
    const result = await createRolloutHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
    // Spec write still happens — the handler doesn't trust pre-existing helm
    // state without persisting the desired-state record.
    expect(state.specs.get("gw-test")?.imageTag).toBe("newSha");
  });

  it("accepts an imageRepository override (e.g., switching repos)", async () => {
    const ALT_REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-alt";
    const state: FakeState = {
      specs: new Map([
        ["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "oldSha" }],
      ]),
      helmInstances: new Map([["default", { repository: ALT_REPO, tag: "newSha" }]]),
      heartbeats: new Map([["gw-test", { version: "newSha", lastHeartbeatAt: 100 }]]),
    };
    const deps = makeDeps(state);
    const result = await createRolloutHandler(deps)(
      mkOp({ input: { gatewayId: "gw-test", imageTag: "newSha", imageRepository: ALT_REPO } }),
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(state.specs.get("gw-test")?.imageRepository).toBe(ALT_REPO);
  });
});

describe("createRolloutHandler — refusals + edge cases", () => {
  it("refuses when op.input is missing gatewayId", async () => {
    const deps = makeDeps({ specs: new Map(), helmInstances: new Map(), heartbeats: new Map() });
    const result = await createRolloutHandler(deps)(mkOp({ input: { imageTag: "x" } }), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/);
  });

  it("refuses when op.input is missing imageTag", async () => {
    const deps = makeDeps({ specs: new Map(), helmInstances: new Map(), heartbeats: new Map() });
    const result = await createRolloutHandler(deps)(
      mkOp({ input: { gatewayId: "gw-test" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/imageTag/);
  });

  it("refuses when glmGateways doc is missing", async () => {
    const deps = makeDeps({ specs: new Map(), helmInstances: new Map(), heartbeats: new Map() });
    const result = await createRolloutHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("refuses when the requested image is identical to current (no-op)", async () => {
    const state: FakeState = {
      specs: new Map([
        ["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "sameSha" }],
      ]),
      helmInstances: new Map([["default", { repository: REPO, tag: "sameSha" }]]),
      heartbeats: new Map([["gw-test", { version: "sameSha", lastHeartbeatAt: 0 }]]),
    };
    const deps = makeDeps(state);
    const result = await createRolloutHandler(deps)(
      mkOp({ input: { gatewayId: "gw-test", imageTag: "sameSha" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no-op|already on/i);
    // updateGlmGatewayImage should NOT have been called
    expect(state.specs.get("gw-test")?.imageTag).toBe("sameSha");
  });
});

describe("createRolloutHandler — failures", () => {
  it("times out helm-render when helm never renders the new tag", async () => {
    const state: FakeState = {
      specs: new Map([
        ["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "oldSha" }],
      ]),
      helmInstances: new Map([["default", { repository: REPO, tag: "oldSha" }]]),
      heartbeats: new Map([["gw-test", { version: "oldSha", lastHeartbeatAt: 0 }]]),
    };
    const deps = makeDeps(state, { helmRenderTimeoutMs: 5_000, pollIntervalMs: 1_000 });
    const ctx = makeCtx();
    const result = await createRolloutHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/helm did not render|within 5000ms/);
    const failed = ctx.reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("helm-render");
  });

  it("times out heartbeat-fresh when the new pod never publishes the new version", async () => {
    const state: FakeState = {
      specs: new Map([
        ["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "oldSha" }],
      ]),
      // Helm flips fast; heartbeat never updates from oldSha.
      helmInstances: new Map([["default", { repository: REPO, tag: "newSha" }]]),
      heartbeats: new Map([["gw-test", { version: "oldSha", lastHeartbeatAt: 0 }]]),
    };
    const deps = makeDeps(state, { helmRenderTimeoutMs: 60_000, heartbeatTimeoutMs: 5_000 });
    const ctx = makeCtx();
    const result = await createRolloutHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/heartbeat with version=newSha/);
    const failed = ctx.reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("heartbeat-fresh");
  });
});
