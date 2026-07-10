import { describe, it, expect } from "vitest";
import {
  revisionIdForRelease,
  releasePayloadHash,
  classifyGatewayField,
  isRevisionRealizationDoc,
  isGatewayDesiredDoc,
  gatewayEdgeServiceName,
  gatewayPodServiceName,
  REVISION_TOMBSTONES_COLLECTION,
  revisionTombstoneDocId,
  isRevisionTombstone,
  RELEASE_NEW_REVISION_FIELDS,
  RELEASE_IN_PLACE_FIELDS,
  GATEWAY_MUTABLE_FIELDS,
  isAssignmentState,
  INTRA_FAMILY_HOP_HEADER,
  ASSIGNMENT_EPOCH_HEADER,
  INTERNAL_ROUTING_HEADERS,
  commitPlacementAtomic,
  type AssignmentDoc,
  type GatewayRollState,
  type GatewayIdleSleepState,
  type PlacementDocRef,
  type PlacementFirestore,
  type PlacementTxn,
  type ReleasePayload,
  type RevisionTombstone,
} from "./gateway-releases";

describe("glmGateways doc-kind discriminators", () => {
  const revisionDoc = {
    docKind: "revision",
    revisionId: "default-r3",
    gateway: "default",
    release: 3,
    lifecycle: "provisioning",
  };
  const legacyDesiredDoc = {
    gatewayId: "default",
    imageRepository: "repo",
    imageTag: "abc",
    desiredStatus: "running",
  };
  const gatewayDoc = {
    gatewayId: "default",
    latestRelease: 2,
    desiredRelease: 2,
    desiredStatus: "running",
  };

  it("isRevisionRealizationDoc: only the revision doc", () => {
    expect(isRevisionRealizationDoc(revisionDoc)).toBe(true);
    expect(isRevisionRealizationDoc(legacyDesiredDoc)).toBe(false);
    expect(isRevisionRealizationDoc(gatewayDoc)).toBe(false);
    expect(isRevisionRealizationDoc(null)).toBe(false);
  });

  it("isRevisionRealizationDoc: structural fallback when docKind predates the field", () => {
    const { docKind: _omit, ...noDocKind } = revisionDoc;
    expect(isRevisionRealizationDoc(noDocKind)).toBe(true);
  });

  it("isGatewayDesiredDoc: only the new GatewayDoc, never a legacy desired or revision doc", () => {
    expect(isGatewayDesiredDoc(gatewayDoc)).toBe(true);
    expect(isGatewayDesiredDoc(legacyDesiredDoc)).toBe(false);
    expect(isGatewayDesiredDoc(revisionDoc)).toBe(false);
    expect(isGatewayDesiredDoc(null)).toBe(false);
  });
});

function samplePayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "abc1234",
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: "small",
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
    byosub: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("revisionIdForRelease", () => {
  it("derives the {gatewayId}-r{n} revision id convention", () => {
    expect(revisionIdForRelease("default", 1)).toBe("default-r1");
    expect(revisionIdForRelease("bender", 42)).toBe("bender-r42");
  });
});

describe("service-name helpers", () => {
  it("names the gateway-edge Service by the addressed id (bare gateway OR revision)", () => {
    // Service-form addressing targets the per-gateway Service (Cowboy-flipped
    // selector); revision-pinned addressing targets the revision's own Service.
    expect(gatewayEdgeServiceName("default")).toBe("gateway-edge-default");
    expect(gatewayEdgeServiceName("default-r7")).toBe("gateway-edge-default-r7");
  });

  it("names the gateway pod Service (preview surface) by the addressed id", () => {
    expect(gatewayPodServiceName("default")).toBe("octogee-gateway-default");
    expect(gatewayPodServiceName("default-r7")).toBe("octogee-gateway-default-r7");
  });
});

describe("revision tombstones", () => {
  it("keys the tombstone doc by the revision id", () => {
    expect(REVISION_TOMBSTONES_COLLECTION).toBe("revisionTombstones");
    expect(revisionTombstoneDocId("default", 3)).toBe("default-r3");
  });

  it("recognizes a well-formed tombstone (current-revision pointer may be null)", () => {
    const tombstone: RevisionTombstone = {
      gatewayId: "default",
      revision: 3,
      revisionId: "default-r3",
      currentRevisionId: "default-r4",
      retiredAt: 1_700_000_000_000,
    };
    expect(isRevisionTombstone(tombstone)).toBe(true);
    expect(isRevisionTombstone({ ...tombstone, currentRevisionId: null })).toBe(true);
  });

  it("rejects malformed tombstones", () => {
    expect(isRevisionTombstone(null)).toBe(false);
    expect(isRevisionTombstone({ gatewayId: "default", revision: "3" })).toBe(false);
    expect(isRevisionTombstone({ gatewayId: "default", revisionId: "default-r3" })).toBe(false);
  });
});

describe("releasePayloadHash", () => {
  it("is deterministic regardless of key insertion order", () => {
    const a = samplePayload();
    const b: ReleasePayload = {
      preemption: null,
      modelBrokerLimits: null,
      byosub: null,
      openclawOverrides: null,
      builderSlug: null,
      coOwnerUids: [],
      ownerUid: null,
      operatorAccess: null,
      serviceAccount: null,
      serviceAccountName: null,
      gatewayContainerSecurityContext: null,
      gcpProject: null,
      computeClass: null,
      sizingTier: "small",
      imageProfile: "standard",
      gatewayClass: "shared",
      profile: "standard",
      imageTag: "abc1234",
      imageRepository:
        "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    };
    expect(releasePayloadHash(a)).toBe(releasePayloadHash(b));
  });

  it("changes when any payload value changes", () => {
    const base = releasePayloadHash(samplePayload());
    expect(releasePayloadHash(samplePayload({ imageTag: "def5678" }))).not.toBe(base);
    expect(releasePayloadHash(samplePayload({ sizingTier: "medium" }))).not.toBe(base);
    expect(
      releasePayloadHash(samplePayload({ modelBrokerLimits: { spendWindowUsd: 5 } })),
    ).not.toBe(base);
  });

  it("is stable across nested-object key order", () => {
    const a = samplePayload({
      gatewayContainerSecurityContext: { runAsUser: 1000, runAsNonRoot: true },
    });
    const b = samplePayload({
      gatewayContainerSecurityContext: { runAsNonRoot: true, runAsUser: 1000 },
    });
    expect(releasePayloadHash(a)).toBe(releasePayloadHash(b));
  });

  it("normalizes set-like coOwnerUids order so a reorder is not a new release", () => {
    const a = samplePayload({ coOwnerUids: ["alice", "bob", "carol"] });
    const b = samplePayload({ coOwnerUids: ["carol", "alice", "bob"] });
    expect(releasePayloadHash(a)).toBe(releasePayloadHash(b));
  });

  it("still changes when the coOwnerUids set membership actually changes", () => {
    const base = releasePayloadHash(samplePayload({ coOwnerUids: ["alice", "bob"] }));
    expect(releasePayloadHash(samplePayload({ coOwnerUids: ["alice", "carol"] }))).not.toBe(base);
    expect(releasePayloadHash(samplePayload({ coOwnerUids: ["alice"] }))).not.toBe(base);
  });
});

describe("classifyGatewayField", () => {
  it("classifies an unknown/new field as new-revision (conservative default)", () => {
    expect(classifyGatewayField("someFieldWeHaveNeverSeen")).toBe("new-revision");
    expect(classifyGatewayField("futureRuntimeKnob")).toBe("new-revision");
  });

  it("classifies every spec new-revision field as new-revision", () => {
    for (const field of RELEASE_NEW_REVISION_FIELDS) {
      expect(classifyGatewayField(field)).toBe("new-revision");
    }
  });

  it("classifies release-audit-but-in-place-safe fields as in-place", () => {
    for (const field of RELEASE_IN_PLACE_FIELDS) {
      expect(classifyGatewayField(field)).toBe("in-place");
    }
    expect(classifyGatewayField("modelBrokerLimits")).toBe("in-place");
    expect(classifyGatewayField("preemption")).toBe("in-place");
  });

  it("classifies gateway-doc fields mutable without a release as gateway-mutable", () => {
    for (const field of GATEWAY_MUTABLE_FIELDS) {
      expect(classifyGatewayField(field)).toBe("gateway-mutable");
    }
    expect(classifyGatewayField("desiredStatus")).toBe("gateway-mutable");
    expect(classifyGatewayField("roll")).toBe("gateway-mutable");
  });

  it("classifies every gateway-doc lifecycle field from the spec as gateway-mutable", () => {
    for (const field of [
      "desiredStatus",
      "roll",
      "idleSleep",
      "preemptionHandoff",
      "liveRelease",
      "liveRevisionId",
      "trafficRevisionId",
      "retireAfter",
    ]) {
      expect(classifyGatewayField(field)).toBe("gateway-mutable");
    }
  });

  it("keeps operatorAccess and openclawOverrides on the conservative new-revision default", () => {
    expect(classifyGatewayField("operatorAccess")).toBe("new-revision");
    expect(classifyGatewayField("openclawOverrides")).toBe("new-revision");
    expect(classifyGatewayField("byosub")).toBe("new-revision");
  });
});

describe("GatewayIdleSleepState", () => {
  it("accepts the exact shapes the dedicated idle sweeper writes", () => {
    const paused: GatewayIdleSleepState = {
      status: "paused",
      pausedAt: 1,
      action: "pause-empty-dedicated",
    };
    const emptyWaiting: GatewayIdleSleepState = {
      status: "empty-waiting",
      action: "pause-empty-dedicated",
      emptySince: 2,
      lastActivityAt: 3,
    };
    const returning: GatewayIdleSleepState = {
      status: "returning-to-shared",
      requestedAt: 4,
      operationId: "op-1",
      targetGatewayId: "default",
      lastActivityAt: 5,
    };
    expect([paused.status, emptyWaiting.status, returning.status]).toEqual([
      "paused",
      "empty-waiting",
      "returning-to-shared",
    ]);
  });
});

describe("assignment roster state + epoch (PR7 mid-roll routing)", () => {
  it("isAssignmentState accepts exactly serving|quiescing|migrating", () => {
    expect(isAssignmentState("serving")).toBe(true);
    expect(isAssignmentState("quiescing")).toBe(true);
    expect(isAssignmentState("migrating")).toBe(true);
    expect(isAssignmentState("draining")).toBe(false);
    expect(isAssignmentState("")).toBe(false);
    expect(isAssignmentState(null)).toBe(false);
  });

  it("AssignmentDoc carries state + epoch", () => {
    const doc: AssignmentDoc = {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      revisionId: "default-r2",
      release: 2,
      source: "rollout",
      state: "serving",
      epoch: 3,
      updatedAt: 1,
      updatedByOperationId: null,
    };
    expect(doc.state).toBe("serving");
    expect(doc.epoch).toBe(3);
  });
});

describe("internal routing headers (intra-family forward)", () => {
  it("names are lowercase (Node lowercases incoming header keys) and stable", () => {
    expect(INTRA_FAMILY_HOP_HEADER).toBe("x-octogee-intra-family-hop");
    expect(ASSIGNMENT_EPOCH_HEADER).toBe("x-octogee-assignment-epoch");
  });

  it("INTERNAL_ROUTING_HEADERS enumerates every internal header so the public router can strip them all", () => {
    expect([...INTERNAL_ROUTING_HEADERS].sort()).toEqual(
      [INTRA_FAMILY_HOP_HEADER, ASSIGNMENT_EPOCH_HEADER].sort(),
    );
  });
});

describe("GatewayRollState.flippedAt (durable forwarder-TTL base)", () => {
  it("carries the selector-flip timestamp so a controller crash never loses the drain deadline", () => {
    const roll: GatewayRollState = {
      operationId: "roll-default-r2-1",
      status: "retiring-source",
      fromRelease: 1,
      toRelease: 2,
      sourceRevisionId: "default-r1",
      targetRevisionId: "default-r2",
      acceptingNewAssignments: false,
      startedAt: 1,
      updatedAt: 2,
      error: null,
      flippedAt: 99,
    };
    expect(roll.flippedAt).toBe(99);
  });
});

describe("commitPlacementAtomic", () => {
  // Path-keyed store + a serialized/buffered runTransaction mirroring Firestore's
  // all-or-nothing commit. Reads see live store; writes buffer until the body
  // completes (a throw leaves the store untouched).
  function mkDb(seed: Record<string, Record<string, unknown>> = {}) {
    const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
    function docRef(path: string): PlacementDocRef {
      return {
        get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
        set: async (data, opts) => {
          store.set(path, opts?.merge && store.has(path) ? { ...store.get(path), ...data } : { ...data });
        },
        update: async (data) => {
          if (!store.has(path)) throw new Error(`update of missing doc ${path}`);
          store.set(path, { ...store.get(path), ...data });
        },
        collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
      };
    }
    const db: PlacementFirestore = {
      collection: (name) => ({ doc: (id) => docRef(`${name}/${id}`) }),
      runTransaction: async (body) => {
        const writes: Array<() => Promise<void>> = [];
        const txn: PlacementTxn = {
          get: (ref) => ref.get(),
          set: (ref, data, opts) => {
            writes.push(() => ref.set(data, opts));
          },
          update: (ref, data) => {
            writes.push(() => ref.update(data));
          },
        };
        const result = await body(txn);
        for (const w of writes) await w();
        return result;
      },
    };
    return { db, store };
  }

  const backfilled = (overrides: Record<string, unknown> = {}) => ({
    gatewayId: "default",
    latestRelease: 3,
    desiredRelease: 3,
    liveRelease: 3,
    liveRevisionId: "default-r3",
    desiredStatus: "running",
    roll: null,
    ...overrides,
  });

  const mirror = { "provisioning.openclaw.gatewayId": "default", "provisioning.openclaw.shellsEnabled": false };

  it("un-backfilled gateway (no GatewayDoc): writes ONLY the mirror, byte-identical to today", async () => {
    const { db, store } = mkDb({
      "users/u1": { approved: true },
      "gateways/default": { gatewayId: "default", status: "ready" }, // legacy heartbeat doc, not a GatewayDoc
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "mirror-only" });
    expect(store.get("users/u1")).toMatchObject({ "provisioning.openclaw.gatewayId": "default" });
    // No assignment doc written for a legacy gateway.
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it("steady backfilled gateway: writes mirror + assignment at the LIVE revision (serving, epoch 0)", async () => {
    const { db, store } = mkDb({
      "users/u1": { approved: true },
      "gateways/default": backfilled(),
      "glmGateways/default-r3": { lifecycle: "serving" },
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "assigned", revisionId: "default-r3", release: 3 });
    expect(store.get("gateways/default/assignments/u1")).toMatchObject({
      uid: "u1", slug: "s1", gatewayId: "default", revisionId: "default-r3", release: 3,
      source: "onboarding", state: "serving", epoch: 0, updatedAt: 100, updatedByOperationId: null,
    });
    expect(store.get("users/u1")).toMatchObject({ "provisioning.openclaw.gatewayId": "default" });
  });

  it("roll accepting new assignments: places on the TARGET revision, not the live one", async () => {
    const { db, store } = mkDb({
      "users/u1": { approved: true },
      "gateways/default": backfilled({
        liveRevisionId: "default-r3",
        liveRelease: 3,
        roll: {
          operationId: "op", status: "migrating", fromRelease: 3, toRelease: 4,
          sourceRevisionId: "default-r3", targetRevisionId: "default-r4",
          acceptingNewAssignments: true, startedAt: 1, updatedAt: 2, error: null, flippedAt: null,
        },
      }),
      "glmGateways/default-r4": { lifecycle: "serving" },
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "assigned", revisionId: "default-r4", release: 4 });
    expect(store.get("gateways/default/assignments/u1")).toMatchObject({ revisionId: "default-r4", release: 4 });
  });

  it("rejects when the resolved revision is not serving (revision-not-ready) and writes NOTHING", async () => {
    const { db, store } = mkDb({
      "users/u1": { approved: true },
      "gateways/default": backfilled(),
      "glmGateways/default-r3": { lifecycle: "warming" },
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "rejected", reason: "revision-not-ready" });
    expect(store.get("users/u1")).toEqual({ approved: true }); // mirror untouched
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it("rejects when a backfilled gateway has no live revision (no-live-revision)", async () => {
    const { db } = mkDb({
      "users/u1": { approved: true },
      "gateways/default": backfilled({ liveRevisionId: null, liveRelease: null }),
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "rejected", reason: "no-live-revision" });
  });

  it("mirror and assignment are all-or-nothing: neither lands if the commit throws", async () => {
    const { db, store } = mkDb({
      "users/u1": { approved: true },
      "gateways/default": backfilled(),
      "glmGateways/default-r3": { lifecycle: "serving" },
    });
    // Force the assignment write to throw, and model Firestore's atomic commit
    // (snapshot → apply all → restore on any failure) so a mid-commit throw
    // leaves NOTHING — the mirror must not leak without its assignment.
    db.runTransaction = async (body) => {
      const writes: Array<() => Promise<void>> = [];
      const txn: PlacementTxn = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => {
          writes.push(() =>
            String((data as { revisionId?: unknown }).revisionId) === "default-r3"
              ? Promise.reject(new Error("assignment write failed"))
              : ref.set(data, opts),
          );
        },
        update: (ref, data) => {
          writes.push(() => ref.update(data));
        },
      };
      const result = await body(txn);
      const snapshot = new Map(store);
      try {
        for (const w of writes) await w();
      } catch (e) {
        store.clear();
        for (const [k, v] of snapshot) store.set(k, v);
        throw e;
      }
      return result;
    };
    await expect(
      commitPlacementAtomic(db, {
        uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
      }),
    ).rejects.toThrow(/assignment write failed/);
    // Mirror update was committed with the assignment or not at all — never alone.
    expect(store.get("users/u1")).toEqual({ approved: true });
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });
});
