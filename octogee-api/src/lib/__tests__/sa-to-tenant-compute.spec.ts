import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { mapReviewToTenant } from "../sa-to-tenant.js";

type Docs = Record<string, Record<string, unknown>>;

function valueAt(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function fakeDb(docs: Docs): Pick<Firestore, "doc" | "collection"> {
  return {
    doc: (path: string) => ({
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
    }),
    collection: (name: string) => ({
      where: (field: string, operator: string, value: unknown) => ({
        get: async () => ({
          docs: Object.entries(docs)
            .filter(([path, data]) => path.startsWith(`${name}/`) && !path.slice(name.length + 1).includes("/")
              && operator === "==" && valueAt(data, field) === value)
            .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => data })),
        }),
      }),
    }),
  } as unknown as Pick<Firestore, "doc" | "collection">;
}

function durableGateway(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "t", updatedAt: 1, updatedBy: "t",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1,
    liveRevisionId: `${gatewayId}-r1`, trafficRevisionId: `${gatewayId}-r1`,
    desiredStatus: "running", roll: null, configSchemaVersion: 1,
    profile: "builder", gatewayClass: "builder", imageProfile: "builder", sizingTier: null,
    gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
    serviceAccount: null, builderAccess: null, ownerUid: "UidA", builderSlug: "mama",
    openclawOverrides: null, modelBrokerLimits: null, preemption: null,
    ...overrides,
  };
}

function runtimeDoc(gatewayId: string, instanceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", runtime: "gce-vm",
    vm: { instanceName: `octogee-gw-${gatewayId}`, zone: "us-west1-b", instanceId, internalIp: "172.20.0.9", status: "RUNNING", provisioningModel: "SPOT", updatedAt: 1 },
    ...overrides,
  };
}

const review = (instanceId: string, namespace = "octogee-test") => ({
  authenticated: true as const,
  saName: "octogee-computer-test",
  namespace,
  audiences: ["octogee-api"],
  podName: `octogee-gw-b-x`,
  podUid: instanceId,
  computeInstance: { projectId: "octogee", zone: "us-west1-b", instanceId, instanceName: "octogee-gw-b-x" },
});

describe("mapReviewToTenant for a GCE computer identity", () => {
  it("binds the instance id to the one gce-vm gateway that recorded it", async () => {
    const db = fakeDb({
      "gateways/b-x": durableGateway("b-x"),
      "glmGateways/b-x": runtimeDoc("b-x", "4242"),
    });
    expect(await mapReviewToTenant(db, review("4242"), "octogee-test")).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "b-x", ownerUid: "UidA" },
    });
  });

  it("refuses an instance no gateway recorded, a cluster-runtime gateway, a retired gateway, or a namespace mismatch", async () => {
    const unknown = fakeDb({ "gateways/b-x": durableGateway("b-x"), "glmGateways/b-x": runtimeDoc("b-x", "1") });
    expect(await mapReviewToTenant(unknown, review("4242"), "octogee-test")).toMatchObject({ attached: false, result: "unknown_tenant" });

    const cluster = fakeDb({ "gateways/b-x": durableGateway("b-x"), "glmGateways/b-x": runtimeDoc("b-x", "4242", { runtime: "cluster" }) });
    expect(await mapReviewToTenant(cluster, review("4242"), "octogee-test")).toMatchObject({ attached: false, result: "unknown_tenant" });

    const retired = fakeDb({ "gateways/b-x": durableGateway("b-x", { desiredStatus: "retired" }), "glmGateways/b-x": runtimeDoc("b-x", "4242") });
    expect(await mapReviewToTenant(retired, review("4242"), "octogee-test")).toMatchObject({ attached: false, result: "unknown_tenant" });

    const ok = fakeDb({ "gateways/b-x": durableGateway("b-x"), "glmGateways/b-x": runtimeDoc("b-x", "4242") });
    expect(await mapReviewToTenant(ok, review("4242", "octogee"), "octogee-test")).toMatchObject({ attached: false, result: "ns_mismatch" });
  });

  it("keeps a retired gateway's computer bound for its final home checkpoint only while Cowboy's request is outstanding", async () => {
    const retired = (vmHome: Record<string, unknown> | undefined) => fakeDb({
      "gateways/b-x": durableGateway("b-x", { desiredStatus: "retired", retirementClaim: { operationId: "op-1", version: 1 } }),
      "glmGateways/b-x": runtimeDoc("b-x", "4242", vmHome ? { vmHome } : {}),
    });

    expect(await mapReviewToTenant(retired({ checkpointRequestedAt: 1_000, lastCheckpoint: null }), review("4242"), "octogee-test")).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "b-x", ownerUid: "UidA", finalHomeCheckpoint: true },
    });
    expect(await mapReviewToTenant(retired({ checkpointRequestedAt: 1_000, lastCheckpoint: { completedAt: 900 } }), review("4242"), "octogee-test"))
      .toMatchObject({ attached: true, tenant: { finalHomeCheckpoint: true } });

    expect(await mapReviewToTenant(retired({ checkpointRequestedAt: 1_000, lastCheckpoint: { completedAt: 1_000 } }), review("4242"), "octogee-test"))
      .toMatchObject({ attached: true, tenant: { finalHomeCheckpoint: true } });
    expect(await mapReviewToTenant(retired({ checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, lastCheckpoint: { completedAt: 1_000 } }), review("4242"), "octogee-test"))
      .toMatchObject({ attached: false, result: "unknown_tenant" });
    expect(await mapReviewToTenant(retired({ checkpointRequestedAt: null, lastCheckpoint: null }), review("4242"), "octogee-test"))
      .toMatchObject({ attached: false, result: "unknown_tenant" });
    expect(await mapReviewToTenant(retired(undefined), review("4242"), "octogee-test")).toMatchObject({ attached: false, result: "unknown_tenant" });

    const live = fakeDb({ "gateways/b-x": durableGateway("b-x"), "glmGateways/b-x": runtimeDoc("b-x", "4242", { vmHome: { checkpointRequestedAt: 1_000, lastCheckpoint: null } }) });
    expect(await mapReviewToTenant(live, review("4242"), "octogee-test")).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "b-x", ownerUid: "UidA" },
    });
  });

  it("refuses when two gateways claim the same instance id", async () => {
    const db = fakeDb({
      "gateways/b-x": durableGateway("b-x"),
      "glmGateways/b-x": runtimeDoc("b-x", "4242"),
      "glmGateways/b-y": runtimeDoc("b-y", "4242"),
    });
    expect(await mapReviewToTenant(db, review("4242"), "octogee-test")).toMatchObject({ attached: false, result: "unknown_tenant" });
  });

  it("still maps a Kubernetes review by service-account name", async () => {
    const db = fakeDb({ "gateways/b-x": durableGateway("b-x") });
    const k8s = { authenticated: true as const, saName: "octogee-gw-b-x", namespace: "octogee-test", audiences: ["octogee-api"] };
    expect(await mapReviewToTenant(db, k8s, "octogee-test")).toMatchObject({ attached: true, tenant: { kind: "gateway", gatewayId: "b-x" } });
  });
});
