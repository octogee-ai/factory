import { describe, expect, it, vi } from "vitest";

import {
  auditOpenClawControlRpc,
  authorizeOpenClawControlSession,
  redeemOpenClawControlTicket,
} from "./broker.js";

const sessionId = "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70";

describe("OpenClaw Dashboard broker client", () => {
  it("redeems and reauthorizes the broker session by opaque session id", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? new Response(JSON.stringify({
            uid: "uid-owner",
            gatewayId: "bender",
            revisionId: "bender-r7",
            expiresAt: 10_000,
          }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await expect(redeemOpenClawControlTicket({
      ticket: "ticket",
      sessionId,
      gatewayId: "bender",
      revisionId: "bender-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    })).resolves.toMatchObject({ uid: "uid-owner" });
    await expect(authorizeOpenClawControlSession({
      sessionId,
      gatewayId: "bender",
      revisionId: "bender-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    })).resolves.toBe(true);
    expect(bodies).toEqual([
      { gatewayId: "bender", revisionId: "bender-r7", sessionId, ticket: "ticket" },
      { gatewayId: "bender", revisionId: "bender-r7", sessionId },
    ]);
  });

  it("sends only canonical audit category/outcome and never raw tool or upstream material", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const serialized = String(init?.body);
      expect(JSON.parse(serialized)).toEqual({
        gatewayId: "bender",
        revisionId: "bender-r7",
        sessionId,
        events: [{
          event: "rpc_allow",
          methodCategory: "tools_invoke",
          outcome: "ok",
          reason: "none",
        }],
      });
      for (const forbidden of [
        "memory_search",
        "prior decision",
        "gateway-token",
        "upstream exploded",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await auditOpenClawControlRpc({
      gatewayId: "bender",
      revisionId: "bender-r7",
      sessionId,
      event: "rpc_allow",
      category: "tools_invoke",
      outcome: "ok",
      reason: "none",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    });
  });

  it("rejects a malformed redemption response before issuing a local session", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      uid: "",
      gatewayId: "bender",
      revisionId: "bender-r7",
      expiresAt: "later",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(redeemOpenClawControlTicket({
      ticket: "ticket",
      sessionId,
      gatewayId: "bender",
      revisionId: "bender-r7",
      env: { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test" },
      fetchImpl,
    })).rejects.toThrow(/invalid JSON/i);
  });
});
