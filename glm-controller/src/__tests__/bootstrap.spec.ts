import { describe, it, expect, vi } from "vitest";
import type { HelmInstancesMap } from "@octogee/shared/types/glm";
import { computeBootstrapWrites } from "../bootstrap";
import { bootstrapGlmGateways } from "../index";

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
          gateway: "bender",
          imageRepository: REPO,
          imageTag: "00750cf",
          gatewayClass: "shared",
          imageProfile: "standard",
          desiredStatus: "running",
          createdBy: "controller-bootstrap",
        },
      },
    ]);
  });

  it("derives the gateway identity from a blue/green-suffixed map key by convention", () => {
    const writes = computeBootstrapWrites(
      {
        "default-blue": {
          enabled: true,
          image: { repository: REPO, tag: "00750cf" },
          gatewayId: "default-blue",
        },
      },
      new Set(),
    );
    expect(writes[0]?.doc.gateway).toBe("default");
  });

  it("never adopts an immutable revision release as a legacy desired gateway", () => {
    const writes = computeBootstrapWrites(
      {
        "default-r4": {
          enabled: true,
          image: { repository: REPO, tag: "00750cf" },
          gatewayId: "default",
        },
      },
      new Set(),
    );

    expect(writes).toEqual([]);
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
      gateway: "default",
      imageRepository: REPO,
      imageTag: "00750cf",
      gatewayClass: "shared",
      imageProfile: "standard",
      desiredStatus: "running",
      createdBy: "controller-bootstrap",
    });
  });
});

describe("bootstrapGlmGateways", () => {
  it("does not inspect or register Helm releases while maintenance is frozen", async () => {
    const helm = {
      readDeployedInstances: vi.fn(async () => actual),
    } as unknown as Parameters<typeof bootstrapGlmGateways>[0]["helm"];
    const db = {} as Parameters<typeof bootstrapGlmGateways>[0]["db"];

    await bootstrapGlmGateways({
      db,
      helm,
      handlers: {} as Parameters<typeof bootstrapGlmGateways>[0]["handlers"],
      log: vi.fn(),
      maintenanceGate: {
        state: async () => ({ frozen: true, reason: "incident repair" }),
        stateInTransaction: async () => ({ frozen: true, reason: "incident repair" }),
      },
    });

    expect(helm.readDeployedInstances).not.toHaveBeenCalled();
  });

  it("does not create a bare legacy desired doc for a durable live revision", async () => {
    const create = vi.fn(async () => undefined);
    const db = {
      collection: (name: string) => {
        if (name === "glmGateways") {
          return {
            get: async () => ({ docs: [] }),
            doc: () => ({ create }),
          };
        }
        if (name === "gateways") {
          return {
            get: async () => ({
              docs: [
                {
                  data: () => ({
                    gatewayId: "default",
                    latestRelease: 2,
                    desiredRelease: 2,
                    liveRelease: 2,
                    liveRevisionId: "default-r2",
                    trafficRevisionId: "default-r2",
                    desiredStatus: "running",
                    roll: null,
                  }),
                },
              ],
            }),
          };
        }
        throw new Error(`unexpected collection ${name}`);
      },
    } as unknown as Parameters<typeof bootstrapGlmGateways>[0]["db"];
    const helm = {
      readDeployedInstances: vi.fn(async () => ({
        "default-r2": {
          enabled: true,
          image: { repository: REPO, tag: "00750cf" },
          gatewayId: "default",
        },
      })),
    } as unknown as Parameters<typeof bootstrapGlmGateways>[0]["helm"];
    const log = vi.fn();

    await bootstrapGlmGateways({
      db,
      helm,
      handlers: {} as Parameters<typeof bootstrapGlmGateways>[0]["handlers"],
      log,
    });

    expect(create).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no writes"));
  });
});
