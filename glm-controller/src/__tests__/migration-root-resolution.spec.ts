import { describe, expect, it } from "vitest";

import {
  durableRolloutGateway,
  isRecoverableHelmRevision,
  resolveLiveRevisionAsSource,
  resolvePlacementFromFirestore,
  resolveSourceRevisionFromFirestore,
} from "../index.js";

type Docs = Record<string, Record<string, unknown>>;

function database(docs: Docs) {
  function document(path: string) {
    const data = docs[path];
    return {
      get: async () => ({ exists: data !== undefined, data: () => data }),
      collection(name: string) {
        return {
          doc(id: string) {
            return document(`${path}/${name}/${id}`);
          },
        };
      },
    };
  }

  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return document(`${name}/${id}`);
        },
      };
    },
  };
}

function durableGateway(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: `${gatewayId}-r1`,
    trafficRevisionId: `${gatewayId}-r1`,
    desiredStatus: "running",
    roll: null,
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

function servingRevision(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    docKind: "revision",
    revisionId: `${gatewayId}-r1`,
    gateway: gatewayId,
    release: 1,
    lifecycle: "serving",
    ...overrides,
  };
}

describe("durable migration root resolution", () => {
  it("keeps a claimed retired gateway out of ordinary migration sources and destinations", async () => {
    const claimedRetired = durableGateway("default", {
      desiredStatus: "retired",
      retirementClaim: {
        operationId: "retire-1",
        version: 1,
        claimedAt: 10,
        liveRevisionId: "default-r1",
        liveRelease: 1,
        previousDesiredStatus: "running",
      },
    });
    const db = database({
      "gateways/default": claimedRetired,
      "glmGateways/default-r1": servingRevision("default"),
    });

    await expect(resolvePlacementFromFirestore(db as never, "default")).resolves.toEqual({
      ok: false,
      reason: "revision-not-ready",
    });
    await expect(resolveLiveRevisionAsSource(db as never, "default")).resolves.toBeNull();
  });

  it("binds an unassigned source to the exact stable live root generation", async () => {
    const db = database({
      "gateways/source": durableGateway("source", { updatedAt: 17 }),
      "glmGateways/source-r1": servingRevision("source"),
    });

    await expect(
      resolveSourceRevisionFromFirestore(db as never, "uid-alice", "source"),
    ).resolves.toEqual({
      revisionId: "source-r1",
      release: 1,
      assignmentMode: "unassigned-live",
      rootUpdatedAt: 17,
    });
  });

  it("does not bind an unassigned source while its durable root is rolling", async () => {
    const db = database({
      "gateways/source": durableGateway("source", {
        updatedAt: 18,
        desiredRelease: 2,
        roll: { operationId: "roll-source" },
      }),
      "glmGateways/source-r1": servingRevision("source"),
    });

    await expect(
      resolveSourceRevisionFromFirestore(db as never, "uid-alice", "source"),
    ).resolves.toBeNull();
  });

  it("does not recover a pending Helm revision for a paused durable root", async () => {
    const db = database({
      "gateways/default": durableGateway("default", { desiredStatus: "paused" }),
      "glmGateways/default-r1": servingRevision("default"),
    });

    await expect(isRecoverableHelmRevision(db as never, "default-r1")).resolves.toBe(false);
  });

  it("does not recover a pending Helm revision marked failed", async () => {
    const db = database({
      "gateways/default": durableGateway("default"),
      "glmGateways/default-r1": servingRevision("default", { lifecycle: "failed" }),
    });

    await expect(isRecoverableHelmRevision(db as never, "default-r1")).resolves.toBe(false);
  });

  it("rejects a gateway-shaped root before a rollout can consume it", () => {
    expect(
      durableRolloutGateway(
        {
          gatewayId: "target",
          latestRelease: 1,
          desiredRelease: 1,
          desiredStatus: "running",
        },
        "target",
      ),
    ).toBeNull();
  });

  it("rejects a destination that has only a gateway-shaped legacy root", async () => {
    const db = database({
      "gateways/target": {
        gatewayId: "target",
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: 1,
        liveRevisionId: "target-r1",
        desiredStatus: "running",
      },
      "glmGateways/target-r1": servingRevision("target"),
    });

    await expect(resolvePlacementFromFirestore(db as never, "target")).resolves.toBeNull();
  });

  it("rejects a source that has only a gateway-shaped legacy root", async () => {
    const db = database({
      "gateways/source": {
        gatewayId: "source",
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: 1,
        liveRevisionId: "source-r1",
        desiredStatus: "running",
      },
      "glmGateways/source-r1": servingRevision("source"),
    });

    await expect(resolveLiveRevisionAsSource(db as never, "source")).resolves.toBeNull();
  });

  it("refuses a destination revision whose identity does not match its durable root", async () => {
    const db = database({
      "gateways/target": durableGateway("target"),
      "glmGateways/target-r1": servingRevision("other"),
    });

    await expect(resolvePlacementFromFirestore(db as never, "target")).resolves.toEqual({
      ok: false,
      reason: "revision-not-ready",
    });
  });

  it("refuses an assigned source whose revision identity does not match its durable root", async () => {
    const db = database({
      "gateways/source": durableGateway("source"),
      "gateways/source/assignments/uid-alice": {
        slug: "alice",
        gatewayId: "source",
        revisionId: "source-r1",
        release: 1,
        source: "rollout",
      },
      "glmGateways/source-r1": servingRevision("other"),
    });

    await expect(
      resolveSourceRevisionFromFirestore(db as never, "uid-alice", "source"),
    ).resolves.toBeNull();
  });
});
