import { describe, it, expect } from "vitest";
import {
  TIER_CREW_ACCESS,
  getProvisioning,
  CREW_ROLES,
  CREW_IDENTITY,
  TIERS,
} from "../lib/crew.js";

// ── CREW_ROLES ──────────────────────────────────────────────────────────────────

describe("CREW_ROLES", () => {
  it("contains only coach", () => {
    expect(CREW_ROLES).toEqual(["coach"]);
  });
});

// ── CREW_IDENTITY ───────────────────────────────────────────────────────────────

describe("CREW_IDENTITY", () => {
  it("coach is Octo with octopus emoji", () => {
    expect(CREW_IDENTITY.coach.name).toBe("Octo");
    expect(CREW_IDENTITY.coach.emoji).toBe("🐙");
  });
});

// ── TIERS ───────────────────────────────────────────────────────────────────────

describe("TIERS", () => {
  it("has 5 tiers", () => {
    expect(TIERS).toEqual(["trial", "free", "hobby", "pro", "max"]);
  });
});

// ── TIER_CREW_ACCESS ────────────────────────────────────────────────────────────

describe("TIER_CREW_ACCESS", () => {
  it("all tiers get only coach", () => {
    for (const tier of TIERS) {
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
