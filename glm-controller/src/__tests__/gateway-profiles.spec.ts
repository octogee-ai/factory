import { describe, it, expect } from "vitest";
import {
  resolveGatewayImageRepository,
  GATEWAY_AR_BASE,
  PROFILE_IMAGE_NAME,
} from "../gateway-profiles";
import { buildInstancesMap, buildHelmTargetMap, diffInstancesMap } from "../reconcile-plan";
import type { GatewayDesiredState } from "../../../shared/types/glm";

const STD_REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function mkDesired(o: Partial<GatewayDesiredState>): GatewayDesiredState {
  return {
    gatewayId: "gw-x",
    instanceName: "x",
    imageRepository: STD_REPO,
    imageTag: "abc1234",
    desiredStatus: "running",
    createdBy: "ci:abc1234",
    ...o,
  };
}

describe("resolveGatewayImageRepository", () => {
  it("profile unset ⇒ the literal imageRepository (zero regression for the cattle fleet)", () => {
    expect(resolveGatewayImageRepository(mkDesired({}))).toBe(STD_REPO);
  });

  it("profile 'standard' ⇒ the literal imageRepository", () => {
    expect(resolveGatewayImageRepository(mkDesired({ profile: "standard" }))).toBe(STD_REPO);
  });

  it("profile 'operator' ⇒ derived operator image at GATEWAY_AR_BASE", () => {
    expect(resolveGatewayImageRepository(mkDesired({ profile: "operator" }))).toBe(
      `${GATEWAY_AR_BASE}/${PROFILE_IMAGE_NAME.operator}`,
    );
    expect(PROFILE_IMAGE_NAME.operator).toBe("octogee-gateway-operator");
  });
});

describe("Cowboy resolves profile in the helm maps (image name, NOT the tag)", () => {
  it("buildInstancesMap: operator profile → operator repo, tag unchanged (fleet SHA)", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "bender", gatewayId: "gw-bender", profile: "operator" }),
    ]);
    expect(map.bender.image.repository).toBe(
      `${GATEWAY_AR_BASE}/octogee-gateway-operator`,
    );
    expect(map.bender.image.tag).toBe("abc1234");
  });

  it("buildInstancesMap: no profile → repo is byte-unchanged (regression guard)", () => {
    const map = buildInstancesMap([mkDesired({ instanceName: "default" })]);
    expect(map.default.image.repository).toBe(STD_REPO);
  });

  it("buildHelmTargetMap: operator profile resolves the same way", () => {
    const map = buildHelmTargetMap([
      mkDesired({ instanceName: "bender", gatewayId: "gw-bender", profile: "operator" }),
    ], {});
    expect(map.bender.image.repository).toBe(
      `${GATEWAY_AR_BASE}/octogee-gateway-operator`,
    );
  });

  it("changing profile is a reconcile `update` (Cowboy rolls the instance onto the profile image)", () => {
    const actual = buildInstancesMap([mkDesired({ instanceName: "bender", gatewayId: "gw-bender" })]);
    const desired = buildInstancesMap([
      mkDesired({ instanceName: "bender", gatewayId: "gw-bender", profile: "operator" }),
    ]);
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual([
      { kind: "update", instanceName: "bender", from: actual.bender, to: desired.bender },
    ]);
  });
});
