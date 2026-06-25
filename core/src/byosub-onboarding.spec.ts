import { describe, it, expect } from "vitest";
import {
  startFlow,
  nextFlowState,
  coachAgentId,
  type FlowState,
} from "./byosub-onboarding.js";

const AW = (): FlowState =>
  startFlow({ url: "https://auth.openai.com/codex/device", code: "5BLJ-IWPLN", expiresAt: 1000 });

describe("coachAgentId", () => {
  it("derives the coach agent id from a workspace slug", () => {
    expect(coachAgentId("ceckert")).toBe("octogee-ceckert-coach");
  });
});

describe("startFlow", () => {
  it("begins in awaiting_user with the surfaced url/code/expiry", () => {
    const s = AW();
    expect(s).toEqual({
      phase: "awaiting_user",
      url: "https://auth.openai.com/codex/device",
      code: "5BLJ-IWPLN",
      expiresAt: 1000,
    });
  });
});

describe("nextFlowState — awaiting_user", () => {
  it("expires when a tick passes expiresAt", () => {
    expect(nextFlowState(AW(), { type: "tick", now: 1000 }).phase).toBe("expired");
    expect(nextFlowState(AW(), { type: "tick", now: 999 }).phase).toBe("awaiting_user");
  });

  it("clean child exit WITH auth.json → capturing", () => {
    expect(
      nextFlowState(AW(), { type: "childExit", code: 0, authPresent: true }).phase,
    ).toBe("capturing");
  });

  it("clean child exit WITHOUT auth.json → failed (anomaly, not silent)", () => {
    const s = nextFlowState(AW(), { type: "childExit", code: 0, authPresent: false });
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") expect(s.reason).toMatch(/auth\.json|no credential/i);
  });

  it("non-zero child exit → failed with the code in the reason", () => {
    const s = nextFlowState(AW(), { type: "childExit", code: 7, authPresent: false });
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") expect(s.reason).toMatch(/7/);
  });
});

describe("nextFlowState — capturing", () => {
  const CAP: FlowState = { phase: "capturing" };
  it("captureResult ok → connected", () => {
    expect(nextFlowState(CAP, { type: "captureResult", ok: true }).phase).toBe("connected");
  });
  it("captureResult !ok → failed (reason surfaced)", () => {
    const s = nextFlowState(CAP, { type: "captureResult", ok: false, reason: "SM 403" });
    expect(s.phase).toBe("failed");
    if (s.phase === "failed") expect(s.reason).toMatch(/SM 403/);
  });
  it("a stray tick/childExit while capturing is a no-op", () => {
    expect(nextFlowState(CAP, { type: "tick", now: 9e9 })).toEqual(CAP);
    expect(nextFlowState(CAP, { type: "childExit", code: 0, authPresent: true })).toEqual(CAP);
  });
});

describe("nextFlowState — terminal states are idempotent", () => {
  for (const t of [
    { phase: "connected" } as FlowState,
    { phase: "expired" } as FlowState,
    { phase: "failed", reason: "x" } as FlowState,
  ]) {
    it(`${t.phase} ignores all further events`, () => {
      expect(nextFlowState(t, { type: "tick", now: 9e9 })).toEqual(t);
      expect(nextFlowState(t, { type: "captureResult", ok: true })).toEqual(t);
      expect(nextFlowState(t, { type: "childExit", code: 1, authPresent: false })).toEqual(t);
    });
  }
});
