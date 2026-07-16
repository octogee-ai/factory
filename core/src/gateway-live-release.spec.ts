import { describe, expect, it } from "vitest";
import {
  mergeGatewayConfigWithArtifact,
  isBareGatewayId,
  isGatewayMutableConfig,
  isGatewayMutableConfigForGateway,
  gatewayAuthorizationFromRootDocument,
  gatewayRevisionIdFromPodName,
  readGatewayArtifact,
  readGatewayAuthorization,
  readGatewayLiveRevisionHeartbeat,
  readRevisionGatewayAuthorization,
  readServingGatewayAuthorization,
  type GatewayMutableConfig,
} from "./gateway-live-release.js";

describe("gatewayRevisionIdFromPodName", () => {
  it("derives the exact revision from a generated gateway pod name", () => {
    expect(
      gatewayRevisionIdFromPodName(
        "bender",
        "octogee-gateway-bender-r12-5bc5949d46-p946t",
      ),
    ).toBe("bender-r12");
  });

  it("rejects another gateway, a bare revision name, and non-canonical releases", () => {
    expect(
      gatewayRevisionIdFromPodName(
        "bender",
        "octogee-gateway-other-r12-5bc5949d46-p946t",
      ),
    ).toBeNull();
    expect(gatewayRevisionIdFromPodName("bender", "octogee-gateway-bender-r12")).toBeNull();
    expect(
      gatewayRevisionIdFromPodName(
        "bender",
        "octogee-gateway-bender-r012-5bc5949d46-p946t",
      ),
    ).toBeNull();
  });
});

type Docs = Record<string, Record<string, unknown>>;

function database(docs: Docs) {
  return {
    doc(path: string) {
      const data = docs[path];
      return {
        get: async () => ({
          exists: data !== undefined,
          data: () => data,
        }),
      };
    },
  };
}

function mutableConfig(
  overrides: Partial<GatewayMutableConfig> = {},
): GatewayMutableConfig {
  return {
    configSchemaVersion: 1,
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: "small",
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: { shellsEnabled: true },
    ownerUid: "uid-ceckert",
    coOwnerUids: [],
    builderSlug: "ceckert",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function durableGateway(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "bender",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 2,
    liveRevisionId: "bender-r2",
    desiredStatus: "running",
    ...mutableConfig(),
    ...overrides,
  };
}

function servingRevision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docKind: "revision",
    revisionId: "bender-r2",
    gateway: "bender",
    release: 2,
    lifecycle: "serving",
    heartbeat: { status: "ready" },
    ...overrides,
  };
}

describe("gateway durable configuration authorization", () => {
  it("authorizes a durable root document without issuing a second Firestore read", () => {
    expect(gatewayAuthorizationFromRootDocument(durableGateway(), "bender")).toMatchObject({
      kind: "durable",
      gateway: { gatewayId: "bender" },
      config: { ownerUid: "uid-ceckert" },
    });
    expect(gatewayAuthorizationFromRootDocument(durableGateway(), "other")).toBeNull();
  });

  it("rejects revision-shaped ids before attempting a durable root read", async () => {
    let reads = 0;
    const db = {
      doc() {
        reads += 1;
        throw new Error("revision ids must not reach Firestore");
      },
    };

    expect(isBareGatewayId("bender")).toBe(true);
    expect(isBareGatewayId("bender-r2")).toBe(false);
    await expect(readGatewayAuthorization(db as never, "bender-r2")).resolves.toBeNull();
    expect(reads).toBe(0);
  });

  it("uses root mutable configuration instead of stale bare glm gateway config", async () => {
    const docs: Docs = {
      "gateways/bender": durableGateway(),
      "gateways/bender/releases/2": {
        gatewayId: "bender",
        release: 2,
        payload: {
          gatewayClass: "shared",
          ownerUid: "uid-someone-else",
          operatorAccess: { shellsEnabled: false },
        },
      },
      "glmGateways/bender-r2": servingRevision(),
      "glmGateways/bender": {
        gatewayId: "bender",
        ownerUid: "uid-ceckert",
        gatewayClass: "shared",
        profile: "standard",
        operatorAccess: { shellsEnabled: false },
      },
    };

    await expect(readGatewayAuthorization(database(docs) as never, "bender")).resolves.toMatchObject({
      kind: "durable",
      config: {
        gatewayClass: "operator",
        ownerUid: "uid-ceckert",
        operatorAccess: { shellsEnabled: true },
      },
    });
    await expect(readServingGatewayAuthorization(database(docs) as never, "bender")).resolves.toMatchObject({
      kind: "durable",
      config: { gatewayClass: "operator" },
    });
  });

  it("uses root configuration while service authorization remains pinned to the serving live revision", async () => {
    const docs: Docs = {
      "gateways/bender": durableGateway({
        roll: { acceptingNewAssignments: true, targetRevisionId: "bender-r3", toRelease: 3 },
      }),
      "glmGateways/bender-r2": servingRevision(),
      "glmGateways/bender-r3": servingRevision({
        revisionId: "bender-r3",
        release: 3,
        lifecycle: "warming",
      }),
    };

    await expect(readServingGatewayAuthorization(database(docs) as never, "bender")).resolves.toMatchObject({
      kind: "durable",
      config: { gatewayClass: "operator" },
    });
  });

  it("resolves an exact revision only when it is the durable live or roll-target revision", async () => {
    const docs: Docs = {
      "gateways/bender": durableGateway({
        roll: { acceptingNewAssignments: true, targetRevisionId: "bender-r3", toRelease: 3 },
      }),
      "glmGateways/bender-r2": servingRevision(),
      "glmGateways/bender-r3": servingRevision({
        revisionId: "bender-r3",
        release: 3,
        lifecycle: "warming",
      }),
    };

    await expect(
      readRevisionGatewayAuthorization(database(docs) as never, "bender", "bender-r3"),
    ).resolves.toMatchObject({
      kind: "durable",
      config: { gatewayClass: "operator" },
    });
    await expect(
      readRevisionGatewayAuthorization(database(docs) as never, "bender", "bender-r9"),
    ).resolves.toBeNull();
  });

  it("fails closed when a root points to a noncanonical live or roll revision id", async () => {
    const legacyLive = durableGateway({ liveRevisionId: "bender-blue", liveRelease: 2 });
    const liveDocs: Docs = {
      "gateways/bender": legacyLive,
      "glmGateways/bender-blue": servingRevision({ revisionId: "bender-blue", release: 2 }),
    };
    await expect(readGatewayLiveRevisionHeartbeat(database(liveDocs) as never, legacyLive as never)).resolves.toBeNull();
    await expect(readServingGatewayAuthorization(database(liveDocs) as never, "bender")).resolves.toBeNull();

    const legacyTargetDocs: Docs = {
      "gateways/bender": durableGateway({
        roll: { acceptingNewAssignments: true, targetRevisionId: "bender-green", toRelease: 3 },
      }),
      "glmGateways/bender-r2": servingRevision(),
      "glmGateways/bender-green": servingRevision({
        revisionId: "bender-green",
        release: 3,
        lifecycle: "warming",
      }),
    };
    await expect(
      readRevisionGatewayAuthorization(database(legacyTargetDocs) as never, "bender", "bender-green"),
    ).resolves.toBeNull();
  });

  it("fails closed instead of falling back to stale bare glm config before the root config marker exists", async () => {
    const docs: Docs = {
      "gateways/bender": durableGateway({ configSchemaVersion: undefined }),
      "glmGateways/bender": {
        gatewayId: "bender",
        ownerUid: "uid-ceckert",
        gatewayClass: "operator",
      },
    };

    await expect(readGatewayAuthorization(database(docs) as never, "bender")).resolves.toBeNull();
  });

  it("fails closed when no durable gateway exists instead of reading a bare glm config", async () => {
    const docs: Docs = {
      "glmGateways/bender": {
        gatewayId: "bender",
        ownerUid: "uid-ceckert",
        gatewayClass: "operator",
        operatorAccess: { shellsEnabled: true },
      },
    };

    await expect(readServingGatewayAuthorization(database(docs) as never, "bender")).resolves.toBeNull();
  });

  it("does not authorize a revision realization without a durable root", async () => {
    const docs: Docs = {
      "glmGateways/bender-r2": servingRevision({
        ownerUid: "uid-ceckert",
        gatewayClass: "operator",
      }),
    };

    await expect(readGatewayAuthorization(database(docs) as never, "bender-r2")).resolves.toBeNull();
  });

  it("does not revive stale legacy authority when a durable gateway doc is malformed", async () => {
    const docs: Docs = {
      "gateways/bender": { gatewayId: "bender", desiredStatus: "running" },
      "glmGateways/bender": {
        gatewayId: "bender",
        ownerUid: "uid-ceckert",
        gatewayClass: "operator",
        operatorAccess: { shellsEnabled: true },
      },
    };

    await expect(readGatewayAuthorization(database(docs) as never, "bender")).resolves.toBeNull();
  });

  it("rejects a durable live revision that is missing or not serving", async () => {
    const docs: Docs = {
      "gateways/bender": durableGateway(),
      "glmGateways/bender-r2": servingRevision({ lifecycle: "retired" }),
    };

    await expect(readServingGatewayAuthorization(database(docs) as never, "bender")).resolves.toBeNull();
  });

  it("merges only root mutable configuration with the selected immutable artifact", () => {
    const config = {
      ...mutableConfig(),
      imageTag: "stale-tag",
    } as unknown as GatewayMutableConfig;

    const rendered = mergeGatewayConfigWithArtifact(config, {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
      imageTag: "deadbee",
    });

    expect(rendered).toMatchObject({
      imageTag: "deadbee",
      gatewayClass: "operator",
      ownerUid: "uid-ceckert",
    });
    expect(rendered).not.toHaveProperty("configSchemaVersion");
  });

  it("rejects invalid mutable ownership, compute, and preemption values", () => {
    expect(isGatewayMutableConfig(mutableConfig({ ownerUid: null }))).toBe(false);
    expect(isGatewayMutableConfig(mutableConfig({ coOwnerUids: [""] }))).toBe(false);
    expect(isGatewayMutableConfig(mutableConfig({ computeClass: "" }))).toBe(false);
    expect(
      isGatewayMutableConfig(mutableConfig({ preemption: { warmTargetGatewayId: "" } })),
    ).toBe(false);
    expect(
      isGatewayMutableConfig(mutableConfig({ modelBrokerLimits: { spendWeekUsd: -1 } })),
    ).toBe(false);
    expect(isGatewayMutableConfig({ ...mutableConfig(), byosub: {} })).toBe(false);
    expect(
      isGatewayMutableConfigForGateway(
        mutableConfig({ serviceAccountName: "custom-operator-ksa" }),
        "bender",
      ),
    ).toBe(true);
    expect(
      isGatewayMutableConfigForGateway(
        mutableConfig({ serviceAccountName: "octogee-gw-bender" }),
        "bender",
      ),
    ).toBe(true);
    expect(
      isGatewayMutableConfigForGateway(
        mutableConfig({ serviceAccountName: "octogee-gateway-bender" }),
        "bender",
      ),
    ).toBe(true);
    expect(
      isGatewayMutableConfigForGateway(
        mutableConfig({ serviceAccountName: "octogee-gw-other" }),
        "bender",
      ),
    ).toBe(false);
    expect(
      isGatewayMutableConfigForGateway(
        mutableConfig({ serviceAccountName: "octogee-gateway-other" }),
        "bender",
      ),
    ).toBe(false);
    for (const reserved of ["octogee-api", "octogee-glm-controller", "octogee-cron", "octogee-gateway"]) {
      expect(
        isGatewayMutableConfigForGateway(mutableConfig({ serviceAccountName: reserved }), "bender"),
      ).toBe(false);
    }
    expect(
      isGatewayMutableConfigForGateway(
        mutableConfig({ serviceAccountName: "invalid_name" }),
        "bender",
      ),
    ).toBe(false);
    expect(
      isGatewayMutableConfigForGateway(mutableConfig({ serviceAccountName: "UPPER" }), "bender"),
    ).toBe(false);
    expect(
      isGatewayMutableConfig(mutableConfig({ serviceAccount: { create: "yes" } as never })),
    ).toBe(false);
    expect(
      isGatewayMutableConfig(
        mutableConfig({ operatorAccess: { kubeApiServerEgressCidrs: ["10.0.0.0/8", 1] } as never }),
      ),
    ).toBe(false);
  });

  it("reads an artifact-only selected release", async () => {
    const docs: Docs = {
      "gateways/bender/releases/2": {
        gatewayId: "bender",
        release: 2,
        payload: {
          imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
          imageTag: "deadbee",
        },
      },
    };

    await expect(readGatewayArtifact(database(docs) as never, "bender", 2)).resolves.toEqual({
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
      imageTag: "deadbee",
    });
  });

  it("preserves the paired W9 gateway-edge digest with the TEST candidate artifact", async () => {
    const gatewayTag = `agent-conversation-w9a-8c356bb1@sha256:${"a".repeat(64)}`;
    const gatewayEdgeImage = {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
      imageTag: `agent-conversation-w9a-8c356bb1@sha256:${"d".repeat(64)}`,
    };
    const testExperiment = {
      kind: "w9-agent-conversation",
      mode: "publisher-live",
      candidateManifest: {
        path: "infra/gateway/openclaw-candidates/agent-conversation.json",
        sha256: "b".repeat(64),
      },
      mattermostOverlay: {
        valuesPath: "infra/candidates/values.mattermost-silent-post.yaml",
        imageReference: `mattermostdevelopment/mattermost-team-edition:cce485f@sha256:${"c".repeat(64)}`,
      },
    };
    const docs: Docs = {
      "gateways/bender/releases/2": {
        gatewayId: "bender",
        release: 2,
        payload: {
          imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
          imageTag: gatewayTag,
          gatewayEdgeImage,
          testExperiment,
        },
      },
    };

    await expect(readGatewayArtifact(database(docs) as never, "bender", 2)).resolves.toMatchObject({
      imageTag: gatewayTag,
      gatewayEdgeImage,
      testExperiment,
    });
  });

  it("refuses a release payload that still carries mutable policy or credential state", async () => {
    const docs: Docs = {
      "gateways/bender/releases/2": {
        gatewayId: "bender",
        release: 2,
        payload: {
          imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
          imageTag: "deadbee",
          gatewayClass: "shared",
          byosub: { legacy: true },
        },
      },
    };

    await expect(readGatewayArtifact(database(docs) as never, "bender", 2)).resolves.toBeNull();
  });
  it("reads heartbeat telemetry only from the root's exact live revision", async () => {
    const docs: Docs = {
      "glmGateways/bender-r2": servingRevision({ heartbeat: { status: "ready" } }),
      "glmGateways/bender-r3": servingRevision({
        revisionId: "bender-r3",
        release: 3,
        heartbeat: { status: "stale" },
      }),
    };

    await expect(
      readGatewayLiveRevisionHeartbeat(
        database(docs) as never,
        durableGateway() as never,
      ),
    ).resolves.toEqual({ status: "ready" });
  });

  it("refuses a retired exact revision even when its stale heartbeat says ready", async () => {
    const docs: Docs = {
      "glmGateways/bender-r2": servingRevision({
        lifecycle: "retired",
        heartbeat: { status: "ready" },
      }),
    };

    await expect(
      readGatewayLiveRevisionHeartbeat(
        database(docs) as never,
        durableGateway() as never,
      ),
    ).resolves.toBeNull();
  });

  it("refuses a release payload that still carries credential state", async () => {
    const docs: Docs = {
      "gateways/bender/releases/2": {
        gatewayId: "bender",
        release: 2,
        payload: {
          imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
          imageTag: "deadbee",
          byosub: { legacy: true },
        },
      },
    };

    await expect(readGatewayArtifact(database(docs) as never, "bender", 2)).resolves.toBeNull();
  });
});
