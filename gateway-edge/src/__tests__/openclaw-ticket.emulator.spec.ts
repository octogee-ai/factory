import request from "supertest";
import express from "express";
import { describe, expect, it } from "vitest";

import openclawRouter from "../routes/openclaw.js";
import { db } from "../lib/db.js";
import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@octogee/test-helpers/firestore-emulator";

setupEmulatorTest({
  env: { API_PUBLIC_URL: "https://chat-proxy.test.octogee.com" },
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/openclaw", openclawRouter);
  return app;
}

async function getActiveIdToken(uid: string): Promise<string> {
  await db.doc(`users/${uid}`).set(
    { accountLifecycle: { status: "active" } },
    { merge: true },
  );
  return getIdTokenForUid(uid);
}

describe("POST /api/openclaw/ticket — real Firebase Auth + Firestore (emulators)", () => {
  it("rejects unauthenticated requests with 401 (real requireAuth)", async () => {
    const res = await request(buildApp()).post("/api/openclaw/ticket");
    expect(res.status).toBe(401);
  });

  it("rejects malformed Bearer token with 401 (real verifyIdToken)", async () => {
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns a ticket + proxy URL on a valid Firebase token", async () => {
    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.proxyUrl).toBe("https://chat-proxy.test.octogee.com");
  });

  it("writes an ocTickets/{uuid} doc with uid + ~30s expiry — visible in real Firestore", async () => {
    const token = await getActiveIdToken("caller-uid");
    const before = Date.now();
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    const after = Date.now();
    expect(res.status).toBe(200);

    const snap = await db.collection("gatewayTickets").doc(res.body.wsTicket).get();
    expect(snap.exists).toBe(true);
    const data = snap.data();
    expect(data?.uid).toBe("caller-uid");
    expect(data?.purpose).toBe("openclaw-ws");
    const exp = data?.expiresAt as number;
    expect(exp).toBeGreaterThanOrEqual(before + 29_000);
    expect(exp).toBeLessThanOrEqual(after + 31_000);
  });

  it("issues distinct tickets across calls", async () => {
    const token = await getActiveIdToken("caller-uid");
    const a = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    const b = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(a.body.wsTicket).not.toBe(b.body.wsTicket);
  });

it("returns gatewayId from users/{uid}.provisioning.openclaw.gatewayId when set", async () => {
    await db.doc("users/caller-uid").set({
      provisioning: { openclaw: { gatewayId: "gw-bender" } },
    });
    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("gw-bender");
  });

  it("returns gatewayId='' when the user doc has no openclaw provisioning (legacy / pre-provisioning fallback to bare /api path)", async () => {
    
    const token = await getActiveIdToken("no-provisioning-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("");
  });

  it("records targetless activation demand when the client anticipates a session", async () => {
    await db.doc("users/caller-uid").set({
      username: "alice",
      builderSubscription: { tier: "pro", status: "active" },
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    });
    await db.doc("gateways/default/assignments/caller-uid").set({
      uid: "caller-uid",
      gatewayId: "default",
      state: "serving",
      epoch: 7,
    });

    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`)
      .send({ anticipate: true });

    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("default");
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);

    const user = await db.doc("users/caller-uid").get();
    expect(user.data()?.provisioning.openclaw.activationLease).toMatchObject({
      generation: 1,
      status: "requested",
      cause: "ticket",
      builderSlug: "alice",
      sourceGatewayId: "default",
      sourceAssignmentEpoch: 7,
      entitlementTier: "pro",
      sizingTier: "m",
    });
    expect(
      user.data()?.provisioning.openclaw.activationLease,
    ).not.toHaveProperty("targetGatewayId");
    const ops = await db.collection("glmOperations").get();
    expect(ops.empty).toBe(true);
  });

  it("mints without recording demand when the client does not anticipate — a reconnect cannot summon or hold the runtime", async () => {
    await db.doc("users/caller-uid").set({
      username: "alice",
      builderSubscription: { tier: "pro", status: "active" },
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    });
    await db.doc("gateways/default/assignments/caller-uid").set({
      uid: "caller-uid",
      gatewayId: "default",
      state: "serving",
      epoch: 7,
    });

    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`)
      .send({ anticipate: false });

    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("default");
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);

    const user = await db.doc("users/caller-uid").get();
    expect(user.data()?.provisioning.openclaw).not.toHaveProperty("activationLease");
  });

  it.each([
    ["a Personal user", { subscription: { tier: "personal", status: "active" } }],
    ["an Enterprise Builder", { builderSubscription: { tier: "enterprise", status: "active" } }],
  ])("mints the current shared ticket for %s when disposable activation is unavailable", async (
    _label,
    entitlement,
  ) => {
    await db.doc("users/caller-uid").set({
      username: "alice",
      ...entitlement,
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    });
    await db.doc("gateways/default/assignments/caller-uid").set({
      uid: "caller-uid",
      gatewayId: "default",
      state: "serving",
      epoch: 7,
    });

    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`)
      .send({ anticipate: true });

    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("default");
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints against the current user pointer while its assignment is returning", async () => {
    await db.doc("users/caller-uid").set({
      username: "alice",
      builderSubscription: { tier: "pro", status: "active" },
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    });
    await db.doc("gateways/default/assignments/caller-uid").set({
      uid: "caller-uid",
      gatewayId: "default",
      state: "returning",
      epoch: 7,
    });

    const token = await getActiveIdToken("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`)
      .send({ anticipate: true });

    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("default");
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);
  });
});
