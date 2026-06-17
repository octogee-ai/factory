import { describe, it, expect } from "vitest";
import {
  canonicalPayload,
  signFleetRequest,
  verifyFleetRequest,
} from "../lib/fleet-signature.js";
import { FLEET_KEY_PAIR, OTHER_FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = FLEET_KEY_PAIR;

describe("canonicalPayload", () => {
  it("joins jobId + body with a single newline separator", () => {
    expect(canonicalPayload("abc", "body")).toBe("abc\nbody");
  });

  it("preserves raw body content byte-for-byte (no trimming, no normalization)", () => {
    expect(canonicalPayload("j", "  padded  ")).toBe("j\n  padded  ");
    expect(canonicalPayload("j", "line1\nline2")).toBe("j\nline1\nline2");
  });
});

describe("signFleetRequest / verifyFleetRequest", () => {
  it("produces a stable base64url Ed25519 signature across calls", () => {
    const a = signFleetRequest(PRIVATE_KEY, "job1", "body");
    const b = signFleetRequest(PRIVATE_KEY, "job1", "body");
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(64);
  });

  it("round-trips: a signature made with the private key verifies with the public key", () => {
    const sig = signFleetRequest(PRIVATE_KEY, "job1", "{}");
    expect(verifyFleetRequest(PUBLIC_KEY, "job1", "{}", sig)).toBe(true);
  });

  it("accepts base64-wrapped PEM key material from env-style values", () => {
    const privateWrapped = Buffer.from(PRIVATE_KEY, "utf8").toString("base64");
    const publicWrapped = Buffer.from(PUBLIC_KEY, "utf8").toString("base64url");
    const sig = signFleetRequest(privateWrapped, "job1", "{}");
    expect(verifyFleetRequest(publicWrapped, "job1", "{}", sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signFleetRequest(PRIVATE_KEY, "job1", "{}");
    expect(verifyFleetRequest(PUBLIC_KEY, "job1", '{"extra":1}', sig)).toBe(false);
  });

  it("rejects a tampered jobId", () => {
    const sig = signFleetRequest(PRIVATE_KEY, "job1", "{}");
    expect(verifyFleetRequest(PUBLIC_KEY, "job2", "{}", sig)).toBe(false);
  });

  it("rejects a signature made with a different private key", () => {
    const sig = signFleetRequest(OTHER_FLEET_KEY_PAIR.privateKey, "job1", "{}");
    expect(verifyFleetRequest(PUBLIC_KEY, "job1", "{}", sig)).toBe(false);
  });

  it("does not accept old symmetric-HMAC style material as a verifier key", () => {
    const sig = signFleetRequest(PRIVATE_KEY, "job1", "{}");
    expect(verifyFleetRequest("test-secret-do-not-use-in-prod", "job1", "{}", sig)).toBe(false);
  });

  it("rejects when the header is missing or empty", () => {
    expect(verifyFleetRequest(PUBLIC_KEY, "job1", "{}", undefined)).toBe(false);
    expect(verifyFleetRequest(PUBLIC_KEY, "job1", "{}", "")).toBe(false);
  });

  it("rejects when the header is the wrong length (pre-comparison guard)", () => {
    expect(verifyFleetRequest(PUBLIC_KEY, "job1", "{}", "deadbeef")).toBe(false);
  });

  it("rejects garbage header bytes without throwing", () => {
    expect(verifyFleetRequest(PUBLIC_KEY, "job1", "{}", "zzzz".repeat(16))).toBe(
      false,
    );
  });
});
