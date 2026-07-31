import { describe, expect, it, vi } from "vitest";
import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { GatewayRuntimeDoc } from "@octogee/shared/types/gateway-runtime";
import { refineGatewayConvergenceAction } from "../index.js";
import type { DurableGateway } from "../converge-gateway.js";

const repository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const operatorRepository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-operator";

function gateway(): DurableGateway {
  return {
    gatewayId: "bender",
    latestRelease: 2,
    desiredStatus: "running",
    desiredRelease: 2,
    liveRelease: 1,
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  } as DurableGateway;
}

const artifact: ReleasePayload = {
  imageRepository: repository,
  imageTag: "def5678-oc2026.7.1",
};

function runtime(version: string): GatewayRuntimeDoc {
  return {
    heartbeat: { status: "ready", version },
  } as GatewayRuntimeDoc;
}

function passDeps(
  reconcileSurgeHandoff: () => Promise<{ ready: boolean }>,
  current = gateway(),
) {
  return {
    db: {
      collection: () => ({
        doc: () => ({ get: async () => ({ exists: true, data: () => current }) }),
      }),
    } as never,
    reconcileSurgeHandoff,
  };
}

describe("gateway convergence surge wiring", () => {
  it("marks a release live only after handoff and the desired-build heartbeat agree", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
    expect(reconcileSurgeHandoff).toHaveBeenCalledWith({
      gatewayId: "bender",
      desiredImageTag: "def5678-oc2026.7.1",
      requiresCustomerMigration: true,
      ownerlessOperatorPrewarm: false,
    });

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    reconcileSurgeHandoff.mockResolvedValueOnce({ ready: false });
    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("old-build"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });
  });

  it("uses the operator image receipt for operator gateway handoff and readiness", async () => {
    const standardImageTag = `def5678-oc2026.7.1@sha256:${"a".repeat(64)}`;
    const operatorImageTag = `def5678-oc2026.7.1@sha256:${"b".repeat(64)}`;
    const operatorGateway = {
      ...gateway(),
      gatewayClass: "operator" as const,
      profile: "operator" as const,
      imageProfile: "operator" as const,
      ownerUid: "uid-bender",
      builderSlug: "bender",
    };
    const operatorArtifact: ReleasePayload = {
      ...artifact,
      imageTag: standardImageTag,
      profileImages: {
        operator: {
          imageRepository: operatorRepository,
          imageTag: operatorImageTag,
        },
      },
    };
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, operatorGateway),
      gateway: operatorGateway,
      artifact: operatorArtifact,
      runtime: runtime(operatorImageTag),
      helmObserved: {
        imageRepository: operatorRepository,
        imageTag: operatorImageTag,
        replicas: 1,
        ownerUid: "uid-bender",
        builderSlug: "bender",
      },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith({
      gatewayId: "bender",
      desiredImageTag: operatorImageTag,
      requiresCustomerMigration: true,
      ownerlessOperatorPrewarm: false,
    });
  });

  it("requires Spot target admission only while a capacity rebalance is active", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: false }));
    const rebalancing = {
      ...gateway(),
      capacityRebalanceNonce: "capacity-rebalance-bender-1",
      capacityRebalance: {
        nonce: "capacity-rebalance-bender-1",
        active: true,
        operationId: "capacity-rebalance-bender-1",
        previousNonce: null,
        sourcePodUids: ["old-pod"],
        requestedAt: 1,
      },
    };

    await refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, rebalancing),
      gateway: rebalancing,
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith({
      gatewayId: "bender",
      desiredImageTag: "def5678-oc2026.7.1",
      requiresCustomerMigration: true,
      ownerlessOperatorPrewarm: false,
      requiredTargetCapacity: "spot",
    });
  });

  it("does not mark a qualified release live from an ambiguous legacy SHA heartbeat", async () => {
    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(vi.fn(async () => ({ ready: true }))),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
  })).resolves.toEqual({ kind: "steady" });
  });

  it("does not invoke surge handoff reconciliation for an operator-managed gateway", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: { ...gateway(), managedBy: "operator" },
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    expect(reconcileSurgeHandoff).not.toHaveBeenCalled();
  });

  it("rechecks durable ownership before surge handoff work after the convergence snapshot", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, { ...gateway(), managedBy: "operator" }),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    expect(reconcileSurgeHandoff).not.toHaveBeenCalled();
  });

});
