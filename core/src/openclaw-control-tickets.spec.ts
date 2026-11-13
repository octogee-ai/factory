import { describe, expect, it } from "vitest";

import {
  OPENCLAW_CONTROL_TICKET_TTL_MS,
  createOpenClawControlTicket,
  inspectOpenClawControlTicket,
  openClawControlTicketHash,
  redeemableOpenClawControlTicket,
} from "./openclaw-control-tickets.js";

describe("OpenClaw Control tickets", () => {
  it("allows a bounded two-minute handoff from the launcher to the Dashboard", () => {
    expect(OPENCLAW_CONTROL_TICKET_TTL_MS).toBe(120_000);
  });

  it("mints 256-bit URL-safe material while persisting only its hash", () => {
    const minted = createOpenClawControlTicket({
      uid: "uid-owner",
      gatewayId: "walter",
      workspaceSlug: "alex",
      revisionId: "walter-r7",



      now: 1_000,
      random: () => Buffer.alloc(32, 7),
    });

    expect(minted.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(minted.ticketHash).toBe(openClawControlTicketHash(minted.ticket));
    expect(minted.document).toMatchObject({
      uid: "uid-owner",
      gatewayId: "walter",
      workspaceSlug: "alex",
      revisionId: "walter-r7",



      expiresAt: 1_000 + OPENCLAW_CONTROL_TICKET_TTL_MS,
    });
    expect(JSON.stringify(minted.document)).not.toContain(minted.ticket);
  });

  it("rejects expired, malformed, and cross-revision redemption", () => {
    const document = {
      uid: "uid-owner",
      gatewayId: "walter",
      workspaceSlug: "alex",
      revisionId: "walter-r7",
      expiresAt: 20_000,



    };
    expect(redeemableOpenClawControlTicket({
      document,
      gatewayId: "walter",
      revisionId: "walter-r7",
      now: 19_999,
    })).toMatchObject({ uid: "uid-owner" });
    expect(redeemableOpenClawControlTicket({
      document,
      gatewayId: "walter",
      revisionId: "walter-r8",
      now: 19_999,
    })).toBeNull();
    expect(redeemableOpenClawControlTicket({
      document,
      gatewayId: "walter",
      revisionId: "walter-r7",
      now: 20_000,
    })).toBeNull();
    expect(redeemableOpenClawControlTicket({
      document: { ...document, uid: "" },
      gatewayId: "walter",
      revisionId: "walter-r7",
      now: 19_999,
    })).toBeNull();
  });

  it("classifies replay, expiry, and scope mismatch without exposing ticket material", () => {
    const document = {
      uid: "uid-owner",
      gatewayId: "walter",
      workspaceSlug: "alex",
      revisionId: "walter-r7",
      expiresAt: 20_000,



    };
    expect(inspectOpenClawControlTicket({
      document,
      gatewayId: "walter",
      revisionId: "walter-r7",
      now: 19_999,
    })).toMatchObject({ kind: "redeemable", uid: "uid-owner" });
    expect(inspectOpenClawControlTicket({
      document: { ...document, redeemedAt: 19_000 },
      gatewayId: "walter",
      revisionId: "walter-r7",
      now: 19_999,
    })).toMatchObject({ kind: "rejected", reason: "ticket_replay", uid: "uid-owner" });
    expect(inspectOpenClawControlTicket({
      document,
      gatewayId: "other",
      revisionId: "other-r7",
      now: 19_999,
    })).toMatchObject({ kind: "rejected", reason: "gateway_mismatch", uid: "uid-owner" });
    expect(inspectOpenClawControlTicket({
      document,
      gatewayId: "walter",
      revisionId: "walter-r8",
      now: 19_999,
    })).toMatchObject({ kind: "rejected", reason: "revision_mismatch", uid: "uid-owner" });
    expect(inspectOpenClawControlTicket({
      document,
      gatewayId: "walter",
      revisionId: "walter-r7",
      now: 20_000,
    })).toMatchObject({ kind: "rejected", reason: "ticket_expired", uid: "uid-owner" });
    expect(inspectOpenClawControlTicket({
      document: undefined,
      gatewayId: "walter",
      revisionId: "walter-r7",
      now: 19_999,
    })).toEqual({ kind: "rejected", reason: "ticket_invalid" });
  });
});
