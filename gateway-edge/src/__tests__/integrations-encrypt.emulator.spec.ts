

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  setupEmulatorTest,
  useAuthToken,
} from "@octogee/test-helpers/firestore-emulator";
import { db } from "../lib/db.js";
import { _setKmsClientForTesting, type KmsClient } from "../lib/kms.js";

const UID = "uid-encrypt-test";
const PLAINTEXT_PASSWORD = "hunter2-imap-original-plaintext";
const PLAINTEXT_TWILIO_TOKEN = "twilio-auth-token-AbCdEf1234567890";

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

describe("integrations — disconnect scope after the /api/connect migration", () => {
  it("rejects registry connectors (google/microsoft/github disconnect via /api/connect)", async () => {
    for (const service of ["google", "microsoft", "github"]) {
      const res = await request(createApp())
        .post("/api/integrations/disconnect")
        .set("Authorization", auth.bearer())
        .send({ service });
      expect(res.status, service).toBe(400);
    }
  });

  it("still disconnects imap, deleting the secret doc", async () => {
    await request(createApp())
      .post("/api/integrations/imap")
      .set("Authorization", auth.bearer())
      .send({
        email: "u@x.com",
        imapHost: "imap.x.com",
        username: "u@x.com",
        password: PLAINTEXT_PASSWORD,
      });
    expect(await readSecret("imap")).toBeDefined();

    const res = await request(createApp())
      .post("/api/integrations/disconnect")
      .set("Authorization", auth.bearer())
      .send({ service: "imap" });
    expect(res.status).toBe(200);
    expect(await readSecret("imap")).toBeUndefined();

    const meta = await db
      .collection("users")
      .doc(UID)
      .collection("integrations")
      .doc("imap")
      .get();
    expect(meta.data()?.status).toBe("disconnected");
  });
});
