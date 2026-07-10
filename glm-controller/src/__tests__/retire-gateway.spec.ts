import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import { createRetireGatewayHandler } from "../handlers/retire-gateway";
import type { RetireGatewayDeps } from "../handlers/retire-gateway";
import type { OperationContext } from "../operation-router";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-r-1",
    kind: "retire-gateway",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: "canary" },
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
  helmInstances: Set<string>;
  live: Map<string, { mounted: string[] }>;
  glmGatewayIds: Map<string, string>;
  deletedGlm: Set<string>;
  deletedHeartbeat: Set<string>;
  heartbeatPresentAfterDelete?: Set<string>;
  // Step 2 full-gateway retire inputs.
  assignments: Array<{ uid: string; slug: string }>;
  revisions: Array<{ revisionId: string; release: number; lifecycle: string }>;
  helmUninstalledRevisions: string[];
  revokedRevisionMacOpsTokens: string[];
  revokedLegacyMacOpsTokens: string[];
  retiredRevisionDocs: string[];
  tombstonedRevisions: string[];
  revisionTeardownSteps: string[];
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    helmInstances: new Set(),
    live: new Map([["canary", { mounted: [] }]]),
    glmGatewayIds: new Map([["canary", "canary"]]),
    deletedGlm: new Set(),
    deletedHeartbeat: new Set(),
    assignments: [],
    revisions: [],
    helmUninstalledRevisions: [],
    revokedRevisionMacOpsTokens: [],
    revokedLegacyMacOpsTokens: [],
    retiredRevisionDocs: [],
    tombstonedRevisions: [],
    revisionTeardownSteps: [],
    ...overrides,
  };
}

function makeDeps(state: FakeState, overrides: Partial<RetireGatewayDeps> = {}): RetireGatewayDeps {
  let virtualClock = 0;
  return {
    helm: {
      readDeployedInstances: vi.fn(async () => {
        const m: Record<
          string,
          { enabled: boolean; image: { repository: string; tag: string }; gatewayId: string }
        > = {};
        for (const name of state.helmInstances) {
          m[name] = { enabled: true, image: { repository: "repo", tag: "abc" }, gatewayId: name };
        }
        return m;
      }),
    },
    readGatewayLiveState: vi.fn(async (gatewayId: string) => {
      const live = state.live.get(gatewayId);
      if (!live) return null;
      return { mountedCustomers: live.mounted };
    }),
    readAssignmentsForGateway: vi.fn(async () => state.assignments),
    readNonRetiredRevisions: vi.fn(async () =>
      state.revisions
        .filter((r) => r.lifecycle !== "retired")
        .map((r) => ({ revisionId: r.revisionId, release: r.release })),
    ),
    helmUninstallRevision: vi.fn(async (revisionId: string) => {
      state.helmUninstalledRevisions.push(revisionId);
      state.revisionTeardownSteps.push(`helm:${revisionId}`);
    }),
    revokeRevisionMacOpsTokens: vi.fn(async ({ revisionId }: { revisionId: string }) => {
      state.revokedRevisionMacOpsTokens.push(revisionId);
      state.revisionTeardownSteps.push(`revoke:${revisionId}`);
    }),
    revokeGatewayLegacyMacOpsTokens: vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      state.revokedLegacyMacOpsTokens.push(gatewayId);
      state.revisionTeardownSteps.push(`revoke-legacy:${gatewayId}`);
    }),
    retireRevisionDoc: vi.fn(async (revisionId: string) => {
      state.retiredRevisionDocs.push(revisionId);
      state.revisionTeardownSteps.push(`retire:${revisionId}`);
      const rev = state.revisions.find((r) => r.revisionId === revisionId);
      if (rev) rev.lifecycle = "retired";
    }),
    readGlmGatewayId: vi.fn(async (gatewayId: string) => state.glmGatewayIds.get(gatewayId) ?? null),
    deleteGlmGateway: vi.fn(async (gatewayId: string) => {
      state.deletedGlm.add(gatewayId);
    }),
    deleteGatewayHeartbeat: vi.fn(async (gatewayId: string) => {
      state.deletedHeartbeat.add(gatewayId);
    }),
    readGatewayHeartbeatExists: vi.fn(
      async (gatewayId: string) => state.heartbeatPresentAfterDelete?.has(gatewayId) ?? false,
    ),
    deleteGatewayPersistentVolumeClaim: vi.fn(async () => {}),
    deleteGatewayKubeSecret: vi.fn(async () => {}),
    deleteAuthTokenSecret: vi.fn(async () => {}),
    deleteGatewayServiceAccount: vi.fn(async () => {}),
    deleteGatewayEdgeService: vi.fn(async () => {}),
    deleteGatewayModelKeyKubeSecret: vi.fn(async () => {}),
    deleteGatewayModelKeySource: vi.fn(async () => {}),
    teardownGatewayServiceAccount: vi.fn(async () => {}),
    syncFleetIngress: vi.fn(async () => {}),
    helmUninstallTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    now: () => virtualClock,
    wait: vi.fn(async (ms: number) => {
      virtualClock += ms;
    }),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createRetireGatewayHandler — teardown completeness (happy path)", () => {
  it("deletes every gateway-scoped runtime resource before records and ingress", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalledWith("canary");
    expect(deps.deleteGatewayKubeSecret).toHaveBeenCalledWith("canary");
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
    expect(deps.deleteGatewayServiceAccount).toHaveBeenCalledWith("canary");
    expect(deps.deleteGatewayEdgeService).toHaveBeenCalledWith("canary");
    expect(deps.deleteGatewayModelKeyKubeSecret).toHaveBeenCalledWith("canary");
    expect(deps.deleteGatewayModelKeySource).toHaveBeenCalledWith("canary");
    expect(deps.teardownGatewayServiceAccount).toHaveBeenCalledWith("canary");
    expect(state.deletedGlm.has("canary")).toBe(true);
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-uninstall:running",
      "helm-uninstall:done",
      "revoke-legacy-mac-ops-token:running",
      "revoke-legacy-mac-ops-token:done",
      "delete-pvc:running",
      "delete-pvc:done",
      "delete-kube-secret:running",
      "delete-kube-secret:done",
      "delete-sm-secret:running",
      "delete-sm-secret:done",
      "delete-ksa:running",
      "delete-ksa:done",
      "delete-edge-service:running",
      "delete-edge-service:done",
      "delete-model-key-kube-secret:running",
      "delete-model-key-kube-secret:done",
      "delete-model-key-source:running",
      "delete-model-key-source:done",
      "teardown-gsa:running",
      "teardown-gsa:done",
      "cleanup:running",
      "cleanup:done",
      "heartbeat-quiesce:running",
      "heartbeat-quiesce:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("retainData=true preserves the PVC (skips delete-pvc) but still deletes both secrets", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", retainData: true } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(deps.deleteGatewayKubeSecret).toHaveBeenCalledWith("canary");
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
    expect(ctx.reported.some((s) => s.name === "delete-pvc")).toBe(false);
  });

  it("no-ops GSA teardown when no teardownGatewayServiceAccount dep is wired", async () => {
    const state = baseState();
    const deps = makeDeps(state, { teardownGatewayServiceAccount: undefined });
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(ctx.reported.some((s) => s.name === "teardown-gsa")).toBe(false);
  });

  it("calls syncFleetIngress exactly once after teardown + records succeed", async () => {
    const state = baseState();
    const sync = vi.fn(async () => {});
    const deps = makeDeps(state, { syncFleetIngress: sync });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("writes the revision_gone tombstone during teardown, before the glm doc is deleted", async () => {
    const state = baseState();
    const order: string[] = [];
    const writeRevisionTombstone = vi.fn(async () => {
      order.push("tombstone");
    });
    const deps = makeDeps(state, {
      writeRevisionTombstone,
      deleteGlmGateway: vi.fn(async (gatewayId: string) => {
        order.push("delete-glm");
        state.deletedGlm.add(gatewayId);
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(true);
    expect(writeRevisionTombstone).toHaveBeenCalledWith("canary");
    // Ordering matters: the writer must read the still-present revision doc.
    expect(order).toEqual(["tombstone", "delete-glm"]);
  });

  it("fails the op (records preserved for retry) when the tombstone write throws", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      writeRevisionTombstone: vi.fn(async () => {
        throw new Error("firestore down");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(state.deletedGlm.has("canary")).toBe(false);
  });
});

describe("createRetireGatewayHandler — Mac ops retirement", () => {
  it("revokes the generic legacy PAT only after every revision has been drained", async () => {
    const state = baseState({
      revisions: [
        { revisionId: "canary-r1", release: 1, lifecycle: "ready" },
        { revisionId: "canary-r2", release: 2, lifecycle: "ready" },
      ],
    });
    const deps = makeDeps(state) as RetireGatewayDeps & {
      revokeGatewayLegacyMacOpsTokens: (input: { gatewayId: string }) => Promise<void>;
    };
    deps.revokeGatewayLegacyMacOpsTokens = vi.fn(async ({ gatewayId }) => {
      state.revokedLegacyMacOpsTokens.push(gatewayId);
      state.revisionTeardownSteps.push(`revoke-legacy:${gatewayId}`);
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(true);
    expect(state.revokedLegacyMacOpsTokens).toEqual(["canary"]);
    expect(state.revisionTeardownSteps).toEqual([
      "helm:canary-r1",
      "revoke:canary-r1",
      "retire:canary-r1",
      "helm:canary-r2",
      "revoke:canary-r2",
      "retire:canary-r2",
      "revoke-legacy:canary",
    ]);
  });
});

describe("createRetireGatewayHandler — independent best-effort teardown (D4)", () => {
  it("attempts every teardown step even when one throws, fails the op, preserves records for retry", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      deleteGatewayKubeSecret: vi.fn(async () => {
        throw new Error("kubectl secret denied");
      }),
    });
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/teardown incomplete/);
    expect(result.error).toMatch(/kubectl secret denied/);
    // Every other teardown step is still attempted — one failure does not abort the rest.
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalled();
    expect(deps.deleteGatewayServiceAccount).toHaveBeenCalled();
    expect(deps.deleteGatewayEdgeService).toHaveBeenCalled();
    expect(deps.deleteGatewayModelKeyKubeSecret).toHaveBeenCalled();
    expect(deps.deleteGatewayModelKeySource).toHaveBeenCalled();
    expect(deps.teardownGatewayServiceAccount).toHaveBeenCalled();
    // Records preserved so the operation stays re-drivable.
    expect(state.deletedGlm.size).toBe(0);
    expect(state.deletedHeartbeat.size).toBe(0);
    const failed = ctx.reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("delete-kube-secret");
  });

  it("aggregates multiple teardown failures into one error", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      deleteGatewayPersistentVolumeClaim: vi.fn(async () => {
        throw new Error("pvc stuck");
      }),
      deleteAuthTokenSecret: vi.fn(async () => {
        throw new Error("sm denied");
      }),
      deleteGatewayEdgeService: vi.fn(async () => {
        throw new Error("service stuck");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pvc stuck/);
    expect(result.error).toMatch(/sm denied/);
    expect(result.error).toMatch(/service stuck/);
  });

  it("GSA teardown failure aggregate-gates the op — a stranded IAM principal is not silently OK", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      teardownGatewayServiceAccount: vi.fn(async () => {
        throw new Error("iam denied");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/teardown incomplete/);
    expect(result.error).toMatch(/teardown-gsa: iam denied/);
    // Records preserved so the op is re-drivable once the GSA is cleared.
    expect(state.deletedGlm.size).toBe(0);
  });

  it("retainServiceAccount=true skips GSA teardown (terraform-managed GSA), op succeeds", async () => {
    const state = baseState();
    const teardownGsa = vi.fn(async () => {
      throw new Error("would fail if called");
    });
    const deps = makeDeps(state, { teardownGatewayServiceAccount: teardownGsa });

    const result = await createRetireGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", retainServiceAccount: true } }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(teardownGsa).not.toHaveBeenCalled();
    expect(state.deletedGlm.has("canary")).toBe(true);
  });

  it("fails the op when fleet-ingress sync throws — records already done, failed step reported", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      syncFleetIngress: vi.fn(async () => {
        throw new Error("kubectl apply denied");
      }),
    });
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kubectl apply denied/);
    expect(state.deletedGlm.has("canary")).toBe(true);
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("fleet-ingress");
  });

  it("waits through pre-uninstall polls until helm removes the instance", async () => {
    const state = baseState({ helmInstances: new Set(["canary"]) });
    let polls = 0;
    const deps = makeDeps(state, {
      wait: vi.fn(async (_ms: number) => {
        polls++;
        if (polls === 2) state.helmInstances.delete("canary");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
  });
});

describe("createRetireGatewayHandler — refusals + edge cases", () => {
  it("refuses when the gateway still has mounted customers (nothing torn down)", async () => {
    const state = baseState({
      helmInstances: new Set(["canary"]),
      live: new Map([["canary", { mounted: ["alice", "bob"] }]]),
    });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still has 2 mounted/);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });

  it("proceeds with retire when heartbeat doc is missing (stranded crash-loop case)", async () => {
    const state = baseState({ live: new Map() });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
    expect(state.deletedGlm.has("canary")).toBe(true);
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalledWith("canary");
  });

  it("finishes cleanup when glmGateways doc is already gone and helm release is absent", async () => {
    const state = baseState({ glmGatewayIds: new Map() });
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalledWith("canary");
    expect(deps.deleteGatewayKubeSecret).toHaveBeenCalledWith("canary");
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
    expect(deps.teardownGatewayServiceAccount).toHaveBeenCalledWith("canary");
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-uninstall:running",
      "helm-uninstall:done",
      "revoke-legacy-mac-ops-token:running",
      "revoke-legacy-mac-ops-token:done",
      "delete-pvc:running",
      "delete-pvc:done",
      "delete-kube-secret:running",
      "delete-kube-secret:done",
      "delete-sm-secret:running",
      "delete-sm-secret:done",
      "delete-ksa:running",
      "delete-ksa:done",
      "delete-edge-service:running",
      "delete-edge-service:done",
      "delete-model-key-kube-secret:running",
      "delete-model-key-kube-secret:done",
      "delete-model-key-source:running",
      "delete-model-key-source:done",
      "teardown-gsa:running",
      "teardown-gsa:done",
      "cleanup:running",
      "cleanup:done",
      "heartbeat-quiesce:running",
      "heartbeat-quiesce:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("refuses when glmGateways doc is missing but helm release still exists", async () => {
    const state = baseState({
      helmInstances: new Set(["canary"]),
      glmGatewayIds: new Map(),
    });
    const deps = makeDeps(state);

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/glmGateways.*not found|helm release still exists/);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
  });

  it("refuses teardown when the resolved gatewayId mismatches the input id (no destructive work)", async () => {
    const state = baseState({ glmGatewayIds: new Map([["canary", "other"]]) });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatched id/);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });

  it("rejects a structurally-invalid gatewayId before any teardown", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "Bad ID!" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid gatewayId/);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it("returns failure when op.input is missing gatewayId", async () => {
    const state = baseState({ live: new Map(), glmGatewayIds: new Map() });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp({ input: {} }), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/);
  });
});

describe("createRetireGatewayHandler — full-gateway revision-aware retire (Step 2)", () => {
  const trackTombstone = (state: FakeState) =>
    vi.fn(async (rid: string) => {
      state.tombstonedRevisions.push(rid);
      state.revisionTeardownSteps.push(`tombstone:${rid}`);
    });

  it("refuses while assignment docs exist, naming the slugs sorted — nothing torn down", async () => {
    const state = baseState({
      assignments: [
        { uid: "u2", slug: "beta" },
        { uid: "u1", slug: "alpha" },
      ],
      revisions: [{ revisionId: "canary-r1", release: 1, lifecycle: "serving" }],
    });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still has 2 assigned/);
    expect(result.error).toMatch(/alpha, beta/); // slugs sorted, migration hint
    expect(deps.helmUninstallRevision).not.toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(state.retiredRevisionDocs).toEqual([]);
  });

  it("retires EVERY revision (uninstall + tombstone + retire doc) BEFORE any gateway-scoped teardown", async () => {
    const state = baseState({
      glmGatewayIds: new Map(), // new-model gateway: no bare glmGateways/{id} doc
      live: new Map(),
      revisions: [
        { revisionId: "canary-r1", release: 1, lifecycle: "serving" },
        { revisionId: "canary-r2", release: 2, lifecycle: "draining" },
      ],
    });
    let revisionsRetiredAtGatewayTeardown: string[] | null = null;
    const deps = makeDeps(state, {
      writeRevisionTombstone: trackTombstone(state),
      deleteGatewayPersistentVolumeClaim: vi.fn(async () => {
        // First gateway-scoped teardown step: snapshot revision retirement state.
        revisionsRetiredAtGatewayTeardown = [...state.retiredRevisionDocs];
      }),
    });
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(state.helmUninstalledRevisions).toEqual(["canary-r1", "canary-r2"]);
    expect(state.revokedRevisionMacOpsTokens).toEqual(["canary-r1", "canary-r2"]);
    // Each revision is tombstoned during its own teardown (the trailing bare-id
    // cleanup tombstone is a production no-op — no `canary` revision doc exists).
    expect(state.tombstonedRevisions.filter((t) => /-r\d+$/.test(t))).toEqual([
      "canary-r1",
      "canary-r2",
    ]);
    expect(state.retiredRevisionDocs).toEqual(["canary-r1", "canary-r2"]);
    expect(state.revisionTeardownSteps).toEqual([
      "helm:canary-r1",
      "revoke:canary-r1",
      "tombstone:canary-r1",
      "retire:canary-r1",
      "helm:canary-r2",
      "revoke:canary-r2",
      "tombstone:canary-r2",
      "retire:canary-r2",
      "revoke-legacy:canary",
      "tombstone:canary",
    ]);
    // Both revisions were already retired at the first gateway-scoped teardown.
    expect(revisionsRetiredAtGatewayTeardown).toEqual(["canary-r1", "canary-r2"]);
    const names = ctx.reported.map((s) => s.name);
    expect(names.indexOf("retire-revision:canary-r2")).toBeLessThan(names.indexOf("delete-pvc"));
    // Gateway-scoped teardown DID run last (this is a full gateway retire).
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
  });

  it("NEVER runs gateway-scoped teardown while a revision is still non-retired (uninstall fails)", async () => {
    const state = baseState({
      glmGatewayIds: new Map(),
      live: new Map(),
      revisions: [
        { revisionId: "canary-r1", release: 1, lifecycle: "serving" },
        { revisionId: "canary-r2", release: 2, lifecycle: "serving" },
      ],
    });
    const deps = makeDeps(state, {
      writeRevisionTombstone: trackTombstone(state),
      helmUninstallRevision: vi.fn(async (rid: string) => {
        if (rid === "canary-r2") throw new Error("kubectl down");
        state.helmUninstalledRevisions.push(rid);
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/revision teardown incomplete/);
    expect(result.error).toMatch(/canary-r2/);
    // r1 retired, r2 not — and NO gateway-scoped teardown, no record deletion.
    expect(state.retiredRevisionDocs).toEqual(["canary-r1"]);
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });

  it("leaves the revision retryable when scoped PAT revocation fails after Helm uninstall", async () => {
    const state = baseState({
      glmGatewayIds: new Map(),
      live: new Map(),
      revisions: [{ revisionId: "canary-r1", release: 1, lifecycle: "serving" }],
    });
    const deps = makeDeps(state, {
      writeRevisionTombstone: trackTombstone(state),
      revokeRevisionMacOpsTokens: vi.fn(async () => {
        throw new Error("Mattermost unavailable");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Mattermost unavailable/);
    expect(state.helmUninstalledRevisions).toEqual(["canary-r1"]);
    expect(state.tombstonedRevisions).toEqual([]);
    expect(state.retiredRevisionDocs).toEqual([]);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it("crash after revision-1 teardown converges next tick: revision-2 + gateway-scoped teardown finish", async () => {
    const state = baseState({
      glmGatewayIds: new Map(),
      live: new Map(),
      revisions: [
        { revisionId: "canary-r1", release: 1, lifecycle: "serving" },
        { revisionId: "canary-r2", release: 2, lifecycle: "serving" },
      ],
    });

    // Pass 1: r1 fully retires, then the controller dies on r2's uninstall.
    const crashing = makeDeps(state, {
      writeRevisionTombstone: trackTombstone(state),
      helmUninstallRevision: vi.fn(async (rid: string) => {
        if (rid === "canary-r2") throw new Error("controller died");
        state.helmUninstalledRevisions.push(rid);
      }),
    });
    const pass1 = await createRetireGatewayHandler(crashing)(mkOp(), makeCtx());
    expect(pass1.success).toBe(false);
    expect(state.retiredRevisionDocs).toEqual(["canary-r1"]);
    expect(crashing.deleteAuthTokenSecret).not.toHaveBeenCalled();

    // Pass 2: fresh controller over the same durable state — r1 already retired
    // drops out of the enumeration, r2 finishes, then gateway-scoped teardown.
    const healthy = makeDeps(state, { writeRevisionTombstone: trackTombstone(state) });
    const pass2 = await createRetireGatewayHandler(healthy)(mkOp(), makeCtx());
    expect(pass2.success).toBe(true);
    expect(healthy.helmUninstallRevision).toHaveBeenCalledTimes(1); // only r2 this pass
    expect(state.retiredRevisionDocs).toEqual(["canary-r1", "canary-r2"]);
    expect(healthy.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
  });

  it("legacy bare-id gateway (no assignments, no revisions) retires exactly as before — no revision teardown", async () => {
    const state = baseState(); // glmGatewayIds has canary, revisions empty
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(true);
    expect(deps.helmUninstallRevision).not.toHaveBeenCalled();
    expect(state.retiredRevisionDocs).toEqual([]);
    expect(state.tombstonedRevisions).toEqual([]);
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
    expect(state.deletedGlm.has("canary")).toBe(true);
  });
});

describe("createRetireGatewayHandler — failures", () => {
  it("times out helm-uninstall and reports the failure step when helm never removes the instance", async () => {
    const state = baseState({ helmInstances: new Set(["canary"]) });
    const deps = makeDeps(state, { helmUninstallTimeoutMs: 5_000, pollIntervalMs: 1_000 });
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not uninstall|timeout/i);
    const failed = ctx.reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("helm-uninstall");
    // No teardown attempted when the workload won't stop.
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });
});

describe("createRetireGatewayHandler — P2 heartbeat-quiesce", () => {
  it("re-deletes the heartbeat doc when a pod's late write resurrected it after cleanup", async () => {
    const state = baseState({ heartbeatPresentAfterDelete: new Set(["canary"]) });
    const deps = makeDeps(state);
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(true);
    expect(deps.deleteGatewayHeartbeat).toHaveBeenCalledTimes(2);
    const quiesceFinal = ctx.reported.filter((s) => s.name === "heartbeat-quiesce").at(-1);
    expect(quiesceFinal?.status).toBe("done");
  });

  it("skips the re-delete when heartbeat stays gone after cleanup (happy path, no zombie)", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(true);
    expect(deps.deleteGatewayHeartbeat).toHaveBeenCalledTimes(1);
    const quiesceFinal = ctx.reported.filter((s) => s.name === "heartbeat-quiesce").at(-1);
    expect(quiesceFinal?.status).toBe("done");
  });
});
