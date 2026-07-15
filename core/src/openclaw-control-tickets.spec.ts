import { describe, expect, it } from "vitest";

import {
  OPENCLAW_CONTROL_TICKET_TTL_MS,
  createOpenClawControlTicket,
  openClawControlTicketHash,
  redeemableOpenClawControlTicket,
} from "./openclaw-control-tickets.js";

describe("OpenClaw Control tickets", () => {
  it("mints 256-bit URL-safe material while persisting only its hash", () => {
    const minted = createOpenClawControlTicket({
      uid: "uid-owner",
      gatewayId: "bender",
      revisionId: "bender-r7",
      now: 1_000,
      random: () => Buffer.alloc(32, 7),
    });

    expect(minted.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(minted.ticketHash).toBe(openClawControlTicketHash(minted.ticket));
    expect(minted.document).toMatchObject({
      uid: "uid-owner",
      gatewayId: "bender",
      revisionId: "bender-r7",
      expiresAt: 1_000 + OPENCLAW_CONTROL_TICKET_TTL_MS,
    });
    expect(JSON.stringify(minted.document)).not.toContain(minted.ticket);
  });

  it("rejects expired, malformed, and cross-revision redemption", () => {
    const document = {
      uid: "uid-owner",
      gatewayId: "bender",
      revisionId: "bender-r7",
      expiresAt: 20_000,
    };
    expect(redeemableOpenClawControlTicket({
      document,
      gatewayId: "bender",
      revisionId: "bender-r7",
      now: 19_999,
    })).toMatchObject({ uid: "uid-owner" });
    expect(redeemableOpenClawControlTicket({
      document,
      gatewayId: "bender",
      revisionId: "bender-r8",
      now: 19_999,
    })).toBeNull();
    expect(redeemableOpenClawControlTicket({
      document,
      gatewayId: "bender",
      revisionId: "bender-r7",
      now: 20_000,
    })).toBeNull();
    expect(redeemableOpenClawControlTicket({
      document: { ...document, uid: "" },
      gatewayId: "bender",
      revisionId: "bender-r7",
      now: 19_999,
    })).toBeNull();
  });
});
