import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";
import {
  CREW_IDENTITY,
  CREW_ROLES,
  TIER_COLLABORATOR_LIMITS,
  TIER_CREW_ACCESS,
  TIERS,
  getProvisioning,
} from "./crew.js";

describe("crew constants", () => {
  it("defines the agent identity and tier access matrix", () => {
    expect(CREW_ROLES).toEqual(["coach"]);
    expect(CREW_IDENTITY.coach.name).toBe("Octo");
    expect(CREW_IDENTITY.coach.model).toBe(DEFAULT_USER_AGENT_MODEL_REF);
    expect(CREW_IDENTITY.coach.model).toBe("platform-openai/gpt-6.1-terra");
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
