import { describe, expect, it } from "vitest";
import { isReleasePayload } from "@octogee/shared/types/gateway-releases";
import {
  platformGatewayArtifactFromEnvironment,
  sharedPoolReplicaBoundsFromEnvironment,
} from "../platform-release.js";

const REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee";
const env = {
  PLATFORM_GATEWAY_IMAGE_REPOSITORY: `${REPOSITORY}/octogee-gateway`,
  PLATFORM_GATEWAY_IMAGE_TAG: `a0180aa@sha256:${"a".repeat(64)}`,
  PLATFORM_GATEWAY_BUILDER_IMAGE_TAG: `a0180aa@sha256:${"b".repeat(64)}`,
  PLATFORM_GATEWAY_EDGE_IMAGE_REPOSITORY: `${REPOSITORY}/gateway-edge`,
  PLATFORM_GATEWAY_EDGE_IMAGE_TAG: `a0180aa@sha256:${"c".repeat(64)}`,
};

describe("platformGatewayArtifactFromEnvironment", () => {
  it("builds a complete release payload including the Builder image disposable allocations need", () => {
    const artifact = platformGatewayArtifactFromEnvironment(env);
    expect(artifact).toEqual({
      imageRepository: `${REPOSITORY}/octogee-gateway`,
      imageTag: env.PLATFORM_GATEWAY_IMAGE_TAG,
      profileImages: {
        builder: {
          imageRepository: `${REPOSITORY}/octogee-gateway-builder`,
          imageTag: env.PLATFORM_GATEWAY_BUILDER_IMAGE_TAG,
        },
      },
      gatewayEdgeImage: {
        imageRepository: `${REPOSITORY}/gateway-edge`,
        imageTag: env.PLATFORM_GATEWAY_EDGE_IMAGE_TAG,
      },
    });
    expect(isReleasePayload(artifact)).toBe(true);
  });

  it("carries the OpenClaw fork sha only when it is a full commit", () => {
    expect(platformGatewayArtifactFromEnvironment({ ...env, OPENCLAW_FORK_SHA: "f".repeat(40) }))
      .toMatchObject({ openclawSourceSha: "f".repeat(40) });
    expect(platformGatewayArtifactFromEnvironment({ ...env, OPENCLAW_FORK_SHA: "n/a" }))
      .not.toHaveProperty("openclawSourceSha");
  });

  it.each([
    ["PLATFORM_GATEWAY_IMAGE_TAG", "latest"],
    ["PLATFORM_GATEWAY_BUILDER_IMAGE_TAG", ""],
    ["PLATFORM_GATEWAY_BUILDER_IMAGE_TAG", `other12@sha256:${"b".repeat(64)}`],
    ["PLATFORM_GATEWAY_EDGE_IMAGE_TAG", `a0180aa@sha256:${"c".repeat(63)}`],
    ["PLATFORM_GATEWAY_EDGE_IMAGE_REPOSITORY", `${REPOSITORY}/octogee-api`],
  ])("fails closed when %s is %j", (name, value) => {
    expect(() => platformGatewayArtifactFromEnvironment({ ...env, [name]: value })).toThrow();
  });
});

describe("sharedPoolReplicaBoundsFromEnvironment", () => {
  it("parses the environment floor and ceiling and rejects an inverted pair", () => {
    expect(sharedPoolReplicaBoundsFromEnvironment({
      SHARED_POOL_MIN_REPLICAS: "0",
      SHARED_POOL_MAX_REPLICAS: "8",
    })).toEqual({ minReplicas: 0, maxReplicas: 8 });
    expect(() => sharedPoolReplicaBoundsFromEnvironment({
      SHARED_POOL_MIN_REPLICAS: "3",
      SHARED_POOL_MAX_REPLICAS: "2",
    })).toThrow("SHARED_POOL_MIN_REPLICAS");
  });
});
