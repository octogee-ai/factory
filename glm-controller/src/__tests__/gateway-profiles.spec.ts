import { describe, it, expect } from "vitest";
import { resolveGatewayImageRepository, PROFILE_IMAGE_NAME } from "../gateway-profiles";
import { buildInstancesMap, buildHelmTargetMap, diffInstancesMap } from "../reconcile-plan";
import type { GatewayDesiredState } from "@octogee/shared/types/glm";

const STD_REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const OPERATOR_REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-operator";

function mkDesired(o: Partial<GatewayDesiredState>): GatewayDesiredState {
  return {
    gatewayId: "x",
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

  it("profile 'operator' ⇒ profile image at the SAME registry/project (derived, not hardcoded)", () => {
    expect(resolveGatewayImageRepository(mkDesired({ profile: "operator" }))).toBe(OPERATOR_REPO);
    expect(PROFILE_IMAGE_NAME.operator).toBe("octogee-gateway-operator");
  });

  it("derivation follows the instance's own registry — no hardcoded AR host/project", () => {

expect(
      resolveGatewayImageRepository(
        mkDesired({ profile: "operator", imageRepository: "europe-docker.pkg.dev/acme/reg/octogee-gateway" }),
      ),
    ).toBe("europe-docker.pkg.dev/acme/reg/octogee-gateway-operator");
  });
});

describe("Cowboy resolves profile in the helm maps (image name, NOT the tag)", () => {
  it("buildInstancesMap: operator profile → operator repo, tag unchanged (fleet SHA)", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "bender", profile: "operator" }),
    ]);
    expect(map.bender.image.repository).toBe(OPERATOR_REPO);
    expect(map.bender.image.tag).toBe("abc1234");
  });

  it("buildInstancesMap: no profile → repo is byte-unchanged (regression guard)", () => {
    const map = buildInstancesMap([mkDesired({ gatewayId: "default" })]);
    expect(map.default.image.repository).toBe(STD_REPO);
  });

  it("buildHelmTargetMap: operator profile resolves the same way", () => {
    const map = buildHelmTargetMap([
      mkDesired({ gatewayId: "bender", profile: "operator" }),
    ], {});
    expect(map.bender.image.repository).toBe(OPERATOR_REPO);
  });

  it("changing profile is a reconcile `update` (Cowboy rolls the instance onto the profile image)", () => {
    const actual = buildInstancesMap([mkDesired({ gatewayId: "bender" })]);
    const desired = buildInstancesMap([
      mkDesired({ gatewayId: "bender", profile: "operator" }),
    ]);
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual([
      { kind: "update", gatewayId: "bender", from: actual.bender, to: desired.bender },
    ]);
  });
});
