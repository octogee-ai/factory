import { describe, expect, it } from "vitest";
import {
  CREW_IDENTITY,
  CREW_ROLES,
  TIER_COLLABORATOR_LIMITS,
  TIER_CREW_ACCESS,
  TIERS,
  getProvisioning,
} from "./crew.js";

describe("crew constants", () => {
  it("defines the coach identity and tier access matrix", () => {
    expect(CREW_ROLES).toEqual(["coach"]);
    expect(CREW_IDENTITY.coach.name).toBe("Octo");
    expect(CREW_IDENTITY.coach.model).toBe("platform-openrouter/z-ai/glm-5.2");
    expect(TIERS).toEqual(["trial", "free", "hobby", "pro", "max"]);
    for (const tier of TIERS) {
      expect(TIER_CREW_ACCESS[tier]).toEqual(["coach"]);
    }
    expect(TIER_COLLABORATOR_LIMITS.max).toBe(Infinity);
  });
});

describe("getProvisioning", () => {
  it("extracts provisioning state and defaults optional arrays", () => {
    expect(getProvisioning({
      provisioning: {
        openclaw: {
          slug: "acme",
          status: "ready",
        },
      },
    })).toEqual({
      slug: "acme",
      status: "ready",
      customerDir: "",
      agentIds: [],
      activatedAgents: [],
    });
  });

  it("returns null when the openclaw provisioning shape is incomplete", () => {
    expect(getProvisioning({})).toBeNull();
    expect(getProvisioning({ provisioning: { openclaw: { slug: "acme" } } })).toBeNull();
  });
});
