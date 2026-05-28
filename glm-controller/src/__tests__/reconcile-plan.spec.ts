import { describe, it, expect } from "vitest";
import {
  buildHelmTargetMap,
  buildInstancesMap,
  deriveFleetImageTag,
  diffInstancesMap,
  isReplicasOnlyUpdate,
  type ReconcileChange,
} from "../reconcile-plan";
import type { GatewayDesiredState, HelmInstancesMap } from "../../../shared/types/glm";
import type { SizingTier } from "../../../shared/types/sizing";

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

describe("sizingTier transition safety (stale Firestore values)", () => {
  // A pre-rename tier like "operator" can still sit in glmGateways desired
  // state. The actual-state reader (readPersonalKnobs) drops unknown tiers, so
  // forwarding a stale value here would get schema-rejected by the chart and
  // the gateway would diff + retry forever. Both sides must treat an unknown
  // tier as unset → profile default.
  const STALE = "operator" as unknown as SizingTier;

  it("buildInstancesMap omits a stale/legacy sizingTier", () => {
    const map = buildInstancesMap([mkDesired({ sizingTier: STALE })]);
    expect(map.default.sizingTier).toBeUndefined();
  });

  it("still forwards a valid sizingTier", () => {
    const map = buildInstancesMap([mkDesired({ sizingTier: "large" })]);
    expect(map.default.sizingTier).toBe("large");
  });

  it("no perpetual update when desired holds a stale tier that actual already dropped", () => {
    const actual = buildInstancesMap([mkDesired({})]);
    const desired = buildHelmTargetMap([mkDesired({ sizingTier: STALE })], actual);
    expect(diffInstancesMap(actual, desired)).toEqual([]);
  });
});

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
        replicas: 1,
      },
    });
  });

  it("paused desired-status renders replicas=0 (release stays, pod scales to zero)", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "default", desiredStatus: "paused" }),
    ]);
    expect(map.default).toMatchObject({ enabled: true, replicas: 0 });
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

  it("preserves personal gateway helm knobs from desired state", () => {
    const map = buildInstancesMap([
      mkDesired({
        instanceName: "bender",
        gatewayId: "gw-bender",
        serviceAccountName: "octogee-gateway-bender",
        gatewayContainerSecurityContext: {
          allowPrivilegeEscalation: true,
          capabilities: { drop: ["ALL"] },
        },
        persistence: {
          enabled: true,
          storageClassName: "premium-rwo",
          size: "20Gi",
          accessModes: ["ReadWriteOnce"],
        },
      }),
    ]);
    expect(map.bender).toMatchObject({
      serviceAccountName: "octogee-gateway-bender",
      gatewayContainerSecurityContext: {
        allowPrivilegeEscalation: true,
      },
      persistence: {
        enabled: true,
        size: "20Gi",
      },
    });
  });

  it("returns an empty map when no desired state exists", () => {
    const map = buildInstancesMap([]);
    expect(map).toEqual({});
  });

it("propagates the operator profile onto the helm instance value (so the chart can gate env injection)", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "bender", profile: "operator" }),
    ]);
    expect(map.bender.profile).toBe("operator");
  });

  it("omits profile when desired state has none (cattle default — chart sees profile=\"\")", () => {
    const map = buildInstancesMap([
      mkDesired({ instanceName: "default" }),
    ]);
    expect(map.default).not.toHaveProperty("profile");
  });
});

describe("deriveFleetImageTag — what sidecars should run", () => {
  it("uses the `default` instance's imageTag when present", () => {
    const tag = deriveFleetImageTag([
      mkDesired({ instanceName: "default", imageTag: "abc1234" }),
      mkDesired({ instanceName: "canary", imageTag: "canary999" }),
    ]);
    expect(tag).toBe("abc1234");
  });

  it("falls back to the first non-retired instance's imageTag when there's no `default`", () => {
    const tag = deriveFleetImageTag([
      mkDesired({ instanceName: "smoke", imageTag: "smoke111" }),
      mkDesired({ instanceName: "canary", imageTag: "canary222" }),
    ]);
    expect(tag).toBe("smoke111");
  });

  it("ignores retired instances when picking the fleet imageTag", () => {
    const tag = deriveFleetImageTag([
      mkDesired({ instanceName: "default", desiredStatus: "retired", imageTag: "old" }),
      mkDesired({ instanceName: "canary", imageTag: "fresh" }),
    ]);
    expect(tag).toBe("fresh");
  });

  it("returns undefined when no non-retired instances exist (chart default applies)", () => {
    const tag = deriveFleetImageTag([
      mkDesired({ instanceName: "default", desiredStatus: "retired", imageTag: "old" }),
    ]);
    expect(tag).toBeUndefined();
  });

  it("returns undefined for an empty desired list (fresh-cluster bootstrap)", () => {
    expect(deriveFleetImageTag([])).toBeUndefined();
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

  it("reports an update when replicas flips (pause/resume path)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), replicas: 1 } };
    const desired: HelmInstancesMap = { default: { ...baseInstance("abc"), replicas: 0 } };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", instanceName: "default", from: actual.default, to: desired.default },
    ]);
  });

  it("reports an update when sizingTier flips (change-tier path)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), sizingTier: "medium" } };
    const desired: HelmInstancesMap = { default: { ...baseInstance("abc"), sizingTier: "large" } };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", instanceName: "default", from: actual.default, to: desired.default },
    ]);
  });

  it("reports exactly one update when image, sizingTier, and replicas all differ (no double-counting)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), sizingTier: "medium", replicas: 1 } };
    const desired: HelmInstancesMap = { default: { ...baseInstance("def"), sizingTier: "large", replicas: 0 } };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "update", instanceName: "default" });
  });

  it("reports an update when personal gateway helm knobs change", () => {
    const actual: HelmInstancesMap = {
      bender: {
        enabled: true,
        image: { repository: REPO, tag: "abc" },
        gatewayId: "gw-bender",
      },
    };
    const desired: HelmInstancesMap = {
      bender: {
        ...actual.bender,
        serviceAccountName: "octogee-gateway-bender",
        persistence: { enabled: true, size: "20Gi" },
      },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([
      { kind: "update", instanceName: "bender", from: actual.bender, to: desired.bender },
    ]);
  });

  it("does NOT report an update when a helm-knob object differs only in key order (stable compare — no per-tick reconcile churn)", () => {
    const actual: HelmInstancesMap = {
      bender: {
        enabled: true,
        image: { repository: REPO, tag: "abc" },
        gatewayId: "gw-bender",
        gatewayContainerSecurityContext: {
          allowPrivilegeEscalation: true,
          capabilities: { drop: ["ALL"] },
        },
        persistence: { enabled: true, size: "20Gi", storageClassName: "premium-rwo" },
      },
    };

const desired: HelmInstancesMap = {
      bender: {
        enabled: true,
        gatewayId: "gw-bender",
        image: { tag: "abc", repository: REPO },
        persistence: { storageClassName: "premium-rwo", size: "20Gi", enabled: true },
        gatewayContainerSecurityContext: {
          capabilities: { drop: ["ALL"] },
          allowPrivilegeEscalation: true,
        },
      },
    };
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual<ReconcileChange[]>([]);
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

  it("removes a retired instance from target when no customers are mounted (helm uninstalls)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      canary: { enabled: true, image: { repository: REPO_PATH, tag: "def" }, gatewayId: "gw-test-canary" },
    };
    const mounted = new Map<string, readonly string[]>([
      ["gw-test", ["alice", "bob"]],
      ["gw-test-canary", []],
    ]);
    const target = buildHelmTargetMap(
      [
        desired({ instanceName: "canary", gatewayId: "gw-test-canary", desiredStatus: "retired" }),
      ],
      actual,
      mounted,
    );
    expect(Object.keys(target).sort()).toEqual(["default"]);
  });

  it("preserves a retired instance from target while customers are still mounted (drain wait)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      canary: { enabled: true, image: { repository: REPO_PATH, tag: "def" }, gatewayId: "gw-test-canary" },
    };
    const mounted = new Map<string, readonly string[]>([
      ["gw-test-canary", ["alice"]],
    ]);
    const target = buildHelmTargetMap(
      [
        desired({ instanceName: "canary", gatewayId: "gw-test-canary", desiredStatus: "retired" }),
      ],
      actual,
      mounted,
    );
    expect(target.canary).toEqual(actual.canary);
  });

  it("removes a retired instance whose heartbeat doc never existed (stranded crash-looping canary case)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
      crashloop: { enabled: true, image: { repository: REPO_PATH, tag: "bad" }, gatewayId: "gw-test-crashloop" },
    };
    const mounted = new Map<string, readonly string[]>([["gw-test", []]]);
    const target = buildHelmTargetMap(
      [
        desired({ instanceName: "crashloop", gatewayId: "gw-test-crashloop", desiredStatus: "retired" }),
      ],
      actual,
      mounted,
    );
    expect(Object.keys(target).sort()).toEqual(["default"]);
  });

  it("returns the unchanged actual map when no desired-state docs exist (drift-only state)", () => {
    const actual: HelmInstancesMap = {
      default: { enabled: true, image: { repository: REPO_PATH, tag: "abc" }, gatewayId: "gw-test" },
    };
    const target = buildHelmTargetMap([], actual);
    expect(target).toEqual(actual);
  });
});

describe("chart-template drift detection", () => {
  const baseInstance = (tag: string) => ({
    enabled: true,
    image: { repository: REPO, tag },
    gatewayId: "gw-test",
  });

  const desired = (overrides: Partial<GatewayDesiredState>): GatewayDesiredState => ({
    gatewayId: "gw-test",
    instanceName: "default",
    imageRepository: REPO,
    imageTag: "abc",
    desiredStatus: "running",
    createdBy: "ci:abc",
    ...overrides,
  });

  it("buildInstancesMap stamps the chartFingerprint onto every live entry when provided", () => {
    const map = buildInstancesMap([desired({})], "fp-aaa");
    expect(map.default.chartFingerprint).toBe("fp-aaa");
  });

  it("buildInstancesMap omits chartFingerprint when not provided (boot/legacy callers)", () => {
    const map = buildInstancesMap([desired({})]);
    expect(map.default.chartFingerprint).toBeUndefined();
  });

  it("buildHelmTargetMap stamps the desired fingerprint onto live entries (overrides actual)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-old" } };
    const target = buildHelmTargetMap([desired({})], actual, new Map(), "fp-new");
    expect(target.default.chartFingerprint).toBe("fp-new");
  });

  it("diffInstancesMap returns `update` when actual has no fingerprint and desired has one (transition case)", () => {
    const actual: HelmInstancesMap = { default: baseInstance("abc") };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "update", instanceName: "default" });
  });

  it("diffInstancesMap returns no changes when both sides carry the same fingerprint", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-same" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-same" } };
    expect(diffInstancesMap(actual, desiredMap)).toEqual([]);
  });

  it("diffInstancesMap returns `update` when fingerprints differ but image tag is identical (chart-only drift)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("abc"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("update");
  });
});

describe("chart-drift comparison is caller-gated (issue #997 — PROD must not auto-roll)", () => {
  const baseInstance = (tag: string) => ({
    enabled: true,
    image: { repository: REPO, tag },
    gatewayId: "gw-prod",
  });

  it("compareChartFingerprint:false — chart-only drift produces NO changes (a glm-controller image bump must not roll customer pods)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-new" } };
    expect(
      diffInstancesMap(actual, desiredMap, { compareChartFingerprint: false }),
    ).toEqual([]);
  });

  it("compareChartFingerprint:false — the undefined→fingerprint transition is also suppressed (fresh Cowboy image must not roll the existing release)", () => {
    const actual: HelmInstancesMap = { default: baseInstance("sha") };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-new" } };
    expect(
      diffInstancesMap(actual, desiredMap, { compareChartFingerprint: false }),
    ).toEqual([]);
  });

  it("compareChartFingerprint:false — an image-tag change still rolls (operator-driven PROD rollout via promote-gateway.ts)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("sha-old"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha-new"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap, {
      compareChartFingerprint: false,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "update", instanceName: "default" });
  });

  it("compareChartFingerprint defaults to true — chart-only drift still re-applies (TEST auto-roll unchanged)", () => {
    const actual: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-old" } };
    const desiredMap: HelmInstancesMap = { default: { ...baseInstance("sha"), chartFingerprint: "fp-new" } };
    const changes = diffInstancesMap(actual, desiredMap);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("update");
  });
});

describe("isReplicasOnlyUpdate", () => {
  const REPO2 = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
  const base = () => ({
    enabled: true as const,
    image: { repository: REPO2, tag: "abc" },
    gatewayId: "gw-test",
  });

  it("returns true when only replicas differs (paused: 1 → 0)", () => {
    const change: ReconcileChange = {
      kind: "update",
      instanceName: "default",
      from: { ...base(), replicas: 1 },
      to: { ...base(), replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(true);
  });

  it("returns true when only replicas differs (resume: 0 → 1)", () => {
    const change: ReconcileChange = {
      kind: "update",
      instanceName: "default",
      from: { ...base(), replicas: 0 },
      to: { ...base(), replicas: 1 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(true);
  });

  it("returns false when replicas AND image tag differ (chart-shape change → helm)", () => {
    const change: ReconcileChange = {
      kind: "update",
      instanceName: "default",
      from: { ...base(), image: { repository: REPO2, tag: "abc" }, replicas: 1 },
      to: { ...base(), image: { repository: REPO2, tag: "def" }, replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when replicas AND sizingTier differ", () => {
    const change: ReconcileChange = {
      kind: "update",
      instanceName: "default",
      from: { ...base(), sizingTier: "small", replicas: 1 },
      to: { ...base(), sizingTier: "large", replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when persistence differs (object diff)", () => {
    const change: ReconcileChange = {
      kind: "update",
      instanceName: "bender",
      from: { ...base(), persistence: { enabled: true, size: "20Gi" }, replicas: 1 },
      to: { ...base(), persistence: { enabled: true, size: "40Gi" }, replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false on `create` kind", () => {
    const change: ReconcileChange = {
      kind: "create",
      instanceName: "default",
      to: { ...base(), replicas: 1 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false on `drift` kind", () => {
    const change: ReconcileChange = {
      kind: "drift",
      instanceName: "default",
      current: { ...base(), replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when chartFingerprint differs", () => {
    const change: ReconcileChange = {
      kind: "update",
      instanceName: "default",
      from: { ...base(), chartFingerprint: "fp-old", replicas: 1 },
      to: { ...base(), chartFingerprint: "fp-new", replicas: 0 },
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });

  it("returns false when nothing actually differs (defensive — diffInstancesMap wouldn't emit this, but the predicate must be honest)", () => {
    const inst = { ...base(), replicas: 1 };
    const change: ReconcileChange = {
      kind: "update",
      instanceName: "default",
      from: inst,
      to: inst,
    };
    expect(isReplicasOnlyUpdate(change)).toBe(false);
  });
});
