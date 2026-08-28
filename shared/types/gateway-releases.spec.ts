import { describe, it, expect } from "vitest";
import {
  releasePayloadHash,
  upgradeReleasePayloadSchema,
  isReleasePayload,
  classifyGatewayField,
  isGatewayRuntimeDoc,
  isGatewayDesiredDoc,
  projectGatewayDesiredRootForGateway,
  gatewayEdgeServiceName,
  gatewayPodServiceName,
  helmReleaseNameForGateway,
  RELEASE_FIELDS,
  GATEWAY_MUTABLE_FIELDS,
  isAssignmentState,
  commitPlacementAtomic,
  type AssignmentDoc,
  type PlacementDocRef,
  type PlacementFirestore,
  type PlacementTxn,
  type ReleasePayload,
} from "./gateway-releases";

describe("glmGateways doc-kind discriminators", () => {
  const runtimeDoc = {
    docKind: "runtime",
    gatewayId: "default",
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

  it("isGatewayRuntimeDoc: only the runtime doc, by explicit docKind", () => {
    expect(isGatewayRuntimeDoc(runtimeDoc)).toBe(true);
    expect(isGatewayRuntimeDoc(legacyDesiredDoc)).toBe(false);
    expect(isGatewayRuntimeDoc(gatewayDoc)).toBe(false);
    expect(isGatewayRuntimeDoc({ ...runtimeDoc, docKind: "revision" })).toBe(false);
    expect(isGatewayRuntimeDoc(null)).toBe(false);
  });

  it("isGatewayDesiredDoc: only the GatewayDoc, never a legacy desired or runtime doc", () => {
    expect(isGatewayDesiredDoc(gatewayDoc)).toBe(true);
    expect(isGatewayDesiredDoc({ ...gatewayDoc, desiredStatus: "draining" })).toBe(true);
    expect(isGatewayDesiredDoc(legacyDesiredDoc)).toBe(false);
    expect(isGatewayDesiredDoc(runtimeDoc)).toBe(false);
    expect(isGatewayDesiredDoc(null)).toBe(false);
  });

  it("classifies managedBy as a mutable durable gateway field", () => {
    expect(GATEWAY_MUTABLE_FIELDS).toContain("managedBy");
    expect(classifyGatewayField("managedBy")).toBe("gateway-mutable");
  });
});

function samplePayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "abc1234",
    ...overrides,
  };
}

describe("isReleasePayload", () => {
  it("accepts the artifact schema and rejects mutable policy or credential state", () => {
    expect(isReleasePayload(samplePayload())).toBe(true);
    expect(isReleasePayload({ ...samplePayload(), gatewayClass: "shared" })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(), byosub: { stale: true } })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(), coOwnerUids: [] })).toBe(false);
    expect(isReleasePayload({ ...samplePayload(), imageTag: "latest" })).toBe(false);
  });

  it("accepts a separately digest-pinned gateway-edge image only from the paired package", () => {
    const payload = samplePayload({
      imageTag: `abc1234@sha256:${"a".repeat(64)}`,
      gatewayEdgeImage: {
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
        imageTag: `abc1234@sha256:${"b".repeat(64)}`,
      },
    });

    expect(isReleasePayload(payload)).toBe(true);
    expect(isReleasePayload({
      ...payload,
      gatewayEdgeImage: {
        ...payload.gatewayEdgeImage!,
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      },
    })).toBe(false);
  });

  it("accepts a Builder profile image only from its paired package and release tag", () => {
    const payload = samplePayload({
      imageTag: `abc1234@sha256:${"a".repeat(64)}`,
      profileImages: {
        builder: {
          imageRepository:
            "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder",
          imageTag: `abc1234@sha256:${"c".repeat(64)}`,
        },
      },
    });

    expect(isReleasePayload(payload)).toBe(true);
    expect(isReleasePayload({
      ...payload,
      profileImages: {
        builder: {
          ...payload.profileImages!.builder,
          imageRepository:
            "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        },
      },
    })).toBe(false);
    expect(isReleasePayload({
      ...payload,
      profileImages: {
        builder: {
          ...payload.profileImages!.builder,
          imageTag: `def5678@sha256:${"c".repeat(64)}`,
        },
      },
    })).toBe(false);
  });

});

describe("stable-name helpers (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  it("names the Helm release by the bare gateway id", () => {
    expect(helmReleaseNameForGateway("default")).toBe("octogee-gw-default");
    expect(helmReleaseNameForGateway("bender")).toBe("octogee-gw-bender");
  });

  it("names the gateway-edge Service by the bare gateway id", () => {
    expect(gatewayEdgeServiceName("default")).toBe("gateway-edge-default");
  });

  it("names the gateway pod Service (preview surface) by the bare gateway id", () => {
    expect(gatewayPodServiceName("default")).toBe("octogee-gateway-default");
  });
});

describe("releasePayloadHash", () => {
  it("is deterministic regardless of key insertion order", () => {
    const a = samplePayload();
    const b: ReleasePayload = {
      imageTag: "abc1234",
      imageRepository:
        "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    };
    expect(releasePayloadHash(a)).toBe(releasePayloadHash(b));
  });

  it("changes when any payload value changes", () => {
    const base = releasePayloadHash(samplePayload());
    expect(releasePayloadHash(samplePayload({ imageTag: "def5678" }))).not.toBe(base);
  });
});

describe("upgradeReleasePayloadSchema", () => {
  it("removes the one retired Mac field and returns the replacement hash", () => {
    const legacyPayload = {
      ...samplePayload(),
      macOpsTokenProtocol: { version: 1 },
    };

    expect(upgradeReleasePayloadSchema(legacyPayload, releasePayloadHash(legacyPayload as never)))
      .toEqual({
        status: "upgraded",
        migration: "remove-retired-mac-ops-token-protocol",
        payload: samplePayload(),
        payloadHash: releasePayloadHash(samplePayload()),
      });
  });

  it("accepts a current payload only when its persisted hash matches", () => {
    const payload = samplePayload();

    expect(upgradeReleasePayloadSchema(payload, releasePayloadHash(payload))).toEqual({
      status: "current",
      payload,
      payloadHash: releasePayloadHash(payload),
    });
    expect(upgradeReleasePayloadSchema(payload, "0".repeat(64))).toEqual({
      status: "unsupported",
      reason: "payload-hash-mismatch",
    });
  });

  it("refuses unknown fields and a tampered legacy payload", () => {
    const unknown = { ...samplePayload(), futureField: true };
    const legacy = { ...samplePayload(), macOpsTokenProtocol: true };

    expect(upgradeReleasePayloadSchema(unknown, releasePayloadHash(unknown as never))).toEqual({
      status: "unsupported",
      reason: "unsupported-payload-schema",
    });
    expect(upgradeReleasePayloadSchema(legacy, "0".repeat(64))).toEqual({
      status: "unsupported",
      reason: "payload-hash-mismatch",
    });
  });
});

describe("classifyGatewayField", () => {
  it("classifies an unknown/new field as release-audited (conservative default)", () => {
    expect(classifyGatewayField("someFieldWeHaveNeverSeen")).toBe("release");
    expect(classifyGatewayField("futureRuntimeKnob")).toBe("release");
  });

  it("classifies every spec release field as release-audited", () => {
    for (const field of RELEASE_FIELDS) {
      expect(classifyGatewayField(field)).toBe("release");
    }
  });

  it("classifies gateway-doc fields mutable without a release as gateway-mutable", () => {
    for (const field of GATEWAY_MUTABLE_FIELDS) {
      expect(classifyGatewayField(field)).toBe("gateway-mutable");
    }
  });

  it("classifies every gateway-doc lifecycle field from the spec as gateway-mutable", () => {
    for (const field of [
      "desiredStatus",
      "liveRelease",
      "retireAfter",
    ]) {
      expect(classifyGatewayField(field)).toBe("gateway-mutable");
    }
  });

  it("no longer classifies the retired computeClass as gateway-mutable", () => {
    expect(GATEWAY_MUTABLE_FIELDS).not.toContain("computeClass");
    expect(classifyGatewayField("computeClass")).toBe("release");
  });

  it("no longer classifies retired idle-sleep state as gateway-mutable", () => {
    expect(GATEWAY_MUTABLE_FIELDS).not.toContain("idleSleep");
    expect(classifyGatewayField("idleSleep")).toBe("release");
  });

  it("classifies all former release policy fields as gateway-mutable", () => {
    expect(classifyGatewayField("builderAccess")).toBe("gateway-mutable");
    expect(classifyGatewayField("openclawOverrides")).toBe("gateway-mutable");
    expect(classifyGatewayField("allocation")).toBe("gateway-mutable");
  });
});

describe("assignment roster state + epoch (migration plane)", () => {
  it("isAssignmentState accepts exactly serving|quiescing|migrating", () => {
    expect(isAssignmentState("serving")).toBe(true);
    expect(isAssignmentState("quiescing")).toBe(true);
    expect(isAssignmentState("migrating")).toBe(true);
    expect(isAssignmentState("draining")).toBe(false);
    expect(isAssignmentState("")).toBe(false);
    expect(isAssignmentState(null)).toBe(false);
  });

  it("AssignmentDoc carries state + epoch, keyed on the bare gateway", () => {
    const doc: AssignmentDoc = {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      source: "migrate-customer",
      state: "serving",
      epoch: 3,
      updatedAt: 1,
      updatedByOperationId: null,
    };
    expect(doc.state).toBe("serving");
    expect(doc.epoch).toBe(3);
  });
});

describe("commitPlacementAtomic", () => {
  // Path-keyed store + a serialized/buffered runTransaction mirroring Firestore's
  // all-or-nothing commit. Reads see live store; writes buffer until the body
  // completes (a throw leaves the store untouched).
  function mkDb(
    seed: Record<string, Record<string, unknown>> = {},
    beforeTransaction?: (store: Map<string, Record<string, unknown>>) => void,
  ) {
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
        beforeTransaction?.(store);
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
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 3,
    desiredRelease: 3,
    liveRelease: 3,
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
  });

  const runtimeDoc = (
    gatewayId = "default",
    release = 3,
    lifecycle = "serving",
  ) => ({
    docKind: "runtime",
    gatewayId,
    release,
    lifecycle,
  });

  const mirror = { "provisioning.openclaw.gatewayId": "default", "provisioning.openclaw.controlUiEnabled": false };

  it("projects only an empty retired co-owner mirror from a desired root", () => {
    const projected = projectGatewayDesiredRootForGateway(
      backfilled({ coOwnerUids: [] }),
      "default",
    );

    expect(projected).not.toBeNull();
    expect(projected).not.toHaveProperty("coOwnerUids");
    expect(projectGatewayDesiredRootForGateway(
      backfilled({ coOwnerUids: ["uid-former-helper"] }),
      "default",
    )).toBeNull();
  });

  it("un-backfilled gateway (no GatewayDoc): writes ONLY the mirror, byte-identical to today", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "mirror-only" });
    expect(store.get("users/u1")).toMatchObject({ "provisioning.openclaw.gatewayId": "default" });
    // No assignment doc written for a legacy gateway.
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it("strict placement rejects a missing gateway without changing the user mirror", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
    });

    const result = await commitPlacementAtomic(db, {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      source: "repair",
      now: 100,
      mirrorPatch: mirror,
      requireDurableGateway: true,
    });

    expect(result).toEqual({ kind: "rejected", reason: "gateway-root-invalid" });
    expect(store.get("users/u1")).toEqual({ tier: "trial" });
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it("rejects an existing malformed root instead of falling back to a mirror-only legacy write", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": { gatewayId: "default", status: "ready" },
    });

    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });

    expect(res).toEqual({ kind: "rejected", reason: "gateway-root-invalid" });
    expect(store.get("users/u1")).toEqual({ tier: "trial" });
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it.each(["paused", "retired"] as const)(
    "rejects a %s durable root without writing a mirror or assignment",
    async (desiredStatus) => {
      const { db, store } = mkDb({
        "users/u1": { tier: "trial" },
        "gateways/default": backfilled({ desiredStatus }),
        "glmGateways/default": runtimeDoc(),
      });

      const res = await commitPlacementAtomic(db, {
        uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
      });

      expect(res).toEqual({ kind: "rejected", reason: "gateway-not-running" });
      expect(store.get("users/u1")).toEqual({ tier: "trial" });
      expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
    },
  );

  it("reads desiredStatus from the transaction snapshot before writing placement", async () => {
    const { db, store } = mkDb(
      {
        "users/u1": { tier: "trial" },
        "gateways/default": backfilled(),
        "glmGateways/default": runtimeDoc(),
      },
      (transactionStore) => {
        transactionStore.set("gateways/default", backfilled({ desiredStatus: "paused" }));
      },
    );

    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });

    expect(res).toEqual({ kind: "rejected", reason: "gateway-not-running" });
    expect(store.get("users/u1")).toEqual({ tier: "trial" });
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it("rejects an automatic placement when its transaction reads an operator-managed target or builder", async () => {
    const target = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled({ managedBy: "operator" }),
      "glmGateways/default": runtimeDoc(),
    });
    await expect(commitPlacementAtomic(target.db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "repair", now: 100,
      mirrorPatch: mirror, automatic: true,
    })).resolves.toEqual({ kind: "rejected", reason: "gateway-operator-managed" });
    expect(target.store.get("users/u1")).toEqual({ tier: "trial" });

    const builder = mkDb({
      "users/u1": { tier: "trial", provisioning: { openclaw: { managedBy: "operator" } } },
      "gateways/default": backfilled(),
      "glmGateways/default": runtimeDoc(),
    });
    await expect(commitPlacementAtomic(builder.db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "repair", now: 100,
      mirrorPatch: mirror, automatic: true,
    })).resolves.toEqual({ kind: "rejected", reason: "builder-operator-managed" });
    expect(builder.store.get("users/u1")).toEqual({
      tier: "trial", provisioning: { openclaw: { managedBy: "operator" } },
    });
  });

  it("steady gateway: writes mirror + assignment on the serving gateway (serving, epoch 0)", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled(),
      "glmGateways/default": runtimeDoc(),
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "assigned", release: 3 });
    expect(store.get("gateways/default/assignments/u1")).toMatchObject({
      uid: "u1", slug: "s1", gatewayId: "default",
      source: "onboarding", state: "serving", epoch: 0, updatedAt: 100, updatedByOperationId: null,
    });
    expect(store.get("users/u1")).toMatchObject({ "provisioning.openclaw.gatewayId": "default" });
  });

  it("creates a guarded user field and its side document in the placement transaction", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled(),
      "glmGateways/default": runtimeDoc(),
    });

    await commitPlacementAtomic(db, {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      source: "onboarding",
      now: 100,
      mirrorPatch: mirror,
      atomicCreate: {
        userField: "trialGrant",
        userPatch: { trialGrant: { offerVersion: 3 } },
        writes: [{
          collection: "modelBrokerSignupOfferBudgets",
          document: "so_new",
          data: { chargeUsd: 0 },
        }],
      },
    });

    expect(store.get("users/u1")?.trialGrant).toEqual({ offerVersion: 3 });
    expect(store.get("modelBrokerSignupOfferBudgets/so_new")).toEqual({ chargeUsd: 0 });
  });

  it("preserves a user field created after caller preparation and skips its stale side write", async () => {
    const concurrentReceipt = { offerVersion: 2, configHash: "winner" };
    const { db, store } = mkDb(
      {
        "users/u1": { tier: "trial" },
        "gateways/default": backfilled(),
        "glmGateways/default": runtimeDoc(),
      },
      (transactionStore) => {
        transactionStore.set("users/u1", { tier: "trial", trialGrant: concurrentReceipt });
      },
    );

    await commitPlacementAtomic(db, {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      source: "onboarding",
      now: 100,
      mirrorPatch: mirror,
      atomicCreate: {
        userField: "trialGrant",
        userPatch: { trialGrant: { offerVersion: 3, configHash: "stale" } },
        writes: [{
          collection: "modelBrokerSignupOfferBudgets",
          document: "so_stale",
          data: { chargeUsd: 0 },
        }],
      },
    });

    expect(store.get("users/u1")?.trialGrant).toEqual(concurrentReceipt);
    expect(store.get("modelBrokerSignupOfferBudgets/so_stale")).toBeUndefined();
  });

  it("places through an empty retired co-owner mirror but rejects a non-empty one", async () => {
    const empty = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled({ coOwnerUids: [] }),
      "glmGateways/default": runtimeDoc(),
    });
    await expect(commitPlacementAtomic(empty.db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    })).resolves.toEqual({ kind: "assigned", release: 3 });

    const nonEmpty = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled({ coOwnerUids: ["uid-former-helper"] }),
      "glmGateways/default": runtimeDoc(),
    });
    await expect(commitPlacementAtomic(nonEmpty.db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    })).resolves.toEqual({ kind: "rejected", reason: "gateway-root-invalid" });
  });

  it("create-if-missing repair preserves an existing in-flight assignment byte-for-byte", async () => {
    const existing = {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      source: "migrate-customer",
      state: "quiescing",
      epoch: 7,
      updatedAt: 90,
      updatedByOperationId: "migrate-default-1",
    };
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled(),
      "gateways/default/assignments/u1": existing,
      "glmGateways/default": runtimeDoc(),
    });

    const res = await commitPlacementAtomic(db, {
      uid: "u1",
      slug: "s1",
      gatewayId: "default",
      source: "repair",
      now: 100,
      mirrorPatch: mirror,
      assignmentWrite: "create-if-missing",
    });

    expect(res).toEqual({ kind: "assignment-preserved" });
    expect(store.get("gateways/default/assignments/u1")).toEqual(existing);
    expect(store.get("users/u1")).toMatchObject({ "provisioning.openclaw.gatewayId": "default" });
  });

  it("rejects when the gateway runtime is not serving and writes NOTHING", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled(),
      "glmGateways/default": runtimeDoc("default", 3, "provisioning"),
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "rejected", reason: "gateway-not-serving" });
    expect(store.get("users/u1")).toEqual({ tier: "trial" }); // mirror untouched
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it("rejects a runtime doc that does not belong to the placed gateway", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled(),
      "glmGateways/default": runtimeDoc("other-gateway"),
    });

    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });

    expect(res).toEqual({ kind: "rejected", reason: "gateway-not-serving" });
    expect(store.get("users/u1")).toEqual({ tier: "trial" });
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });

  it("rejects when the gateway has no runtime realization yet", async () => {
    const { db } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled({ liveRelease: null }),
    });
    const res = await commitPlacementAtomic(db, {
      uid: "u1", slug: "s1", gatewayId: "default", source: "onboarding", now: 100, mirrorPatch: mirror,
    });
    expect(res).toEqual({ kind: "rejected", reason: "gateway-not-serving" });
  });

  it("mirror and assignment are all-or-nothing: neither lands if the commit throws", async () => {
    const { db, store } = mkDb({
      "users/u1": { tier: "trial" },
      "gateways/default": backfilled(),
      "glmGateways/default": runtimeDoc(),
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
            String((data as { uid?: unknown }).uid) === "u1"
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
    expect(store.get("users/u1")).toEqual({ tier: "trial" });
    expect(store.get("gateways/default/assignments/u1")).toBeUndefined();
  });
});
