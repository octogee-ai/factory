import { describe, it, expect } from "vitest";
import {
  buildHelmTargetMap,
  buildInstancesMap,
  diffInstancesMap,
  type ReconcileChange,
} from "../reconcile-plan";
import type { GatewayDesiredState, HelmInstancesMap } from "../../../shared/types/glm";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function mkDesired(overrides: Partial<GatewayDesiredState>): GatewayDesiredState {
  return {
    gatewayId: "gw-test-default",
    instanceName: "default",
    imageRepository: REPO,
    imageTag: "abc1234",
    desiredStatus: "running",
    createdBy: "ci:abc1234",
    ...overrides,
  };
}

describe("buildInstancesMap", () => {
  it("renders one instance entry per `running` desired-state doc", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "default", gatewayId: "gw-test", imageTag: "abc" }),
    ]);
    expect(map).toEqual({
      default: {
        enabled: true,
        image: { repository: REPO, tag: "abc" },
        gatewayId: "gw-test",
      },
    });
  });

  it("keeps enabled=true for desiredStatus=draining — pod stays up; new placements are blocked elsewhere", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "default", desiredStatus: "draining" }),
    ]);
    expect(map.default.enabled).toBe(true);
  });

  it("omits desiredStatus=retired entirely (instance slot is gone)", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "default", desiredStatus: "running" }),
      mkDesired({ instanceName: "old", desiredStatus: "retired" }),
    ]);
    expect(Object.keys(map).sort()).toEqual(["default"]);
  });

  it("renders multiple running instances side by side", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "default", gatewayId: "gw-test", imageTag: "abc" }),
      mkDesired({ instanceName: "canary", gatewayId: "gw-test-canary", imageTag: "def" }),
    ]);
    expect(map.default).toMatchObject({ gatewayId: "gw-test", image: { tag: "abc" } });
    expect(map.canary).toMatchObject({ gatewayId: "gw-test-canary", image: { tag: "def" } });
  });

  it("returns an empty map when no desired state exists", () => {
    const map = buildInstancesMap([]);
    expect(map).toEqual({});
  });
});

describe("diffInstancesMap", () => {
  const baseInstance = (tag: string) => ({
    enabled: true,
    image: { repository: REPO, tag },
    gatewayId: "gw-test",
  });

  it("reports no changes when desired == actual", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = { default: baseInstance("abc") };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual([]);
  });

  it("reports a `create` when desired has an instance actual doesn't", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = {
      default: baseInstance("abc"),
      canary: { enabled: true, image: { repository: REPO, tag: "def" }, gatewayId: "gw-canary" },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "create", instanceName: "canary" });
  });

  it("reports `drift` (NOT `remove`) when actual has an instance desired doesn't — never auto-deletes", () => {
    const actual: HelmInstancesMap = {
      default: baseInstance("abc"),
      old: baseInstance("xyz"),
    };
    const desired: HelmInstancesMap = { default: baseInstance("abc") };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual([
      { kind: "drift", instanceName: "old", current: actual.old },
    ]);
  });

  it("reports an `update` when image tag differs for the same instance", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = { default: baseInstance("def") };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", instanceName: "default", from: actual.default, to: desired.default },
    ]);
  });

  it("reports an `update` when enabled flips from true to false (drain)", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desired: HelmInstancesMap = {
      default: { ...baseInstance("abc"), enabled: false },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("update");
  });

  it("reports multiple independent changes in a single diff (create + update + drift)", () => {
    const actual: HelmInstancesMap = {
      stale: baseInstance("old"),
      default: baseInstance("abc"),
    };
    const desired: HelmInstancesMap = {
      default: baseInstance("def"),
      canary: { ...baseInstance("ghi"), gatewayId: "gw-canary" },
    };
    const changes = diffInstancesMap(actual, desired);
    const kinds = changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["create", "drift", "update"]);
  });
});

describe("buildHelmTargetMap", () => {
  const REPO_PATH = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
  const desired = (overrides: Partial<GatewayDesiredState>): GatewayDesiredState => ({
    gatewayId: "gw-test-default",
    instanceName: "default",
    imageRepository: REPO_PATH,
    imageTag: "abc1234",
    desiredStatus: "running",
    createdBy: "ci:abc1234",
    ...overrides,
  });

  it("preserves drifted instances (in actual but no glmGateways doc) — never deletes", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      old: { enabled: true, image: { repository: REPO_PATH, tag: "xyz" }, gatewayId: "gw-test-old" },
    };
    const target = buildHelmTargetMap([desired({})], actual);
    expect(Object.keys(target).sort()).toEqual(["default", "old"]);
    expect(target.old).toEqual(actual.old);
  });

  it("applies non-retired glmGateways on top of actual (overriding the matching instance)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "old" }, gatewayId: "gw-test" },
    };
    const target = buildHelmTargetMap(
      [desired({ instanceName: "default", imageTag: "new" })],
      actual,
    );
    expect(target.default.image.tag).toBe("new");
  });

  it("adds new instances from glmGateways that aren't in actual yet (the create case)", () => {
    const actual: HelmInstancesMap = {};
    const target = buildHelmTargetMap(
      [desired({ instanceName: "canary", gatewayId: "gw-test-canary" })],
      actual,
    );
    expect(target.canary.gatewayId).toBe("gw-test-canary");
  });

  it("does NOT remove instances from actual on retire (PR 4 owns the retire flow)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
    };
    const target = buildHelmTargetMap(
      [desired({ instanceName: "default", desiredStatus: "retired" })],
      actual,
    );
    expect(target.default).toEqual(actual.default);
  });

  it("returns the unchanged actual map when no desired-state docs exist (drift-only state)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
    };
    const target = buildHelmTargetMap([], actual);
    expect(target).toEqual(actual);
  });
});
