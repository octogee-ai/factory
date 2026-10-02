import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  createRollRosterGate,
  createRollRosterStore,
  createRollRosterUpgradeGate,
  guardUpgradeRequest,
  mmRosterVerdictFor,
  resolveServiceRoute,
  revisionUnavailableUpgradeResponse,
  uidFromAuthHeader,
  wrapRedeemWithRosterGate,
  type RosterDocSnapshot,
  type RosterEntry,
} from "../roll-roster.js";

// Fake bearer with an arbitrary (unverified) payload — the gate uses it ONLY to
// choose between serving and 503-retry for a tenant this pod already serves;
// real auth still happens downstream.
function bearerFor(uid: string): string {
  const payload = Buffer.from(JSON.stringify({ user_id: uid })).toString("base64url");
  return `Bearer h.${payload}.s`;
}

describe("uidFromAuthHeader — routing-only, unverified decode", () => {
  it("extracts user_id / sub from a bearer JWT payload", () => {
    expect(uidFromAuthHeader(bearerFor("uid-1"))).toBe("uid-1");
    const subPayload = Buffer.from(JSON.stringify({ sub: "uid-2" })).toString("base64url");
    expect(uidFromAuthHeader(`Bearer h.${subPayload}.s`)).toBe("uid-2");
  });

  it("returns null for absent/garbage headers", () => {
    expect(uidFromAuthHeader(undefined)).toBeNull();
    expect(uidFromAuthHeader("Bearer nope")).toBeNull();
    expect(uidFromAuthHeader("Basic abc")).toBeNull();
    expect(uidFromAuthHeader("Bearer a.!!!.c")).toBeNull();
  });
});

describe("resolveServiceRoute — per-customer admission (migration quiesce gate)", () => {
  it("503s EVERYTHING customer-state until the roster is loaded — never serve-local on boot", () => {
    expect(resolveServiceRoute({ rosterLoaded: false, entry: null })).toEqual({
      action: "unavailable",
      reason: "roster-loading",
    });
  });

  it("serves a gap user (no roster entry) locally — this pod is the gateway's only pod", () => {
    expect(resolveServiceRoute({ rosterLoaded: true, entry: null })).toEqual({ action: "serve" });
  });

  it("serves a customer whose assignment is serving", () => {
    const entry: RosterEntry = { uid: "uid-1", state: "serving", epoch: 4 };
    expect(resolveServiceRoute({ rosterLoaded: true, entry })).toEqual({ action: "serve" });
  });

  it.each(["quiescing", "migrating"] as const)(
    "BLOCKS a %s customer until the atomic cutover stamps the target serving (no double-serve window)",
    (state) => {
      const entry: RosterEntry = { uid: "uid-1", state, epoch: 4 };
      expect(resolveServiceRoute({ rosterLoaded: true, entry })).toEqual({
        action: "unavailable",
        reason: "customer-quiescing",
      });
    },
  );
});

describe("createRollRosterStore", () => {
  function docsFor(entries: Array<Record<string, unknown> & { uid: string }>): RosterDocSnapshot[] {
    return entries.map((entry) => ({ id: entry.uid, data: () => entry }));
  }

  it("is unloaded until the first snapshot, then serves lean {uid, state, epoch} entries", () => {
    let deliver: ((docs: RosterDocSnapshot[]) => void) | undefined;
    const store = createRollRosterStore({
      subscribe: (onDocs) => {
        deliver = onDocs;
        return () => undefined;
      },
      log: vi.fn(),
    });

    expect(store.loaded()).toBe(false);
    deliver?.(docsFor([{ uid: "uid-1", state: "quiescing", epoch: 7 }]));
    expect(store.loaded()).toBe(true);
    expect(store.get("uid-1")).toEqual({ uid: "uid-1", state: "quiescing", epoch: 7 });
    expect(store.get("uid-unknown")).toBeUndefined();
    store.stop();
  });

  it("parses an entry without revisionId (the simple-roll roster shape) and defaults malformed state/epoch", () => {
    let deliver: ((docs: RosterDocSnapshot[]) => void) | undefined;
    const store = createRollRosterStore({
      subscribe: (onDocs) => {
        deliver = onDocs;
        return () => undefined;
      },
      log: vi.fn(),
    });
    deliver?.(docsFor([{ uid: "uid-1", state: "bogus", epoch: -3 }]));
    expect(store.get("uid-1")).toEqual({ uid: "uid-1", state: "serving", epoch: 0 });
    store.stop();
  });

  it("stays unloaded (fail closed → 503s) when the subscription errors before any snapshot", () => {
    const store = createRollRosterStore({
      subscribe: (_onDocs, onError) => {
        onError(new Error("snapshot broke"));
        return () => undefined;
      },
      scheduleReconnect: () => undefined,
      log: vi.fn(),
    });
    expect(store.loaded()).toBe(false);
    store.stop();
  });

  it("RESETS to unloaded (fail closed) after a terminal error following a successful load, then reconnects", () => {
    const handlers: Array<{
      onDocs: (docs: RosterDocSnapshot[]) => void;
      onError: (err: Error) => void;
    }> = [];
    const retries: Array<() => void> = [];
    const store = createRollRosterStore({
      subscribe: (onDocs, onError) => {
        handlers.push({ onDocs, onError });
        return () => undefined;
      },
      scheduleReconnect: (_attempt, retry) => {
        retries.push(retry);
      },
      log: vi.fn(),
    });

    handlers[0].onDocs([{ id: "uid-1", data: () => ({ uid: "uid-1", state: "serving", epoch: 1 }) }]);
    expect(store.loaded()).toBe(true);

    handlers[0].onError(new Error("terminal"));
    expect(store.loaded()).toBe(false);
    expect(store.get("uid-1")).toBeUndefined();

    retries[0]();
    handlers[1].onDocs([{ id: "uid-1", data: () => ({ uid: "uid-1", state: "serving", epoch: 2 }) }]);
    expect(store.loaded()).toBe(true);
    expect(store.get("uid-1")?.epoch).toBe(2);
    store.stop();
  });

  it("does not re-subscribe after stop() even if a terminal error fires", () => {
    let capturedOnError: ((err: Error) => void) | undefined;
    const subscribe = vi.fn(
      (_onDocs: (docs: RosterDocSnapshot[]) => void, onError: (err: Error) => void) => {
        capturedOnError = onError;
        return () => undefined;
      },
    );
    const retries: Array<() => void> = [];
    const store = createRollRosterStore({
      subscribe,
      scheduleReconnect: (_attempt, retry) => {
        retries.push(retry);
      },
      log: vi.fn(),
    });
    store.stop();
    capturedOnError?.(new Error("late"));
    for (const retry of retries) retry();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});

describe("createRollRosterGate — end to end", () => {
  function harness(
    entries: Record<string, RosterEntry>,
    opts: { loaded?: boolean; selfRevisionId?: string } = {},
  ) {
    const gate = createRollRosterGate({
      store: {
        loaded: () => opts.loaded ?? true,
        get: (uid) => entries[uid],
      },
      gatewayId: "default",
      selfRevisionId: opts.selfRevisionId ?? "default",
      log: vi.fn(),
    });
    return {
      handle: (headers: Record<string, string> = {}) => {
        let status: number | null = null;
        let body: unknown;
        let retryAfter: string | null = null;
        let nexted = false;
        const res = {
          status(code: number) {
            status = code;
            return this;
          },
          set(name: string, value: string) {
            if (name === "Retry-After") retryAfter = value;
            return this;
          },
          json(payload: unknown) {
            body = payload;
            return this;
          },
        } as unknown as Response;
        gate({ headers } as unknown as Request, res, () => {
          nexted = true;
        });
        return { status, body, retryAfter, nexted };
      },
    };
  }

  it("503 + Retry-After for ALL requests while the roster is loading (boot mid-migration)", () => {
    const result = harness({}, { loaded: false }).handle({ authorization: bearerFor("uid-1") });
    expect(result.status).toBe(503);
    expect(result.retryAfter).toBe("2");
    expect(result.body).toEqual({ error: "gateway_revision_unavailable", reason: "roster-loading" });
  });

  it("serves a serving customer, a gap user, and a request without a resolvable uid", () => {
    const gate = harness({ "uid-1": { uid: "uid-1", state: "serving", epoch: 3 } });
    expect(gate.handle({ authorization: bearerFor("uid-1") }).nexted).toBe(true);
    expect(gate.handle({ authorization: bearerFor("uid-unknown") }).nexted).toBe(true);
    expect(gate.handle().nexted).toBe(true);
  });

  it("503s a quiescing customer (blocked BEFORE the migration target serves) with the typed workspace-moving code", () => {
    const result = harness({ "uid-1": { uid: "uid-1", state: "quiescing", epoch: 3 } })
      .handle({ authorization: bearerFor("uid-1") });
    expect(result.status).toBe(503);
    expect(result.retryAfter).toBe("2");
    expect(result.body).toEqual({
      error: "gateway_revision_unavailable",
      reason: "customer-quiescing",
      code: "workspace-moving",
      id: "workspace-moving",
      status_code: 503,
      message: "Moving your workspace — reconnecting shortly",
    });
  });

  it("refuses only the migrating customer; a serving neighbour on the same gateway is served", () => {
    const gate = harness({
      "uid-1": { uid: "uid-1", state: "quiescing", epoch: 3 },
      "uid-2": { uid: "uid-2", state: "serving", epoch: 9 },
    });
    expect(gate.handle({ authorization: bearerFor("uid-1") }).status).toBe(503);
    expect(gate.handle({ authorization: bearerFor("uid-2") }).nexted).toBe(true);
  });

  it("legacy/cluster surface (no identity) never gates anything", () => {
    const result = harness({}, { loaded: false, selfRevisionId: "" }).handle({
      authorization: bearerFor("uid-1"),
    });
    expect(result.nexted).toBe(true);
  });
});

describe("revisionUnavailableUpgradeResponse — the retryable migration-in-progress signal", () => {
  it("is a 503 + Retry-After, NOT a generic 500, and carries the typed body", () => {
    const response = revisionUnavailableUpgradeResponse(2, "customer-quiescing");
    expect(response).toContain("HTTP/1.1 503 Service Unavailable");
    expect(response).toContain("Retry-After: 2");
    expect(response).toContain('"error":"gateway_revision_unavailable"');
    expect(response).toContain('"reason":"customer-quiescing"');
    expect(response).toContain('"code":"workspace-moving"');
  });

  it("keeps the roster-loading refusal untyped: nothing is moving, the pod is booting", () => {
    expect(revisionUnavailableUpgradeResponse(2, "roster-loading")).not.toContain("workspace-moving");
  });
});

describe("createRollRosterUpgradeGate — verdicts", () => {
  function gateFor(
    entries: Record<string, RosterEntry>,
    opts: { loaded?: boolean; selfRevisionId?: string } = {},
  ) {
    return createRollRosterUpgradeGate({
      store: {
        loaded: () => opts.loaded ?? true,
        get: (uid) => entries[uid],
      },
      gatewayId: "default",
      selfRevisionId: opts.selfRevisionId ?? "default",
      log: vi.fn(),
    });
  }

  it("refuses every upgrade while the roster is loading (boot mid-migration)", () => {
    expect(gateFor({}, { loaded: false }).checkUid("uid-1")).toEqual({
      allow: false,
      reason: "roster-loading",
    });
  });

  it("refuses a quiescing customer (blocked before the migration target serves)", () => {
    expect(gateFor({ "uid-1": { uid: "uid-1", state: "quiescing", epoch: 1 } }).checkUid("uid-1"))
      .toEqual({ allow: false, reason: "customer-quiescing" });
  });

  it("allows a serving customer, a gap user, and everything on a legacy pod", () => {
    expect(gateFor({ "uid-1": { uid: "uid-1", state: "serving", epoch: 1 } }).checkUid("uid-1"))
      .toEqual({ allow: true });
    expect(gateFor({}).checkUid(null)).toEqual({ allow: true });
    expect(gateFor({}, { loaded: false, selfRevisionId: "" }).checkUid("uid-1")).toEqual({
      allow: true,
    });
  });

  it("checkRequest resolves the uid from the bearer, exactly like the HTTP gate", () => {
    const gate = gateFor({ "uid-1": { uid: "uid-1", state: "quiescing", epoch: 1 } });
    const verdict = gate.checkRequest({
      headers: { authorization: bearerFor("uid-1") },
    } as never);
    expect(verdict).toEqual({ allow: false, reason: "customer-quiescing" });
  });

  it("checkUnmappedIdentity: an armed pod REFUSES (retryable), a legacy pod allows, and loading fails closed", () => {
    expect(gateFor({}).checkUnmappedIdentity()).toEqual({
      allow: false,
      reason: "identity-unmapped",
    });
    expect(gateFor({}, { selfRevisionId: "" }).checkUnmappedIdentity()).toEqual({ allow: true });
    expect(gateFor({}, { loaded: false }).checkUnmappedIdentity()).toEqual({
      allow: false,
      reason: "roster-loading",
    });
  });

  it("refuse() answers the socket with the typed 503 and destroys it", () => {
    const gate = gateFor({});
    const writes: string[] = [];
    const destroy = vi.fn();
    gate.refuse({ write: (s) => writes.push(s), destroy }, { reason: "customer-quiescing" });
    expect(writes[0]).toContain("503 Service Unavailable");
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("upgrade-gate helpers", () => {
  it("guardUpgradeRequest refuses through the gate and never refuses with a null gate", () => {
    const gate = createRollRosterUpgradeGate({
      store: { loaded: () => false, get: () => undefined },
      gatewayId: "default",
      selfRevisionId: "default",
      log: vi.fn(),
    });
    const destroy = vi.fn();
    expect(guardUpgradeRequest(gate, { headers: {} } as never, { write: vi.fn(), destroy }))
      .toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
    expect(guardUpgradeRequest(null, { headers: {} } as never, { write: vi.fn(), destroy: vi.fn() }))
      .toBe(false);
  });

  it("mmRosterVerdictFor: null identity is the gap-user path, unmapped identity refuses, mapped identity gets the uid verdict", async () => {
    const gate = createRollRosterUpgradeGate({
      store: {
        loaded: () => true,
        get: (uid) => (uid === "uid-1" ? { uid: "uid-1", state: "quiescing", epoch: 1 } : undefined),
      },
      gatewayId: "default",
      selfRevisionId: "default",
      log: vi.fn(),
    });
    await expect(mmRosterVerdictFor(gate, null, async () => null)).resolves.toEqual({ allow: true });
    await expect(mmRosterVerdictFor(gate, "mm-1", async () => null)).resolves.toEqual({
      allow: false,
      reason: "identity-unmapped",
    });
    await expect(mmRosterVerdictFor(gate, "mm-1", async () => "uid-1")).resolves.toEqual({
      allow: false,
      reason: "customer-quiescing",
    });
  });

  it("wrapRedeemWithRosterGate throws on a refused customer and passes through with a null gate", async () => {
    const gate = createRollRosterUpgradeGate({
      store: {
        loaded: () => true,
        get: () => ({ uid: "uid-1", state: "quiescing", epoch: 1 }),
      },
      gatewayId: "default",
      selfRevisionId: "default",
      log: vi.fn(),
    });
    const redeem = async () => ({ uid: "uid-1" });
    await expect(wrapRedeemWithRosterGate(redeem, gate)("t")).rejects.toThrow(
      /customer-quiescing/u,
    );
    await expect(wrapRedeemWithRosterGate(redeem, null)("t")).resolves.toEqual({ uid: "uid-1" });
  });
});
