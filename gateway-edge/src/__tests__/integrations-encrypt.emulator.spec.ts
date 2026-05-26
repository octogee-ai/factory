

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  setupEmulatorTest,
  useAuthToken,
} from "@shared/test-helpers/firestore-emulator.js";
import { db } from "../lib/db.js";
import { _setKmsClientForTesting, type KmsClient } from "../lib/kms.js";

const UID = "uid-encrypt-test";
const PLAINTEXT_PASSWORD = "hunter2-imap-original-plaintext";
const PLAINTEXT_TWILIO_TOKEN = "twilio-auth-token-AbCdEf1234567890";
const PLAINTEXT_GOOGLE_ACCESS = "ya29.a0AfB-PLAINTEXT-google-access";
const PLAINTEXT_GOOGLE_REFRESH = "1//05PLAINTEXT-google-refresh-token";
const PLAINTEXT_MS_ACCESS = "EwBoA8l6BPLAINTEXT-microsoft-access";
const PLAINTEXT_MS_REFRESH = "M.R3_BAY.PLAINTEXT-microsoft-refresh";

function deterministicMockKms(): KmsClient {
  return {
    encrypt: vi.fn(async ({ plaintext }) => [
      {
        ciphertext: Buffer.concat([Buffer.from("ENC:"), Buffer.from(plaintext)]),
      },
    ] as [{ ciphertext: Buffer }]) as unknown as KmsClient["encrypt"],
    decrypt: vi.fn(async ({ ciphertext }) => [
      { plaintext: Buffer.from(ciphertext).slice(4) },
    ] as [{ plaintext: Buffer }]) as unknown as KmsClient["decrypt"],
  };
}

const { createApp } = await import("../index.js");

setupEmulatorTest({
  env: {
    OCTOGEE_KMS_KEY_NAME:
      "projects/octogee-test/locations/us-central1/keyRings/test/cryptoKeys/test",
  },
});
const auth = useAuthToken(UID);

beforeEach(() => {
  _setKmsClientForTesting(deterministicMockKms());
});

afterEach(() => {
  _setKmsClientForTesting(null);

vi.restoreAllMocks();
});

async function readSecret(provider: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db
    .collection("users")
    .doc(UID)
    .collection("secrets")
    .doc(provider)
    .get();
  return snap.data();
}

function jsonString(doc: unknown): string {
  return JSON.stringify(doc ?? {});
}

describe("integrations — IMAP credentials at rest", () => {
  it("POST /api/integrations/imap stores `encryptedPassword` as ciphertext, never plaintext", async () => {
    const res = await request(createApp())
      .post("/api/integrations/imap")
      .set("Authorization", auth.bearer())
      .send({
        email: "user@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        username: "user@example.com",
        password: PLAINTEXT_PASSWORD,
      });
    expect(res.status).toBe(200);

    const secret = await readSecret("imap");
    expect(secret).toBeDefined();

expect(jsonString(secret)).not.toContain(PLAINTEXT_PASSWORD);

    const imapEnc = (secret as Record<string, Record<string, string>>).imap
      ?.encryptedPassword;
    const smtpEnc = (secret as Record<string, Record<string, string>>).smtp
      ?.encryptedPassword;
    expect(typeof imapEnc).toBe("string");
    expect(typeof smtpEnc).toBe("string");
    expect(imapEnc.length).toBeGreaterThan(0);
    expect(imapEnc).not.toBe(PLAINTEXT_PASSWORD);

expect(imapEnc).toBe(smtpEnc);

const expected = Buffer.concat([
      Buffer.from("ENC:"),
      Buffer.from(PLAINTEXT_PASSWORD),
    ]).toString("base64");
    expect(imapEnc).toBe(expected);
  });
});

describe("integrations — Twilio credentials at rest", () => {
  it("POST /api/integrations/twilio stores `encryptedAuthToken` as ciphertext, never plaintext", async () => {
    const res = await request(createApp())
      .post("/api/integrations/twilio")
      .set("Authorization", auth.bearer())
      .send({
        accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        authToken: PLAINTEXT_TWILIO_TOKEN,
        fromNumber: "+15551234567",
      });
    expect(res.status).toBe(200);

    const secret = await readSecret("twilio");
    expect(secret).toBeDefined();
    expect(jsonString(secret)).not.toContain(PLAINTEXT_TWILIO_TOKEN);

    const enc = (secret as Record<string, Record<string, string>>).twilio
      ?.encryptedAuthToken;
    expect(typeof enc).toBe("string");
    expect(enc).not.toBe(PLAINTEXT_TWILIO_TOKEN);

    const expected = Buffer.concat([
      Buffer.from("ENC:"),
      Buffer.from(PLAINTEXT_TWILIO_TOKEN),
    ]).toString("base64");
    expect(enc).toBe(expected);
  });

  it("Twilio integrations/ metadata doc carries accountSid in CLEAR (semi-public identifier, not a secret)", async () => {
    await request(createApp())
      .post("/api/integrations/twilio")
      .set("Authorization", auth.bearer())
      .send({
        accountSid: "ACdistinct-sid",
        authToken: "shouldnt-show-here",
        fromNumber: "+15551234567",
      });
    const meta = await db
      .collection("users")
      .doc(UID)
      .collection("integrations")
      .doc("twilio")
      .get();
    expect((meta.data() as { twilio: { accountSid: string } }).twilio.accountSid).toBe(
      "ACdistinct-sid",
    );
    
    const secret = await readSecret("twilio");
    expect(jsonString(secret)).not.toContain("shouldnt-show-here");
  });
});

describe("integrations — Google OAuth callback credentials at rest", () => {
  it("GET /api/integrations/google/callback stores `encryptedAccessToken` + `encryptedRefreshToken` as ciphertext", async () => {
    
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: string | URL,
    ) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: PLAINTEXT_GOOGLE_ACCESS,
            refresh_token: PLAINTEXT_GOOGLE_REFRESH,
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("googleapis.com/oauth2/v2/userinfo")) {
        return new Response(JSON.stringify({ email: "test@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch);

    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    const state = Buffer.from(
      JSON.stringify({ uid: UID, returnUrl: "/dashboard" }),
    ).toString("base64url");

    const res = await request(createApp()).get(
      `/api/integrations/google/callback?code=fake-code&state=${state}`,
    );
    expect([302, 200]).toContain(res.status); 

    const secret = await readSecret("google");
    expect(secret).toBeDefined();

expect(jsonString(secret)).not.toContain(PLAINTEXT_GOOGLE_ACCESS);
    expect(jsonString(secret)).not.toContain(PLAINTEXT_GOOGLE_REFRESH);

    const tokens = (secret as Record<string, Record<string, unknown>>).tokens;
    expect(tokens.encryptedAccessToken).toBeTypeOf("string");
    expect(tokens.encryptedRefreshToken).toBeTypeOf("string");
    expect(tokens.encryptedAccessToken).not.toBe(PLAINTEXT_GOOGLE_ACCESS);
    expect(tokens.encryptedRefreshToken).not.toBe(PLAINTEXT_GOOGLE_REFRESH);
    
    expect(tokens.tokenType).toBe("Bearer");
    expect(typeof tokens.expiresAt).toBe("number");
    
    expect(tokens).not.toHaveProperty("accessToken");
    expect(tokens).not.toHaveProperty("refreshToken");
    // fetchSpy is restored via the file-level afterEach (vi.restoreAllMocks)
  });
});

describe("integrations — Microsoft OAuth callback credentials at rest", () => {
  it("GET /api/integrations/microsoft/callback stores `encryptedAccessToken` + `encryptedRefreshToken` as ciphertext", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: string | URL,
    ) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) {
        return new Response(
          JSON.stringify({
            access_token: PLAINTEXT_MS_ACCESS,
            refresh_token: PLAINTEXT_MS_REFRESH,
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("graph.microsoft.com")) {
        return new Response(
          JSON.stringify({ mail: "test@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch);

    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    const state = Buffer.from(
      JSON.stringify({ uid: UID, returnUrl: "/dashboard" }),
    ).toString("base64url");

    const res = await request(createApp()).get(
      `/api/integrations/microsoft/callback?code=fake-code&state=${state}`,
    );
    expect([302, 200]).toContain(res.status);

    const secret = await readSecret("microsoft");
    expect(secret).toBeDefined();

    expect(jsonString(secret)).not.toContain(PLAINTEXT_MS_ACCESS);
    expect(jsonString(secret)).not.toContain(PLAINTEXT_MS_REFRESH);

    const tokens = (secret as Record<string, Record<string, unknown>>).tokens;
    expect(tokens.encryptedAccessToken).toBeTypeOf("string");
    expect(tokens.encryptedRefreshToken).toBeTypeOf("string");
    expect(tokens).not.toHaveProperty("accessToken");
    expect(tokens).not.toHaveProperty("refreshToken");
    // fetchSpy is restored via the file-level afterEach (vi.restoreAllMocks)
  });
});

describe("integrations — universal invariant (regression guard)", () => {
  it("after exercising every secret-writing route, no `users/{uid}/secrets/*` doc contains the original plaintext", async () => {
    
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: string | URL,
    ) => {
      const u = String(url);
      if (u.includes("googleapis.com/oauth2/v2/userinfo")) {
        return new Response(JSON.stringify({ email: "g@x.com" }), { status: 200 });
      }
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: PLAINTEXT_GOOGLE_ACCESS,
            refresh_token: PLAINTEXT_GOOGLE_REFRESH,
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }
      if (u.includes("login.microsoftonline.com")) {
        return new Response(
          JSON.stringify({
            access_token: PLAINTEXT_MS_ACCESS,
            refresh_token: PLAINTEXT_MS_REFRESH,
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }
      if (u.includes("graph.microsoft.com")) {
        return new Response(JSON.stringify({ mail: "ms@x.com" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch);

    process.env.GOOGLE_CLIENT_ID = "test";
    process.env.GOOGLE_CLIENT_SECRET = "test";
    process.env.MICROSOFT_CLIENT_ID = "test";
    process.env.MICROSOFT_CLIENT_SECRET = "test";

    const stateGoogle = Buffer.from(
      JSON.stringify({ uid: UID, returnUrl: "/d" }),
    ).toString("base64url");

    await request(createApp())
      .post("/api/integrations/imap")
      .set("Authorization", auth.bearer())
      .send({
        email: "u@x.com",
        imapHost: "imap.x.com",
        username: "u@x.com",
        password: PLAINTEXT_PASSWORD,
      });
    await request(createApp())
      .post("/api/integrations/twilio")
      .set("Authorization", auth.bearer())
      .send({
        accountSid: "ACxxxx",
        authToken: PLAINTEXT_TWILIO_TOKEN,
        fromNumber: "+15551234567",
      });
    await request(createApp()).get(
      `/api/integrations/google/callback?code=c&state=${stateGoogle}`,
    );
    await request(createApp()).get(
      `/api/integrations/microsoft/callback?code=c&state=${stateGoogle}`,
    );

    const secretsSnap = await db
      .collection("users")
      .doc(UID)
      .collection("secrets")
      .get();
    expect(secretsSnap.size).toBeGreaterThanOrEqual(4);

    const plaintexts = [
      PLAINTEXT_PASSWORD,
      PLAINTEXT_TWILIO_TOKEN,
      PLAINTEXT_GOOGLE_ACCESS,
      PLAINTEXT_GOOGLE_REFRESH,
      PLAINTEXT_MS_ACCESS,
      PLAINTEXT_MS_REFRESH,
    ];
    for (const doc of secretsSnap.docs) {
      const body = JSON.stringify(doc.data());
      for (const plaintext of plaintexts) {
        expect(
          body.includes(plaintext),
          `doc=${doc.id} contains plaintext "${plaintext}"`,
        ).toBe(false);
      }
    }
    // fetchSpy is restored via the file-level afterEach (vi.restoreAllMocks)
  });
});
