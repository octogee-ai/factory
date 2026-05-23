import { describe, it, expect, vi } from "vitest";
import {
  buildHelmTargetMap,
  diffInstancesMap,
  type ReconcileChange,
} from "../reconcile-plan.js";
import { createRetireGatewayHandler } from "../handlers/retire-gateway.js";
import type { OperationContext } from "../operation-router.js";
import type {
  GatewayDesiredState,
  HelmInstanceValue,
  HelmInstancesMap,
  Operation,
  OperationStep,
} from "../../../shared/types/glm.js";

interface SharedState {
  helmReleases: Map<string, HelmInstanceValue>; 
  glmGateways: Map<string, GatewayDesiredState>; 
  gateways: Map<string, { mountedCustomers: string[]; inFlightJobId: string | null; lastHeartbeatAt: number }>;
  operations: Map<string, Operation>;
}

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const NS = "octogee-test";

function makeHelm(state: SharedState) {
  return {
    readDeployedInstances: async (): Promise<HelmInstancesMap> => {
      const out: HelmInstancesMap = {};
      for (const [name, v] of state.helmReleases) out[name] = v;
      return out;
    },
    upsertInstance: vi.fn(async () => undefined),
    removeInstance: vi.fn(async ({ instanceName }: { instanceName: string }) => {
      state.helmReleases.delete(instanceName);
    }),
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

async function reconcilerTick(
  state: SharedState,
  helm: ReturnType<typeof makeHelm>,
): Promise<ReconcileChange[]> {
  const desired = [...state.glmGateways.values()];
  const actualMap = await helm.readDeployedInstances();
  const mountedByGatewayId = new Map<string, readonly string[]>();
  for (const [id, hb] of state.gateways) mountedByGatewayId.set(id, hb.mountedCustomers);
  const targetMap = buildHelmTargetMap(desired, actualMap, mountedByGatewayId);
  const changes = diffInstancesMap(actualMap, targetMap);
  for (const change of changes) {
    if (change.kind === "drift") {
      await helm.removeInstance({ namespace: NS, instanceName: change.instanceName });
    }
  }
  return changes;
}

function adminDeleteGateway(
  state: SharedState,
  gatewayId: string,
): { status: number; operationId?: string; error?: string } {
  const glm = state.glmGateways.get(gatewayId);
  if (!glm) return { status: 404, error: "not found" };
  const hb = state.gateways.get(gatewayId);
  if (hb && hb.mountedCustomers.length > 0) {
    return { status: 409, error: "still has mounted customers" };
  }
  if (hb && hb.inFlightJobId) {
    return { status: 409, error: "in-flight restore job" };
  }
  
  const operationId = `op-${state.operations.size + 1}`;
  state.glmGateways.set(gatewayId, { ...glm, desiredStatus: "retired" });
  state.operations.set(operationId, {
    id: operationId,
    kind: "retire-gateway",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    input: { gatewayId },
    steps: [],
  });
  return { status: 202, operationId };
}

function makeRetireDeps(state: SharedState, helm: ReturnType<typeof makeHelm>) {
  return {
    helm,
    readGatewayLiveState: async (gatewayId: string) => {
      const hb = state.gateways.get(gatewayId);
      if (!hb) return null;
      return { mountedCustomers: hb.mountedCustomers, inFlightJobId: hb.inFlightJobId };
    },
    readGlmGatewayInstanceName: async (gatewayId: string) =>
      state.glmGateways.get(gatewayId)?.instanceName ?? null,
    deleteGlmGateway: async (gatewayId: string) => {
      state.glmGateways.delete(gatewayId);
    },
    deleteGatewayHeartbeat: async (gatewayId: string) => {
      state.gateways.delete(gatewayId);
    },
    readGatewayHeartbeatExists: async (gatewayId: string) =>
      state.gateways.has(gatewayId),
    syncFleetIngress: vi.fn(async () => {}),
    helmUninstallTimeoutMs: 30_000,
    pollIntervalMs: 10,
    now: () => Date.now(),
    wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    log: vi.fn(),
  };
}

describe("retire-gateway choreography (integration)", () => {
  it("admin DELETE → reconciler uninstall → op handler cleanup leaves zero traces", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        [
          "default",
          {
            enabled: true,
            image: { repository: REPO, tag: "abc1234" },
            gatewayId: "gw-test",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "gw-test",
          {
            gatewayId: "gw-test",
            instanceName: "default",
            imageRepository: REPO,
            imageTag: "abc1234",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      gateways: new Map([
        ["gw-test", { mountedCustomers: [], inFlightJobId: null, lastHeartbeatAt: Date.now() }],
      ]),
      operations: new Map(),
    };
    const helm = makeHelm(state);

const adminRes = adminDeleteGateway(state, "gw-test");
    expect(adminRes.status).toBe(202);
    expect(state.glmGateways.get("gw-test")?.desiredStatus).toBe("retired");
    expect(state.operations.size).toBe(1);

const changes = await reconcilerTick(state, helm);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "drift", instanceName: "default" }),
    ]);
    expect(helm.removeInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: "default" }),
    );
    expect(state.helmReleases.size).toBe(0);

const op = state.operations.get(adminRes.operationId!);
    expect(op).toBeDefined();
    const handler = createRetireGatewayHandler(makeRetireDeps(state, helm));
    const ctx = makeCtx();
    const result = await handler(op!, ctx);
    expect(result.success).toBe(true);

expect(state.helmReleases.size).toBe(0);
    expect(state.glmGateways.size).toBe(0);
    expect(state.gateways.size).toBe(0);

const stepFlow = ctx.reported.map((s) => `${s.name}:${s.status}`);
    expect(stepFlow).toEqual([
      "helm-uninstall:running",
      "helm-uninstall:done",
      "cleanup:running",
      "cleanup:done",
      "heartbeat-quiesce:running",
      "heartbeat-quiesce:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("admin refuses (409) when gateway has mounted customers — reconciler not engaged, no helm uninstall", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        [
          "default",
          {
            enabled: true,
            image: { repository: REPO, tag: "abc1234" },
            gatewayId: "gw-test",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "gw-test",
          {
            gatewayId: "gw-test",
            instanceName: "default",
            imageRepository: REPO,
            imageTag: "abc1234",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      gateways: new Map([
        ["gw-test", { mountedCustomers: ["cust-a"], inFlightJobId: null, lastHeartbeatAt: Date.now() }],
      ]),
      operations: new Map(),
    };
    const helm = makeHelm(state);

    const adminRes = adminDeleteGateway(state, "gw-test");
    expect(adminRes.status).toBe(409);
    expect(state.glmGateways.get("gw-test")?.desiredStatus).toBe("running");
    expect(state.operations.size).toBe(0);

await reconcilerTick(state, helm);
    expect(helm.removeInstance).not.toHaveBeenCalled();
    expect(state.helmReleases.size).toBe(1);
  });

  it("retire while drained-with-zero-customers but heartbeat is missing (stranded crash-loop) still cleans up", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        [
          "default",
          {
            enabled: true,
            image: { repository: REPO, tag: "abc1234" },
            gatewayId: "gw-test",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "gw-test",
          {
            gatewayId: "gw-test",
            instanceName: "default",
            imageRepository: REPO,
            imageTag: "abc1234",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      
      gateways: new Map(),
      operations: new Map(),
    };
    const helm = makeHelm(state);

    const adminRes = adminDeleteGateway(state, "gw-test");
    expect(adminRes.status).toBe(202);

    await reconcilerTick(state, helm);
    expect(state.helmReleases.size).toBe(0);

    const handler = createRetireGatewayHandler(makeRetireDeps(state, helm));
    const result = await handler(state.operations.get(adminRes.operationId!)!, makeCtx());
    expect(result.success).toBe(true);
    expect(state.glmGateways.size).toBe(0);
  });

it("regression — numeric imageTag does NOT short-circuit either step", async () => {
    const state: SharedState = {
      helmReleases: new Map([
        
        [
          "smoke",
          {
            enabled: true,
            image: { repository: REPO, tag: "9778420" },
            gatewayId: "gw-smoke",
          },
        ],
      ]),
      glmGateways: new Map([
        [
          "gw-smoke",
          {
            gatewayId: "gw-smoke",
            instanceName: "smoke",
            imageRepository: REPO,

imageTag: "9778420",
            desiredStatus: "running",
            createdBy: "ci",
          },
        ],
      ]),
      gateways: new Map([
        ["gw-smoke", { mountedCustomers: [], inFlightJobId: null, lastHeartbeatAt: Date.now() }],
      ]),
      operations: new Map(),
    };
    const helm = makeHelm(state);

    const adminRes = adminDeleteGateway(state, "gw-smoke");
    expect(adminRes.status).toBe(202);

    await reconcilerTick(state, helm);
    expect(state.helmReleases.size).toBe(0);

    const handler = createRetireGatewayHandler(makeRetireDeps(state, helm));
    const result = await handler(state.operations.get(adminRes.operationId!)!, makeCtx());
    expect(result.success).toBe(true);
    expect(state.glmGateways.size).toBe(0);
    expect(state.gateways.size).toBe(0);
  });
});
