import { describe, expect, it } from "vitest";
import { builderAccountFromData, type BuilderAccountReader } from "@octogee/core/builder-account";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { assignOne, commitOperatorPlacement } from "../ops/assign-customer-gateway.js";

function sharedRoot(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running",
    configSchemaVersion: 1, profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null,
    ...overrides,
  };
}

function servingRuntime(gatewayId: string, mountedCustomers: string[] = []): Record<string, unknown> {
  const now = Date.now();
  return {
    docKind: "runtime", gatewayId, release: 1, lifecycle: "serving",
    helm: { availableReplicas: 1 },
    heartbeat: { status: "ready", lastHeartbeatAt: now, mountedCustomers },
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: now },
  };
}

function builder(openclaw: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    username: "alice", onboardingStep: "complete",
    provisioning: { status: "complete", openclaw: { status: "complete", slug: "alice", ...openclaw } },
  };
}

function assignment(gatewayId: string, uid: string, slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { uid, slug, gatewayId, source: "onboarding", state: "serving", epoch: 0, createdAt: 1, updatedAt: 1, updatedByOperationId: null, ...overrides };
}

function fixture(docs: Record<string, Record<string, unknown>>) {
  const records = new Map<string, Record<string, unknown>>(Object.entries({
    "config/orchestrator": { sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 2 } },
    "gateways/shared-0": sharedRoot("shared-0"),
    "glmGateways/shared-0": servingRuntime("shared-0"),
    ...docs,
  }));
  const accounts: BuilderAccountReader = {
    get: async (uid) => {
      const data = records.get(`users/${uid}`);
      return data === undefined ? null : builderAccountFromData(uid, data);
    },
    getMany: async () => { throw new Error("unused"); },
    list: async () => { throw new Error("unused"); },
  };
  return { deps: { store: createDocumentFixtureStore(records), accounts }, records };
}

const placement = {
  uid: "u1", slug: "alice", gatewayId: "shared-0", gatewayProfile: "standard" as const,
  source: "onboarding" as const, assignmentWrite: "upsert" as const, now: 5_000,
};

describe("assign-customer-gateway placement", () => {
  it("writes the mirror and the serving assignment together for an unplaced Builder", async () => {
    const { deps, records } = fixture({ "users/u1": builder() });

    await expect(assignOne(deps, "u1", { dryRun: false })).resolves.toMatchObject({
      kind: "assigned", gatewayId: "shared-0", gatewayProfile: "standard", previous: null,
    });

    expect(records.get("users/u1")).toMatchObject({
      provisioning: { openclaw: { gatewayId: "shared-0", gatewayProfile: "standard", controlUiEnabled: false } },
    });
    expect(records.get("gateways/shared-0/assignments/u1")).toMatchObject({
      uid: "u1", slug: "alice", gatewayId: "shared-0", source: "onboarding", state: "serving", epoch: 0,
    });
  });

  it("repairs a missing assignment behind a mirror that already targets the gateway", async () => {
    const { deps, records } = fixture({ "users/u1": builder({ gatewayId: "shared-0" }) });

    await expect(assignOne(deps, "u1", { dryRun: false })).resolves.toMatchObject({ kind: "already-assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toMatchObject({ uid: "u1", slug: "alice", source: "repair", state: "serving" });
  });

  it("preserves an existing assignment while refreshing the mirror", async () => {
    const existing = assignment("shared-0", "u1", "alice", { source: "migrate-customer", state: "quiescing", epoch: 8, updatedAt: 90, updatedByOperationId: "roll-1" });
    const { deps, records } = fixture({
      "users/u1": builder({ gatewayId: "shared-0" }),
      "gateways/shared-0/assignments/u1": existing,
    });

    await expect(assignOne(deps, "u1", { dryRun: false })).resolves.toMatchObject({ kind: "already-assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toEqual(existing);
    expect(records.get("users/u1")).toMatchObject({ provisioning: { openclaw: { gatewayProfile: "standard", controlUiEnabled: false } } });
  });

  it("writes nothing on a dry run", async () => {
    const { deps, records } = fixture({ "users/u1": builder() });

    await expect(assignOne(deps, "u1", { dryRun: true })).resolves.toMatchObject({ kind: "assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toBeUndefined();
    expect(records.get("users/u1")).toEqual(builder());
  });

  it("refuses a placement onto a missing gateway root without writing the mirror", async () => {
    const { deps, records } = fixture({ "users/u1": builder() });
    records.delete("gateways/shared-0");

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toEqual({ kind: "rejected", reason: "gateway-root-invalid" });

    expect(records.get("users/u1")).toEqual(builder());
    expect(records.get("gateways/shared-0/assignments/u1")).toBeUndefined();
  });

  it("rechecks shared capacity inside the placement transaction", async () => {
    const { deps, records } = fixture({
      "users/u1": builder(),
      "gateways/shared-0/assignments/u2": assignment("shared-0", "u2", "bob"),
      "gateways/shared-0/assignments/u3": assignment("shared-0", "u3", "carol"),
    });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toEqual({ kind: "rejected", reason: "gateway-target-not-accepting" });

    expect(records.get("users/u1")).toEqual(builder());
  });

  it("refuses a shared target with an incoming migration", async () => {
    const { deps } = fixture({
      "users/u1": builder(),
      "glmOperations/migrate-1": {
        kind: "migrate-customer", status: "running", createdBy: "operator:test", createdAt: 1, startedAt: 2, completedAt: null,
        input: { uid: "u9", toGatewayId: "shared-0" }, steps: [],
      },
    });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toEqual({ kind: "rejected", reason: "gateway-target-not-accepting" });
  });

  it("refuses a Builder that still holds an assignment on another gateway", async () => {
    const { deps } = fixture({
      "users/u1": builder({ gatewayId: "shared-9" }),
      "gateways/shared-9/assignments/u1": assignment("shared-9", "u1", "alice"),
    });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toEqual({ kind: "rejected", reason: "assigned-elsewhere" });
  });

  it("refuses a Builder under a restore fence", async () => {
    const { deps } = fixture({ "users/u1": builder({ restoreFence: { operationId: "restore-1" } }) });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toEqual({ kind: "rejected", reason: "restore-in-progress" });
  });

  it("refuses a gateway that is not serving", async () => {
    const { deps } = fixture({ "users/u1": builder(), "glmGateways/shared-0": { ...servingRuntime("shared-0"), lifecycle: "draining" } });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toEqual({ kind: "rejected", reason: "gateway-not-serving" });
  });

  it("reports a Builder that has not finished onboarding as not ready", async () => {
    const { deps } = fixture({ "users/u1": { ...builder(), onboardingStep: "profile" } });

    await expect(assignOne(deps, "u1", { dryRun: false })).resolves.toEqual({
      kind: "not-ready", uid: "u1", slug: "?", reason: "builder-not-eligible:onboarding-incomplete",
    });
  });

  it("reports an operator-managed Builder as not ready", async () => {
    const { deps } = fixture({ "users/u1": builder({ managedBy: "operator" }) });

    await expect(assignOne(deps, "u1", { dryRun: false })).resolves.toEqual({
      kind: "not-ready", uid: "u1", slug: "?", reason: "builder-not-eligible:operator-managed",
    });
  });
});
