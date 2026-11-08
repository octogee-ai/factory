import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { centralGatewayReleasePayload } from "@octogee/core/artifact-registry";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { readReleaseConvergenceRecords } from "../ops/verify-release-convergence.js";

function gatewayRoot(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 2, desiredRelease: 2, liveRelease: 1, desiredStatus: "running",
    configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null,
    ...overrides,
  };
}

const payload = centralGatewayReleasePayload({
  sourceSha: "a".repeat(40), manifestDigest: `sha256:${"d".repeat(64)}`, openclawVersion: "2026.10.2", repository: "registry/images",
  surfaces: { gateway: { "octogee-gateway": `sha256:${"a".repeat(64)}`, "octogee-gateway-builder": `sha256:${"b".repeat(64)}`, "gateway-edge": `sha256:${"c".repeat(64)}` }, platform: {} },
});

function release(gatewayId: string, number: number): Record<string, unknown> {
  return { gatewayId, release: number, payload, payloadHash: releasePayloadHash(payload), createdAt: 1, createdBy: "test", origin: "operator" };
}

function assignment(uid: string, slug: string, state: string): Record<string, unknown> {
  return { uid, slug, gatewayId: "shared-0", source: "onboarding", state, epoch: 0, createdAt: 1, updatedAt: 1, updatedByOperationId: null };
}

function rollout(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "rollout", status: "running", createdBy: "operator:test", createdAt: 1, startedAt: 2, completedAt: null,
    input: { gatewayId, imageTag: payload.imageTag, targetRelease: 2 }, steps: [], ...overrides,
  };
}

function records(docs: Record<string, Record<string, unknown>> = {}) {
  return createDocumentFixtureStore(new Map(Object.entries({
    "config/orchestrator": { defaultGatewayId: "shared-0" },
    "gateways/shared-0": gatewayRoot("shared-0"),
    "gateways/shared-0/releases/2": release("shared-0", 2),
    ...docs,
  })));
}

describe("release convergence records", () => {
  it("projects gateways, rollouts, the default runtime and its assignments", async () => {
    const store = records({
      "gateways/shared-1": gatewayRoot("shared-1", { desiredStatus: "paused", desiredRelease: 1, latestRelease: 1, liveRelease: null }),
      "gateways/shared-0/assignments/u1": assignment("u1", "alice", "serving"),
      "gateways/shared-0/assignments/u2": assignment("u2", "bob", "migrating"),
      "glmGateways/shared-0": {
        docKind: "runtime", gatewayId: "shared-0", release: 1, lifecycle: "serving",
        helm: { releaseName: "gw-shared-0", deploymentName: "octogee-gateway-shared-0-blue" },
        heartbeat: { status: "ready", version: payload.imageTag, lastHeartbeatAt: 5, mountedCustomers: ["alice"], migratingIn: [] },
      },
      "glmOperations/roll-1": rollout("shared-0", { status: "failed", error: "image pull failed" }),
      "glmOperations/roll-untagged": rollout("shared-0", { input: { gatewayId: "shared-0", targetRelease: 2 } }),
      "glmOperations/retire-1": { ...rollout("shared-1"), kind: "retire-gateway" },
    });

    const observed = await readReleaseConvergenceRecords(store);

    expect(observed.configuredDefaultGatewayId).toBe("shared-0");
    expect(observed.gateways).toEqual([
      { gatewayId: "shared-0", desiredStatus: "running", gatewayClass: "shared", desiredRelease: 2, liveRelease: 1, desiredImageTag: payload.imageTag },
      { gatewayId: "shared-1", desiredStatus: "paused", gatewayClass: "shared", desiredRelease: 1, liveRelease: null, desiredImageTag: null },
    ]);
    expect(observed.rolloutOperations).toEqual([
      { id: "roll-1", gatewayId: "shared-0", imageTag: payload.imageTag, status: "failed", error: "image pull failed" },
    ]);
    expect(observed.defaultRuntime).toEqual({
      gatewayId: "shared-0", release: 1, lifecycle: "serving", heartbeatStatus: "ready",
      heartbeatVersion: payload.imageTag, mountedCustomers: ["alice"],
    });
    expect(observed.defaultAssignments).toEqual(["alice", "bob"]);
    expect(observed.defaultAssignmentsServing).toBe(false);
    expect(observed.defaultDeploymentName).toBe("octogee-gateway-shared-0-blue");
  });

  it("names the conventional Deployment when the default gateway has no runtime record", async () => {
    const observed = await readReleaseConvergenceRecords(records());
    expect(observed.defaultRuntime).toBeNull();
    expect(observed.defaultAssignments).toEqual([]);
    expect(observed.defaultAssignmentsServing).toBe(true);
    expect(observed.defaultDeploymentName).toBe("octogee-gateway-shared-0");
  });

  it("skips a durable root whose configuration does not project", async () => {
    const observed = await readReleaseConvergenceRecords(records({ "gateways/old": gatewayRoot("old", { configSchemaVersion: 0 }) }));
    expect(observed.gateways.map((gateway) => gateway.gatewayId)).toEqual(["shared-0"]);
  });

  it("refuses a missing default gateway", async () => {
    await expect(readReleaseConvergenceRecords(records({ "config/orchestrator": {} }))).rejects.toThrow("defaultGatewayId is missing or invalid");
  });

  it("fails closed on a stored root that is not a durable gateway root", async () => {
    await expect(readReleaseConvergenceRecords(records({ "gateways/broken": { gatewayId: "broken" } }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails closed on a desired release that stores another gateway's payload", async () => {
    await expect(readReleaseConvergenceRecords(records({ "gateways/shared-0/releases/2": release("shared-1", 2) }))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("fails closed on a malformed default-gateway assignment", async () => {
    await expect(readReleaseConvergenceRecords(records({ "gateways/shared-0/assignments/u1": { slug: "alice", state: "serving" } }))).rejects.toBeInstanceOf(MalformedRecordError);
  });
});
