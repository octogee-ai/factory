import { describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { refineGatewayConvergenceAction } from "../index.js";
import type { DurableGateway } from "../converge-gateway.js";
import { decideRollStateMigration } from "../roll-state-migration.js";

const unchangedOpenclaw = decideRollStateMigration({
  sourceOpenclawVersion: "2026.7.1",
  targetOpenclawVersion: "2026.7.1",
});

const repository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const builderRepository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder";

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
    builderAccess: null,
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

function runtime(version: string, openclawVersion?: string): GatewayRuntimeDoc {
  return {
    heartbeat: {
      status: "ready",
      version,
      ...(openclawVersion === undefined ? {} : { openclawVersion }),
    },
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
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
    expect(reconcileSurgeHandoff).toHaveBeenCalledWith({
      gatewayId: "bender",
      desiredImageTag: "def5678-oc2026.7.1",
      requiresCustomerMigration: true,
      ownerlessOperatorPrewarm: false,
      stateMigration: unchangedOpenclaw,
    });

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
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

  it("restores a resumed same-release runtime to serving", async () => {
    const resumedGateway = { ...gateway(), liveRelease: 2 };
    const resumedRuntime = {
      ...runtime("def5678-oc2026.7.1"),
      lifecycle: "provisioning",
      release: 2,
    } as GatewayRuntimeDoc;

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(vi.fn(async () => ({ ready: true })), resumedGateway),
      gateway: resumedGateway,
      artifact,
      runtime: resumedRuntime,
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
  });

  it("finishes an in-flight release after autoscaling marks the gateway draining", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));
    const drainingGateway = { ...gateway(), desiredStatus: "draining" as const };

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, drainingGateway),
      gateway: drainingGateway,
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "bender",
      requiresCustomerMigration: true,
    }));
  });

  it("does not start a new handoff for a fully converged draining gateway", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));
    const drainingGateway = {
      ...gateway(),
      desiredStatus: "draining" as const,
      liveRelease: 2,
    };

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, drainingGateway),
      gateway: drainingGateway,
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    expect(reconcileSurgeHandoff).not.toHaveBeenCalled();
  });

  it("uses the Builder image receipt for Builder gateway handoff and readiness", async () => {
    const standardImageTag = `def5678-oc2026.7.1@sha256:${"a".repeat(64)}`;
    const builderImageTag = `def5678-oc2026.7.1@sha256:${"b".repeat(64)}`;
    const builderGateway = {
      ...gateway(),
      gatewayClass: "builder" as const,
      profile: "builder" as const,
      imageProfile: "builder" as const,
      ownerUid: "uid-bender",
      builderSlug: "bender",
    };
    const builderArtifact: ReleasePayload = {
      ...artifact,
      imageTag: standardImageTag,
      profileImages: {
        builder: {
          imageRepository: builderRepository,
          imageTag: builderImageTag,
        },
      },
    };
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff, builderGateway),
      gateway: builderGateway,
      artifact: builderArtifact,
      runtime: runtime(builderImageTag, "2026.7.1"),
      helmObserved: {
        imageRepository: builderRepository,
        imageTag: builderImageTag,
        replicas: 1,
        ownerUid: "uid-bender",
        builderSlug: "bender",
      },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith({
      gatewayId: "bender",
      desiredImageTag: builderImageTag,
      requiresCustomerMigration: true,
      ownerlessOperatorPrewarm: false,
      stateMigration: unchangedOpenclaw,
    });
  });

  it("skips state migration when the release changes the openclaw version", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: false }));
    const upgrade: ReleasePayload = { ...artifact, imageTag: "8886d40-oc2026.7.2-beta.7" };

    await refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact: upgrade,
      runtime: runtime("def5678-oc2026.7.1", "2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: upgrade.imageTag, replicas: 1 },
      action: { kind: "steady" },
    });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
      stateMigration: decideRollStateMigration({
        sourceOpenclawVersion: "2026.7.1",
        targetOpenclawVersion: "2026.7.2-beta.7",
      }),
    }));
  });

  it("skips state migration when the live gateway reports no openclaw version", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: false }));

    await refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678-oc2026.7.1"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
      stateMigration: expect.objectContaining({
        strategy: "provision-fresh",
        sourceOpenclawVersion: null,
        targetOpenclawVersion: "2026.7.1",
      }),
    }));
  });

  it("reads the source version from the runtime config status the pod reports", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: false }));
    const configured = {
      heartbeat: {
        status: "ready",
        version: "def5678-oc2026.7.1",
        openclawVersion: "unknown",
        configStatus: { openclawVersion: "2026.7.1" },
      },
    } as GatewayRuntimeDoc;

    await refineGatewayConvergenceAction({
      passDeps: passDeps(reconcileSurgeHandoff),
      gateway: gateway(),
      artifact,
      runtime: configured,
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    });

    expect(reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({
      stateMigration: unchangedOpenclaw,
    }));
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
