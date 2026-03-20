import { describe, it, expect } from "vitest";
import {
  isPersonalTier,
  TIER_CREW_ACCESS,
  getProvisioning,
  CREW_ROLES,
  CREW_IDENTITY,
} from "../lib/crew.js";

// ── isPersonalTier ──────────────────────────────────────────────────────────────

describe("isPersonalTier", () => {
  it("returns true for free", () => {
    expect(isPersonalTier("free")).toBe(true);
  });

  it("returns true for personal_trial", () => {
    expect(isPersonalTier("personal_trial")).toBe(true);
  });

  it("returns true for personal_hobby", () => {
    expect(isPersonalTier("personal_hobby")).toBe(true);
  });

  it("returns true for personal_pro", () => {
    expect(isPersonalTier("personal_pro")).toBe(true);
  });

  it("returns true for personal_max", () => {
    expect(isPersonalTier("personal_max")).toBe(true);
  });

  it("returns false for starter", () => {
    expect(isPersonalTier("starter")).toBe(false);
  });

  it("returns false for pro", () => {
    expect(isPersonalTier("pro")).toBe(false);
  });

  it("returns false for trial", () => {
    expect(isPersonalTier("trial")).toBe(false);
  });

  it("returns false for business", () => {
    expect(isPersonalTier("business")).toBe(false);
  });

  it("returns false for enterprise", () => {
    expect(isPersonalTier("enterprise")).toBe(false);
  });

  it("returns false for unknown tier", () => {
    expect(isPersonalTier("unknown")).toBe(false);
  });
});

// ── TIER_CREW_ACCESS ────────────────────────────────────────────────────────────

describe("TIER_CREW_ACCESS", () => {
  it("free tier gets only coach", () => {
    expect(TIER_CREW_ACCESS.free).toEqual(["coach"]);
  });

  it("starter tier gets coach + alex", () => {
    expect(TIER_CREW_ACCESS.starter).toEqual(["coach", "alex"]);
  });

  it("pro tier gets coach + alex + riley", () => {
    expect(TIER_CREW_ACCESS.pro).toEqual(["coach", "alex", "riley"]);
  });

  it("business tier gets full crew", () => {
    expect(TIER_CREW_ACCESS.business).toEqual(["coach", "alex", "morgan", "riley", "robert"]);
  });

  it("trial tier gets full crew", () => {
    expect(TIER_CREW_ACCESS.trial).toEqual(["coach", "alex", "morgan", "riley", "robert"]);
  });

  it("personal tiers get only coach", () => {
    for (const tier of ["free", "personal_trial", "personal_hobby", "personal_pro", "personal_max"]) {
      expect(TIER_CREW_ACCESS[tier]).toEqual(["coach"]);
    }
  });
});

// ── getProvisioning ─────────────────────────────────────────────────────────────

describe("getProvisioning", () => {
  it("extracts provisioning data from valid doc", () => {
    const data = {
      provisioning: {
        openclaw: {
          slug: "my-biz",
          status: "complete",
          customerDir: "/path/to/dir",
          agentIds: ["agent-1"],
          activatedAgents: ["coach"],
        },
      },
    };
    const result = getProvisioning(data);
    expect(result).toEqual({
      slug: "my-biz",
      status: "complete",
      customerDir: "/path/to/dir",
      agentIds: ["agent-1"],
      activatedAgents: ["coach"],
    });
  });

  it("returns null when slug is missing", () => {
    const data = { provisioning: { openclaw: { status: "complete" } } };
    expect(getProvisioning(data)).toBeNull();
  });

  it("returns null when status is missing", () => {
    const data = { provisioning: { openclaw: { slug: "test" } } };
    expect(getProvisioning(data)).toBeNull();
  });

  it("returns null when provisioning is missing", () => {
    expect(getProvisioning({})).toBeNull();
  });

  it("handles missing optional fields with defaults", () => {
    const data = {
      provisioning: {
        openclaw: { slug: "test", status: "provisioning" },
      },
    };
    const result = getProvisioning(data);
    expect(result!.customerDir).toBe("");
    expect(result!.agentIds).toEqual([]);
    expect(result!.activatedAgents).toEqual([]);
  });
});
