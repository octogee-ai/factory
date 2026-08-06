import { describe, expect, it } from "vitest";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";

import {
  observeGatewayRelease,
  readReleaseStatus,
  type ReleaseStatusGatewayInput,
} from "../lib/release-status.js";

type DocData = Record<string, unknown>;
const NOW = 10_000_000;
const FRESH_HEARTBEAT_AT = NOW - 1_000;

function gatewayRoot(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): DocData {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 4,
    desiredRelease: 4,
    liveRelease: 4,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function runtime(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): DocData {
  return {
    docKind: "runtime",
    gatewayId,
    release: 4,
    lifecycle: "serving",
    heartbeat: {
      status: "ready",
      version: "abc1234-oc2026.7.1",
      lastHeartbeatAt: FRESH_HEARTBEAT_AT,
    },
    ...overrides,
  };
}

function release(gatewayId: string, number: number, imageTag = "abc1234-oc2026.7.1"): DocData {
  return {
    gatewayId,
    release: number,
    createdAt: 1,
    createdBy: "test",
    sourceRelease: null,
    note: null,
    payloadHash: "payload-hash",
    payload: {
      imageRepository: "repo/octogee-gateway",
      imageTag,
    },
  };
}

function database(
  docs: Record<string, DocData>,
  gatewayIds: readonly string[],
  readPaths: string[] = [],
) {
  return {
    doc(path: string) {
      return {
        get: async () => {
          readPaths.push(path);
          return {
            exists: docs[path] !== undefined,
            data: () => docs[path],
          };
        },
      };
    },
    collection(name: string) {
      if (name === "gateways") {
        return {
          get: async () => {
            readPaths.push(name);
            return {
              docs: gatewayIds.map((id) => ({ id, data: () => docs[`gateways/${id}`] })),
            };
          },
          doc(gatewayId: string) {
            return {
              collection(subcollection: string) {
                if (subcollection !== "releases") {
                  throw new Error(`unexpected subcollection ${subcollection}`);
                }
                return {
                  doc(releaseNumber: string) {
                    const path = `gateways/${gatewayId}/releases/${releaseNumber}`;
                    return {
                      get: async () => {
                        readPaths.push(path);
                        return {
                          exists: docs[path] !== undefined,
                          data: () => docs[path],
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (name === "glmGateways") {
        return {
          doc(gatewayId: string) {
            const path = `glmGateways/${gatewayId}`;
            return {
              get: async () => {
                readPaths.push(path);
                return {
                  exists: docs[path] !== undefined,
                  data: () => docs[path],
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
}

describe("release status", () => {
  it("observes a converged release in one Firestore read pass", async () => {
    const readPaths: string[] = [];
    const db = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": runtime("default", {
        heartbeat: {
          status: "ready",
          version: `abc1234-oc2026.7.1@sha256:${"a".repeat(64)}`,
          lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        },
      }),
    }, ["default"], readPaths);

    await expect(readReleaseStatus(db as never, NOW)).resolves.toEqual({
      defaultGatewayId: "default",
      defaultSelection: "selected",
      gateways: [{
        gatewayId: "default",
        isDefault: true,
        desiredStatus: "running",
        desiredRelease: 4,
        liveRelease: 4,
        desiredImageTag: "abc1234-oc2026.7.1",
        runtimeRelease: 4,
        runtimeLifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: `abc1234-oc2026.7.1@sha256:${"a".repeat(64)}`,
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        observation: "converged",
      }],
    });
    expect(readPaths.sort()).toEqual([
      "config/orchestrator",
      "gateways",
      "gateways/default/releases/4",
      "glmGateways/default",
    ]);
  });

  it.each([
    [
      "unconfigured",
      {},
      null,
      "unconfigured",
    ],
    [
      "empty",
      { defaultGatewayId: "" },
      "",
      "unconfigured",
    ],
    [
      "non-string",
      { defaultGatewayId: 4 },
      null,
      "invalid",
    ],
    [
      "invalid",
      { defaultGatewayId: "default-r4" },
      "default-r4",
      "invalid",
    ],
    [
      "dangling",
      { defaultGatewayId: "missing" },
      "missing",
      "dangling",
    ],
  ] as const)("reports a %s default selection without masking healthy gateway observations", async (
    _caseName,
    orchestrator,
    defaultGatewayId,
    defaultSelection,
  ) => {
    const db = database({
      "config/orchestrator": orchestrator,
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": runtime("default"),
    }, ["default"]);

    await expect(readReleaseStatus(db as never, NOW)).resolves.toMatchObject({
      defaultGatewayId,
      defaultSelection,
      gateways: [{
        gatewayId: "default",
        isDefault: false,
        observation: "converged",
      }],
    });
  });

  it("reports rollout drift without waiting for Cowboy to reconcile", () => {
    const input: ReleaseStatusGatewayInput = {
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 3,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 3,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    };

    expect(observeGatewayRelease(input, NOW)).toBe("rolling");
  });

  it.each([
    ["missing-release", {
      desiredStatus: "running",
      desiredImageTag: null,
    }],
    ["missing-runtime", {
      desiredStatus: "running",
      runtime: null,
    }],
    ["runtime-stale", {
      desiredStatus: "running",
      runtime: {
        release: 3,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }],
    ["not-serving", {
      desiredStatus: "running",
      runtime: {
        release: 4,
        lifecycle: "provisioning",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }],
    ["unhealthy", {
      desiredStatus: "running",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "unreachable",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }],
    ["paused", {
      desiredStatus: "paused",
    }],
    ["retired", {
      desiredStatus: "retired",
    }],
  ] as const)("reports %s without waiting or mutating", (observation, overrides) => {
    const input: ReleaseStatusGatewayInput = {
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
      ...overrides,
    };

    expect(observeGatewayRelease(input, NOW)).toBe(observation);
  });

  it("reports a heartbeat that is not serving the desired release tag", () => {
    expect(observeGatewayRelease({
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "old-tag",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }, NOW)).toBe("version-drift");
  });

  it("recognizes the release tag when the desired payload is digest-pinned", () => {
    expect(observeGatewayRelease({
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: `abc1234-oc2026.7.1@sha256:${"a".repeat(64)}`,
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
      },
    }, NOW)).toBe("converged");
  });

  it("reports an old ready heartbeat as stale instead of converged", () => {
    expect(observeGatewayRelease({
      gatewayId: "default",
      desiredStatus: "running",
      desiredRelease: 4,
      liveRelease: 4,
      desiredImageTag: "abc1234-oc2026.7.1",
      runtime: {
        release: 4,
        lifecycle: "serving",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: NOW - GATEWAY_UNREACHABLE_AFTER_MS - 1,
      },
    }, NOW)).toBe("heartbeat-stale");
  });

  it("accepts Cowboy's booting heartbeat and reports it as unhealthy", async () => {
    const db = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": runtime("default", {
        heartbeat: {
          status: "booting",
          version: "abc1234-oc2026.7.1",
          lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        },
      }),
    }, ["default"]);

    await expect(readReleaseStatus(db as never, NOW)).resolves.toMatchObject({
      gateways: [{
        gatewayId: "default",
        heartbeatStatus: "booting",
        lastHeartbeatAt: FRESH_HEARTBEAT_AT,
        observation: "unhealthy",
      }],
    });
  });

  it("surfaces malformed durable roots instead of silently omitting them", async () => {
    const db = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": { gatewayId: "default" },
    }, ["default"]);

    await expect(readReleaseStatus(db as never, NOW)).resolves.toEqual({
      defaultGatewayId: "default",
      defaultSelection: "dangling",
      gateways: [{
        gatewayId: "default",
        isDefault: false,
        desiredStatus: null,
        desiredRelease: null,
        liveRelease: null,
        desiredImageTag: null,
        runtimeRelease: null,
        runtimeLifecycle: null,
        heartbeatStatus: null,
        heartbeatVersion: null,
        lastHeartbeatAt: null,
        observation: "invalid-root",
      }],
    });
  });

  it.each([
    ["missing heartbeat", {
      docKind: "runtime",
      gatewayId: "default",
      release: 4,
      lifecycle: "serving",
    }],
    ["mismatched gateway identity", runtime("other")],
    ["invalid Date heartbeat", runtime("default", {
      heartbeat: {
        status: "ready",
        version: "abc1234-oc2026.7.1",
        lastHeartbeatAt: new Date(Number.NaN),
      },
    })],
    ["out-of-range numeric heartbeat", runtime("default", {
      heartbeat: {
        status: "ready",
        version: "abc1234-oc2026.7.1",
        lastHeartbeatAt: 8.64e15 + 1,
      },
    })],
  ])("reports %s runtime data as missing instead of crashing or trusting it", async (
    _caseName,
    malformedRuntime,
  ) => {
    const db = database({
      "config/orchestrator": { defaultGatewayId: "default" },
      "gateways/default": gatewayRoot("default"),
      "gateways/default/releases/4": release("default", 4),
      "glmGateways/default": malformedRuntime,
    }, ["default"]);

    await expect(readReleaseStatus(db as never, NOW)).resolves.toMatchObject({
      gateways: [{
        gatewayId: "default",
        runtimeRelease: null,
        runtimeLifecycle: null,
        heartbeatStatus: null,
        heartbeatVersion: null,
        lastHeartbeatAt: null,
        observation: "missing-runtime",
      }],
    });
  });
});
