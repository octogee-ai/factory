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
    input: { gatewayId: "canary", retirementClaimVersion: 1 },
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
  mounted: string[];
  assignments: Array<{ uid: string; slug: string }>;
  claimOk: boolean;
  helmUninstalled: string[];
  deletedGlm: Set<string>;
  deletedHeartbeat: Set<string>;
  heartbeatPresentAfterDelete?: Set<string>;
  teardownCalls: string[];
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    mounted: [],
    assignments: [],
    claimOk: true,
    helmUninstalled: [],
    deletedGlm: new Set(),
    deletedHeartbeat: new Set(),
    teardownCalls: [],
    ...overrides,
  };
}

function makeDeps(state: FakeState, overrides: Partial<RetireGatewayDeps> = {}): RetireGatewayDeps {
  const record = (name: string) => {
    state.teardownCalls.push(name);
  };
  return {
    verifyRetirementClaim: vi.fn(async () =>
      state.claimOk
        ? { ok: true as const }
        : { ok: false as const, error: "gateway canary retirement claim does not match this operation" },
    ),
    readMountedCustomers: vi.fn(async () => state.mounted),
    readAssignmentsForGateway: vi.fn(async () => state.assignments),
    helmUninstallGateway: vi.fn(async (gatewayId: string) => {
      state.helmUninstalled.push(gatewayId);
    }),
    deleteGlmGateway: vi.fn(async (gatewayId: string) => {
      state.deletedGlm.add(gatewayId);
    }),
    deleteGatewayHeartbeat: vi.fn(async (gatewayId: string) => {
      state.deletedHeartbeat.add(gatewayId);
    }),
    readGatewayHeartbeatExists: vi.fn(async (gatewayId: string) =>
      state.heartbeatPresentAfterDelete?.has(gatewayId) ?? false,
    ),
    deleteGatewayPersistentVolumeClaim: vi.fn(async () => record("delete-pvc")),
    deleteGatewayKubeSecret: vi.fn(async () => record("delete-kube-secret")),
    deleteAuthTokenSecret: vi.fn(async () => record("delete-sm-secret")),
    deleteGatewayServiceAccount: vi.fn(async () => record("delete-ksa")),
    deleteGatewayModelKeyKubeSecret: vi.fn(async () => record("delete-model-key-kube-secret")),
    deleteGatewayModelKeySource: vi.fn(async () => record("delete-model-key-source")),
    teardownGatewayServiceAccount: vi.fn(async () => record("teardown-gsa")),
    syncFleetIngress: vi.fn(async () => {}),
    pollIntervalMs: 1,
    now: () => 0,
    wait: async () => {},
    log: vi.fn(),
    ...overrides,
  };
}

describe("createRetireGatewayHandler — simple-roll retirement", () => {
  it("uninstalls the stable release, tears down resources, then removes records and syncs ingress", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const res = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(res.success).toBe(true);
    expect(state.helmUninstalled).toEqual(["canary"]);
    expect(state.teardownCalls).toEqual([
      "delete-pvc",
      "delete-kube-secret",
      "delete-sm-secret",
      "delete-ksa",
      "delete-model-key-kube-secret",
      "delete-model-key-source",
      "teardown-gsa",
    ]);
    expect(state.deletedGlm.has("canary")).toBe(true);
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    expect(deps.syncFleetIngress).toHaveBeenCalledTimes(1);
  });

  it("re-drives the complete idempotent teardown when gateway resources are already absent", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const handler = createRetireGatewayHandler(deps);

    await expect(handler(mkOp(), makeCtx())).resolves.toMatchObject({ success: true });
    await expect(handler(mkOp(), makeCtx())).resolves.toMatchObject({ success: true });

    expect(deps.helmUninstallGateway).toHaveBeenCalledTimes(2);
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalledTimes(2);
    expect(deps.deleteGatewayKubeSecret).toHaveBeenCalledTimes(2);
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledTimes(2);
    expect(deps.deleteGatewayServiceAccount).toHaveBeenCalledTimes(2);
    expect(deps.deleteGatewayModelKeyKubeSecret).toHaveBeenCalledTimes(2);
    expect(deps.deleteGatewayModelKeySource).toHaveBeenCalledTimes(2);
    expect(deps.teardownGatewayServiceAccount).toHaveBeenCalledTimes(2);
  });

  it("refuses while customers are still assigned, naming the slugs", async () => {
    const state = baseState({
      assignments: [
        { uid: "u2", slug: "bob" },
        { uid: "u1", slug: "alice" },
      ],
    });
    const deps = makeDeps(state);

    const res = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain("alice, bob");
    expect(state.helmUninstalled).toEqual([]);
    expect(state.teardownCalls).toEqual([]);
  });

  it("refuses while customers are still mounted, naming the slugs", async () => {
    const state = baseState({ mounted: ["ceckert"] });
    const deps = makeDeps(state);

    const res = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain("ceckert");
    expect(state.helmUninstalled).toEqual([]);
  });

  it("refuses when the retirement claim does not match this operation", async () => {
    const state = baseState({ claimOk: false });
    const deps = makeDeps(state);

    const res = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain("retirement claim does not match");
    expect(state.helmUninstalled).toEqual([]);
  });

  it("attempts every teardown step even when one fails, and preserves records for retry", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      deleteAuthTokenSecret: vi.fn(async () => {
        throw new Error("SM unavailable");
      }),
    });

    const res = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain("delete-sm-secret");
    // Later steps still ran (best-effort), records were NOT removed.
    expect(state.teardownCalls).toContain("delete-ksa");
    expect(state.teardownCalls).toContain("teardown-gsa");
    expect(state.deletedGlm.size).toBe(0);
    expect(state.deletedHeartbeat.size).toBe(0);
  });

  it("retainData preserves the PVC; retainServiceAccount preserves the GSA", async () => {
    const state = baseState();
    const deps = makeDeps(state);

    const res = await createRetireGatewayHandler(deps)(
      mkOp({
        input: {
          gatewayId: "canary",
          retirementClaimVersion: 1,
          retainData: true,
          retainServiceAccount: true,
        },
      }),
      makeCtx(),
    );

    expect(res.success).toBe(true);
    expect(state.teardownCalls).not.toContain("delete-pvc");
    expect(state.teardownCalls).not.toContain("teardown-gsa");
  });

  it("re-deletes a resurrected heartbeat during the quiesce grace pass", async () => {
    const state = baseState({ heartbeatPresentAfterDelete: new Set(["canary"]) });
    const deleteGatewayHeartbeat = vi.fn(async (gatewayId: string) => {
      state.deletedHeartbeat.add(gatewayId);
    });
    const deps = makeDeps(state, { deleteGatewayHeartbeat });

    const res = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(res.success).toBe(true);
    expect(deleteGatewayHeartbeat.mock.calls.length).toBe(2);
  });

  it("rejects a malformed request before touching anything", async () => {
    const state = baseState();
    const deps = makeDeps(state);

    const missingGateway = await createRetireGatewayHandler(deps)(
      mkOp({ input: { retirementClaimVersion: 1 } }),
      makeCtx(),
    );
    expect(missingGateway.success).toBe(false);
    expect(missingGateway.error).toContain("missing gatewayId");

    const missingVersion = await createRetireGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary" } }),
      makeCtx(),
    );
    expect(missingVersion.success).toBe(false);
    expect(missingVersion.error).toContain("retirementClaimVersion");

    expect(state.helmUninstalled).toEqual([]);
  });

  it("fails the op when the helm uninstall fails, before any resource teardown", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      helmUninstallGateway: vi.fn(async () => {
        throw new Error("helm timeout");
      }),
    });

    const res = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain("helm uninstall failed");
    expect(state.teardownCalls).toEqual([]);
    expect(state.deletedGlm.size).toBe(0);
  });
});
