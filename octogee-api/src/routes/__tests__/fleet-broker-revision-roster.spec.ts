import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  buildRosterRevisionFilter,
  isRequestedRevisionAllowed,
  isRevisionRosterRequestAllowed,
} from "../fleet-broker.js";

// Fake Firestore covering gateways/{id}/assignments/{uid}. The roster filter is
// the live mount driver: during a same-gateway roll both revision pods call it
// with the SAME bare tenant, and it keeps each pod to its own revision.
function mkDb(assignments: Record<string, { revisionId: string }> = {}): Firestore {
  return {
    collection: (name: string) => {
      if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
      return {
        doc: (_gatewayId: string) => ({
          collection: (_sub: string) => ({
            get: async () => ({
              docs: Object.entries(assignments).map(([uid, data]) => ({
                id: uid,
                data: () => ({
                  uid,
                  slug: uid,
                  gatewayId: "default",
                  revisionId: data.revisionId,
                  release: 1,
                  source: "rollout",
                  updatedAt: 1,
                  updatedByOperationId: null,
                }),
              })),
            }),
          }),
        }),
      };
    },
  } as unknown as Firestore;
}

describe("buildRosterRevisionFilter", () => {
  it("legacy pod (empty revisionId) mounts every user — byte-identical to today", async () => {
    const filter = await buildRosterRevisionFilter(mkDb(), "default", "", null);
    expect(filter("anyone")).toBe(true);
    expect(filter("someone-else")).toBe(true);
  });

  it("single-revision gateway: every assigned + gap user mounts on the live revision", async () => {
    const filter = await buildRosterRevisionFilter(
      mkDb({ assigned: { revisionId: "default-r1" } }),
      "default",
      "default-r1",
      "default-r1",
    );
    expect(filter("assigned")).toBe(true); // assignment on r1
    expect(filter("gapper")).toBe(true); // no assignment -> live revision r1
  });

  it("two-revision roll: assigned users mount only on their revision; a gap user only on live", async () => {
    const db = mkDb({
      onSource: { revisionId: "default-r1" },
      onTarget: { revisionId: "default-r2" },
    });
    const live = await buildRosterRevisionFilter(db, "default", "default-r1", "default-r1");
    const target = await buildRosterRevisionFilter(db, "default", "default-r2", "default-r1");

    // Live revision pod: source-assigned + gap user; NOT the target-assigned user.
    expect(live("onSource")).toBe(true);
    expect(live("onTarget")).toBe(false);
    expect(live("gapper")).toBe(true);

    // Warming target pod: only its assigned user — the gap user stays on live, NOT both.
    expect(target("onTarget")).toBe(true);
    expect(target("onSource")).toBe(false);
    expect(target("gapper")).toBe(false);
  });
});

describe("isRequestedRevisionAllowed (P1 — same-gateway revision spoofing)", () => {
  const rollingGateway = {
    liveRevisionId: "default-r1",
    roll: { targetRevisionId: "default-r2" },
  };

  it("legacy pod (empty revisionId) is allowed", () => {
    expect(isRequestedRevisionAllowed("default", "", rollingGateway)).toBe(true);
  });

  it("rejects a revision belonging to another gateway", () => {
    expect(isRequestedRevisionAllowed("default", "other-gw-r1", rollingGateway)).toBe(false);
  });

  it("rejects a bogus non-active revision of the bound gateway", () => {
    expect(isRequestedRevisionAllowed("default", "default-r99", rollingGateway)).toBe(false);
  });

  it("allows the live revision and the active roll target", () => {
    expect(isRequestedRevisionAllowed("default", "default-r1", rollingGateway)).toBe(true);
    expect(isRequestedRevisionAllowed("default", "default-r2", rollingGateway)).toBe(true);
  });

  it("allows the desired revision while a durable gateway has no live revision yet", () => {
    const firstRevision = {
      desiredRelease: 1,
      liveRevisionId: null,
      roll: null,
    };
    expect(isRequestedRevisionAllowed("default", "default-r1", firstRevision)).toBe(true);
    expect(isRequestedRevisionAllowed("default", "default-r2", firstRevision)).toBe(false);
  });

  it("pre-backfill (no gateway doc): prefix is the only boundary", () => {
    expect(isRequestedRevisionAllowed("default", "default-r5", undefined)).toBe(true);
    expect(isRequestedRevisionAllowed("default", "other-gw-r5", undefined)).toBe(false);
  });
});

describe("isRevisionRosterRequestAllowed (P0 — omitted revisionId roster downgrade)", () => {
  const gw = "default";
  const desiredDoc = { liveRevisionId: "default-r1", roll: { targetRevisionId: "default-r2" } };

  it("backfilled gateway (desired doc) + omitted revisionId → rejected (no full roster leak)", () => {
    expect(
      isRevisionRosterRequestAllowed({
        gatewayId: gw,
        podRevisionId: "",
        gatewayDoc: desiredDoc,
        hasAssignmentDocs: false,
      }),
    ).toBe(false);
  });

  it("backfilled gateway (assignment docs but no desired doc yet) + omitted revisionId → rejected", () => {
    expect(
      isRevisionRosterRequestAllowed({
        gatewayId: gw,
        podRevisionId: "",
        gatewayDoc: undefined,
        hasAssignmentDocs: true,
      }),
    ).toBe(false);
  });

  it("backfilled gateway + a valid revisionId → allowed (the roster is then revision-filtered)", () => {
    expect(
      isRevisionRosterRequestAllowed({
        gatewayId: gw,
        podRevisionId: "default-r1",
        gatewayDoc: desiredDoc,
        hasAssignmentDocs: true,
      }),
    ).toBe(true);
  });

  it("legacy gateway (no desired doc, no assignments) + omitted revisionId → allowed (full roster, byte-identical to today)", () => {
    expect(
      isRevisionRosterRequestAllowed({
        gatewayId: gw,
        podRevisionId: "",
        gatewayDoc: undefined,
        hasAssignmentDocs: false,
      }),
    ).toBe(true);
  });

  it("legacy gateway + a bogus (wrong-gateway) revisionId → still rejected", () => {
    expect(
      isRevisionRosterRequestAllowed({
        gatewayId: gw,
        podRevisionId: "other-gw-r1",
        gatewayDoc: undefined,
        hasAssignmentDocs: false,
      }),
    ).toBe(false);
  });
});
