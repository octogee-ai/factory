import { describe, it, expect } from "vitest";
import {
  releasePayloadHash,
  upgradeReleasePayloadSchema,
  isReleasePayload,
  dualReadIsolatedProfileImage,
  classifyGatewayField,
  isGatewayRuntimeDoc,
  isGatewayDesiredDoc,
  gatewayEdgeServiceName,
  gatewayPodServiceName,
  helmReleaseNameForGateway,
  RELEASE_FIELDS,
  GATEWAY_MUTABLE_FIELDS,
  isAssignmentState,
  type AssignmentDoc,
  type ReleasePayload,
} from "./gateway-releases";

describe("glmGateways doc-kind discriminators", () => {
  const runtimeDoc = {
    docKind: "runtime",
    gatewayId: "default",
    release: 3,
    lifecycle: "provisioning",
  };
  const legacyDesiredDoc = {
    gatewayId: "default",
    imageRepository: "repo",
    imageTag: "abc",
    desiredStatus: "running",
  };
  const gatewayDoc = {
    gatewayId: "default",
    latestRelease: 2,
    desiredRelease: 2,
    desiredStatus: "running",
  };

  it("isGatewayRuntimeDoc: only the runtime doc, by explicit docKind", () => {
    expect(isGatewayRuntimeDoc(runtimeDoc)).toBe(true);
    expect(isGatewayRuntimeDoc(legacyDesiredDoc)).toBe(false);
    expect(isGatewayRuntimeDoc(gatewayDoc)).toBe(false);
    expect(isGatewayRuntimeDoc({ ...runtimeDoc, docKind: "revision" })).toBe(false);
    expect(isGatewayRuntimeDoc(null)).toBe(false);
  });

  it("isGatewayDesiredDoc: only the GatewayDoc, never a legacy desired or runtime doc", () => {
    expect(isGatewayDesiredDoc(gatewayDoc)).toBe(true);
    expect(isGatewayDesiredDoc({ ...gatewayDoc, desiredStatus: "draining" })).toBe(true);
    expect(isGatewayDesiredDoc(legacyDesiredDoc)).toBe(false);
    expect(isGatewayDesiredDoc(runtimeDoc)).toBe(false);
    expect(isGatewayDesiredDoc(null)).toBe(false);
  });

  it("classifies desiredStatus as a mutable durable gateway field", () => {
    expect(GATEWAY_MUTABLE_FIELDS).toContain("desiredStatus");
    expect(classifyGatewayField("desiredStatus")).toBe("gateway-mutable");
  });
});

function samplePayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "abc1234",
    ...overrides,
  };
}

describe("isReleasePayload", () => {
  it("accepts the artifact schema and rejects mutable policy or credential state", () => {
    expect(isReleasePayload(samplePayload())).toBe(true);
    expect(isReleasePayload(samplePayload({ openclawSourceSha: "a".repeat(40) }))).toBe(true);
    expect(isReleasePayload({ ...samplePayload(), openclawSourceSha: "aaaaaaa" })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(), gatewayClass: "shared" })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(), byosub: { stale: true } })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(), coOwnerUids: [] })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(), imageTag: "latest" })).toBe(false);
  });

  it("accepts a separately digest-pinned gateway-edge image only from the paired package", () => {
    const payload = samplePayload({
      imageTag: `abc1234@sha256:${"a".repeat(64)}`,
      gatewayEdgeImage: {
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
        imageTag: `abc1234@sha256:${"b".repeat(64)}`,
      },
    });

    expect(isReleasePayload(payload)).toBe(true);
    expect(isReleasePayload({
      ...payload,
      gatewayEdgeImage: {
        ...payload.gatewayEdgeImage!,
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      },
    })).toBe(false);
  });

  it("accepts an isolated profile image only from its paired package and release tag", () => {
    const payload = samplePayload({
      imageTag: `abc1234@sha256:${"a".repeat(64)}`,
      profileImages: {
        builder: {
          imageRepository:
            "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder",
          imageTag: `abc1234@sha256:${"c".repeat(64)}`,
        },
      },
    });

    expect(isReleasePayload(payload)).toBe(true);
    expect(isReleasePayload({
      ...payload,
      profileImages: {
        builder: {
          ...payload.profileImages!.builder,
          imageRepository:
            "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        },
      },
    })).toBe(false);
    expect(isReleasePayload({
      ...payload,
      profileImages: {
        builder: {
          ...payload.profileImages!.builder,
          imageTag: `def5678@sha256:${"c".repeat(64)}`,
        },
      },
    })).toBe(false);
  });

  it("reads an isolated profile image under the isolated key the same as under builder", () => {
    const image = {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder",
      imageTag: `abc1234@sha256:${"c".repeat(64)}`,
    };
    const base = { imageTag: `abc1234@sha256:${"a".repeat(64)}` };
    for (const profileImages of [{ builder: image }, { isolated: image }]) {
      const payload = samplePayload({ ...base, profileImages });
      expect(isReleasePayload(payload)).toBe(true);
      expect(dualReadIsolatedProfileImage(payload.profileImages!)).toEqual(image);
    }
    expect(isReleasePayload({ ...samplePayload(base), profileImages: { builder: image, isolated: image } })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(base), profileImages: { operator: image } })).toBe(false);
  });

});

describe("stable-name helpers (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  it("names the Helm release by the bare gateway id", () => {
    expect(helmReleaseNameForGateway("default")).toBe("octogee-gw-default");
    expect(helmReleaseNameForGateway("walter")).toBe("octogee-gw-walter");
  });

  it("names the gateway-edge Service by the bare gateway id", () => {
    expect(gatewayEdgeServiceName("default")).toBe("gateway-edge-default");
  });

  it("names the gateway pod Service (preview surface) by the bare gateway id", () => {
    expect(gatewayPodServiceName("default")).toBe("octogee-gateway-default");
  });
});

describe("releasePayloadHash", () => {
  it("is deterministic regardless of key insertion order", () => {
    const a = samplePayload();
    const b: ReleasePayload = {
      imageTag: "abc1234",
      imageRepository:
        "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    };
    expect(releasePayloadHash(a)).toBe(releasePayloadHash(b));
  });

  it("changes when any payload value changes", () => {
    const base = releasePayloadHash(samplePayload());
    expect(releasePayloadHash(samplePayload({ imageTag: "def5678" }))).not.toBe(base);
  });
});

describe("upgradeReleasePayloadSchema", () => {
  it("removes the one retired Mac field and returns the replacement hash", () => {
    const legacyPayload = {
      ...samplePayload(),
      macOpsTokenProtocol: { version: 1 },
    };

    expect(upgradeReleasePayloadSchema(legacyPayload, releasePayloadHash(legacyPayload as never)))
      .toEqual({
        status: "upgraded",
        migration: "remove-retired-mac-ops-token-protocol",
        payload: samplePayload(),
        payloadHash: releasePayloadHash(samplePayload()),
      });
  });

  it("accepts a current payload only when its persisted hash matches", () => {
    const payload = samplePayload();

    expect(upgradeReleasePayloadSchema(payload, releasePayloadHash(payload))).toEqual({
      status: "current",
      payload,
      payloadHash: releasePayloadHash(payload),
    });
    expect(upgradeReleasePayloadSchema(payload, "0".repeat(64))).toEqual({
      status: "unsupported",
      reason: "payload-hash-mismatch",
    });
  });

  it("refuses unknown fields and a tampered legacy payload", () => {
    const unknown = { ...samplePayload(), futureField: true };
    const legacy = { ...samplePayload(), macOpsTokenProtocol: true };

    expect(upgradeReleasePayloadSchema(unknown, releasePayloadHash(unknown as never))).toEqual({
      status: "unsupported",
      reason: "unsupported-payload-schema",
    });
    expect(upgradeReleasePayloadSchema(legacy, "0".repeat(64))).toEqual({
      status: "unsupported",
      reason: "payload-hash-mismatch",
    });
  });
});

describe("classifyGatewayField", () => {
  it("classifies an unknown/new field as release-audited (conservative default)", () => {
    expect(classifyGatewayField("someFieldWeHaveNeverSeen")).toBe("release");
    expect(classifyGatewayField("futureRuntimeKnob")).toBe("release");
  });

  it("classifies every spec release field as release-audited", () => {
    for (const field of RELEASE_FIELDS) {
      expect(classifyGatewayField(field)).toBe("release");
    }
  });

  it("classifies gateway-doc fields mutable without a release as gateway-mutable", () => {
    for (const field of GATEWAY_MUTABLE_FIELDS) {
      expect(classifyGatewayField(field)).toBe("gateway-mutable");
    }
  });

  it("classifies every gateway-doc lifecycle field from the spec as gateway-mutable", () => {
    for (const field of [
      "desiredStatus",
      "liveRelease",
      "retireAfter",
    ]) {
      expect(classifyGatewayField(field)).toBe("gateway-mutable");
    }
  });

  it("no longer classifies the retired computeClass as gateway-mutable", () => {
    expect(GATEWAY_MUTABLE_FIELDS).not.toContain("computeClass");
    expect(classifyGatewayField("computeClass")).toBe("release");
  });

  it("no longer classifies retired idle-sleep state as gateway-mutable", () => {
    expect(GATEWAY_MUTABLE_FIELDS).not.toContain("idleSleep");
    expect(classifyGatewayField("idleSleep")).toBe("release");
  });

  it("classifies all former release policy fields as gateway-mutable", () => {
    expect(classifyGatewayField("builderAccess")).toBe("gateway-mutable");
    expect(classifyGatewayField("allocation")).toBe("gateway-mutable");
  });
});

describe("assignment roster state + epoch (migration plane)", () => {
  it("isAssignmentState accepts exactly serving|quiescing|migrating", () => {
    expect(isAssignmentState("serving")).toBe(true);
    expect(isAssignmentState("quiescing")).toBe(true);
    expect(isAssignmentState("migrating")).toBe(true);
    expect(isAssignmentState("draining")).toBe(false);
    expect(isAssignmentState("")).toBe(false);
    expect(isAssignmentState(null)).toBe(false);
  });

  it("AssignmentDoc carries state + epoch, keyed on the bare gateway", () => {
    const doc: AssignmentDoc = {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      source: "migrate-user",
      state: "serving",
      epoch: 3,
      updatedAt: 1,
      updatedByOperationId: null,
    };
    expect(doc.state).toBe("serving");
    expect(doc.epoch).toBe(3);
  });
});
