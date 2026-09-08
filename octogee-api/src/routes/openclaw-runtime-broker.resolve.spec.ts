import { describe, expect, it } from "vitest";

import type { Firestore, Transaction } from "firebase-admin/firestore";
import { resolveRedeemGatewayUrl } from "./openclaw-runtime-broker.js";

const LEGACY_URL = "ws://retired-gateway.octogee-test.svc.cluster.local:18789";
const RUNTIME_URL = "ws://octogee-gateway-default.octogee-test.svc.cluster.local:18789";

function assignmentDoc(gatewayId = "default"): Record<string, unknown> {
  return { uid: "u1", slug: "acme", gatewayId, source: "onboarding" };
}

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
    ...extra,
  };
}

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

describe("resolveRedeemGatewayUrl", () => {
  it("rejects a legacy heartbeat without a durable gateway root", async () => {
    const { tx, db } = fakeRedeemDeps({});
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      gatewayData: { internalUrl: LEGACY_URL },
    });
    expect(result).toEqual({ error: "gateway-root-invalid" });
  });

  it("requires a live release even when a customer assignment exists", async () => {
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
      gatewayData: desiredDoc({ liveRelease: null }),
    });
    expect(result).toEqual({ error: "gateway-url-unresolved" });
  });

  it("uses the bound gateway runtime and ignores a flat root URL", async () => {
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
      gatewayData: desiredDoc({ internalUrl: LEGACY_URL }),
    });
    expect(result).toEqual({ url: RUNTIME_URL });
  });

  it("resolves the live runtime without a customer assignment", async () => {
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
      gatewayData: desiredDoc({ coOwnerUids: [] }),
    })).resolves.toEqual({ url: RUNTIME_URL });
    await expect(resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
      gatewayData: desiredDoc({ coOwnerUids: ["uid-former-helper"] }),
    })).resolves.toEqual({ error: "gateway-root-invalid" });
  });

  it("rejects an unrealized gateway instead of dialing a flat root URL", async () => {
    const { tx, db } = fakeRedeemDeps({});
    const result = await resolveRedeemGatewayUrl({
      tx,
      db,
      gatewayId: "default",
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

  it.each([
    ["missing root", undefined],
    ["foreign root", desiredDoc({ gatewayId: "other" })],
  ])("rejects a %s", async (_name, gatewayData) => {
    const { tx, db } = fakeRedeemDeps({});
    await expect(resolveRedeemGatewayUrl({ tx, db, gatewayId: "default", gatewayData }))
      .resolves.toEqual({ error: "gateway-root-invalid" });
  });

  it.each([
    ["missing runtime", undefined],
    ["foreign runtime", { gatewayId: "other", heartbeat: { internalUrl: RUNTIME_URL } }],
    ["failed runtime", { gatewayId: "default", lifecycle: "failed", heartbeat: { internalUrl: RUNTIME_URL } }],
    ["retired runtime", { gatewayId: "default", lifecycle: "retired", heartbeat: { internalUrl: RUNTIME_URL } }],
    ["retired timestamp", { gatewayId: "default", retiredAt: 1, heartbeat: { internalUrl: RUNTIME_URL } }],
    ["missing URL", { gatewayId: "default", heartbeat: {} }],
    ["empty URL", { gatewayId: "default", heartbeat: { internalUrl: "" } }],
  ])("rejects a %s", async (_name, runtime) => {
    const { tx, db } = fakeRedeemDeps({ "glmGateways/default": runtime });
    const result = await resolveRedeemGatewayUrl({
      tx, db, gatewayId: "default", gatewayData: desiredDoc(),
    });
    expect(result).toHaveProperty("error");
  });

});
