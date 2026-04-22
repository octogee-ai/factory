import { describe, it, expect } from "vitest";
import {
  canonicalPayload,
  signFleetRequest,
  verifyFleetRequest,
} from "../lib/fleet-signature.js";

const SECRET = "test-secret-do-not-use-in-prod";

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
  it("produces a stable hex digest across calls", () => {
    const a = signFleetRequest(SECRET, "job1", "body");
    const b = signFleetRequest(SECRET, "job1", "body");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips: a signature made with secret verifies with the same secret", () => {
    const sig = signFleetRequest(SECRET, "job1", "{}");
    expect(verifyFleetRequest(SECRET, "job1", "{}", sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signFleetRequest(SECRET, "job1", "{}");
    expect(verifyFleetRequest(SECRET, "job1", '{"extra":1}', sig)).toBe(false);
  });

  it("rejects a tampered jobId", () => {
    const sig = signFleetRequest(SECRET, "job1", "{}");
    expect(verifyFleetRequest(SECRET, "job2", "{}", sig)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const sig = signFleetRequest("other-secret", "job1", "{}");
    expect(verifyFleetRequest(SECRET, "job1", "{}", sig)).toBe(false);
  });

  it("rejects when the header is missing or empty", () => {
    expect(verifyFleetRequest(SECRET, "job1", "{}", undefined)).toBe(false);
    expect(verifyFleetRequest(SECRET, "job1", "{}", "")).toBe(false);
  });

  it("rejects when the header is the wrong length (pre-comparison guard)", () => {
    expect(verifyFleetRequest(SECRET, "job1", "{}", "deadbeef")).toBe(false);
  });

  it("rejects garbage header bytes without throwing", () => {
    expect(verifyFleetRequest(SECRET, "job1", "{}", "zzzz".repeat(16))).toBe(
      false,
    );
  });
});
