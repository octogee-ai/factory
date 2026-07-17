import { describe, expect, it } from "vitest";
import {
  gatewayUpsertOptsFromRelease,
  planGatewayConvergence,
  provisioningRuntimeDoc,
  type DurableGateway,
} from "../converge-gateway.js";
import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function gateway(overrides: Partial<DurableGateway> = {}): DurableGateway {
  return {
    gatewayId: "bender",
    createdAt: 1,
    createdBy: "op",
    updatedAt: 1,
    updatedBy: "op",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  } as DurableGateway;
}

function artifact(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return { imageRepository: REPO, imageTag: "def5678", ...overrides };
}

describe("planGatewayConvergence", () => {
  it("upserts when no Helm release exists yet (first realization)", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: null, desiredRelease: 1 }),
        artifact: artifact(),
        helm: null,
        deploymentReady: false,
      }),
    ).toEqual({ kind: "upsert", replicas: 1 });
  });

  it("upserts on image drift — a roll is just desiredRelease drift applied in place", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway(),
        artifact: artifact({ imageTag: "def5678" }),
        helm: { imageRepository: REPO, imageTag: "abc1234", replicas: 1 },
        deploymentReady: true,
      }),
    ).toEqual({ kind: "upsert", replicas: 1 });
  });

  it("upserts replicas 0 for a paused gateway", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ desiredStatus: "paused" }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: true,
      }),
    ).toEqual({ kind: "upsert", replicas: 0 });
  });

  it("marks the desired release live once the deployment is ready at the desired image", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: 1, desiredRelease: 2 }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: true,
      }),
    ).toEqual({ kind: "mark-live" });
  });

  it("stays steady while converged, and while applied-but-not-ready", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: 2 }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: true,
      }),
    ).toEqual({ kind: "steady" });
    expect(
      planGatewayConvergence({
        gateway: gateway({ liveRelease: 1, desiredRelease: 2 }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: false,
      }),
    ).toEqual({ kind: "steady" });
  });

  it("uninstalls a retired gateway's release, then forgets it", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway({ desiredStatus: "retired" }),
        artifact: artifact(),
        helm: { imageRepository: REPO, imageTag: "def5678", replicas: 1 },
        deploymentReady: false,
      }),
    ).toEqual({ kind: "uninstall" });
    expect(
      planGatewayConvergence({
        gateway: gateway({ desiredStatus: "retired" }),
        artifact: null,
        helm: null,
        deploymentReady: false,
      }),
    ).toEqual({ kind: "steady" });
  });

  it("holds loudly when the desired release payload is unreadable", () => {
    expect(
      planGatewayConvergence({
        gateway: gateway(),
        artifact: null,
        helm: null,
        deploymentReady: false,
      }),
    ).toMatchObject({
      kind: "hold-missing-release",
      error: expect.stringContaining("gateways/bender/releases/2"),
    });
  });
});

describe("gatewayUpsertOptsFromRelease", () => {
  it("keys every name off the bare gatewayId and always requests surge rolls", () => {
    const opts = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway(),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });
    expect(opts).toMatchObject({
      gatewayId: "bender",
      imageRepository: REPO,
      imageTag: "def5678",
      serviceAccountName: "octogee-gw-bender",
      replicas: 1,
      rollStrategy: "surge",
    });
    expect(opts).not.toHaveProperty("revisionId");
  });

  it("resolves operator access for builder/operator classes from the owner", () => {
    const opts = gatewayUpsertOptsFromRelease({
      namespace: "octogee-test",
      gateway: gateway({
        gatewayClass: "operator",
        imageProfile: "operator",
        profile: "operator",
        ownerUid: "uid-ceckert",
        builderSlug: "ceckert",
      }),
      artifact: artifact(),
      replicas: 1,
      chartPath: "/charts/octogee-gateway",
    });
    expect(opts.gatewayClass).toBe("operator");
    expect(opts.operatorAccess).toBeDefined();
    expect(opts.builderSlug).toBe("ceckert");
  });

  it("refuses a W9 candidate image outside its TEST experiment contract", () => {
    expect(() =>
      gatewayUpsertOptsFromRelease({
        namespace: "octogee",
        gateway: gateway(),
        artifact: artifact({
          imageTag: `agent-conversation-w9a-8c356bb1@sha256:${"a".repeat(64)}`,
        }),
        replicas: 1,
        chartPath: "/charts/octogee-gateway",
      }),
    ).toThrow(/W9/);
  });
});

describe("provisioningRuntimeDoc", () => {
  it("creates a provisioning runtime doc keyed by the bare gatewayId", () => {
    const doc = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 2 }),
      artifact: artifact(),
      existing: null,
      now: 100,
    });
    expect(doc).toMatchObject({
      docKind: "runtime",
      gatewayId: "bender",
      release: 2,
      lifecycle: "provisioning",
      helm: {
        releaseName: "octogee-gw-bender",
        deploymentName: "octogee-gateway-bender",
        gatewayEdgeServiceName: "gateway-edge-bender",
        imageTag: "def5678",
        replicas: 1,
      },
    });
  });

  it("preserves lifecycle and heartbeat across a same-release re-apply, resets on a new release", () => {
    const existing = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 2 }),
      artifact: artifact(),
      existing: null,
      now: 100,
    });
    existing.lifecycle = "serving";
    existing.heartbeat.status = "ready";

    const sameRelease = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 2 }),
      artifact: artifact(),
      existing,
      now: 200,
    });
    expect(sameRelease.lifecycle).toBe("serving");
    expect(sameRelease.heartbeat.status).toBe("ready");
    expect(sameRelease.createdAt).toBe(100);

    const newRelease = provisioningRuntimeDoc({
      gateway: gateway({ desiredRelease: 3 }),
      artifact: artifact({ imageTag: "aaa1111" }),
      existing,
      now: 300,
    });
    expect(newRelease.lifecycle).toBe("provisioning");
    expect(newRelease.release).toBe(3);
  });
});
