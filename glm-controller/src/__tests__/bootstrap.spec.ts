import { describe, it, expect } from "vitest";
import type { HelmInstancesMap } from "../../../shared/types/glm";
import { computeBootstrapWrites } from "../bootstrap";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

const actual: HelmInstancesMap = {
  default: {
    enabled: true,
    image: { repository: REPO, tag: "00750cf" },
    gatewayId: "gw-test",
  },
  canary: {
    enabled: true,
    image: { repository: REPO, tag: "4281fc3" },
    gatewayId: "gw-test-canary",
  },
};

describe("computeBootstrapWrites", () => {
  it("writes a glmGateways doc for every helm instance whose gatewayId isn't already registered", () => {
    const writes = computeBootstrapWrites(actual, new Set());
    expect(writes.map((w) => w.gatewayId).sort()).toEqual([
      "gw-test",
      "gw-test-canary",
    ]);
  });

  it("preserves operator-declared state — never overwrites an existing glmGateways doc", () => {
    const writes = computeBootstrapWrites(actual, new Set(["gw-test"]));
    expect(writes.map((w) => w.gatewayId)).toEqual(["gw-test-canary"]);
  });

  it("returns an empty list when every helm instance is already registered (no-op steady state)", () => {
    const writes = computeBootstrapWrites(actual, new Set(["gw-test", "gw-test-canary"]));
    expect(writes).toEqual([]);
  });

  it("returns an empty list when helm has no instances yet (fresh cluster)", () => {
    const writes = computeBootstrapWrites({}, new Set());
    expect(writes).toEqual([]);
  });

  it("populates the bootstrapped doc with imageRepository, imageTag, instanceName, desiredStatus=running, createdBy=controller-bootstrap", () => {
    const writes = computeBootstrapWrites(actual, new Set());
    const def = writes.find((w) => w.gatewayId === "gw-test");
    expect(def?.doc).toEqual({
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "00750cf",
      desiredStatus: "running",
      createdBy: "controller-bootstrap",
    });
  });
});
