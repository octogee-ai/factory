import { describe, expect, it } from "vitest";
import {
  mintTicket,
  redeemTicket,
  TicketCapExceededError,
  HourlyMintQuotaExceededError,
  _testInternal,
} from "../lib/gateway-ticket.js";
import { db } from "../lib/db.js";
import { setupEmulatorTest } from "@shared/test-helpers/firestore-emulator.js";

setupEmulatorTest();

const COLLECTION = _testInternal.COLLECTION;
const SHELL_CAP = _testInternal.POLICIES["builder-shell"].perUidCap as number;
const SHELL_QUOTA = _testInternal.POLICIES["builder-shell"].hourlyQuota as number;

async function getTicketDoc(id: string) {
  const snap = await db.collection(COLLECTION).doc(id).get();
  return snap.exists ? snap.data() : null;
}

describe("mintTicket — unified gateway ticket (emulator)", () => {
  it("writes gatewayTickets/{uuid} with uid+gatewayId+purpose+future expiresAt+createdAt", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw-bender", purpose: "openclaw-ws" });
    expect(t.ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.purpose).toBe("openclaw-ws");
    const doc = await getTicketDoc(t.ticket);
    expect(doc).toMatchObject({ uid: "u1", gatewayId: "gw-bender", purpose: "openclaw-ws" });
    expect(typeof doc?.expiresAt).toBe("number");
    expect(doc?.expiresAt as number).toBeGreaterThan(Date.now());
    expect(doc?.createdAt).toBeTruthy();
    // expireAt is the Timestamp twin the Firestore TTL policy GCs on (C).
    expect((doc?.expireAt as { toMillis(): number }).toMillis()).toBe(doc?.expiresAt);
  });

  it("round-trips feature payload (builder-shell shellId/cwd/containerSlug)", async () => {
    const t = await mintTicket({
      uid: "u1",
      gatewayId: "gw",
      purpose: "builder-shell",
      payload: { shellId: "s1", cwd: "/x", containerSlug: "c1" },
    });
    const doc = await getTicketDoc(t.ticket);
    expect(doc?.payload).toMatchObject({ shellId: "s1", cwd: "/x", containerSlug: "c1" });
    expect(t.payload).toMatchObject({ shellId: "s1", cwd: "/x", containerSlug: "c1" });
  });

  it("two mints return distinct UUID ticket ids", async () => {
    const a = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    const b = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(a.ticket).not.toBe(b.ticket);
  });

  it("uncapped purpose (mattermost-ws) mints freely past the shell cap", async () => {
    for (let i = 0; i < SHELL_CAP + 10; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "mattermost-ws" });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "mattermost-ws" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("per-uid cap (builder-shell) throws TicketCapExceededError at the cap", async () => {
    for (let i = 0; i < SHELL_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: { shellId: "s" } });
    }
    await expect(
      mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: { shellId: "s" } }),
    ).rejects.toThrow(TicketCapExceededError);
  });

  it("cap is per-(uid,purpose) — exhausting builder-shell does NOT block preview", async () => {
    for (let i = 0; i < SHELL_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: {} });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("cap is per-uid, not global — u2 unaffected by u1's exhausted cap", async () => {
    for (let i = 0; i < SHELL_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: {} });
    }
    const ok = await mintTicket({ uid: "u2", gatewayId: "gw", purpose: "builder-shell", payload: {} });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hourly quota (builder-shell) caps sustained mints per (uid,purpose)", async () => {
    const now = Date.now();
    for (let i = 0; i < SHELL_QUOTA - 1; i++) {
      await db.collection(_testInternal.MINT_LOG_COLLECTION).add({
        uid: "u1",
        purpose: "builder-shell",
        mintedAt: now - i * 1000,
      });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: {} });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: {} }),
    ).rejects.toThrow(HourlyMintQuotaExceededError);
  });

  it("hourly quota is per-(uid,purpose) — an exhausted shell window does NOT block openclaw-ws", async () => {
    const now = Date.now();
    for (let i = 0; i < SHELL_QUOTA; i++) {
      await db.collection(_testInternal.MINT_LOG_COLLECTION).add({
        uid: "u1",
        purpose: "builder-shell",
        mintedAt: now - i * 1000,
      });
    }
    await expect(
      mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: {} }),
    ).rejects.toThrow(HourlyMintQuotaExceededError);
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "openclaw-ws" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("per-uid cap holds under concurrent mints — transactional regression", async () => {
    const attempts = SHELL_CAP + 2;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: {} }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(SHELL_CAP);
    const live = await db
      .collection(COLLECTION)
      .where("uid", "==", "u1")
      .where("expiresAt", ">", Date.now())
      .get();
    expect(live.size).toBe(SHELL_CAP);
  });

  it("invalid purpose throws", async () => {
    await expect(
      mintTicket({ uid: "u1", gatewayId: "gw", purpose: "nope" as unknown as "preview" }),
    ).rejects.toThrow();
  });

  it("missing uid throws; empty gatewayId is allowed (stored for the not-yet-provisioned oc/ws path)", async () => {
    await expect(mintTicket({ uid: "", gatewayId: "gw", purpose: "preview" })).rejects.toThrow();
    const ok = await mintTicket({ uid: "u1", gatewayId: "", purpose: "openclaw-ws" });
    expect(ok.gatewayId).toBe("");
    expect((await getTicketDoc(ok.ticket))?.gatewayId).toBe("");
  });
});

describe("redeemTicket — unified gateway ticket (emulator)", () => {
  it("returns the ticket and DELETES the doc on first successful consume", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "openclaw-ws" });
    const r = await redeemTicket({ ticketId: t.ticket, purpose: "openclaw-ws" });
    expect(r).not.toBeNull();
    expect(r?.uid).toBe("u1");
    expect(r?.gatewayId).toBe("gw");
    expect(await getTicketDoc(t.ticket)).toBeNull();
  });

  it("second consume returns null — one-time use, replay denied", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "openclaw-ws" });
    await redeemTicket({ ticketId: t.ticket, purpose: "openclaw-ws" });
    expect(await redeemTicket({ ticketId: t.ticket, purpose: "openclaw-ws" })).toBeNull();
  });

  it("WRONG PURPOSE returns null and does NOT consume — a preview ticket cannot open a shell (D2 cross-purpose isolation)", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(await redeemTicket({ ticketId: t.ticket, purpose: "builder-shell" })).toBeNull();
    expect(await getTicketDoc(t.ticket)).not.toBeNull();
    const r = await redeemTicket({ ticketId: t.ticket, purpose: "preview" });
    expect(r?.purpose).toBe("preview");
  });

  it("expectedGatewayId binds redemption — match redeems, mismatch returns null WITHOUT consuming, explicit null opts out", async () => {
    const a = await mintTicket({ uid: "u1", gatewayId: "gw-bender", purpose: "openclaw-ws" });
    // mismatch → null, ticket NOT consumed
    expect(
      await redeemTicket({ ticketId: a.ticket, purpose: "openclaw-ws", expectedGatewayId: "gw-other" }),
    ).toBeNull();
    expect(await getTicketDoc(a.ticket)).not.toBeNull();
    // match → redeems
    const m = await redeemTicket({ ticketId: a.ticket, purpose: "openclaw-ws", expectedGatewayId: "gw-bender" });
    expect(m?.gatewayId).toBe("gw-bender");
    // explicit null opt-out → redeems regardless of the ticket's gateway
    const b = await mintTicket({ uid: "u1", gatewayId: "gw-bender", purpose: "openclaw-ws" });
    expect(
      await redeemTicket({ ticketId: b.ticket, purpose: "openclaw-ws", expectedGatewayId: null }),
    ).not.toBeNull();
  });

  it("unknown ticket id returns null", async () => {
    expect(
      await redeemTicket({ ticketId: "00000000-0000-0000-0000-000000000000", purpose: "preview" }),
    ).toBeNull();
  });

  it("empty / wrong-type ticket id returns null without touching Firestore", async () => {
    expect(await redeemTicket({ ticketId: "", purpose: "preview" })).toBeNull();
    expect(await redeemTicket({ ticketId: null as unknown as string, purpose: "preview" })).toBeNull();
  });

  it("expired ticket: returns null AND does NOT delete (expiry cleanup is a separate sweeper concern)", async () => {
    const id = "expired-id";
    await db.collection(COLLECTION).doc(id).set({
      uid: "u1",
      gatewayId: "gw",
      purpose: "preview",
      expiresAt: Date.now() - 60_000,
      payload: {},
    });
    expect(await redeemTicket({ ticketId: id, purpose: "preview" })).toBeNull();
    expect(await getTicketDoc(id)).not.toBeNull();
  });

  it("malformed doc (missing expiresAt / non-string uid) → null, doc preserved", async () => {
    await db.collection(COLLECTION).doc("no-exp").set({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(await redeemTicket({ ticketId: "no-exp", purpose: "preview" })).toBeNull();
    expect(await getTicketDoc("no-exp")).not.toBeNull();

    await db.collection(COLLECTION).doc("bad-uid").set({
      uid: 12345,
      gatewayId: "gw",
      purpose: "preview",
      expiresAt: Date.now() + 30_000,
    });
    expect(await redeemTicket({ ticketId: "bad-uid", purpose: "preview" })).toBeNull();
  });

  it("onValidated side-writes commit atomically with the ticket delete on success", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: { shellId: "s1" } });
    let ranWith: { uid: string; shellId: unknown } | null = null;
    const r = await redeemTicket({
      ticketId: t.ticket,
      purpose: "builder-shell",
      onValidated: (tx, ticket) => {
        ranWith = { uid: ticket.uid, shellId: ticket.payload.shellId };
        tx.set(db.collection("gatewayTicketSessions").doc(ticket.ticket), {
          uid: ticket.uid,
          gatewayId: ticket.gatewayId,
          status: "active",
        });
      },
    });
    expect(r).not.toBeNull();
    expect(ranWith).toEqual({ uid: "u1", shellId: "s1" });
    expect((await db.collection("gatewayTicketSessions").doc(t.ticket).get()).exists).toBe(true);
    expect(await getTicketDoc(t.ticket)).toBeNull();
  });

  it("onValidated throw ABORTS the transaction — ticket NOT deleted, side-write rolled back", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: {} });
    await expect(
      redeemTicket({
        ticketId: t.ticket,
        purpose: "builder-shell",
        onValidated: (tx, ticket) => {
          tx.set(db.collection("gatewayTicketSessions").doc(ticket.ticket), { status: "active" });
          throw new Error("simulated downstream failure");
        },
      }),
    ).rejects.toThrow();
    expect(await getTicketDoc(t.ticket)).not.toBeNull();
    expect((await db.collection("gatewayTicketSessions").doc(t.ticket).get()).exists).toBe(false);
  });

  it("validate predicate vetoes redemption with NO consume (feature payload rejected inside the tx); a passing validate consumes normally", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "builder-shell", payload: { shellId: "s1" } });
    const vetoed = await redeemTicket({ ticketId: t.ticket, purpose: "builder-shell", validate: () => false });
    expect(vetoed).toBeNull();
    expect(await getTicketDoc(t.ticket)).not.toBeNull();
    const ok = await redeemTicket({
      ticketId: t.ticket,
      purpose: "builder-shell",
      validate: (tk) => tk.payload.shellId === "s1",
    });
    expect(ok?.payload.shellId).toBe("s1");
    expect(await getTicketDoc(t.ticket)).toBeNull();
  });

  it("two concurrent consumes race: exactly one wins", async () => {
    const t = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "openclaw-ws" });
    const [a, b] = await Promise.all([
      redeemTicket({ ticketId: t.ticket, purpose: "openclaw-ws" }),
      redeemTicket({ ticketId: t.ticket, purpose: "openclaw-ws" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
