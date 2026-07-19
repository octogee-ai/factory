import { describe, expect, it, vi } from "vitest";
import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { GatewayRuntimeDoc } from "@octogee/shared/types/gateway-runtime";
import { refineGatewayConvergenceAction } from "../index.js";
import type { DurableGateway } from "../converge-gateway.js";

const repository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function gateway(): DurableGateway {
  return {
    gatewayId: "bender",
    desiredStatus: "running",
    desiredRelease: 2,
    liveRelease: 1,
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

describe("gateway convergence surge wiring", () => {
  it("marks a release live only after handoff and the desired-build heartbeat agree", async () => {
    const reconcileSurgeHandoff = vi.fn(async () => ({ ready: true }));

    await expect(refineGatewayConvergenceAction({
      passDeps: { reconcileSurgeHandoff },
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
    });

    reconcileSurgeHandoff.mockResolvedValueOnce({ ready: false });
    await expect(refineGatewayConvergenceAction({
      passDeps: { reconcileSurgeHandoff },
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });

    await expect(refineGatewayConvergenceAction({
      passDeps: { reconcileSurgeHandoff },
      gateway: gateway(),
      artifact,
      runtime: runtime("old-build"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "steady" });
  });

  it("keeps accepting a legacy build-SHA heartbeat after the surge handoff", async () => {
    await expect(refineGatewayConvergenceAction({
      passDeps: { reconcileSurgeHandoff: vi.fn(async () => ({ ready: true })) },
      gateway: gateway(),
      artifact,
      runtime: runtime("def5678"),
      helmObserved: { imageRepository: repository, imageTag: artifact.imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
  });
});
