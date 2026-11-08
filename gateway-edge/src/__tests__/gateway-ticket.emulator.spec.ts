import { describe, expect, it } from "vitest";
import {
  mintTicket,
  TicketCapExceededError,
  HourlyMintQuotaExceededError,
  _testInternal,
} from "../lib/gateway-ticket.js";
import { db } from "../lib/db.js";
import { setupEmulatorTest } from "@octogee/test-helpers/firestore-emulator";

setupEmulatorTest();

const COLLECTION = _testInternal.COLLECTION;
const VOICE_CAP = _testInternal.POLICIES["voice-ws"].perUidCap as number;
const VOICE_QUOTA = _testInternal.POLICIES["voice-ws"].hourlyQuota as number;

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

  it("round-trips an opaque feature payload", async () => {
    const t = await mintTicket({
      uid: "u1",
      gatewayId: "gw",
      purpose: "openclaw-ws",
      payload: { session: "dashboard" },
    });
    const doc = await getTicketDoc(t.ticket);
    expect(doc?.payload).toMatchObject({ session: "dashboard" });
    expect(t.payload).toMatchObject({ session: "dashboard" });
  });

  it("two mints return distinct UUID ticket ids", async () => {
    const a = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    const b = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(a.ticket).not.toBe(b.ticket);
  });

  it("uncapped purpose (mattermost-ws) mints freely past the voice cap", async () => {
    for (let i = 0; i < VOICE_CAP + 10; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "mattermost-ws" });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "mattermost-ws" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("per-uid cap (voice-ws) throws TicketCapExceededError at the cap", async () => {
    for (let i = 0; i < VOICE_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    }
    await expect(
      mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} }),
    ).rejects.toThrow(TicketCapExceededError);
  });

  it("cap is per-(uid,purpose) — exhausting voice-ws does NOT block preview", async () => {
    for (let i = 0; i < VOICE_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "preview" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("cap is per-uid, not global — u2 unaffected by u1's exhausted cap", async () => {
    for (let i = 0; i < VOICE_CAP; i++) {
      await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    }
    const ok = await mintTicket({ uid: "u2", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hourly quota (voice-ws) caps sustained mints per (uid,purpose)", async () => {
    const now = Date.now();
    for (let i = 0; i < VOICE_QUOTA - 1; i++) {
      await db.collection(_testInternal.MINT_LOG_COLLECTION).add({
        uid: "u1",
        purpose: "voice-ws",
        mintedAt: now - i * 1000,
      });
    }
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} }),
    ).rejects.toThrow(HourlyMintQuotaExceededError);
  });

  it("hourly quota is per-(uid,purpose) — an exhausted voice window does NOT block openclaw-ws", async () => {
    const now = Date.now();
    for (let i = 0; i < VOICE_QUOTA; i++) {
      await db.collection(_testInternal.MINT_LOG_COLLECTION).add({
        uid: "u1",
        purpose: "voice-ws",
        mintedAt: now - i * 1000,
      });
    }
    await expect(
      mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} }),
    ).rejects.toThrow(HourlyMintQuotaExceededError);
    const ok = await mintTicket({ uid: "u1", gatewayId: "gw", purpose: "openclaw-ws" });
    expect(ok.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("per-uid cap holds under concurrent mints — transactional regression", async () => {
    const attempts = VOICE_CAP + 2;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        mintTicket({ uid: "u1", gatewayId: "gw", purpose: "voice-ws", payload: {} }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(VOICE_CAP);
    const live = await db
      .collection(COLLECTION)
      .where("uid", "==", "u1")
      .where("expiresAt", ">", Date.now())
      .get();
    expect(live.size).toBe(VOICE_CAP);
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
