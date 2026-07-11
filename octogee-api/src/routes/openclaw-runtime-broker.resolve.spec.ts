import { describe, expect, it } from "vitest";

import type { Firestore, Transaction } from "firebase-admin/firestore";
import {
  readRevisionInternalUrl,
  resolveRedeemGatewayUrl,
  resolveServingRevisionId,
} from "./openclaw-runtime-broker.js";

const LEGACY_URL = "ws://octogee-gateway-default.octogee-test.svc.cluster.local:18789";
const REV_URL = "ws://octogee-gateway-default-r7.octogee-test.svc.cluster.local:18789";

function assignmentDoc(revisionId: string, gatewayId = "default"): Record<string, unknown> {
  return {
    uid: "u1",
    slug: "acme",
    gatewayId,
    revisionId,
    release: 7,
    source: "onboarding",
  };
}

describe("resolveServingRevisionId", () => {
  it("prefers the customer's assignment-doc revision", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: { liveRevisionId: "default-r9" },
      assignmentData: assignmentDoc("default-r7"),
      uid: "u1",
    });
    expect(revisionId).toBe("default-r7");
  });

  it("falls back to the gateway's live revision for a gap user (no assignment)", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: { liveRevisionId: "default-r9" },
      assignmentData: undefined,
      uid: "u1",
    });
    expect(revisionId).toBe("default-r9");
  });

  it("ignores a junk/partial assignment doc and falls back to live revision", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: { liveRevisionId: "default-r9" },
      assignmentData: { revisionId: "default-r7" }, // missing slug/release/source → not a valid assignment
      uid: "u1",
    });
    expect(revisionId).toBe("default-r9");
  });

  it("returns null when neither an assignment nor a live revision resolves", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: {},
      assignmentData: undefined,
      uid: "u1",
    });
    expect(revisionId).toBeNull();
  });
});

describe("readRevisionInternalUrl", () => {
  it("returns the revision heartbeat internalUrl when the revision belongs to the bound gateway", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gateway: "default", heartbeat: { internalUrl: REV_URL } },
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect(result).toEqual({ url: REV_URL });
  });

  it("fails loud when the revision belongs to another gateway (never dial a wrong revision)", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gateway: "bender", heartbeat: { internalUrl: REV_URL } },
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect("error" in result).toBe(true);
  });

  it("fails loud when the revision has no serving internalUrl", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gateway: "default", heartbeat: { internalUrl: "" } },
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect("error" in result).toBe(true);
  });

  it("fails loud when the revision doc is missing", () => {
    const result = readRevisionInternalUrl({
      revisionData: undefined,
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect("error" in result).toBe(true);
  });

  it("rejects a RETIRED revision even when it still carries a stale internalUrl (never dial a corpse)", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gateway: "default", lifecycle: "retired", heartbeat: { internalUrl: REV_URL } },
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect("error" in result).toBe(true);
  });

  it("rejects a revision whose retiredAt is set", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gateway: "default", retiredAt: 123, heartbeat: { internalUrl: REV_URL } },
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect("error" in result).toBe(true);
  });

  it("rejects a FAILED revision", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gateway: "default", lifecycle: "failed", heartbeat: { internalUrl: REV_URL } },
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect("error" in result).toBe(true);
  });

  it("resolves a serving revision (lifecycle serving, retiredAt null)", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gateway: "default", lifecycle: "serving", retiredAt: null, heartbeat: { internalUrl: REV_URL } },
      expectedGatewayId: "default",
      revisionId: "default-r7",
    });
    expect(result).toEqual({ url: REV_URL });
  });
});

// A GatewayDoc shape isGatewayDesiredDoc accepts.
function desiredDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "default",
    desiredRelease: 7,
    latestRelease: 7,
    desiredStatus: "running",
    liveRevisionId: "default-r7",
    configSchemaVersion: 1,
    profile: "standard",
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
    ...extra,
  };
}

// Fake redeem transaction: db.doc(path) returns the path as a token; tx.get maps
// the token back to a seeded snapshot.
function fakeRedeemDeps(snaps: Record<string, Record<string, unknown> | undefined>): {
  tx: Transaction;
  db: Firestore;
} {
  const db = { doc: (path: string) => ({ __path: path }) } as unknown as Firestore;
  const tx = {
    get: async (ref: { __path: string }) => ({
      exists: snaps[ref.__path] !== undefined,
      data: () => snaps[ref.__path],
    }),
  } as unknown as Transaction;
  return { tx, db };
}

describe("resolveRedeemGatewayUrl — broker discriminates a real legacy doc", () => {
  it("a TRUE legacy heartbeat doc uses its flat internalUrl byte-identically (no revision resolution)", async () => {
    const { tx, db } = fakeRedeemDeps({});
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: false,
      gatewayData: { internalUrl: LEGACY_URL },
    });
    expect(result).toEqual({ url: LEGACY_URL });
  });

  it("a backfilled GatewayDoc carrying a STALE flat internalUrl resolves via the assignment revision, NOT the flat field", async () => {
    const { tx, db } = fakeRedeemDeps({
      "gateways/default/assignments/u1": assignmentDoc("default-r7"),
      "glmGateways/default-r7": {
        gateway: "default",
        lifecycle: "serving",
        retiredAt: null,
        heartbeat: { internalUrl: REV_URL },
      },
    });
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: true,
      // Contaminated: a desired doc that ALSO carries a stale flat internalUrl.
      gatewayData: desiredDoc({ internalUrl: LEGACY_URL }),
    });
    expect(result).toEqual({ url: REV_URL });
  });

  it("a backfilled GatewayDoc with a gap user (no assignment) resolves via liveRevisionId", async () => {
    const { tx, db } = fakeRedeemDeps({
      "glmGateways/default-r7": {
        gateway: "default",
        lifecycle: "serving",
        retiredAt: null,
        heartbeat: { internalUrl: REV_URL },
      },
    });
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: true,
      gatewayData: desiredDoc({ internalUrl: LEGACY_URL }),
    });
    expect(result).toEqual({ url: REV_URL });
  });

  it("fails loud (no url) rather than dial the stale flat field when a desired doc cannot resolve a revision", async () => {
    const { tx, db } = fakeRedeemDeps({});
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: true,
      // Desired doc, no liveRevisionId, no assignment → unresolved, never the flat URL.
      gatewayData: desiredDoc({ internalUrl: LEGACY_URL, liveRevisionId: null }),
    });
    expect("error" in result).toBe(true);
  });

  it("rejects an existing incomplete root instead of treating its flat URL as legacy", async () => {
    const { tx, db } = fakeRedeemDeps({});
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: true,
      gatewayData: {
        gatewayId: "default",
        desiredRelease: 7,
        latestRelease: 7,
        desiredStatus: "running",
        internalUrl: LEGACY_URL,
      },
    });

    expect(result).toEqual({ error: "gateway-root-invalid" });
  });
});
