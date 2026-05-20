import request from "supertest";
import express from "express";
import { describe, expect, it } from "vitest";

import openclawRouter from "../routes/openclaw";
import { db } from "../lib/db";
import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "./helpers/firestore-emulator";

setupEmulatorTest({
  env: { CHAT_PROXY_URL: "https://chat-proxy.test.octogee.com" },
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/openclaw", openclawRouter);
  return app;
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
    const token = await getIdTokenForUid("caller-uid");
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.proxyUrl).toBe("https://chat-proxy.test.octogee.com");
  });

  it("writes an ocTickets/{uuid} doc with uid + ~30s expiry — visible in real Firestore", async () => {
    const token = await getIdTokenForUid("caller-uid");
    const before = Date.now();
    const res = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    const after = Date.now();
    expect(res.status).toBe(200);

    const snap = await db.collection("ocTickets").doc(res.body.wsTicket).get();
    expect(snap.exists).toBe(true);
    const data = snap.data();
    expect(data?.uid).toBe("caller-uid");
    const exp = data?.expiresAt as number;
    expect(exp).toBeGreaterThanOrEqual(before + 29_000);
    expect(exp).toBeLessThanOrEqual(after + 31_000);
  });

  it("issues distinct tickets across calls", async () => {
    const token = await getIdTokenForUid("caller-uid");
    const a = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    const b = await request(buildApp())
      .post("/api/openclaw/ticket")
      .set("Authorization", `Bearer ${token}`);
    expect(a.body.wsTicket).not.toBe(b.body.wsTicket);
  });
});
