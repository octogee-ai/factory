import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "../../../shared/types/glm";
import { createRolloutHandler } from "../handlers/rollout";
import type { RolloutDeps, CurrentGatewaySpec } from "../handlers/rollout";
import type { OperationContext } from "../operation-router";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const OPERATOR_REPO =
  "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-operator";

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
  
  specs: Map<string, CurrentGatewaySpec>;
  
  helmInstances: Map<string, { repository: string; tag: string }>;
  
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
    updateGlmGatewayImage: vi.fn(async (gatewayId, repo, tag, profile) => {
      const cur = state.specs.get(gatewayId);
      if (cur)
        state.specs.set(gatewayId, {
          ...cur,
          imageRepository: repo,
          imageTag: tag,
          ...(profile ? { profile } : {}),
        });
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

specs: new Map([
        ["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "oldSha" }],
      ]),
      helmInstances: new Map([["default", { repository: REPO, tag: "newSha" }]]),
      heartbeats: new Map([["gw-test", { version: "newSha", lastHeartbeatAt: 100 }]]),
    };
    const deps = makeDeps(state);
    const result = await createRolloutHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);

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
    
    expect(state.specs.get("gw-test")?.imageTag).toBe("sameSha");
  });

it("does NOT refuse no-op when Firestore desired matches request but actual deployed differs (drift)", async () => {
    let helmReadCount = 0;
    const state: FakeState = {
      specs: new Map([

["gw-test", { instanceName: "default", imageRepository: REPO, imageTag: "newSha" }],
      ]),

helmInstances: new Map([["default", { repository: REPO, tag: "oldSha" }]]),
      heartbeats: new Map([["gw-test", { version: "oldSha", lastHeartbeatAt: 0 }]]),
    };
    const deps = makeDeps(state, {

helm: {
        readDeployedInstances: vi.fn(async () => {
          helmReadCount++;
          const tag = helmReadCount === 1 ? "oldSha" : "newSha";
          return {
            default: {
              enabled: true,
              image: { repository: REPO, tag },
              gatewayId: "gw-test",
            },
          };
        }),
      },
      readGatewayHeartbeat: vi.fn(async (gatewayId) =>
        
        helmReadCount >= 2
          ? { version: "newSha", lastHeartbeatAt: 0 }
          : state.heartbeats.get(gatewayId) ?? null,
      ),
    });
    const result = await createRolloutHandler(deps)(
      mkOp({ input: { gatewayId: "gw-test", imageTag: "newSha" } }),
      makeCtx(),
    );

expect(result.error ?? "").not.toMatch(/no-op|already on/i);
    expect(result.success).toBe(true);
  });

  it("STILL refuses no-op when desired matches request AND actual deployed matches request (true no-op)", async () => {

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
    expect(deps.updateGlmGatewayImage).not.toHaveBeenCalled();
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

describe("createRolloutHandler — capability profile", () => {
  it("a profile flip at the SAME sha is not a no-op: writes profile and waits on the RESOLVED operator repo", async () => {
    const state: FakeState = {
      specs: new Map([
        
        ["gw-bender", { instanceName: "bender", imageRepository: REPO, imageTag: "sha1" }],
      ]),
      helmInstances: new Map([["bender", { repository: REPO, tag: "sha1" }]]),
      heartbeats: new Map([["gw-bender", { version: "sha1", lastHeartbeatAt: 0 }]]),
    };
    let polls = 2;
    const deps = makeDeps(state, {
      wait: vi.fn(async (_ms: number) => {
        if (--polls === 0) {

state.helmInstances.set("bender", { repository: OPERATOR_REPO, tag: "sha1" });
        }
      }),
    });
    const ctx = makeCtx();
    const result = await createRolloutHandler(deps)(
      mkOp({ input: { gatewayId: "gw-bender", imageTag: "sha1", profile: "operator" } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(state.specs.get("gw-bender")?.profile).toBe("operator");

expect(state.specs.get("gw-bender")?.imageRepository).toBe(REPO);
  });

  it("same sha AND same profile is still a no-op (boundary not over-broadened)", async () => {
    const state: FakeState = {
      specs: new Map([
        ["gw-bender", { instanceName: "bender", imageRepository: REPO, imageTag: "sha1", profile: "operator" }],
      ]),
      helmInstances: new Map([["bender", { repository: OPERATOR_REPO, tag: "sha1" }]]),
      heartbeats: new Map([["gw-bender", { version: "sha1", lastHeartbeatAt: 0 }]]),
    };
    const deps = makeDeps(state);
    const ctx = makeCtx();
    const result = await createRolloutHandler(deps)(
      mkOp({ input: { gatewayId: "gw-bender", imageTag: "sha1", profile: "operator" } }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no-op/);
    expect(deps.updateGlmGatewayImage).not.toHaveBeenCalled();
  });
});
