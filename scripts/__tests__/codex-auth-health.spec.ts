import { describe, it, expect, vi } from "vitest";
import {
  deriveCodexAuthHealth,
  checkCodexAuthHealthForAgents,
} from "../lib/codex-auth-health.js";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "../lib/byot-multi-provider-config.js";

const P = OPENAI_CODEX_DEFAULT_PROFILE_ID; // "openai-codex:default"
const NOW = 1_780_000_000_000;

// openclaw persists auth-profile failure state to <agentAuthDir>/<AUTH_STATE_FILENAME>:
//   { version, order?, lastGood?, usageStats?: Record<profileId, ProfileUsageStats> }
// ProfileUsageStats.disabledReason is an AuthProfileFailureReason ("auth_permanent"
// | "billing" | ...) paired with disabledUntil. We treat ONLY an active
// auth_permanent disable window for the codex profile as "needs_reauth".
const state = (usageStats: Record<string, unknown>) =>
  JSON.stringify({ version: 1, usageStats });

describe("deriveCodexAuthHealth — absence/garbage is OK (no state ≠ failure)", () => {
  it.each([null, undefined, "", "   ", "not json", "[]", "5", "null", '"x"'])(
    "%j → ok",
    (raw) => {
      expect(deriveCodexAuthHealth(raw as string | null, P, NOW)).toBe("ok");
    },
  );

  it("record without usageStats → ok", () => {
    expect(deriveCodexAuthHealth(JSON.stringify({ version: 1 }), P, NOW)).toBe("ok");
    expect(
      deriveCodexAuthHealth(JSON.stringify({ version: 1, usageStats: 7 }), P, NOW),
    ).toBe("ok");
  });

  it("usageStats has no entry for the codex profile → ok", () => {
    expect(deriveCodexAuthHealth(state({ "anthropic:default": {} }), P, NOW)).toBe(
      "ok",
    );
  });
});

describe("deriveCodexAuthHealth — only an ACTIVE auth_permanent disable = needs_reauth", () => {
  it("disabledReason=auth_permanent + disabledUntil in the future → needs_reauth", () => {
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "auth_permanent", disabledUntil: NOW + 60_000 } }),
        P,
        NOW,
      ),
    ).toBe("needs_reauth");
  });

  it("realistic openclaw payload (order/lastGood/failureCounts) → needs_reauth", () => {
    const raw = JSON.stringify({
      version: 1,
      order: { [P]: 0 },
      lastGood: { [P]: NOW - 999_999 },
      usageStats: {
        [P]: {
          disabledReason: "auth_permanent",
          disabledUntil: NOW + 600_000,
          errorCount: 3,
          failureCounts: { auth_permanent: 3 },
        },
      },
    });
    expect(deriveCodexAuthHealth(raw, P, NOW)).toBe("needs_reauth");
  });

  it("auth_permanent but disabledUntil already elapsed (≤ now) → ok (openclaw will retry)", () => {
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "auth_permanent", disabledUntil: NOW - 1 } }),
        P,
        NOW,
      ),
    ).toBe("ok");
  });

  it("fail-safe: auth_permanent with no/garbage disabledUntil → needs_reauth", () => {
    expect(
      deriveCodexAuthHealth(state({ [P]: { disabledReason: "auth_permanent" } }), P, NOW),
    ).toBe("needs_reauth");
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "auth_permanent", disabledUntil: "soon" } }),
        P,
        NOW,
      ),
    ).toBe("needs_reauth");
  });

  it("a different disabledReason (billing) or transient cooldown is NOT reauth", () => {
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "billing", disabledUntil: NOW + 60_000 } }),
        P,
        NOW,
      ),
    ).toBe("ok");
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { cooldownReason: "auth_permanent", cooldownUntil: NOW + 60_000 } }),
        P,
        NOW,
      ),
    ).toBe("ok");
  });

  it("per-profile isolation: a different profile disabled does not flag codex", () => {
    expect(
      deriveCodexAuthHealth(
        state({
          "anthropic:default": { disabledReason: "auth_permanent", disabledUntil: NOW + 60_000 },
        }),
        P,
        NOW,
      ),
    ).toBe("ok");
  });
});

describe("checkCodexAuthHealthForAgents — periodic detection sweep (injected I/O, never throws)", () => {
  const disabled = state({
    [P]: { disabledReason: "auth_permanent", disabledUntil: NOW + 600_000 },
  });
  const healthy = state({ [P]: { errorCount: 0 } });

  it("no agents → zeroed tally, no signal", async () => {
    const signal = vi.fn(async () => {});
    const r = await checkCodexAuthHealthForAgents({
      agentIds: [],
      profileId: P,
      now: NOW,
      readAuthState: () => null,
      signalNeedsReauth: signal,
    });
    expect(r).toEqual({ checked: 0, needsReauth: 0, signalled: 0 });
    expect(signal).not.toHaveBeenCalled();
  });

  it("healthy / absent state → checked, not signalled", async () => {
    const signal = vi.fn(async () => {});
    const r = await checkCodexAuthHealthForAgents({
      agentIds: ["octogee-a-coach", "octogee-b-coach"],
      profileId: P,
      now: NOW,
      readAuthState: (a) => (a === "octogee-a-coach" ? healthy : null),
      signalNeedsReauth: signal,
    });
    expect(r).toEqual({ checked: 2, needsReauth: 0, signalled: 0 });
    expect(signal).not.toHaveBeenCalled();
  });

  it("an auth_permanent agent → signalled exactly once with its agentId", async () => {
    const seen: string[] = [];
    const r = await checkCodexAuthHealthForAgents({
      agentIds: ["octogee-a-coach", "octogee-bad-coach", "octogee-c-coach"],
      profileId: P,
      now: NOW,
      readAuthState: (a) => (a === "octogee-bad-coach" ? disabled : healthy),
      signalNeedsReauth: async (a) => {
        seen.push(a);
      },
    });
    expect(r).toEqual({ checked: 3, needsReauth: 1, signalled: 1 });
    expect(seen).toEqual(["octogee-bad-coach"]);
  });

  it("per-item isolation: a readAuthState throw skips that agent, others still processed; never throws", async () => {
    const logs: string[] = [];
    const seen: string[] = [];
    const r = await checkCodexAuthHealthForAgents({
      agentIds: ["octogee-explode", "octogee-bad-coach"],
      profileId: P,
      now: NOW,
      readAuthState: (a) => {
        if (a === "octogee-explode") throw new Error("EACCES auth-state.json");
        return disabled;
      },
      signalNeedsReauth: async (a) => {
        seen.push(a);
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ checked: 1, needsReauth: 1, signalled: 1 });
    expect(seen).toEqual(["octogee-bad-coach"]);
    expect(logs.join("\n")).toMatch(/octogee-explode|EACCES/);
  });

  it("a signal failure is counted+logged, not thrown (detection must not wedge the sweep)", async () => {
    const logs: string[] = [];
    const r = await checkCodexAuthHealthForAgents({
      agentIds: ["octogee-bad-coach"],
      profileId: P,
      now: NOW,
      readAuthState: () => disabled,
      signalNeedsReauth: async () => {
        throw new Error("gateway-edge 503");
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ checked: 1, needsReauth: 1, signalled: 0 });
    expect(logs.join("\n")).toMatch(/octogee-bad-coach|503/);
  });
});
