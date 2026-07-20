import { describe, expect, it } from "vitest";

import type { Firestore, Transaction } from "firebase-admin/firestore";
import {
  readRevisionInternalUrl,
  resolveRedeemGatewayUrl,
  resolveServingRevisionId,
} from "./openclaw-runtime-broker.js";

const LEGACY_URL = "ws://octogee-gateway-default.octogee-test.svc.cluster.local:18789";
const RUNTIME_URL = "ws://octogee-gateway-default.octogee-test.svc.cluster.local:18789";

function assignmentDoc(gatewayId = "default"): Record<string, unknown> {
  return {
    uid: "u1",
    slug: "acme",
    gatewayId,
    source: "onboarding",
  };
}

describe("resolveServingRevisionId", () => {
  it("resolves an assigned customer to the bare gateway", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: { liveRelease: 9 },
      assignmentData: assignmentDoc(),
      uid: "u1",
      gatewayId: "default",
    });
    expect(revisionId).toBe("default");
  });

  it("resolves a gap user (no assignment) via the gateway's live release", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: { liveRelease: 9 },
      assignmentData: undefined,
      uid: "u1",
      gatewayId: "default",
    });
    expect(revisionId).toBe("default");
  });

  it("ignores a junk/partial assignment doc and falls back to the live release", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: { liveRelease: 9 },
      assignmentData: { gatewayId: "default" }, // missing slug/source → not a valid assignment
      uid: "u1",
      gatewayId: "default",
    });
    expect(revisionId).toBe("default");
  });

  it("returns null when neither an assignment nor a live release resolves", () => {
    const revisionId = resolveServingRevisionId({
      gatewayData: {},
      assignmentData: undefined,
      uid: "u1",
      gatewayId: "default",
    });
    expect(revisionId).toBeNull();
  });
});

describe("readRevisionInternalUrl", () => {
  it("returns the runtime heartbeat internalUrl when it belongs to the bound gateway", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gatewayId: "default", heartbeat: { internalUrl: RUNTIME_URL } },
      expectedGatewayId: "default",
      revisionId: "default",
    });
    expect(result).toEqual({ url: RUNTIME_URL });
  });

  it("fails loud when the runtime doc belongs to another gateway (never dial a wrong pod)", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gatewayId: "bender", heartbeat: { internalUrl: RUNTIME_URL } },
      expectedGatewayId: "default",
      revisionId: "default",
    });
    expect("error" in result).toBe(true);
  });

  it("fails loud when the runtime has no serving internalUrl", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gatewayId: "default", heartbeat: { internalUrl: "" } },
      expectedGatewayId: "default",
      revisionId: "default",
    });
    expect("error" in result).toBe(true);
  });

  it("fails loud when the runtime doc is missing", () => {
    const result = readRevisionInternalUrl({
      revisionData: undefined,
      expectedGatewayId: "default",
      revisionId: "default",
    });
    expect("error" in result).toBe(true);
  });

  it("rejects a FAILED runtime even when it still carries a stale internalUrl", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gatewayId: "default", lifecycle: "failed", heartbeat: { internalUrl: RUNTIME_URL } },
      expectedGatewayId: "default",
      revisionId: "default",
    });
    expect("error" in result).toBe(true);
  });

  it("resolves a serving runtime", () => {
    const result = readRevisionInternalUrl({
      revisionData: { gatewayId: "default", lifecycle: "serving", heartbeat: { internalUrl: RUNTIME_URL } },
      expectedGatewayId: "default",
      revisionId: "default",
    });
    expect(result).toEqual({ url: RUNTIME_URL });
  });
});

// A GatewayDoc shape isGatewayDesiredDoc accepts.
function desiredDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "default",
    desiredRelease: 7,
    latestRelease: 7,
    liveRelease: 7,
    desiredStatus: "running",
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
  it("a TRUE legacy heartbeat doc uses its flat internalUrl byte-identically (no runtime resolution)", async () => {
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

  it("a GatewayDoc carrying a STALE flat internalUrl resolves via the bare runtime doc, NOT the flat field", async () => {
    const { tx, db } = fakeRedeemDeps({
      "gateways/default/assignments/u1": assignmentDoc(),
      "glmGateways/default": {
        gatewayId: "default",
        lifecycle: "serving",
        heartbeat: { internalUrl: RUNTIME_URL },
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
    expect(result).toEqual({ url: RUNTIME_URL });
  });

  it("a GatewayDoc with a gap user (no assignment) resolves via the live release", async () => {
    const { tx, db } = fakeRedeemDeps({
      "glmGateways/default": {
        gatewayId: "default",
        lifecycle: "serving",
        heartbeat: { internalUrl: RUNTIME_URL },
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
    expect(result).toEqual({ url: RUNTIME_URL });
  });

  it("resolves only an empty retired co-owner mirror on the desired root", async () => {
    const { tx, db } = fakeRedeemDeps({
      "glmGateways/default": {
        gatewayId: "default",
        lifecycle: "serving",
        heartbeat: { internalUrl: RUNTIME_URL },
      },
    });
    await expect(resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: true,
      gatewayData: desiredDoc({ coOwnerUids: [] }),
    })).resolves.toEqual({ url: RUNTIME_URL });
    await expect(resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: true,
      gatewayData: desiredDoc({ coOwnerUids: ["uid-former-helper"] }),
    })).resolves.toEqual({ error: "gateway-root-invalid" });
  });

  it("fails loud (no url) rather than dial the stale flat field when a desired doc cannot resolve", async () => {
    const { tx, db } = fakeRedeemDeps({});
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      uid: "u1",
      gatewayExists: true,
      // Desired doc, never realized, no assignment → unresolved, never the flat URL.
      gatewayData: desiredDoc({ internalUrl: LEGACY_URL, liveRelease: null }),
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
