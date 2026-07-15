import { describe, expect, it } from "vitest";

import {
  parseSystemConfigObservedStatus,
  resolveAssignedUsersRevisionGate,
  revisionIdFromGatewayPodName,
} from "./fleet-broker.js";

function gatewayStateDb(
  data: Record<string, unknown> | undefined,
  assignments: Array<{ uid: string; data: Record<string, unknown> }> = [],
) {
  return {
    collection: (name: string) => {
      if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
      return {
        doc: () => ({
          get: async () => ({ exists: data !== undefined, data: () => data }),
          collection: (subcollection: string) => {
            if (subcollection !== "assignments") {
              throw new Error(`unexpected subcollection ${subcollection}`);
            }
            return {
              get: async () => ({
                docs: assignments.map((assignment) => ({
                  id: assignment.uid,
                  data: () => assignment.data,
                })),
              }),
            };
          },
        }),
      };
    },
  };
}

function durableGatewayState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 14,
    desiredRelease: 14,
    liveRelease: 12,
    desiredStatus: "running",
    liveRevisionId: "default-r12",
    trafficRevisionId: "default-r12",
    roll: {
      operationId: "roll-default-r14",
      status: "migrating",
      fromRelease: 12,
      toRelease: 14,
      sourceRevisionId: "default-r12",
      targetRevisionId: "default-r14",
      acceptingNewAssignments: true,
      startedAt: 1,
      updatedAt: 1,
      error: null,
      flippedAt: null,
    },
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("revisionIdFromGatewayPodName", () => {
  it("derives the immutable revision from the authenticated Deployment pod name", () => {
    expect(
      revisionIdFromGatewayPodName(
        "default",
        "octogee-gateway-default-r27-5bc5949d46-p946t",
      ),
    ).toBe("default-r27");
  });

  it("refuses pods outside the gateway Deployment naming contract", () => {
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default-r27")).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-other-r27-5bc5949d46-p946t")).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default-r027-5bc5949d46-p946t")).toBeNull();
  });
});

describe("system config observed status validation", () => {
  it("accepts only the redacted bounded status projection", () => {
    expect(parseSystemConfigObservedStatus({
      state: "error",
      acceptedCommit: "a".repeat(40),
      configHash: `sha256:${"b".repeat(64)}`,
      lastErrorCode: "non-fast-forward-conflict",
      rejectedCount: 2,
      recoveryCount: 1,
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:01.000Z",
      freezeState: "frozen",
      openclawVersion: "2026.7.1",
      openclawForkSha: "abc1234",
      controlProtocol: {
        protocol: "durable-openclaw-config",
        version: 1,
      },
      unknown: "drop-me",
    })).toEqual({
      state: "error",
      acceptedCommit: "a".repeat(40),
      configHash: `sha256:${"b".repeat(64)}`,
      lastErrorCode: "non-fast-forward-conflict",
      rejectedCount: 2,
      recoveryCount: 1,
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:01.000Z",
      freezeState: "frozen",
      openclawVersion: "2026.7.1",
      openclawForkSha: "abc1234",
      controlProtocol: {
        protocol: "durable-openclaw-config",
        version: 1,
      },
    });
  });

  it("rejects secret-shaped, invalid, and oversized fields", () => {
    expect(parseSystemConfigObservedStatus({ state: "bogus" })).toBeNull();
    expect(parseSystemConfigObservedStatus({ state: "clean", acceptedCommit: "not-a-sha" })).toBeNull();
    expect(parseSystemConfigObservedStatus({
      state: "error",
      lastErrorCode: "x".repeat(81),
    })).toBeNull();
    expect(parseSystemConfigObservedStatus({
      state: "error",
      token: "must-not-pass",
    })).toEqual({ state: "error" });
    expect(parseSystemConfigObservedStatus({
      state: "clean",
      controlProtocol: { protocol: "durable-openclaw-config", version: 2 },
    })).toBeNull();
  });
});

describe("fleet broker durable root boundary", () => {
  const incompleteRoot = { gatewayId: "default", internalUrl: "http://legacy-should-not-run" };

  it("permits the empty-revision legacy roster path only when the root is absent", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(gatewayStateDb(undefined) as never, "default", ""),
    ).resolves.toEqual({ allowed: true, liveRevisionId: null });
    await expect(
      resolveAssignedUsersRevisionGate(gatewayStateDb(incompleteRoot) as never, "default", ""),
    ).resolves.toEqual({ allowed: false });
  });

  it("requires a durable root when a routing roster is requested", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateDb(undefined) as never,
        "default",
        "default-r1",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: false });
  });

  it("keeps a superseded assigned revision authorized for both roster mounts until it drains", async () => {
    const supersededTargetAssignment = {
      uid: "uid-builder",
      data: {
        slug: "builder",
        gatewayId: "default",
        revisionId: "default-r13",
        release: 13,
        source: "rollout",
        state: "serving",
        epoch: 2,
        updatedAt: 1,
        updatedByOperationId: "roll-default-r13",
      },
    };
    const root = durableGatewayState();

    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateDb(root, [supersededTargetAssignment]) as never,
        "default",
        "default-r13",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: true, liveRevisionId: "default-r12" });

    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateDb(root, [supersededTargetAssignment]) as never,
        "default",
        "default-r13",
      ),
    ).resolves.toEqual({ allowed: true, liveRevisionId: "default-r12" });

    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateDb(root) as never,
        "default",
        "default-r13",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: false });
  });

});
