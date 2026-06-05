import { describe, it, expect } from "vitest";
import type { HelmInstancesMap } from "../../../shared/types/glm";
import { computeBootstrapWrites } from "../bootstrap";

const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

const actual: HelmInstancesMap = {
  default: {
    enabled: true,
    image: { repository: REPO, tag: "00750cf" },
    gatewayId: "default",
  },
  canary: {
    enabled: true,
    image: { repository: REPO, tag: "4281fc3" },
    gatewayId: "canary",
  },
};

describe("computeBootstrapWrites", () => {
  it("writes a glmGateways doc for every helm instance whose gatewayId isn't already registered", () => {
    const writes = computeBootstrapWrites(actual, new Set());
    expect(writes.map((w) => w.gatewayId).sort()).toEqual([
      "canary",
      "default",
    ]);
  });

  it("preserves operator-declared state — never overwrites an existing glmGateways doc", () => {
    const writes = computeBootstrapWrites(actual, new Set(["default"]));
    expect(writes.map((w) => w.gatewayId)).toEqual(["canary"]);
  });

  it("uses the release suffix as the identity when adopting an old release with stale decorated helm values", () => {
    const writes = computeBootstrapWrites(
      {
        bender: {
          enabled: true,
          image: { repository: REPO, tag: "00750cf" },
          gatewayId: "gw-bender",
        },
      },
      new Set(),
    );

    expect(writes).toEqual([
      {
        gatewayId: "bender",
        doc: {
          gatewayId: "bender",
          imageRepository: REPO,
          imageTag: "00750cf",
          desiredStatus: "running",
          createdBy: "controller-bootstrap",
        },
      },
    ]);
  });

  it("returns an empty list when every helm instance is already registered (no-op steady state)", () => {
    const writes = computeBootstrapWrites(actual, new Set(["default", "canary"]));
    expect(writes).toEqual([]);
  });

  it("returns an empty list when helm has no instances yet (fresh cluster)", () => {
    const writes = computeBootstrapWrites({}, new Set());
    expect(writes).toEqual([]);
  });

  it("populates the bootstrapped doc with imageRepository, imageTag, desiredStatus=running, createdBy=controller-bootstrap", () => {
    const writes = computeBootstrapWrites(actual, new Set());
    const def = writes.find((w) => w.gatewayId === "default");
    expect(def?.doc).toEqual({
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "00750cf",
      desiredStatus: "running",
      createdBy: "controller-bootstrap",
    });
  });
});
